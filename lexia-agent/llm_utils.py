"""
LLM utility functions for Servia Services
"""

import base64
import json
import os
import re
import time
import sys
from typing import Dict, Any, List, Optional, TYPE_CHECKING
from pathlib import Path
import logging
from dotenv import load_dotenv

from services.dataframe_services import DataFrameService
from skill_registry import resolve_skill, skills_dir

# Add parent directory to path to allow imports from root level
# Handle case where __file__ might not be defined (e.g., in debug console)
try:
    _file_path = __file__
except NameError:
    # __file__ is not defined (e.g., in interactive Python or debug console)
    _file_path = None

if _file_path:
    _parent_dir = Path(_file_path).parent.parent
else:
    # Fallback to current working directory parent if __file__ is not available
    _parent_dir = Path.cwd().parent

if str(_parent_dir) not in sys.path:
    sys.path.insert(0, str(_parent_dir))

if TYPE_CHECKING:
    from services.dataframe_services import DataFrameService

IMAGE_DIR = Path("tmp_images")
IMAGE_DIR.mkdir(exist_ok=True)


# Import settings and factory
from config import get_settings
from llm.llm_factory import get_llm, clear_llm_cache

# Load environment variables
load_dotenv()

logger = logging.getLogger(__name__)

# Initialize LLM clients using the factory pattern
# This automatically selects the correct provider (OpenAI, Ollama, vLLM, etc.)
# based on the configuration in config.yaml
client, async_client = get_llm()

# Get LLM configuration at module level (initialized once)
llm_config = get_settings().llm


def reinitialize_llm_clients():
    """
    Reinitialize LLM clients after configuration changes.

    This function should be called when the LLM configuration is updated
    (e.g., via the config API) to ensure clients use the new settings.
    """
    global client, async_client, llm_config

    logger.info("🔄 Reinitializing LLM clients due to configuration change...")

    # Clear the cache to force reinitialization
    clear_llm_cache()

    # Reload settings to get the updated configuration
    get_settings(reload=True)

    # Reinitialize clients with new configuration
    client, async_client = get_llm()

    # Update LLM config
    llm_config = get_settings().llm

    logger.info(
        f"✅ LLM clients reinitialized - Provider: {llm_config.provider}, Model: {llm_config.model}"
    )


