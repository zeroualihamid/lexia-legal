# llm/anthropic_client.py

"""
Anthropic Claude Client
Implementation of BaseLLM for Anthropic's Claude models
"""

from typing import Any, Callable, Dict, List, Optional, Iterator
import os

from llm.base_llm import BaseLLM, LLMResponse, LLMConfig, ToolDefinition, ToolCall
from monitoring.logger import get_logger

logger = get_logger(__name__)

# Type alias for stream callbacks: receives each text chunk as it arrives
StreamCallback = Callable[[str], None]

# Built-in callback that prints chunks to stdout in real time
console_callback: StreamCallback = lambda x: print(x, end="", flush=True)


class AnthropicClient(BaseLLM):
    """
    Anthropic Claude LLM Client
    
    Supports Claude models via the Anthropic API.
    
    Example:
        config = LLMConfig(
            provider='anthropic',
            model='claude-sonnet-4',
            api_key=os.getenv('ANTHROPIC_API_KEY')
        )
        
        client = AnthropicClient(config)
        response = client.generate("Explain quantum computing")
        print(response.content)
    """
    
    def __init__(self, config: LLMConfig):
        super().__init__(config)
        
        # Initialize Anthropic client
        self.client = self._initialize_client()

    # Legacy aliases that may appear in configs but are not valid API IDs.
    MODEL_ALIASES = {
        "claude-sonnet-4-5-20250929": "claude-sonnet-4-5-20250929",
        "claude-haiku-4-5-20251001": "claude-3-5-haiku-latest",
        "claude-opus-4-5-20251101": "claude-3-opus-latest",
    }

    def _resolve_model_name(self, model_name: str) -> str:
        """Map friendly/legacy model aliases to API-valid model IDs."""
        resolved = self.MODEL_ALIASES.get(model_name, model_name)
        if resolved != model_name:
            self.logger.warning(
                "Mapped Anthropic model alias '%s' -> '%s'",
                model_name,
                resolved,
            )
        return resolved
    
    def _initialize_client(self):
        """Initialize Anthropic SDK client"""
        try:
            from anthropic import Anthropic
            
            api_key = self.config.api_key or os.getenv('ANTHROPIC_API_KEY')
            
            if not api_key:
                raise ValueError("Anthropic API key not provided")
            
            client = Anthropic(api_key=api_key)
            
            self.logger.info("Anthropic client initialized")
            
            return client
        
        except ImportError:
            self.logger.error(
                "Anthropic SDK not installed. "
                "Install with: pip install anthropic"
            )
            raise
    
    def generate(
        self,
        prompt: str,
        system: Optional[str] = None,
        **kwargs
    ) -> LLMResponse:
        """
        Generate completion using Claude
        
        Args:
            prompt: User prompt
            system: Optional system message
            **kwargs: Additional Anthropic-specific arguments
            
        Returns:
            LLMResponse with generated content
        """
        
        # Prepare messages
        messages = [{"role": "user", "content": prompt}]
        
        api_kwargs = {
            'model': self._resolve_model_name(kwargs.get('model', self.config.model)),
            'max_tokens': kwargs.get('max_tokens', self.config.max_tokens),
            'temperature': kwargs.get('temperature', self.config.temperature),
            'messages': messages,
            'cache_control': {"type": "ephemeral"},
        }
        
        if system:
            api_kwargs['system'] = system
        
        try:
            response = self.client.messages.create(**api_kwargs)
            
            content = response.content[0].text
            usage = self._extract_cache_usage(response.usage)
            
            metadata = {
                'model': response.model,
                'stop_reason': response.stop_reason,
                'id': response.id
            }
            
            if usage.get("cache_read_input_tokens"):
                self.logger.info(
                    "Prompt cache HIT: %d tokens read from cache",
                    usage["cache_read_input_tokens"],
                )
            
            return LLMResponse(
                content=content,
                model=response.model,
                usage=usage,
                metadata=metadata
            )
        
        except Exception as e:
            if "not_found_error" in str(e) and "model" in str(e):
                self.logger.error(
                    "Anthropic model '%s' not found after alias resolution. "
                    "Try a concrete model like 'claude-sonnet-4-5-20250929'.",
                    api_kwargs.get('model'),
                )
            self.logger.error(f"Anthropic API call failed: {e}")
            raise
    
    def generate_stream(
        self,
        prompt: str,
        system: Optional[str] = None,
        callback: Optional[StreamCallback] = None,
        **kwargs
    ) -> Iterator[str]:
        """
        Generate streaming completion
        
        Args:
            prompt: User prompt
            system: Optional system message
            **kwargs: Additional arguments
            
        Yields:
            Content chunks
        """
        
        messages = [{"role": "user", "content": prompt}]
        
        api_kwargs = {
            'model': self._resolve_model_name(kwargs.get('model', self.config.model)),
            'max_tokens': kwargs.get('max_tokens', self.config.max_tokens),
            'temperature': kwargs.get('temperature', self.config.temperature),
            'messages': messages,
            'cache_control': {"type": "ephemeral"},
        }
        
        if system:
            api_kwargs['system'] = system
        
        stream_callback = callback or kwargs.get('stream_callback') or kwargs.get('callback')
        
        try:
            with self.client.messages.stream(**api_kwargs) as stream:
                for text in stream.text_stream:
                    if callable(stream_callback):
                        try:
                            stream_callback(text)
                        except Exception as callback_error:
                            self.logger.warning(f"Anthropic stream callback failed: {callback_error}")

                    yield text
        
        except Exception as e:
            if "not_found_error" in str(e) and "model" in str(e):
                self.logger.error(
                    "Anthropic model '%s' not found after alias resolution. "
                    "Try a concrete model like 'claude-sonnet-4-5-20250929'.",
                    api_kwargs.get('model'),
                )
            self.logger.error(f"Anthropic streaming failed: {e}")
            raise
    
    def count_tokens(self, text: str) -> int:
        """
        Count tokens using Anthropic's counting
        
        Args:
            text: Text to count
            
        Returns:
            Token count
        """
        try:
            # Use Anthropic's token counting
            count = self.client.count_tokens(text)
            return count
        except:
            # Fallback: rough estimate (4 chars per token)
            return len(text) // 4
    
    def estimate_cost(self, tokens: int) -> float:
        """
        Estimate cost for Anthropic models
        
        Args:
            tokens: Token count
            
        Returns:
            Estimated cost in USD
        """
        # Pricing as of 2024 (update as needed)
        pricing = {
            'claude-opus-4': {'input': 15.00, 'output': 75.00},
            'claude-sonnet-4': {'input': 3.00, 'output': 15.00},
            'claude-haiku-4': {'input': 0.25, 'output': 1.25},
        }
        
        model_pricing = pricing.get(self.config.model, {'input': 3.00, 'output': 15.00})
        
        # Assume 50/50 split input/output
        cost = (tokens / 2 * model_pricing['input'] / 1_000_000 +
                tokens / 2 * model_pricing['output'] / 1_000_000)
        
        return cost

    # ── Tool-calling ──────────────────────────────────────────────────────

    @staticmethod
    def _extract_cache_usage(usage) -> Dict[str, int]:
        """Extract standard + prompt-cache token counts from an Anthropic usage object."""
        result = {
            "input_tokens": usage.input_tokens,
            "output_tokens": usage.output_tokens,
            "total_tokens": usage.input_tokens + usage.output_tokens,
        }
        cache_creation = getattr(usage, "cache_creation_input_tokens", 0) or 0
        cache_read = getattr(usage, "cache_read_input_tokens", 0) or 0
        if cache_creation or cache_read:
            result["cache_creation_input_tokens"] = cache_creation
            result["cache_read_input_tokens"] = cache_read
        return result

    def generate_with_tools(
        self,
        messages: List[Dict[str, Any]],
        tools: List[ToolDefinition],
        system: Optional[str] = None,
        **kwargs,
    ) -> LLMResponse:
        """Generate a response that may include tool calls (Anthropic native).

        Enables automatic prompt caching (``cache_control``) so that
        the system prompt, tool definitions, and message prefix are
        cached across consecutive calls within a session, reducing
        input token costs by ~90% on cache hits.
        """
        api_tools = [
            {
                "name": t.name,
                "description": t.description,
                "input_schema": t.input_schema,
            }
            for t in tools
        ]

        api_kwargs: Dict[str, Any] = {
            "model": self._resolve_model_name(kwargs.get("model", self.config.model)),
            "max_tokens": kwargs.get("max_tokens", self.config.max_tokens),
            "temperature": kwargs.get("temperature", self.config.temperature),
            "messages": messages,
            "cache_control": {"type": "ephemeral"},
        }
        if api_tools:
            api_kwargs["tools"] = api_tools
        if system:
            api_kwargs["system"] = system

        try:
            response = self.client.messages.create(**api_kwargs)

            text_parts: List[str] = []
            tool_calls: List[ToolCall] = []
            for block in response.content:
                if block.type == "text":
                    text_parts.append(block.text)
                elif block.type == "tool_use":
                    tool_calls.append(
                        ToolCall(id=block.id, name=block.name, arguments=block.input)
                    )

            usage = self._extract_cache_usage(response.usage)

            if usage.get("cache_read_input_tokens"):
                self.logger.info(
                    "Prompt cache HIT: %d tokens read from cache, %d created",
                    usage["cache_read_input_tokens"],
                    usage.get("cache_creation_input_tokens", 0),
                )

            return LLMResponse(
                content="\n".join(text_parts),
                model=response.model,
                usage=usage,
                metadata={"id": response.id, "stop_reason": response.stop_reason},
                tool_calls=tool_calls,
                stop_reason=response.stop_reason,
            )

        except Exception as e:
            self.logger.error("Anthropic tool-calling API failed: %s", e)
            raise

# ============================================================================
# FACTORY FUNCTION
# ============================================================================

def create_anthropic_client(
    model: str = 'claude-sonnet-4-5-20250929',
    temperature: float = 0.2,
    max_tokens: int = 4000,
    api_key: Optional[str] = None,
) -> AnthropicClient:   
    """Create an Anthropic client with sensible defaults."""
    config = LLMConfig(
        provider='anthropic',
        model=model,
        temperature=temperature,
        max_tokens=max_tokens,
        api_key=api_key,
    )
    return AnthropicClient(config)


# ============================================================================
# EXAMPLE USAGE
# ============================================================================

if __name__ == '__main__':
    """
    Example usage of Anthropic client
    """
    
    import os
    
    # Create client     
    client = create_anthropic_client(
        model='claude-sonnet-4-5-20250929',
        api_key=os.getenv('ANTHROPIC_API_KEY')
    )
    
    # Generate
    print("Generating with Anthropic (Claude Sonnet 4)...\n")
    
    try:
        # Consume the generator so streaming actually runs and callbacks fire.
        for _ in client.generate_stream(
            prompt="Count from 1 to 50",
            callback=console_callback
        ):
            pass
    except Exception as e:
        print(f"Error: {e}")
    finally:
        print("\nStreaming completed")