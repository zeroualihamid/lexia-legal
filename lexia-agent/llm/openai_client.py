# llm/openai_client.py

"""
OpenAI Client
Implementation of BaseLLM for OpenAI's GPT models
"""

from typing import Optional, Iterator, Dict, Any, List, Callable
import os
import time
import functools

from llm.base_llm import BaseLLM, LLMResponse, LLMConfig, ToolDefinition, ToolCall
from monitoring.logger import get_logger

logger = get_logger(__name__)

# Models that require max_completion_tokens instead of max_tokens
# and only support default temperature
_NEW_MODEL_PREFIXES = ("gpt-5", "o1", "o3", "o4")

# Pricing per 1M tokens (USD) — update as models/pricing change
_PRICING: Dict[str, Dict[str, float]] = {
    "gpt-5":         {"input": 10.00, "output": 30.00},
    "gpt-4o":        {"input":  2.50, "output": 10.00},
    "gpt-4o-mini":   {"input":  0.15, "output":  0.60},
    "gpt-4-turbo":   {"input": 10.00, "output": 30.00},
    "gpt-4":         {"input": 30.00, "output": 60.00},
    "gpt-3.5-turbo": {"input":  0.50, "output":  1.50},
    "o1":            {"input": 15.00, "output": 60.00},
    "o3":            {"input": 10.00, "output": 40.00},
    "o4-mini":       {"input":  1.10, "output":  4.40},
}

_DEFAULT_PRICING = _PRICING["gpt-4o"]

# Type alias for stream callbacks: receives each text chunk as it arrives
StreamCallback = Callable[[str], None]

# Built-in callback that prints chunks to stdout in real time
console_callback: StreamCallback = lambda x: print(x, end="", flush=True)

# Passthrough kwargs forwarded directly to the API
_PASSTHROUGH_KEYS = frozenset({"top_p", "frequency_penalty", "presence_penalty"})

# Retryable parameter-mismatch patterns
_RETRY_RULES = (
    # (error substring pairs, kwarg to pop, kwarg to set via popped value)
    (
        ("Unsupported parameter: 'max_tokens'", "unsupported_parameter", "'max_tokens'"),
        "max_tokens",
        "max_completion_tokens",
    ),
    (
        ("Unsupported value: 'temperature'", "unsupported_value", "'temperature'"),
        "temperature",
        None,  # just remove it
    ),
)


@functools.lru_cache(maxsize=4)
def _get_tiktoken_encoding(model: str):
    """Return a cached tiktoken encoding for the given model."""
    import tiktoken

    for prefix in ("gpt-4", "gpt-3.5"):
        if prefix in model:
            return tiktoken.encoding_for_model(f"{prefix}-turbo" if prefix == "gpt-3.5" else prefix)
    return tiktoken.get_encoding("cl100k_base")