def call_llm_with_tools(
    prompt: str = None,
    tools: List[Dict[str, Any]] = None,
    tool_choice: str = "auto",
    stream: bool = False,
    system_prompt: str = None,
    messages: List[Dict[str, Any]] = None,
    user_id: str = None,
    metadata: Dict[str, Any] = None,
    context_window_size: int = None,
    max_tokens: int = None,
    stream_callback: callable = None,
) -> Dict[str, Any]:
    """
    Call OpenAI LLM with optional tool support.

    Args:
        prompt: The prompt to send to the LLM (optional if messages provided)
        tools: List of available tools
        tool_choice: Tool choice strategy ("auto", "none", or specific tool name)
        stream: Whether to stream the response
        system_prompt: Optional system prompt (uses default if not provided)
        messages: Optional pre-built messages list (for multi-turn conversations)
        user_id: Optional user ID for evaluation logging
        metadata: Optional metadata for evaluation logging
        context_window_size: Optional context window size limit
        max_tokens: Optional maximum tokens for response (overrides config default)
        stream_callback: Optional callback function to receive streaming chunks (chunk_text: str) -> None

    Returns:
        Dictionary with message and optional tool_calls
    """

    def dedup_tool_calls(tool_calls_list):
        """
        Deduplicate tool calls by normalized (name, arguments), case-insensitive on file paths and patterns.
        Special handling:
          - cat/function_describer: dedup on file_path only (lowercased, resolved)
          - grep: dedup on (file_path, pattern, case_sensitive) with file_path and pattern lowercased when case_sensitive=False
        """
        seen = set()
        unique = []
        skills_root = skills_dir()

        def normalize(tc):
            if hasattr(tc, "function"):
                name = getattr(tc.function, "name", None)
                args_raw = getattr(tc.function, "arguments", None)
            elif isinstance(tc, dict):
                func = tc.get("function", {})
                name = func.get("name")
                args_raw = func.get("arguments")
            else:
                name = None
                args_raw = None

            # Parse args if JSON string
            args = args_raw
            if isinstance(args_raw, str):
                try:
                    args = json.loads(args_raw)
                except Exception:
                    args = args_raw

            # Normalization rules
            if name in ("cat", "function_describer"):
                file_path = args.get("file_path") if isinstance(args, dict) else None
                if not file_path:
                    return None, None, None
                fp = Path(file_path)
                if not fp.exists() or skills_root not in fp.resolve().parents:
                    return None, None, None
                # normalize path lowercase
                key = (name, str(fp.resolve()).lower())
            elif name == "grep":
                if isinstance(args, dict):
                    file_path = args.get("file_path")
                    pattern = args.get("pattern")
                    case_sensitive = bool(args.get("case_sensitive", False))
                    if not file_path:
                        return None, None, None
                    fp = Path(file_path)
                    if not fp.exists() or skills_root not in fp.resolve().parents:
                        return None, None, None
                    norm_path = str(fp.resolve()).lower()
                    norm_pattern = (
                        pattern
                        if pattern is None
                        else (pattern if case_sensitive else str(pattern).lower())
                    )
                    key = (name, norm_path, norm_pattern, case_sensitive)
                else:
                    key = (name, str(args).lower())
            else:
                key = (
                    name,
                    json.dumps(args, sort_keys=True)
                    if isinstance(args, dict)
                    else str(args),
                )

            return key, name, args_raw

        for tc in tool_calls_list or []:
            key, _, _ = normalize(tc)
            if key is None:
                continue
            if key in seen:
                continue
            seen.add(key)
            unique.append(tc)
        return unique

    # Start timer for evaluation logging
    start_time = time.time()

    # Prepare tool configuration - use the actual tools from JSON
    tool_configs = []
    full_content = ""

    if tools:
        for tool in tools:
            tool_configs.append({"type": "function", "function": tool})

    # Prepare OpenAI call parameters using module-level config
    call_params = {
        "model": llm_config.model,
        "messages": messages,
        # "temperature": llm_config.temperature,
        # "max_tokens": max_tokens if max_tokens is not None else llm_config.max_tokens,
        "stream": stream,
    }

    # Add tools if available
    if tool_configs:
        call_params["tools"] = tool_configs
        call_params["tool_choice"] = tool_choice

    try:
        # Make the API call
        response = client.chat.completions.create(**call_params)
        # response = client.responses.create(
        #     model=llm_config.model,
        #     instructions="You are a helpful assistant.",
        #     input = messages,
        #     tools = tools,
        #     stream = stream,
        # )

        if stream:
            # Handle streaming response
            # full_content = ""
            tool_calls = []

            for chunk in response:
                if chunk.choices:
                    delta = chunk.choices[0].delta

                    if delta.tool_calls:
                        for tool_call in delta.tool_calls:
                            if tool_call.index >= len(tool_calls):
                                tool_calls.extend(
                                    [None] * (tool_call.index + 1 - len(tool_calls))
                                )

                            if tool_calls[tool_call.index] is None:
                                # Initialize with empty strings for None values
                                tool_calls[tool_call.index] = {
                                    "id": tool_call.id,
                                    "type": tool_call.type or "function",
                                    "function": {
                                        "name": tool_call.function.name or "",
                                        "arguments": tool_call.function.arguments or "",
                                    },
                                }
                            else:
                                # Append to existing values (handle None safely)
                                if tool_call.function.name:
                                    tool_calls[tool_call.index]["function"]["name"] += (
                                        tool_call.function.name
                                    )
                                if tool_call.function.arguments:
                                    tool_calls[tool_call.index]["function"][
                                        "arguments"
                                    ] += tool_call.function.arguments
                                if (
                                    tool_call.id
                                    and not tool_calls[tool_call.index]["id"]
                                ):
                                    tool_calls[tool_call.index]["id"] = tool_call.id

                    if delta.content:
                        chunk_text = delta.content
                        full_content += chunk_text

                        # Call the callback with the chunk if provided and callable
                        if stream_callback and callable(stream_callback):
                            try:
                                stream_callback(chunk_text)
                            except Exception as e:
                                logger.error(f"Error in stream_callback: {e}")

            # Calculate execution duration
            execution_duration = int(
                (time.time() - start_time) * 1000
            )  # Convert to milliseconds

            tool_calls = dedup_tool_calls(tool_calls)

            return {
                "message": full_content,
                "tool_calls": tool_calls,
                "execution_duration": execution_duration,
            }
        else:
            # Handle non-streaming response
            message_content = response.choices[0].message.content or ""
            tool_calls = []

            if response.choices[0].message.tool_calls:
                for tool_call in dedup_tool_calls(
                    response.choices[0].message.tool_calls
                ):
                    tool_calls.append(
                        {
                            "id": tool_call.id,
                            "type": tool_call.type,
                            "function": {
                                "name": tool_call.function.name,
                                "arguments": tool_call.function.arguments,
                            },
                        }
                    )

            # Calculate execution duration
            execution_duration = int(
                (time.time() - start_time) * 1000
            )  # Convert to milliseconds

            return {
                "message": message_content,
                "tool_calls": tool_calls if tool_calls else None,
                "execution_duration": execution_duration,
            }

    except Exception as e:
        error_type = type(e).__name__
        error_msg = str(e)
        logger.error(f"Error calling LLM ({error_type}): {error_msg}")
        logger.error(
            f"LLM Config - Provider: {llm_config.provider}, Model: {llm_config.model}, Base URL: {llm_config.base_url}"
        )

        # Calculate execution duration
        execution_duration = int(
            (time.time() - start_time) * 1000
        )  # Convert to milliseconds

        # Provide more helpful error message
        if (
            "Connection" in error_type
            or "connection" in error_msg.lower()
            or "ConnectionError" in error_type
        ):
            detailed_error = f"Erreur de connexion à l'API LLM ({llm_config.provider}). Vérifiez que le service est accessible à {llm_config.base_url}"
        else:
            detailed_error = f"Erreur lors de l'appel à l'API: {error_msg}"

        return {
            "message": detailed_error,
            "tool_calls": None,
            "error": {
                "type": error_type,
                "message": error_msg,
                "provider": llm_config.provider,
                "base_url": llm_config.base_url,
            },
        }


