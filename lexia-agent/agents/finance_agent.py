import sys
import os
from pathlib import Path

# Add the parent directory to Python path
# ocr_agent.py is in agents/ directory, so go up one level to get to project root
project_root = Path(__file__).parent.parent
if str(project_root) not in sys.path:
    sys.path.insert(0, str(project_root))

from services.dataframe_services import DataFrameService
import json
import logging
import yaml
import time
import re
from datetime import datetime, timezone
from typing import Dict, Any, Optional, List, Tuple, TYPE_CHECKING
from collections import defaultdict
import asyncio
from pocketflow import Flow, Node, AsyncFlow, AsyncNode
from utils.llm_utils import call_llm_with_tools, execute_tool_call, clean_parameters_for_openai
from utils import run_async_safely
from config import get_settings
from skill_registry import build_skills_summary


if TYPE_CHECKING:
    from services.dataframe_services import DataFrameService


# Setup logger for chat operations
# Use __name__ to get module-specific logger (lumo.agents.chat_agent)
logger = logging.getLogger(__name__)

# Set logger level to INFO (matches root logger level in main.py)
logger.setLevel(logging.INFO)

logger.propagate = True


# ============================================================================
# PERFORMANCE TRACING LOGGER
# ============================================================================

class PerformanceTracer:
    """
    Dedicated performance tracer that logs timing information to separate files.
    Supports per-query log files and can be enabled/disabled via config.yaml.
    
    Configuration (config.yaml):
        performance:
          enabled: true
          log_dir: logs/performance
          log_per_query: true
          console_output: false
          include_summary: true
    """
    _instance = None
    _config = None
    _session_loggers = {}  # Per-session loggers (for log_per_query mode)
    _global_logger = None  # Shared logger (for daily mode)
    _session_timings = {}  # Track cumulative timings per session
    
    @classmethod
    def get_instance(cls):
        if cls._instance is None:
            cls._instance = cls()
            cls._load_config()
        return cls._instance
    
    @classmethod
    def _load_config(cls):
        """Load performance config from settings."""
        try:
            from config import get_settings
            settings = get_settings()
            cls._config = settings.performance
            
            if cls._config.enabled:
                # Create log directory
                log_dir = Path(cls._config.log_dir)
                log_dir.mkdir(parents=True, exist_ok=True)
                logger.info(f"📊 Performance tracing enabled: {log_dir}")
            else:
                logger.info("📊 Performance tracing disabled")
        except Exception as e:
            logger.warning(f"Could not load performance config: {e}. Using defaults.")
            # Default config if loading fails
            cls._config = type('Config', (), {
                'enabled': True,
                'log_dir': 'logs/performance',
                'log_per_query': True,
                'console_output': False,
                'include_summary': True
            })()
    
    @classmethod
    def _is_enabled(cls) -> bool:
        """Check if tracing is enabled."""
        cls.get_instance()
        return cls._config.enabled if cls._config else False
    
    @classmethod
    def _get_session_logger(cls, session_id: str, query: str = "") -> logging.Logger:
        """Get or create logger for a session."""
        if not cls._is_enabled():
            return None
        
        if cls._config.log_per_query:
            # Create per-query log file
            if session_id not in cls._session_loggers:
                log_dir = Path(cls._config.log_dir)
                log_dir.mkdir(parents=True, exist_ok=True)
                
                # Create filename with timestamp and sanitized query
                timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
                safe_query = "".join(c if c.isalnum() or c in (' ', '-', '_') else '' for c in query[:30]).strip().replace(' ', '_')
                log_file = log_dir / f"{timestamp}_{session_id[:8]}_{safe_query}.log"
                
                # Create logger for this session
                session_logger = logging.getLogger(f"qvd_perf.{session_id[:8]}")
                session_logger.setLevel(logging.DEBUG)
                session_logger.handlers = []  # Clear any existing handlers
                
                # File handler
                file_handler = logging.FileHandler(log_file, mode='w', encoding='utf-8')
                file_handler.setLevel(logging.DEBUG)
                formatter = logging.Formatter(
                    '%(asctime)s.%(msecs)03d | %(message)s',
                    datefmt='%H:%M:%S'
                )
                file_handler.setFormatter(formatter)
                session_logger.addHandler(file_handler)
                
                # Optional console handler
                if cls._config.console_output:
                    console_handler = logging.StreamHandler()
                    console_handler.setLevel(logging.INFO)
                    console_handler.setFormatter(formatter)
                    session_logger.addHandler(console_handler)
                
                session_logger.propagate = False
                cls._session_loggers[session_id] = {
                    "logger": session_logger,
                    "log_file": log_file
                }
                
                logger.info(f"📝 Performance log: {log_file}")
            
            return cls._session_loggers[session_id]["logger"]
        else:
            # Use shared daily log file
            if cls._global_logger is None:
                log_dir = Path(cls._config.log_dir)
                log_dir.mkdir(parents=True, exist_ok=True)
                
                log_file = log_dir / f"performance_{datetime.now().strftime('%Y%m%d')}.log"
                
                cls._global_logger = logging.getLogger("qvd_perf.global")
                cls._global_logger.setLevel(logging.DEBUG)
                cls._global_logger.handlers = []
                
                file_handler = logging.FileHandler(log_file, mode='a', encoding='utf-8')
                file_handler.setLevel(logging.DEBUG)
                formatter = logging.Formatter(
                    '%(asctime)s.%(msecs)03d | %(message)s',
                    datefmt='%Y-%m-%d %H:%M:%S'
                )
                file_handler.setFormatter(formatter)
                cls._global_logger.addHandler(file_handler)
                cls._global_logger.propagate = False
            
            return cls._global_logger
    
    @classmethod
    def _cleanup_session_logger(cls, session_id: str):
        """Cleanup logger for a completed session."""
        if session_id in cls._session_loggers:
            session_data = cls._session_loggers[session_id]
            session_logger = session_data["logger"]
            
            # Close and remove handlers
            for handler in session_logger.handlers[:]:
                handler.close()
                session_logger.removeHandler(handler)
            
            del cls._session_loggers[session_id]
    
    @classmethod
    def start_session(cls, session_id: str, query: str):
        """Start tracking a new session."""
        if not cls._is_enabled():
            return
        
        cls._session_timings[session_id] = {
            "start_time": time.time(),
            "query": query[:100],
            "phases": {},
            "tools": []
        }
        
        session_logger = cls._get_session_logger(session_id, query)
        if session_logger:
            session_logger.info(f"{'='*80}")
            session_logger.info(f"QUERY: {query}")
            session_logger.info(f"SESSION: {session_id}")
            session_logger.info(f"START TIME: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
            session_logger.info(f"{'='*80}")
    
    @classmethod
    def end_session(cls, session_id: str):
        """End session and log summary."""
        if not cls._is_enabled():
            return
        
        if session_id not in cls._session_timings:
            return
        
        session = cls._session_timings[session_id]
        total_ms = int((time.time() - session["start_time"]) * 1000)
        
        session_logger = cls._get_session_logger(session_id)
        if session_logger and cls._config.include_summary:
            session_logger.info(f"\n{'-'*80}")
            session_logger.info(f"SESSION SUMMARY")
            session_logger.info(f"Total Duration: {total_ms}ms ({total_ms/1000:.2f}s)")
            session_logger.info(f"{'-'*80}")
            
            # Log phase breakdown
            phases = session.get("phases", {})
            if phases:
                session_logger.info("\nPHASE BREAKDOWN:")
                sorted_phases = sorted(phases.items(), key=lambda x: x[1], reverse=True)
                for phase, duration_ms in sorted_phases:
                    pct = (duration_ms / total_ms * 100) if total_ms > 0 else 0
                    bar = "█" * int(pct / 5) + "░" * (20 - int(pct / 5))
                    session_logger.info(f"  {phase:40} | {duration_ms:6}ms | {pct:5.1f}% | {bar}")
            
            # Log tool breakdown
            tools = session.get("tools", [])
            if tools:
                session_logger.info("\nTOOL BREAKDOWN:")
                total_tool_time = sum(t['duration_ms'] for t in tools)
                for tool in tools:
                    status = "✅" if tool.get('success', True) else "❌"
                    pct = (tool['duration_ms'] / total_tool_time * 100) if total_tool_time > 0 else 0
                    session_logger.info(f"  {tool['name']:40} | {tool['duration_ms']:6}ms | {pct:5.1f}% | {status}")
                session_logger.info(f"  {'TOTAL':40} | {total_tool_time:6}ms | 100.0%")
            
            session_logger.info(f"\n{'='*80}")
            session_logger.info(f"END TIME: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
            session_logger.info(f"{'='*80}\n")
        
        # Cleanup
        del cls._session_timings[session_id]
        cls._cleanup_session_logger(session_id)
    
    @classmethod
    def trace(cls, session_id: str, phase: str, message: str, duration_ms: int = None):
        """Log a trace event."""
        if not cls._is_enabled():
            return
        
        session_logger = cls._get_session_logger(session_id)
        if not session_logger:
            return
        
        timestamp = datetime.now().strftime('%H:%M:%S.%f')[:-3]
        
        if duration_ms is not None:
            session_logger.info(f"[{timestamp}] {phase:25} | {duration_ms:6}ms | {message}")
            
            # Accumulate phase timing
            if session_id in cls._session_timings:
                phases = cls._session_timings[session_id].setdefault("phases", {})
                phases[phase] = phases.get(phase, 0) + duration_ms
        else:
            session_logger.info(f"[{timestamp}] {phase:25} |        | {message}")
    
    @classmethod
    def trace_tool(cls, session_id: str, tool_name: str, duration_ms: int, success: bool = True):
        """Log tool execution timing."""
        if not cls._is_enabled():
            return
        
        session_logger = cls._get_session_logger(session_id)
        if not session_logger:
            return
        
        status = "✅" if success else "❌"
        session_logger.info(f"[TOOL] {tool_name:35} | {duration_ms:6}ms | {status}")
        
        if session_id in cls._session_timings:
            cls._session_timings[session_id].setdefault("tools", []).append({
                "name": tool_name,
                "duration_ms": duration_ms,
                "success": success
            })


# Convenience function for timing blocks
class TimingContext:
    """Context manager for timing code blocks."""
    def __init__(self, session_id: str, phase: str, message: str = ""):
        self.session_id = session_id
        self.phase = phase
        self.message = message
        self.start_time = None
    
    def __enter__(self):
        self.start_time = time.time()
        PerformanceTracer.trace(self.session_id, self.phase, f"START: {self.message}")
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        duration_ms = int((time.time() - self.start_time) * 1000)
        status = "DONE" if exc_type is None else f"ERROR: {exc_type.__name__}"
        PerformanceTracer.trace(self.session_id, self.phase, f"{status}: {self.message}", duration_ms)
        return False


# Initialize tracer (lazy - won't create files until first use)
perf_tracer = None  # Will be created on first access


# ============================================================================
# SYSTEM-LEVEL IMPROVEMENTS: Caching, Circuit Breaker, Validation
# ============================================================================

class ToolCache:
    """Simple in-memory cache for tool results to reduce redundant calls."""
    def __init__(self, ttl_seconds: int = 300):
        # Cache stores: (result, timestamp, duration_ms)
        self.cache: Dict[str, Tuple[Any, float, int]] = {}
        self.ttl = ttl_seconds
    
    def get(self, key: str) -> Optional[Tuple[Any, int]]:
        """Get cached result and duration if not expired.
        
        Returns:
            Tuple of (result, duration_ms) or None if not cached/expired
        """
        return None
        if key in self.cache:
            result, timestamp, duration_ms = self.cache[key]
            if time.time() - timestamp < self.ttl:
                logger.info(f"🎯 Cache HIT: {key} (original duration: {duration_ms}ms)")
                return (result, duration_ms)
            else:
                # Expired, remove
                del self.cache[key]
        return None
    
    def set(self, key: str, value: Any, duration_ms: int = 0):
        """Cache a result with current timestamp and execution duration."""
        self.cache[key] = (value, time.time(), duration_ms)
        logger.info(f"💾 Cached: {key} (duration: {duration_ms}ms)")
    
    def clear(self):
        """Clear all cached entries."""
        self.cache.clear()
        logger.info("🗑️  Cache cleared")

class CircuitBreaker:
    """Circuit breaker to temporarily disable failing tools."""
    def __init__(self, failure_threshold: int = 3, timeout_seconds: int = 60):
        self.failures: Dict[str, int] = defaultdict(int)
        self.failure_threshold = failure_threshold
        self.timeout = timeout_seconds
        self.open_until: Dict[str, float] = {}
    
    def can_call(self, tool_name: str) -> bool:
        """Check if tool can be called (circuit not open)."""
        if tool_name in self.open_until:
            if time.time() < self.open_until[tool_name]:
                logger.warning(f"⚠️  Circuit OPEN for {tool_name} (temporarily disabled)")
                return False
            else:
                # Timeout expired, reset
                del self.open_until[tool_name]
                self.failures[tool_name] = 0
        return True
    
    def record_success(self, tool_name: str):
        """Record successful tool call."""
        self.failures[tool_name] = 0
    
    def record_failure(self, tool_name: str):
        """Record failed tool call and open circuit if threshold reached."""
        self.failures[tool_name] += 1
        if self.failures[tool_name] >= self.failure_threshold:
            self.open_until[tool_name] = time.time() + self.timeout
            logger.error(f"🔴 Circuit OPENED for {tool_name} (too many failures)")

# Global instances
tool_cache = ToolCache(ttl_seconds=300)  # 5 minutes cache
circuit_breaker = CircuitBreaker(failure_threshold=3, timeout_seconds=60)

def execute_tool_call_with_recovery(
    tool_name: str,
    tool_args: dict,
    stream_callback: callable = None,
    dataframe_service: DataFrameService = None,
    chart_callback: callable = None,
    session_id: str = None,
) -> Tuple[str, int]:
    """
    Execute a tool call with circuit breaker, caching, and error recovery.
    
    Args:
        tool_name: Name of the tool to execute
        tool_args: Arguments for the tool
        stream_callback: Optional callback for streaming tool output
        dataframe_service: DataFrameService instance for pandas operations
        chart_callback: Optional callback for spawning chart generation
        session_id: Optional session ID for performance tracing
    
    Returns:
        Tuple of (tool result as JSON string, duration_ms)
    """
    trace_session = session_id or "unknown"
    
    # Check circuit breaker
    if not circuit_breaker.can_call(tool_name):
        PerformanceTracer.trace(trace_session, "TOOL_CIRCUIT_BREAKER", f"{tool_name} blocked by circuit breaker")
        error_result = json.dumps({
            "success": False,
            "error": "Tool temporarily unavailable",
            "error_type": "CircuitBreakerOpen",
            "message": f"{tool_name} est temporairement indisponible. Réessayez dans quelques instants."
        })
        return (error_result, 0)
    
    # Create cache key (tool + args)
    cache_key = f"{tool_name}:{json.dumps(tool_args, sort_keys=True)}"
    
    # Check cache
    cache_check_start = time.time()
    cached_data = tool_cache.get(cache_key)
    cache_check_ms = int((time.time() - cache_check_start) * 1000)
    
    if cached_data:
        cached_result, cached_duration_ms = cached_data
        circuit_breaker.record_success(tool_name)
        PerformanceTracer.trace(trace_session, "TOOL_CACHE_HIT", f"{tool_name} (cached: {cached_duration_ms}ms)", cache_check_ms)
        if stream_callback and tool_name == "openai_web_search":
            stream_callback(cached_data)
        return (cached_result, cached_duration_ms)
    
    # Execute tool
    try:
        # Track execution timing
        start_time = time.time()
        PerformanceTracer.trace(trace_session, "TOOL_EXEC_START", f"{tool_name} args={str(tool_args)[:100]}")

        # NOTE: Do NOT stream tool-call metadata to the client UI.
        # Tools are internal; only assistant text chunks should be streamed.
        
        # Execute the tool
        result = execute_tool_call(
            tool_name,
            tool_args,
            stream_callback=stream_callback,
            dataframe_service=dataframe_service,
            chart_callback=chart_callback,
        )

        # Calculate execution duration in milliseconds
        execution_duration_ms = int((time.time() - start_time) * 1000)
        
        # Log timing for diagnostics
        logger.info(f"⏱️  Tool {tool_name} executed in {execution_duration_ms}ms")
        PerformanceTracer.trace_tool(trace_session, tool_name, execution_duration_ms, success=True)
        
        # Cache successful result (only for read operations, not create/update/delete)
        if not tool_name.startswith(('create_', 'update_', 'delete_')):
            tool_cache.set(cache_key, result, duration_ms=execution_duration_ms)
        
        circuit_breaker.record_success(tool_name)
        return (result, execution_duration_ms)
        
    except Exception as e:
        execution_duration_ms = int((time.time() - start_time) * 1000)
        circuit_breaker.record_failure(tool_name)
        logger.error(f"Tool {tool_name} failed: {e}", exc_info=True)
        PerformanceTracer.trace_tool(trace_session, tool_name, execution_duration_ms, success=False)
        
        # Return structured error
        error_result = json.dumps({
            "success": False,
            "error": str(e),
            "error_type": type(e).__name__,
            "message": f"Erreur lors de l'exécution de {tool_name}: {str(e)}",
        })
        return (error_result, 0)

# Import conversation history retrieval
get_recent_conversations = None

# Global execution logger - will be initialized when first workflow is created
execution_logger = None
execution_log_file = None





def load_system_prompt() -> str:
    """Load the chat prompt from markdown file."""
    prompt_path = Path(__file__).parent.parent / "prompts" / "system_prompt.md"
    try:
        with open(prompt_path, 'r', encoding='utf-8') as f:
            content = f.read()
        logger.info(f"Loaded chat prompt from {prompt_path}")
        return content
    except Exception as e:
        logger.error(f"Failed to load chat prompt: {e}")
        return ""

def format_tools_for_openai(tools: list) -> list:
    """
    Format tools for OpenAI/vLLM function calling.
    
    Args:
        tools: List of tool definitions (each with name, description, parameters)
        
    Returns:
        List of cleaned function definitions for call_llm_with_tools
    """
    if not tools:
        return []
    
    formatted_tools = []
    
    for tool_def in tools:
        if not isinstance(tool_def, dict):
            logger.warning(f"Skipping invalid tool definition: {tool_def}")
            continue
        
        tool_name = tool_def.get("name")
        if not tool_name or not isinstance(tool_name, str):
            logger.warning(f"Skipping tool with invalid name: {tool_def}")
            continue

        cleaned_params = clean_parameters_for_openai(tool_def.get("parameters", {}))
        
        # Build the function definition
        function_def = {
            "name": str(tool_name),
            "description": str(tool_def.get("description", "")),
            "parameters": cleaned_params
        }
        
        formatted_tools.append(function_def)
    
    logger.info(f"Formatted {len(formatted_tools)} tools for OpenAI")
    return formatted_tools


def load_tools() -> list:
    """Load the statement tools descriptions from JSON file."""
    tools_path = Path(__file__).parent.parent / "prompts" / "tools" / "statement_tools.json"
    try:
        with open(tools_path, 'r', encoding='utf-8') as f:
            tools = json.load(f)
        
        # Handle both list format (new) and dict format (legacy)
        if isinstance(tools, dict):
            # Convert dict format to list format
            tools_list = []
            for tool_name, tool_def in tools.items():
                tool_def["name"] = tool_name
                tools_list.append(tool_def)
            tools = tools_list
        
        logger.info(f"Loaded {len(tools)} statement tool descriptions")
        return tools
    except Exception as e:
        logger.error(f"Failed to load statement tools descriptions: {e}")
        return []

def load_skills_descriptions() -> str:
    """
    Load all SKILL.md files from the skills directory and return a formatted summary string.
    
    Searches for all SKILL.md files in lumo/prompts/skills/ and subdirectories,
    parses the YAML frontmatter, and extracts only the name and description fields.
    
    Returns:
        Formatted string with skill summaries for injection into system prompt:
        ```
        - rag: Description of RAG skill
        - client_identification: Description of client identification skill
        
        Pour obtenir les instructions détaillées d'une compétence, appeler read_skill(skill_name).
        ```
    """
    skills_summary = build_skills_summary()
    if not skills_summary:
        return ""

    return f"""## COMPÉTENCES DISPONIBLES

        {skills_summary}

      
        **TU DOIS OBLIGATOIREMENT** :
        1. Lire attentivement le champ `_skill_instructions` dans le résultat de l'outil
        2. Suivre EXACTEMENT les règles de formatage décrites (tableaux, colonnes, devises, etc.)
        3. Ne JAMAIS ignorer ces instructions

        """


# Prompts and tools are loaded dynamically in ChatAgent.__init__ and nodes
# to ensure runtime changes are reflected immediately


def format_conversation_history(conversation_history: List[Dict[str, Any]], max_conversations: int = 3) -> str:
    """
    Format conversation history for inclusion in the prompt.
    Optimized to reduce context size and processing time.
    
    Args:
        conversations: List of conversation dictionaries from get_recent_conversations
        max_conversations: Maximum number of conversations to include (default: 3, optimized)
    
    Returns:
        Formatted string with conversation history
    """

    if not conversation_history:
        return "No previous conversation."
    
    formatted = []
    for msg in conversation_history:
        role = msg['role'].capitalize()
        content = msg['content'][:500]  # Truncate if very long
        formatted.append(f"{role}: {content}")
    
    return "\n".join(formatted)


def retrieve_conversation_history(user_id: Optional[str] = None, limit: int = 3) -> List[Dict[str, Any]]:
    """
    Retrieve recent conversation history for a user.
    
    Args:
        user_id: User ID to retrieve conversations for (optional)
        limit: Maximum number of conversations to retrieve (default: 5)
    
    Returns:
        List of conversation dictionaries
    """
    if not get_recent_conversations:
        logger.warning("get_recent_conversations not available, skipping conversation history")
        return []
    
    if not user_id:
        logger.debug("No user_id provided, skipping conversation history")
        return []
    
    try:
        result = get_recent_conversations(user_id=user_id, limit=limit, offset=0)
        
        if result.get("success") and result.get("data"):
            conversations = result["data"]
            logger.info(f"Retrieved {len(conversations)} previous conversations for user {user_id}")
            return conversations
        else:
            logger.debug(f"No conversation history found for user {user_id}")
            return []
    except Exception as e:
        logger.error(f"Error retrieving conversation history: {e}", exc_info=True)
        return []


def sanitize_chat_history(msgs: List[Dict]) -> List[Dict]:
        """Return a JSON-serializable chat history (drops unknown fields)."""
        sanitized: List[Dict] = []
        for m in msgs or []:
            role = m.get("role")
            if role == "system":
                sanitized.append({"role": "system", "content": m.get("content", "")})
            elif role == "user":
                sanitized.append({"role": "user", "content": m.get("content", "")})
            elif role == "assistant":
                entry = {"role": "assistant", "content": m.get("content")}
                # Keep tool call metadata if present (JSON-serializable dicts only)
                if isinstance(m.get("tool_calls"), list):
                    entry["tool_calls"] = m.get("tool_calls")
                sanitized.append(entry)
            elif role == "tool":
                sanitized.append({
                    "role": "tool",
                    "tool_call_id": m.get("tool_call_id"),
                    "content": m.get("content", "")
                })
            else:
                # Unknown role: keep minimal
                sanitized.append({"role": role, "content": m.get("content")})
        return sanitized


def setup_execution_logger():
    """Setup the execution chronology logger."""
    global execution_logger, execution_log_file
    
    if execution_logger is not None:
        return execution_logger
    
    # Create execution chronology logger
    execution_logger = logging.getLogger("servia_services.chat_agent_execution")
    execution_logger.setLevel(logging.INFO)
    
    # Create logs directory if it doesn't exist
    logs_dir = Path("workflow_logs")
    logs_dir.mkdir(exist_ok=True)
    
    # Setup execution chronology file handler
    execution_log_file = logs_dir / f"chat_agent_execution_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"
    execution_handler = logging.FileHandler(execution_log_file, encoding='utf-8')
    execution_handler.setLevel(logging.INFO)
    
    # Create a detailed formatter for execution logging
    execution_formatter = logging.Formatter(
        '%(asctime)s.%(msecs)03d | %(levelname)s | STEP: %(step_id)s | PHASE: %(phase)s | %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )
    execution_handler.setFormatter(execution_formatter)
    execution_logger.addHandler(execution_handler)
    
    # Prevent propagation to avoid duplicate logs
    execution_logger.propagate = False
    
    print(f"📝 Chat agent execution log: {execution_log_file}")
    return execution_logger
# =============================================================================
# RECURSIVE TOOL CALLING ENGINE
# =============================================================================

# Maximum recursion depth to prevent infinite loops
MAX_TOOL_RECURSION_DEPTH = 10


STANDARD_TOOLS = (load_tools())

async def _execute_single_tool(
    tool_call: Dict, 
    iteration: int,
    tool_stream_callback: callable = None,
    dataframe_service: DataFrameService = None,
    chart_callback: callable = None,
    session_id: str = None,
) -> Dict:
    """
    Execute a single tool call and return structured result.
    
    Args:
        tool_call: Tool call dictionary from LLM
        iteration: Current iteration number for ID generation
        tool_stream_callback: Optional callback for streaming tool execution status
        dataframe_service: DataFrameService instance for pandas operations
        chart_callback: Optional callback for spawning chart generation
        session_id: Optional session ID for performance tracing
        
    Returns:
        Dictionary with tool execution results
    """
    trace_session = session_id or "unknown"
    
    # Support both dict tool calls and OpenAI ChatCompletionMessageFunctionToolCall objects
    if hasattr(tool_call, "function"):
        raw_function_name = tool_call.function.name
        arguments = tool_call.function.arguments
    else:
        raw_function_name = tool_call["function"]["name"]
        arguments = tool_call["function"]["arguments"]

    # Validate minimal arguments to avoid empty / malformed calls
    if not raw_function_name:
        logger.warning("Skipping tool call with empty function name")
        return _create_error_result(tool_call, "", arguments, "empty function name")

    # For grep / cat, ensure file_path is provided and only allow SKILL.md files
    if raw_function_name in ("grep", "cat"):
        validation_error = _validate_file_tool_call(raw_function_name, arguments)
        if validation_error:
            return _create_error_result(tool_call, raw_function_name, arguments, validation_error)

    # Sanitize tool name (remove channel tokens from vLLM models)
    function_name = raw_function_name.split('<|channel|>')[0]
    
    if function_name != raw_function_name:
        logger.warning(f"Sanitized tool name: '{raw_function_name}' -> '{function_name}'")
    
    logger.info(f"🔧 Executing tool: {function_name}")
    logger.debug(f"   Arguments: {arguments}")
    
    PerformanceTracer.trace(trace_session, "SINGLE_TOOL_START", f"{function_name} iteration={iteration}")

    # Execute the tool with recovery and timing (run in thread pool to avoid blocking)
    tool_start = time.time()
    result, tool_exec_duration_ms = await asyncio.to_thread(
        execute_tool_call_with_recovery, 
        function_name, 
        arguments,
        tool_stream_callback,
        dataframe_service,
        chart_callback,
        session_id,
    )
    actual_duration = int((time.time() - tool_start) * 1000)
    logger.info(f"⏱️  Tool execution: {function_name} | {actual_duration}ms")
    PerformanceTracer.trace(trace_session, "SINGLE_TOOL_END", f"{function_name} completed", actual_duration)
    
    # Parse result
    try:
        result_parsed = json.loads(result) if isinstance(result, str) else result
    except json.JSONDecodeError:
        result_parsed = {"raw_result": result}
    
    logger.info(f"✅ Tool {function_name} completed")
    
    # Stream completion feedback to user
    if tool_stream_callback and callable(tool_stream_callback):
        try:
            # Map tool names to completion messages
            completion_messages = {
                "search_columns_embeddings": "✅ Recherche terminée",
                "generate_pandas_code": "✅ Analyse terminée",
                "read_skill": "✅ Compétences chargées"
            }
            msg = completion_messages.get(function_name)
            if msg:
                # Check if there was an error
                if result_parsed.get("status") == "error":
                    msg = f"⚠️ {function_name}: {result_parsed.get('error', 'Erreur')[:50]}"
                tool_stream_callback(f"{msg}\n")
        except Exception as e:
            logger.error(f"Error streaming tool completion: {e}")
    
    # Get tool call ID
    tool_call_id = _get_tool_call_id(tool_call, iteration, function_name)
    
    return {
        "tool_call": tool_call,
        "tool_call_id": tool_call_id,
        "function_name": function_name,
        "arguments": arguments,
        "result": result,
        "result_parsed": result_parsed,
        "duration_ms": tool_exec_duration_ms
    }


def _create_error_result(tool_call: Dict, function_name: str, arguments: Any, error_msg: str) -> Dict:
    """Create a standardized error result for tool execution failures."""
    return {
        "tool_call": tool_call,
        "tool_call_id": None,
        "function_name": function_name,
        "arguments": arguments,
        "result": json.dumps({"error": error_msg}),
        "result_parsed": {"error": error_msg},
        "duration_ms": 0
    }


def _validate_file_tool_call(function_name: str, arguments: Any) -> Optional[str]:
    """Validate file-based tool calls (grep/cat). Returns error message or None."""
    try:
        arg_dict = json.loads(arguments) if isinstance(arguments, str) else arguments
    except Exception:
        arg_dict = {}
    
    file_path = arg_dict.get("file_path") if isinstance(arg_dict, dict) else None
    
    if not file_path:
        logger.warning(f"Skipping {function_name} call without file_path")
        return "file_path required"
    
    if not file_path.endswith("SKILL.md"):
        logger.warning(f"Skipping {function_name} call - only SKILL.md files are allowed, got: {file_path}")
        return f"Only SKILL.md files are allowed, got: {file_path}"
    
    return None


def _get_tool_call_id(tool_call: Dict, iteration: int, function_name: str) -> str:
    """Extract or generate tool call ID."""
    if isinstance(tool_call, dict):
        tool_call_id = tool_call.get("id")
    else:
        tool_call_id = getattr(tool_call, "id", None)
    
    if tool_call_id is None:
        tool_call_id = f"call_{iteration}_{function_name}"
    
    return tool_call_id



async def _execute_tools_parallel(
    tool_calls: List[Dict],
    iteration: int,
    tool_stream_callback: callable = None,
    dataframe_service: DataFrameService = None,
    chart_callback: callable = None,
    session_id: str = None,
) -> List[Dict]:
    """
    Execute a batch of tool calls IN PARALLEL.
    
    Args:
        tool_calls: List of tool call dictionaries from LLM
        iteration: Current iteration number
        tool_stream_callback: Optional callback for streaming
        dataframe_service: DataFrameService instance for pandas operations
        chart_callback: Optional callback for spawning chart generation
        session_id: Optional session ID for performance tracing
        
    Returns:
        List of tool execution results
    """
    trace_session = session_id or "unknown"
    
    if not tool_calls:
        return []
    
    tool_names = [tc.function.name if hasattr(tc, "function") else tc.get("function", {}).get("name", "?") for tc in tool_calls]
    logger.info(f"🚀 Executing {len(tool_calls)} tool(s) in PARALLEL...")
    PerformanceTracer.trace(trace_session, "PARALLEL_EXEC_START", f"tools={tool_names}")
    
    parallel_start = time.time()
    
    results = await asyncio.gather(
        *[
            _execute_single_tool(tc, iteration, tool_stream_callback, dataframe_service, chart_callback, session_id)
            for tc in tool_calls
        ],
        return_exceptions=True
    )
    
    parallel_duration = int((time.time() - parallel_start) * 1000)
    logger.info(f"⏱️  Parallel execution completed in {parallel_duration}ms")
    PerformanceTracer.trace(trace_session, "PARALLEL_EXEC_END", f"{len(tool_calls)} tools completed", parallel_duration)
    
    # Filter out exceptions and log them
    valid_results = []
    for result in results:
        if isinstance(result, Exception):
            logger.error(f"❌ Tool execution failed with exception: {result}", exc_info=result)
        else:
            valid_results.append(result)
    
    return valid_results


def _update_conversation_context(
    messages: List[Dict],
    tool_results: List[Dict],
    tool_calls_made: List[Dict],
    execution_results: List[Dict],
    assistant_message: Optional[str] = None,
    llm_execution_duration_ms: Optional[int] = None
) -> None:
    """
    Update conversation context with tool execution results.
    
    Modifies messages, tool_results, and tool_calls_made in-place.
    """
    # Preserve the LLM assistant message for this turn (even when it also requested tools).
    # This keeps the conversational text in history for downstream consumers (API/UI/logging).
    if assistant_message:
        msg: Dict[str, Any] = {"role": "assistant", "content": assistant_message}
        if isinstance(llm_execution_duration_ms, (int, float)):
            msg["execution_duration_ms"] = int(llm_execution_duration_ms)
        messages.append(msg)

    for exec_result in execution_results:
        tool_call_id = exec_result["tool_call_id"]
        function_name = exec_result["function_name"]
        arguments = exec_result["arguments"]
        result_parsed = exec_result["result_parsed"]
        tool_exec_duration_ms = exec_result["duration_ms"]
        
        # Track this tool call
        tool_calls_made.append({
            "tool": function_name,
            "args": arguments,
            "duration_ms": tool_exec_duration_ms,
            "node": "PredictionNode"
        })
        
        tool_results.append({
            "tool": function_name,
            "result": result_parsed
        })
        
        # Add assistant message with tool call
        messages.append({
            "role": "assistant",
            "content": None,
            "tool_calls": [{
                "id": tool_call_id,
                "type": "function",
                "function": {
                    "name": function_name,
                    "arguments": arguments if isinstance(arguments, str) else json.dumps(arguments)
                }
            }]
        })
        
        # Add tool response message
        messages.append({
            "role": "tool",
            "tool_call_id": tool_call_id,
            "content": json.dumps(result_parsed, ensure_ascii=False)
        })


async def execute_tool_calling_loop(
    messages: List[Dict],
    max_iterations: int = MAX_TOOL_RECURSION_DEPTH,
    tools: List[Dict] = None,
    stream: bool = False,
    tool_stream_callback: callable = None,
    user_message: str = None,
    conversation_history: List[Dict] = None,
    dataframe_service: DataFrameService = None,
    chart_callback: callable = None,
    session_id: str = None,

) -> Dict[str, List]:
    """
    Execute recursive tool calling loop with LLM until no more tools are requested.
    
    This function recursively calls the LLM and executes tools until:
    - The LLM returns no tool calls (natural termination)
    - Maximum recursion depth is reached (safety limit)
    
    Args:
        messages: List of message dictionaries for LLM conversation
        max_iterations: Maximum recursion depth (safety limit)
        tool_stream_callback: Optional callback for streaming tool execution status
        dataframe_service: DataFrameService instance for pandas operations
        chart_callback: Optional callback for spawning chart generation
        session_id: Optional session ID for performance tracing
        
    Returns:
        Dictionary with 'tool_results' and 'tool_calls_made' lists
    """
    trace_session = session_id or "unknown"
    tool_results: List[Dict] = []
    tool_calls_made: List[Dict] = []
    
    loop_start = time.time()
    PerformanceTracer.trace(trace_session, "TOOL_LOOP_START", f"max_iterations={max_iterations}")
    
    async def recurse(depth: int = 0) -> None:
        """Inner recursive function for tool execution."""
        nonlocal tool_results, tool_calls_made
        
        # Safety check: prevent infinite recursion
        if depth >= max_iterations:
            logger.warning(f"⚠️  Maximum tool recursion depth ({max_iterations}) reached, stopping")
            PerformanceTracer.trace(trace_session, "TOOL_LOOP_MAX_DEPTH", f"stopped at depth={depth}")
            return
        
        
        iteration_start = time.time()
        logger.info(f"🔄 Tool calling iteration {depth + 1} (max: {max_iterations})")
        PerformanceTracer.trace(trace_session, f"ITERATION_{depth+1}_START", f"depth={depth}")
        
        try:
            # Optimize: Limit messages context (keep system + last 8 messages)
            msg_optimize_start = time.time()
            if len(messages) > 10:
                optimized_messages = [messages[0]] + messages[-8:]
            else:
                optimized_messages = messages
            msg_optimize_ms = int((time.time() - msg_optimize_start) * 1000)
            PerformanceTracer.trace(trace_session, "MSG_OPTIMIZATION", f"msgs={len(messages)} -> {len(optimized_messages)}", msg_optimize_ms)
            
            
            # Call LLM with tools.
            #
            # Stream directly to the user for better UX (immediate first token).
            # Tool calls will be executed after the LLM finishes generating.
            llm_call_start = time.time()
            PerformanceTracer.trace(trace_session, "LLM_CALL_START", f"iteration={depth+1}, tools={len(tools) if tools else 0}")

            # Track if we've added a separator before the final response
            first_chunk_sent = False
            
            def _direct_stream_callback(chunk_text: str) -> None:
                """Stream chunks directly to the user callback for immediate feedback."""
                nonlocal first_chunk_sent
                if isinstance(chunk_text, str) and chunk_text and tool_stream_callback and callable(tool_stream_callback):
                    try:
                        # Add newline separator before first chunk if tools have executed (depth > 0)
                        if not first_chunk_sent and depth > 0:
                            tool_stream_callback("\n")
                            first_chunk_sent = True
                        tool_stream_callback(chunk_text)
                    except Exception as e:
                        logger.error(f"Error streaming chunk to callback: {e}")

            response = call_llm_with_tools(
                messages=optimized_messages,
                tools=tools,
                tool_choice="auto",
                stream=stream,
                stream_callback=_direct_stream_callback
            )
            
            llm_call_duration_ms = int((time.time() - llm_call_start) * 1000)
            logger.info(f"⏱️  LLM call (iteration {depth + 1}): {llm_call_duration_ms}ms")
            PerformanceTracer.trace(trace_session, "LLM_CALL_END", f"iteration={depth+1}", llm_call_duration_ms)
            
            # Check for tool calls (treat missing/None/empty as termination)
            if not isinstance(response, dict):
                logger.warning("⚠️  LLM response is not a dict; stopping tool recursion")
                PerformanceTracer.trace(trace_session, "LLM_INVALID_RESPONSE", "response is not a dict")
                return

            assistant_message = response.get("message") or ""
            tool_calls = response.get("tool_calls") or []
            llm_exec_ms = response.get("execution_duration")
            
            # Base case: no tool calls => stop recursion (chunks already streamed).
            if not tool_calls:

                if assistant_message:
                    _update_conversation_context(
                        messages=messages,
                        tool_results=tool_results,
                        tool_calls_made=tool_calls_made,
                        execution_results=[],
                        assistant_message=assistant_message,
                        llm_execution_duration_ms=llm_exec_ms,
                    )
                iteration_duration_ms = int((time.time() - iteration_start) * 1000)
                logger.info(f"✅ No more tool calls, recursion complete after {depth + 1} iteration(s)")
                PerformanceTracer.trace(trace_session, f"ITERATION_{depth+1}_END", f"no tool calls, final response len={len(assistant_message)}", iteration_duration_ms)
                return

            logger.info(f"✅ Tool calls found, executing {len(tool_calls)} tool(s)")
            tool_names = [tc.function.name if hasattr(tc, "function") else tc.get("function", {}).get("name", "?") for tc in tool_calls]
            PerformanceTracer.trace(trace_session, "TOOL_CALLS_FOUND", f"tools={tool_names}")

            # Show progress message with tool names (only on first iteration to avoid spam)
            if tool_stream_callback and callable(tool_stream_callback) and depth == 0:
                try:
                    # Map tool names to user-friendly descriptions
                    tool_descriptions = {
                        "search_columns_embeddings": "🔍 Recherche sémantique dans les données...",
                        "generate_pandas_code": "⚙️ Génération du code d'analyse...",
                        "read_skill": "📖 Chargement des compétences..."
                    }
                    
                    # Show progress for each tool
                    for name in tool_names:
                        desc = tool_descriptions.get(name, f"⏳ Exécution de {name}...")
                        tool_stream_callback(f"\n{desc}\n")
                except Exception as e:
                    logger.error(f"Error streaming tool execution status: {e}")

            # Execute all tool calls in parallel
            tool_exec_start = time.time()
            execution_results = await _execute_tools_parallel(
                tool_calls=tool_calls,
                iteration=depth,
                tool_stream_callback=tool_stream_callback,
                dataframe_service=dataframe_service,
                chart_callback=chart_callback,
                session_id=session_id,
            )
            tool_exec_duration_ms = int((time.time() - tool_exec_start) * 1000)
            PerformanceTracer.trace(trace_session, "TOOLS_EXECUTED", f"{len(tool_calls)} tools completed", tool_exec_duration_ms)
            
            # Update conversation context with results
            context_update_start = time.time()
            _update_conversation_context(
                messages=messages,
                tool_results=tool_results,
                tool_calls_made=tool_calls_made,
                execution_results=execution_results,
                # Do NOT append the LLM's pre-tool message (can contain placeholders)
                assistant_message=None,
                llm_execution_duration_ms=None,
            )
            context_update_ms = int((time.time() - context_update_start) * 1000)
            PerformanceTracer.trace(trace_session, "CONTEXT_UPDATE", f"results={len(execution_results)}", context_update_ms)
            
            iteration_duration_ms = int((time.time() - iteration_start) * 1000)
            logger.info(f"⏱️  Iteration {depth + 1} completed in {iteration_duration_ms}ms")
            PerformanceTracer.trace(trace_session, f"ITERATION_{depth+1}_END", f"tools executed, continuing", iteration_duration_ms)
            
            # Recursive call: continue until LLM stops requesting tools
            await recurse(depth + 1)
            
        except Exception as e:
            logger.error(f"Error in tool calling iteration {depth + 1}: {e}", exc_info=True)
            PerformanceTracer.trace(trace_session, f"ITERATION_{depth+1}_ERROR", str(e))
            # Don't re-raise, allow partial results to be returned
    
    # Start recursion
    await recurse()
    
    loop_duration_ms = int((time.time() - loop_start) * 1000)
    PerformanceTracer.trace(trace_session, "TOOL_LOOP_END", f"total_tools={len(tool_calls_made)}", loop_duration_ms)
    
    return {
        "tool_results": tool_results,
        "tool_calls_made": tool_calls_made
    }


class FinanceAgent:
    """
    Finance Agent class that manages the workflow for finance operations.
    Follows the 4 mandatory steps for Finance assistance.
    """
    
    def __init__(self, session_id: str, dataframe_service: DataFrameService = None, conversation_history: List[Dict] = None, authorization_token: str = None, tool_stream_callback: callable = None, chart_callback: callable = None):
        """
        Initialize QvdAgent.
        Loads prompts and tools fresh to capture any runtime changes.
        
        Args:
            session_id: Session identifier
            dataframe_service: DataFrameService instance for QVD processing
            conversation_history: Optional conversation history
            authorization_token: Optional authorization token
            tool_stream_callback: Optional callback for streaming tool output
            chart_callback: Optional callback for spawning chart generation
        """
        self.flow = None
        self.session_id = session_id
        self.dataframe_service = dataframe_service
        self.columns_descriptions = dataframe_service.get_columns_descriptions()
        self.conversation_history = conversation_history
        self.authorization_token = authorization_token
        self.tool_stream_callback = tool_stream_callback
        self.chart_callback = chart_callback

        logger.info(f"QvdAgent initialized with {self.dataframe_service}")

 
    async def run(self, shared):
        """Run the chat agent async workflow."""
        if not self.flow:
            logger.error("ChatAgent workflow not created")
            return
        
        # Track overall workflow execution time
        workflow_start_time = time.time()
        shared["conversation_history"] = self.conversation_history if self.conversation_history else []
        shared["session_id"] = self.session_id  # Pass session_id for tracing
        
        # Start performance tracing session
        user_query = shared.get("user_message", "")
        PerformanceTracer.start_session(self.session_id, user_query)
        PerformanceTracer.trace(self.session_id, "WORKFLOW_START", f"starting async flow")
      
        await self.flow.run_async(shared=shared)
        
        workflow_duration_ms = int((time.time() - workflow_start_time) * 1000)
        PerformanceTracer.trace(self.session_id, "WORKFLOW_END", f"async flow completed", workflow_duration_ms)
        
        # Log to evaluation manager
        logger.info("📊 Starting evaluation logging...")
        try:
            tool_used = shared.get("tool_used", [])
            tool_results = shared.get("tool_results", [])

            conversation_history = shared.get("conversation_history", [])
            self.conversation_history = conversation_history
            conversation_history = conversation_history[-2:]

           
            logger.info("✅ Evaluation logging completed")
        except Exception as e:
            # Log errors at info level so we can see what's happening
            logger.error(f"❌ Could not log to evaluation manager: {e}", exc_info=True)
        
        # End performance tracing session with summary
        PerformanceTracer.end_session(self.session_id)



if __name__ == "__main__":
    import sys
    from pathlib import Path
    
    # Setup DataFrameService instance
    from services.dataframe_services import DataFrameService
  
    # Initialize DataFrameService instance
    print("\n1. Initializing DataFrameService instance...")
    dataframe_service = DataFrameService()
    if len(sys.argv) < 3:
        print("Usage: python finance_agent.py <parquet_path> <columns_cache_path>")
        sys.exit(1)
    parquet_path = Path(sys.argv[1])
    columns_cache_path = Path(sys.argv[2])
    dataframe_service.load_dataframe_from_parquet(str(parquet_path))
    dataframe_service.load_columns_classes_from_parquet(str(columns_cache_path))
    print("   ✓ DataFrameService instance loaded")
    
    
    # Initialize agent with DataFrameService instance and tool_stream_callback
    print("\n2. Initializing QvdAgent...")
    tool_stream_callback = lambda x: print(x, end="", flush=True)
    agent = QvdAgent(
        session_id="test_session_1234567890",
        dataframe_service=dataframe_service,
        tool_stream_callback=tool_stream_callback
    )
    
    # Create workflow
    print("3. Creating workflow...")
    flow = agent.create_workflow(session_id="test_session_1234567890", max_tool_passes=10)
    print("   ✓ Workflow created")
    
    shared = {} 
    shared["user_message"] = "Le Coût du Risque représente quel pourcentage du Produit Net Bancaire ? Cette proportion est-elle conforme aux normes prudentielles et aux standards du secteur bancaire ?"   

    try:
        run_async_safely(agent.run(shared))
        print(f"\nResponse: {shared.get('final_response', 'No response')[:500]}")
    except Exception as e:
        print(f"\nError: {e}")
        import traceback
        traceback.print_exc()
    
  