class OpenAIClient(BaseLLM):
    """
    OpenAI GPT LLM Client

    Supports GPT-5, GPT-4, GPT-3.5, o-series, and other OpenAI models.

    Example:
        config = LLMConfig(
            provider='openai',
            model='gpt-4',
            api_key=os.getenv('OPENAI_API_KEY')
        )
        client = OpenAIClient(config)
        response = client.generate("Explain quantum computing")
        print(response.content)
    """

    def __init__(self, config: LLMConfig):
        super().__init__(config)
        self._is_new_model = (self.config.model or "").lower().startswith(_NEW_MODEL_PREFIXES)
        self.client = self._initialize_client()

    # ------------------------------------------------------------------
    # Initialization
    # ------------------------------------------------------------------

    def _initialize_client(self):
        """Initialize OpenAI SDK client."""
        try:
            from openai import OpenAI
        except ImportError:
            self.logger.error("OpenAI SDK not installed. Install with: pip install openai")
            raise

        api_key = self.config.api_key or os.getenv("OPENAI_API_KEY") or "dummy"
        base_url = getattr(self.config, "base_url", None)
        timeout = getattr(self.config, "timeout", 180)
        max_retries = getattr(self.config, "max_retries", 3)
        kwargs = {"api_key": api_key, "timeout": timeout, "max_retries": max_retries}
        if base_url:
            # OpenAI-compatible servers (e.g. vLLM) expect /v1/chat/completions; default OpenAI base is .../v1
            base_url = base_url.rstrip("/")
            if not base_url.endswith("/v1"):
                base_url = f"{base_url}/v1"
            kwargs["base_url"] = base_url
        self.logger.info("OpenAI client initialized" + (f" (base_url={base_url})" if base_url else ""))
        return OpenAI(**kwargs)

    # ------------------------------------------------------------------
    # Request building & execution
    # ------------------------------------------------------------------

    def _build_api_kwargs(
        self,
        messages: List[Dict[str, str]],
        stream: bool = False,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        """Build chat.completions kwargs with token-parameter compatibility."""
        token_limit = kwargs.get("max_tokens", self.config.max_tokens)
        temperature = kwargs.get("temperature", self.config.temperature)

        api_kwargs: Dict[str, Any] = {"model": self.config.model, "messages": messages}

        # Temperature handling
        if self._is_new_model:
            if "temperature" in kwargs and kwargs["temperature"] != 1:
                self.logger.warning(
                    "Model %s only supports default temperature; ignoring %s",
                    self.config.model,
                    kwargs["temperature"],
                )
            # omit temperature entirely for new models (unless caller explicitly sets 1)
            elif "temperature" in kwargs and kwargs["temperature"] == 1:
                api_kwargs["temperature"] = 1
        else:
            api_kwargs["temperature"] = temperature

        # Token limit handling
        if "max_completion_tokens" in kwargs:
            api_kwargs["max_completion_tokens"] = kwargs["max_completion_tokens"]
        elif self._is_new_model:
            api_kwargs["max_completion_tokens"] = token_limit
        else:
            api_kwargs["max_tokens"] = token_limit

        # Forward passthrough kwargs
        for key in _PASSTHROUGH_KEYS:
            if key in kwargs:
                api_kwargs[key] = kwargs[key]

        if stream:
            api_kwargs["stream"] = True

        return api_kwargs

    def _create_with_compat_fallback(self, api_kwargs: Dict[str, Any]):
        """
        Execute chat completion, retrying on known parameter-mismatch errors.
        """
        kw = dict(api_kwargs)
        max_retries = len(_RETRY_RULES)

        for attempt in range(max_retries + 1):
            try:
                return self.client.chat.completions.create(**kw)
            except Exception as e:
                if attempt == max_retries:
                    raise

                err = str(e)
                retried = False

                for (exact, cat, field), src_key, dst_key in _RETRY_RULES:
                    if src_key not in kw:
                        continue
                    if exact in err or (cat in err and field in err):
                        val = kw.pop(src_key)
                        if dst_key:
                            kw[dst_key] = val
                        self.logger.warning(
                            "OpenAI rejected %s for model %s; retrying%s",
                            src_key,
                            self.config.model,
                            f" with {dst_key}" if dst_key else " without it",
                        )
                        retried = True
                        break

                if not retried:
                    raise

        # Unreachable — loop always returns or raises
        return self.client.chat.completions.create(**kw)  # pragma: no cover

    # ------------------------------------------------------------------
    # Message helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _build_messages(prompt: str, system: Optional[str] = None) -> List[Dict[str, str]]:
        messages: List[Dict[str, str]] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        return messages

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def generate(
        self,
        prompt: str,
        system: Optional[str] = None,
        **kwargs: Any,
    ) -> LLMResponse:
        """Generate a single completion."""
        messages = self._build_messages(prompt, system)
        api_kwargs = self._build_api_kwargs(messages, stream=False, **kwargs)

        try:
            response = self._create_with_compat_fallback(api_kwargs)

            usage = response.usage
            return LLMResponse(
                content=response.choices[0].message.content,
                model=response.model,
                usage={
                    "input_tokens": usage.prompt_tokens,
                    "output_tokens": usage.completion_tokens,
                    "total_tokens": usage.total_tokens,
                },
                metadata={
                    "model": response.model,
                    "finish_reason": response.choices[0].finish_reason,
                    "id": response.id,
                },
            )
        except Exception as e:
            self.logger.error("OpenAI API call failed: %s", e)
            raise

    def generate_stream(
        self,
        prompt: str,
        system: Optional[str] = None,
        **kwargs: Any,
    ) -> Iterator[str]:
        """Generate a streaming completion, yielding content chunks."""
        messages = self._build_messages(prompt, system)
        api_kwargs = self._build_api_kwargs(messages, stream=True, **kwargs)

        try:
            stream = self._create_with_compat_fallback(api_kwargs)
            for chunk in stream:
                delta = chunk.choices[0].delta.content
                if delta is not None:
                    yield delta
        except Exception as e:
            self.logger.error("OpenAI streaming failed: %s", e)
            raise

    def generate_with_callback(
        self,
        prompt: str,
        system: Optional[str] = None,
        callback: Optional[StreamCallback] = None,
        **kwargs: Any,
    ) -> LLMResponse:
        """
        Stream a completion while invoking a callback for each chunk.

        Combines the best of both worlds: you get real-time output via the
        callback (e.g. printing to the console) AND a complete LLMResponse
        returned at the end with the full content and metadata.

        Args:
            prompt:   User prompt.
            system:   Optional system message.
            callback: Called with each text chunk as it arrives.
                      Defaults to printing to stdout if *None*.
                      Pass ``console_callback`` or any ``Callable[[str], None]``.
            **kwargs: Additional OpenAI-specific arguments.

        Returns:
            LLMResponse with the fully assembled content, model info,
            usage (estimated for streams), and timing metadata.

        Example:
            # Print to console in real time and get the full response back
            response = client.generate_with_callback(
                prompt="Explain recursion",
                system="You are a helpful tutor",
                callback=console_callback,
            )
            print(f"\\nTotal length: {len(response.content)} chars")
        """
        if callback is None:
            callback = lambda x: print(x, end="", flush=True)

        messages = self._build_messages(prompt, system)
        api_kwargs = self._build_api_kwargs(messages, stream=True, **kwargs)

        chunks: List[str] = []
        finish_reason: Optional[str] = None
        model_name: Optional[str] = None
        response_id: Optional[str] = None

        t0 = time.perf_counter()

        try:
            stream = self._create_with_compat_fallback(api_kwargs)

            for event in stream:
                choice = event.choices[0]

                if model_name is None:
                    model_name = getattr(event, "model", self.config.model)
                if response_id is None:
                    response_id = getattr(event, "id", None)

                delta = choice.delta.content
                if delta is not None:
                    chunks.append(delta)
                    callback(delta)

                if choice.finish_reason is not None:
                    finish_reason = choice.finish_reason

        except Exception as e:
            self.logger.error("OpenAI streaming (callback) failed: %s", e)
            raise

        elapsed = time.perf_counter() - t0
        full_content = "".join(chunks)

        # Estimate token counts (streams don't return usage by default)
        est_output_tokens = self.count_tokens(full_content)
        est_input_tokens = self.count_tokens(prompt) + (
            self.count_tokens(system) if system else 0
        )

        return LLMResponse(
            content=full_content,
            model=model_name or self.config.model,
            usage={
                "input_tokens": est_input_tokens,
                "output_tokens": est_output_tokens,
                "total_tokens": est_input_tokens + est_output_tokens,
            },
            metadata={
                "model": model_name or self.config.model,
                "finish_reason": finish_reason,
                "id": response_id,
                "duration": elapsed,
                "tokens_per_second": (
                    est_output_tokens / elapsed if elapsed > 0 else None
                ),
                "streamed": True,
            },
        )

    def count_tokens(self, text: str) -> int:
        """Count tokens using tiktoken (cached encoding)."""
        try:
            encoding = _get_tiktoken_encoding(self.config.model)
            return len(encoding.encode(text))
        except ImportError:
            self.logger.warning("tiktoken not installed, using rough estimate")
            return len(text) // 4
        except Exception as e:
            self.logger.warning("Token counting failed: %s", e)
            return len(text) // 4

    def estimate_cost(self, tokens: int) -> float:
        """Estimate cost in USD assuming a 50/50 input/output split."""
        model = self.config.model
        pricing = next(
            (v for k, v in _PRICING.items() if k in model),
            _DEFAULT_PRICING,
        )
        half = tokens / 2
        return half * pricing["input"] / 1_000_000 + half * pricing["output"] / 1_000_000

    # ── Tool-calling ──────────────────────────────────────────────────────

    def generate_with_tools(
        self,
        messages: List[Dict[str, Any]],
        tools: List[ToolDefinition],
        system: Optional[str] = None,
        **kwargs,
    ) -> LLMResponse:
        """Generate a response that may include tool calls (OpenAI function-calling)."""
        import json as _json

        openai_tools = [
            {
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.input_schema,
                },
            }
            for t in tools
        ]

        full_messages = list(messages)
        if system:
            full_messages.insert(0, {"role": "system", "content": system})

        api_kwargs: Dict[str, Any] = {
            "model": kwargs.get("model", self.config.model),
            "max_tokens": kwargs.get("max_tokens", self.config.max_tokens),
            "temperature": kwargs.get("temperature", self.config.temperature),
            "messages": full_messages,
            "tools": openai_tools,
        }

        try:
            response = self.client.chat.completions.create(**api_kwargs)
            choice = response.choices[0]
            message = choice.message

            tool_calls: List[ToolCall] = []
            if message.tool_calls:
                for tc in message.tool_calls:
                    try:
                        args = _json.loads(tc.function.arguments)
                    except _json.JSONDecodeError:
                        args = {"raw": tc.function.arguments}
                    tool_calls.append(
                        ToolCall(id=tc.id, name=tc.function.name, arguments=args)
                    )

            usage = {
                "input_tokens": response.usage.prompt_tokens,
                "output_tokens": response.usage.completion_tokens,
                "total_tokens": response.usage.total_tokens,
            }

            stop_reason = "tool_use" if tool_calls else "end_turn"

            return LLMResponse(
                content=message.content or "",
                model=response.model,
                usage=usage,
                metadata={"id": response.id, "finish_reason": choice.finish_reason},
                tool_calls=tool_calls,
                stop_reason=stop_reason,
            )

        except Exception as e:
            self.logger.error("OpenAI tool-calling API failed: %s", e)
            raise