def clean_parameters_for_openai(parameters: dict) -> dict:
    """
    Clean parameters to match OpenAI function calling schema.
    Removes custom fields like 'optional', 'example', 'default' from properties.

    OpenAI only accepts: type, properties, required, description, items, enum
    """
    if not isinstance(parameters, dict):
        return parameters

    cleaned = {"type": parameters.get("type", "object")}

    # Clean properties
    if "properties" in parameters:
        cleaned_properties = {}
        for prop_name, prop_def in parameters["properties"].items():
            if isinstance(prop_def, dict):
                # Only keep allowed fields
                cleaned_prop = {}

                # Always include type and description
                if "type" in prop_def:
                    cleaned_prop["type"] = prop_def["type"]
                if "description" in prop_def:
                    cleaned_prop["description"] = prop_def["description"]

                # Handle arrays (items)
                if "items" in prop_def:
                    cleaned_prop["items"] = clean_parameters_for_openai(
                        prop_def["items"]
                    )

                # Handle nested objects
                if "properties" in prop_def:
                    cleaned_prop["properties"] = {}
                    for nested_name, nested_def in prop_def["properties"].items():
                        cleaned_prop["properties"][nested_name] = (
                            clean_parameters_for_openai(nested_def)
                        )

                # Add enum if it exists (OpenAI supports this)
                if "enum" in prop_def:
                    cleaned_prop["enum"] = prop_def["enum"]

                cleaned_properties[prop_name] = cleaned_prop
            else:
                cleaned_properties[prop_name] = prop_def

        cleaned["properties"] = cleaned_properties

    # Keep required field as-is
    if "required" in parameters:
        cleaned["required"] = parameters["required"]

    # Add description if present at top level
    if "description" in parameters:
        cleaned["description"] = parameters["description"]

    return cleaned


# Mapping of tools to their required skills - skill content is auto-injected when these tools are called
TOOL_SKILL_MAP = {"generate_pandas_code": "parquet-reader" }

# Cache for loaded skills to avoid repeated file reads
_SKILL_CONTENT_CACHE: Dict[str, str] = {}


def _load_skill_content(skill_name: str) -> str:
    """Load skill content from file, with caching."""
    if skill_name in _SKILL_CONTENT_CACHE:
        return _SKILL_CONTENT_CACHE[skill_name]

    skill = resolve_skill(skill_name)
    skill_path = skill.skill_path if skill else skills_dir() / skill_name / "SKILL.md"

    if not skill_path.exists():
        logger.warning(f"Skill file not found: {skill_path}")
        return ""

    try:
        content = skill_path.read_text(encoding="utf-8")
        _SKILL_CONTENT_CACHE[skill_name] = content
        logger.info(f"📖 Loaded skill '{skill_name}' ({len(content)} chars)")
        return content
    except Exception as e:
        logger.error(f"Error loading skill {skill_name}: {e}")
        return ""


def execute_tool_call(
    function_name: str,
    arguments: Any,
    selected_tools: List[str] = None,
    stream_callback: callable = None,
    dataframe_service: DataFrameService = None,
    chart_callback: callable = None,
) -> str:
    """
    Execute a tool call and return result as JSON string.

    Args:
        function_name: Name of the function to execute
        arguments: Arguments for the function (can be dict or JSON string)
        selected_tools: Optional list of selected tools (for scraping)
        stream_callback: Optional callback function for streaming tool output
        dataframe_service: DataFrameService instance for pandas operations
        chart_callback: Optional callback for spawning chart generation
                       Signature: chart_callback(pandas_output: str, user_request: str)

    Returns:
        JSON string with the result
    """
    try:
        # Parse arguments if they come as a string
        if isinstance(arguments, str):
            try:
                arguments = json.loads(arguments)
            except json.JSONDecodeError as e:
                logger.error(f"Failed to parse arguments JSON: {e}")
                return json.dumps(
                    {
                        "function": function_name,
                        "arguments": arguments,
                        "error": f"Invalid JSON arguments: {str(e)}",
                        "status": "error",
                    },
                    ensure_ascii=False,
                )

        # Ensure arguments is a dict
        if not isinstance(arguments, dict):
            arguments = {}

        # Auto-inject skill instructions for tools that require them
        skill_name = TOOL_SKILL_MAP.get(function_name)
        skill_instructions = ""
        if skill_name:
            skill_instructions = _load_skill_content(skill_name)
            if skill_instructions:
                logger.info(
                    f"📋 Auto-injecting skill '{skill_name}' for tool '{function_name}'"
                )

        # Generic filesystem tools (from chat_tools.json)
        if function_name == "grep":
            import os
            import re
            from pathlib import Path

            pattern = arguments.get("pattern", "")
            file_path = arguments.get("file_path", "")
            case_sensitive = arguments.get("case_sensitive", False)
            max_results = int(arguments.get("max_results", 100) or 100)

            flags = 0 if case_sensitive else re.IGNORECASE
            compiled = re.compile(pattern, flags)

            results = []

            def search_file(path: Path):
                try:
                    with path.open("r", encoding="utf-8", errors="ignore") as f:
                        for lineno, line in enumerate(f, 1):
                            if compiled.search(line):
                                results.append(f"{path}:{lineno}:{line.rstrip()}")
                                if len(results) >= max_results:
                                    return True
                except Exception as e:
                    results.append(f"{path}:ERROR:{e}")
                return False

            p = Path(file_path)
            if p.is_dir():
                for file in p.rglob("*"):
                    if file.is_file():
                        if search_file(file):
                            break
            elif p.is_file():
                search_file(p)
            else:
                results.append(f"{file_path}:ERROR:Not found")

            return json.dumps(
                {"function": function_name, "arguments": arguments, "matches": results},
                ensure_ascii=False,
            )

        if function_name == "cat":
            from pathlib import Path

            target = Path(arguments.get("file_path", ""))
            start_line = int(arguments.get("start_line", 1) or 1)
            max_lines = arguments.get("max_lines", None)
            max_lines = int(max_lines) if max_lines is not None else None

            if not target.exists() or not target.is_file():
                return json.dumps(
                    {
                        "function": function_name,
                        "arguments": arguments,
                        "error": f"File not found: {target}",
                    },
                    ensure_ascii=False,
                )

            lines = []
            try:
                with target.open("r", encoding="utf-8", errors="ignore") as f:
                    for idx, line in enumerate(f, 1):
                        if idx < start_line:
                            continue
                        lines.append(line.rstrip("\n"))
                        if max_lines is not None and len(lines) >= max_lines:
                            break
            except Exception as e:
                return json.dumps(
                    {
                        "function": function_name,
                        "arguments": arguments,
                        "error": str(e),
                    },
                    ensure_ascii=False,
                )

            return json.dumps(
                {
                    "function": function_name,
                    "arguments": arguments,
                    "content": "\n".join(lines),
                },
                ensure_ascii=False,
            )

        elif function_name == "read_skill":
            try:
                skill_name = arguments.get("skill_name", "")
                if not skill_name:
                    return json.dumps(
                        {"function": function_name, "error": "skill_name is required"},
                        ensure_ascii=False,
                    )

                skill = resolve_skill(skill_name)
                skill_path = skill.skill_path if skill else skills_dir() / skill_name / "SKILL.md"

                if not skill_path.exists():
                    # Try to list available skills for error message
                    available_skills = []
                    current_skills_dir = skills_dir()
                    if current_skills_dir.exists():
                        for subdir in current_skills_dir.iterdir():
                            if subdir.is_dir() and (subdir / "SKILL.md").exists():
                                available_skills.append(subdir.name)

                    return json.dumps(
                        {
                            "function": function_name,
                            "skill_name": skill_name,
                            "error": f"Skill '{skill_name}' not found",
                            "available_skills": available_skills,
                        },
                        ensure_ascii=False,
                    )

                # Read the full skill content
                skill_content = skill_path.read_text(encoding="utf-8")

                logger.info(
                    f"📖 Loaded skill '{skill_name}' ({len(skill_content)} chars)"
                )

                return json.dumps(
                    {
                        "function": function_name,
                        "skill_name": skill.name if skill else skill_name,
                        "resolved_from": skill_name,
                        "skill_directory": skill.directory_name if skill else skill_path.parent.name,
                        "content": skill_content,
                    },
                    ensure_ascii=False,
                )

            except Exception as e:
                logger.error(f"Error executing read_skill: {e}")
                return json.dumps(
                    {
                        "function": function_name,
                        "arguments": arguments,
                        "error": str(e),
                    },
                    ensure_ascii=False,
                )

        elif function_name == "search_columns_embeddings":
            if dataframe_service is None:
                return json.dumps(
                    {
                        "error": "enriched_df n'est pas initialisé. Veuillez charger les données d'abord.",
                        "status": "error",
                    },
                    ensure_ascii=False,
                )

            # Extract required parameters
            search_criteria = arguments.get("search_criteria", None)
            if not isinstance(search_criteria, dict) or not search_criteria:
                return json.dumps(
                    {
                        "error": "search_criteria est requis et doit être un objet non-vide.",
                        "status": "error",
                        "arguments": arguments,
                    },
                    ensure_ascii=False,
                )

            try:
                # Use the provided  DataFrameService instance and call search_dataframe_embeddings
                best_matches = dataframe_service.search_columns_embeddings(
                    search_criteria, threshold=0.7
                )

                # Convert DataFrame to JSON-serializable format
                result = {
                    "status": "success",
                    "search_criteria": best_matches,
                }

                return json.dumps(result, ensure_ascii=False, default=str)

            except Exception as e:
                logger.error(
                    f"Error in search_dataframe_embeddings: {e}", exc_info=True
                )
                return json.dumps(
                    {
                        "error": f"Erreur lors de l'exécution de search_dataframe_embeddings: {str(e)}",
                        "status": "error",
                    },
                    ensure_ascii=False,
                )

        elif function_name == "generate_pandas_code":
            if dataframe_service is None:
                return json.dumps(
                    {
                        "error": "DataFrame n'est pas initialisé. Veuillez charger les données d'abord.",
                        "status": "error",
                    },
                    ensure_ascii=False,
                )

            # Extract parameters
            user_request = arguments.get("user_request", "")
            search_results = arguments.get("search_results", None)

            # Validate required parameters
            if not user_request:
                return json.dumps(
                    {"error": "user_request est requis", "status": "error"},
                    ensure_ascii=False,
                )

            try:
                # Import the codegen tool
                from qclick.tools.codegen_tool import generate_pandas_code, execute_generated_code
                
                # Get columns info from dataframe_service
                columns_info = ""
                if hasattr(dataframe_service, "columns_classes") and dataframe_service.columns_classes:
                    columns_info = json.dumps(
                        [col.column_name for col in dataframe_service.columns_classes.columns],
                        ensure_ascii=False
                    )
                
                # Retry logic: try up to 3 times with feedback
                max_attempts = 3
                last_error = None
                generated_code = None
                exec_result = None

                for attempt in range(max_attempts):
                    # Generate code using LLM (with retry feedback if not first attempt)
                    code_result = generate_pandas_code(
                        user_request=user_request,
                        columns_info=columns_info,
                        search_results=search_results,
                        dataframe_service=dataframe_service,
                        retry_count=attempt,
                        previous_error=last_error
                    )

                    if code_result.get("status") == "error":
                        last_error = code_result.get("error", "Unknown error")
                        if attempt < max_attempts - 1:
                            logger.warning(f"Code generation failed (attempt {attempt + 1}/{max_attempts}): {last_error}. Retrying...")
                            continue
                        else:
                            return json.dumps(code_result, ensure_ascii=False)

                    generated_code = code_result.get("code", "")

                    # Execute the generated code
                    exec_result = execute_generated_code(generated_code, dataframe_service)

                    # If execution succeeded, break out of retry loop
                    if exec_result.get("status") == "success":
                        logger.info(f"✅ Code generation succeeded on attempt {attempt + 1}/{max_attempts}")
                        break

                    # Execution failed - prepare error feedback for retry
                    error_type = "validation" if "validation failed" in exec_result.get("error", "").lower() else "execution"
                    last_error = f"""
{error_type.upper()} ERROR:
{exec_result.get('error', 'Unknown error')}
{exec_result.get('details', '')}

Generated code that failed:
{generated_code}

Fix the error and generate corrected code.
"""

                    if attempt < max_attempts - 1:
                        logger.warning(
                            f"Code execution failed (attempt {attempt + 1}/{max_attempts}): "
                            f"{exec_result.get('error')}. Retrying with feedback..."
                        )
                    else:
                        logger.error(
                            f"Code execution failed after {max_attempts} attempts. "
                            f"Last error: {exec_result.get('error')}"
                        )
                
                # If execution succeeded and chart callback is provided, trigger chart generation
                if exec_result.get("status") == "success" and chart_callback and callable(chart_callback):
                    pandas_output = exec_result.get("output", "")
                    if pandas_output:
                        try:
                            logger.info(f"📊 Triggering chart generation for pandas output...")
                            chart_callback(str(pandas_output), user_request)
                        except Exception as chart_err:
                            logger.error(f"Error spawning chart generation: {chart_err}")
                
                result = {
                    "status": exec_result.get("status", "success"),
                    "generated_code": generated_code,
                    "output": exec_result.get("output", ""),
                    "model": code_result.get("model", "unknown"),
                    "provider": code_result.get("provider", "unknown")
                }

                # Include error details if execution failed
                if exec_result.get("status") == "error":
                    result["error"] = exec_result.get("error", "Erreur inconnue")
                    result["details"] = exec_result.get("details", "")
                    result["returncode"] = exec_result.get("returncode")
                    logger.error(f"Pandas code execution failed:\nCode: {generated_code}\nError: {result['error']}\nDetails: {result['details']}")

                return json.dumps(result, ensure_ascii=False, default=str)
                
            except Exception as e:
                logger.error(f"Error in generate_pandas_code: {e}", exc_info=True)
                return json.dumps(
                    {
                        "error": f"Erreur lors de l'exécution de generate_pandas_code: {str(e)}",
                        "status": "error",
                    },
                    ensure_ascii=False,
                )

           
        else:
            error_result = {
                "function": function_name,
                "arguments": arguments,
                "error": f"Unknown function: {function_name}",
                "status": "error",
            }
            return json.dumps(error_result, ensure_ascii=False, indent=2)

    except Exception as e:
        logger.error(f"Error executing tool {function_name}: {e}")
        error_result = {
            "function": function_name,
            "arguments": arguments,
            "error": str(e),
            "status": "error",
        }

        return json.dumps(error_result)


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 3:
        print("Usage: python llm_utils.py <parquet_path> <columns_cache_path>")
        sys.exit(1)
    parquet_path = Path(sys.argv[1])
    columns_cache_path = Path(sys.argv[2])
    dataframe_service = DataFrameService()
    dataframe_service.load_dataframe_from_parquet(str(parquet_path))
    dataframe_service.load_columns_classes_from_parquet(str(columns_cache_path))
    # dataframe_service.refresh_columns_metadata()
    # columns_classes = dataframe_service.fetch_column_calcutate_embedding(use_chunked=False)

    criteria = {
        "INTITULE": "['Commissions Opérations Diverses Banque Clients Privés']",
        }
    results = dataframe_service.search_columns_embeddings(criteria, threshold=0.7)
    print(results)

    function_name_2 = "search_columns_embeddings"
    search_criteria = {
        "search_criteria": {
            "INTITULE": "['Commissions Opérations Diverses Banque Clients Privés']"
        }
    }

    result = execute_tool_call(
        function_name=function_name_2,
        arguments=search_criteria,
        dataframe_service=dataframe_service,
    )
    print(result)