# ============================================================================
# FACTORY FUNCTION
# ============================================================================

def create_openai_client(
    model: str = "gpt-5",
    temperature: float = 0.2,
    max_tokens: int = 4000,
    api_key: Optional[str] = None,
) -> OpenAIClient:
    """Create an OpenAI client with sensible defaults."""
    config = LLMConfig(
        provider="openai",
        model=model,
        temperature=temperature,
        max_tokens=max_tokens,
        api_key=api_key,
    )
    return OpenAIClient(config)


# ============================================================================
# EXAMPLE USAGE
# ============================================================================

if __name__ == "__main__":
    client = create_openai_client(model="gpt-5", api_key=os.getenv("OPENAI_API_KEY"))

    # ---- 1. Standard (blocking) generation ----
    print("=== Standard generate ===\n")
    response = client.generate(
        prompt="Write a Python function to calculate fibonacci numbers",
        system="You are a helpful Python programmer",
    )
    print(response.content)

    # ---- 2. Streaming with callback (real-time console output + full response) ----
    print("\n\n=== Streaming with callback ===\n")

    response = client.generate_with_callback(
        prompt="Count from 1 to 10, one per line",
        system="You are concise.",
        # callback defaults to: lambda x: print(x, end="", flush=True)
    )

    # After streaming completes we still have the full response object
    print(f"\n\n⚡ Stats:")
    print(f"   Duration: {response.metadata['duration']:.2f}s")
    print(f"   Output tokens (est): {response.usage['output_tokens']}")
    tps = response.metadata.get("tokens_per_second")
    print(f"   Speed: {tps:.0f} tokens/sec" if tps else "   Speed: N/A")
    print(f"   Cost: ${client.estimate_cost(response.usage['total_tokens']):.6f}")

    # ---- 3. Custom callback example ----
    print("\n\n=== Custom callback (word counter) ===\n")

    word_count = 0

    def counting_callback(x: str) -> None:
        global word_count
        word_count += x.count(" ")
        print(x, end="", flush=True)

    response = client.generate_with_callback(
        prompt="Explain recursion in three sentences",
        callback=counting_callback,
    )
    print(f"\n   ~{word_count} words streamed")