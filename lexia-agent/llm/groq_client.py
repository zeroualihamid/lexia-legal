# llm/groq_client.py

"""
Groq Client
Implementation of BaseLLM for Groq's ultra-fast inference API

Groq provides blazing-fast inference for open-source models like:
- Llama 3.3 (70B, 8B)
- Mixtral (8x7B, 8x22B)
- Gemma (7B, 2B)
"""

from typing import Callable, Optional, Iterator, Any
import os

from llm.base_llm import BaseLLM, LLMResponse, LLMConfig
from monitoring.logger import get_logger

logger = get_logger(__name__)

# Type alias for stream callbacks: receives each text chunk as it arrives
StreamCallback = Callable[[str], None]

# Built-in callback that prints chunks to stdout in real time
console_callback: StreamCallback = lambda x: print(x, end="", flush=True)


class GroqClient(BaseLLM):
    """
    Groq LLM Client
    
    Ultra-fast inference using Groq's LPU (Language Processing Unit).
    Compatible with OpenAI-style API but with significantly faster response times.
    
    Supported Models:
    - llama-3.3-70b-versatile (recommended for quality)
    - llama-3.1-70b-versatile
    - llama-3.1-8b-instant (recommended for speed)
    - mixtral-8x7b-32768
    - gemma2-9b-it
    - gemma-7b-it
    
    Example:
        config = LLMConfig(
            provider='groq',
            model='llama-3.3-70b-versatile',
            api_key=os.getenv('GROQ_API_KEY')
        )
        
        client = GroqClient(config)
        response = client.generate("Explain quantum computing")
        print(response.content)
        print(f"⚡ Generated in {response.metadata['duration']}s")
    """
    
    def __init__(self, config: LLMConfig):
        super().__init__(config)
        
        # Initialize Groq client
        self.client = self._initialize_client()
    
    def _initialize_client(self):
        """Initialize Groq SDK client"""
        try:
            from groq import Groq
            
            api_key = self.config.api_key or os.getenv('GROQ_API_KEY')
            
            if not api_key:
                raise ValueError("Groq API key not provided")
            
            client = Groq(api_key=api_key)
            
            self.logger.info("Groq client initialized")
            self.logger.info(f"Using model: {self.config.model}")
            
            return client
        
        except ImportError:
            self.logger.error(
                "Groq SDK not installed. "
                "Install with: pip install groq"
            )
            raise
    
    def generate(
        self,
        prompt: str,
        system: Optional[str] = None,
        **kwargs
    ) -> LLMResponse:
        """
        Generate completion using Groq
        
        Args:
            prompt: User prompt
            system: Optional system message
            **kwargs: Additional Groq-specific arguments
            
        Returns:
            LLMResponse with generated content
        """
        
        # Prepare messages
        messages = []
        
        if system:
            messages.append({"role": "system", "content": system})
        
        messages.append({"role": "user", "content": prompt})
        
        # Prepare kwargs
        api_kwargs = {
            'model': self.config.model,
            'messages': messages,
            'max_tokens': kwargs.get('max_tokens', self.config.max_tokens),
            'temperature': kwargs.get('temperature', self.config.temperature)
        }
        
        # Add optional parameters
        if 'top_p' in kwargs:
            api_kwargs['top_p'] = kwargs['top_p']
        
        if 'stream' in kwargs:
            api_kwargs['stream'] = kwargs['stream']
        
        try:
            import time
            start_time = time.time()
            
            # Call API
            response = self.client.chat.completions.create(**api_kwargs)
            
            duration = time.time() - start_time
            
            # Extract content
            content = response.choices[0].message.content
            
            # Build usage info
            usage = {
                'input_tokens': response.usage.prompt_tokens,
                'output_tokens': response.usage.completion_tokens,
                'total_tokens': response.usage.total_tokens,
                'prompt_time': getattr(response.usage, 'prompt_time', None),
                'completion_time': getattr(response.usage, 'completion_time', None),
                'total_time': getattr(response.usage, 'total_time', None)
            }
            
            # Build metadata
            metadata = {
                'model': response.model,
                'finish_reason': response.choices[0].finish_reason,
                'id': response.id,
                'duration': duration,
                'tokens_per_second': usage['output_tokens'] / duration if duration > 0 else 0
            }
            
            # Log performance
            self.logger.info(
                f"⚡ Groq generation: {usage['output_tokens']} tokens in {duration:.2f}s "
                f"({metadata['tokens_per_second']:.0f} tokens/sec)"
            )
            
            return LLMResponse(
                content=content,
                model=response.model,
                usage=usage,
                metadata=metadata
            )
        
        except Exception as e:
            self.logger.error(f"Groq API call failed: {e}")
            raise
    
    def generate_stream(
        self,
        prompt: str,
        system: Optional[str] = None,
        callback: Optional[StreamCallback] = None,
        **kwargs: Any
    ) -> Iterator[str]:
        """
        Generate streaming completion
        
        Args:
            prompt: User prompt
            system: Optional system message
            callback: Optional callback called per streamed text chunk
            **kwargs: Additional arguments
            
        Yields:
            Content chunks
        """
        
        # Prepare messages
        messages = []
        
        if system:
            messages.append({"role": "system", "content": system})
        
        messages.append({"role": "user", "content": prompt})
        
        # Prepare kwargs
        api_kwargs = {
            'model': self.config.model,
            'messages': messages,
            'max_tokens': kwargs.get('max_tokens', self.config.max_tokens),
            'temperature': kwargs.get('temperature', self.config.temperature),
            'stream': True
        }

        if 'top_p' in kwargs:
            api_kwargs['top_p'] = kwargs['top_p']

        # Backward-compatible aliases for callback passing styles.
        stream_callback = callback or kwargs.get('stream_callback') or kwargs.get('callback')
        
        try:
            stream = self.client.chat.completions.create(**api_kwargs)
            
            for chunk in stream:
                if chunk.choices[0].delta.content is not None:
                    text_chunk = chunk.choices[0].delta.content

                    if callable(stream_callback):
                        try:
                            stream_callback(text_chunk)
                        except Exception as callback_error:
                            self.logger.warning(f"Groq stream callback failed: {callback_error}")

                    yield text_chunk
        
        except Exception as e:
            self.logger.error(f"Groq streaming failed: {e}")
            raise
    
    def count_tokens(self, text: str) -> int:
        """
        Count tokens using tiktoken (approximate for Llama models)
        
        Args:
            text: Text to count
            
        Returns:
            Token count (approximate)
        """
        try:
            import tiktoken
            
            # Use cl100k_base encoding as approximation
            # (Llama tokenizer is similar but not identical)
            encoding = tiktoken.get_encoding('cl100k_base')
            tokens = encoding.encode(text)
            
            return len(tokens)
        
        except ImportError:
            self.logger.warning("tiktoken not installed, using rough estimate")
            # Fallback: rough estimate (4 chars per token)
            return len(text) // 4
        
        except Exception as e:
            self.logger.warning(f"Token counting failed: {e}")
            return len(text) // 4
    
    def estimate_cost(self, tokens: int) -> float:
        """
        Estimate cost for Groq models
        
        Groq pricing is significantly cheaper than other providers.
        
        Args:
            tokens: Token count
            
        Returns:
            Estimated cost in USD
        """
        
        # Groq pricing as of 2024 (per million tokens)
        # These are very competitive rates!
        pricing = {
            'llama-3.3-70b-versatile': {'input': 0.59, 'output': 0.79},
            'llama-3.1-70b-versatile': {'input': 0.59, 'output': 0.79},
            'llama-3.1-8b-instant': {'input': 0.05, 'output': 0.08},
            'llama3-70b-8192': {'input': 0.59, 'output': 0.79},
            'llama3-8b-8192': {'input': 0.05, 'output': 0.08},
            'mixtral-8x7b-32768': {'input': 0.24, 'output': 0.24},
            'gemma2-9b-it': {'input': 0.20, 'output': 0.20},
            'gemma-7b-it': {'input': 0.07, 'output': 0.07},
        }
        
        # Find matching pricing
        model_pricing = None
        for key in pricing:
            if key in self.config.model:
                model_pricing = pricing[key]
                break
        
        if not model_pricing:
            # Default to llama-3.1-8b pricing
            model_pricing = pricing['llama-3.1-8b-instant']
        
        # Assume 50/50 split input/output
        cost = (tokens / 2 * model_pricing['input'] / 1_000_000 +
                tokens / 2 * model_pricing['output'] / 1_000_000)
        
        return cost
    
    def get_available_models(self) -> list:
        """
        Get list of available Groq models
        
        Returns:
            List of model names
        """
        return [
            'llama-3.3-70b-versatile',
            'llama-3.1-70b-versatile',
            'llama-3.1-8b-instant',
            'llama3-70b-8192',
            'llama3-8b-8192',
            'mixtral-8x7b-32768',
            'gemma2-9b-it',
            'gemma-7b-it'
        ]
    
    def get_model_info(self) -> dict:
        """
        Get detailed model information
        
        Returns:
            Dict with model details
        """
        
        model_info = {
            'llama-3.3-70b-versatile': {
                'context_window': 128000,
                'description': 'Meta Llama 3.3 70B - Best quality',
                'speed': 'fast',
                'cost': 'low'
            },
            'llama-3.1-70b-versatile': {
                'context_window': 128000,
                'description': 'Meta Llama 3.1 70B - High quality',
                'speed': 'fast',
                'cost': 'low'
            },
            'llama-3.1-8b-instant': {
                'context_window': 128000,
                'description': 'Meta Llama 3.1 8B - Blazing fast',
                'speed': 'ultra-fast',
                'cost': 'very-low'
            },
            'mixtral-8x7b-32768': {
                'context_window': 32768,
                'description': 'Mixtral 8x7B - Good balance',
                'speed': 'fast',
                'cost': 'low'
            },
            'gemma2-9b-it': {
                'context_window': 8192,
                'description': 'Google Gemma 2 9B',
                'speed': 'fast',
                'cost': 'low'
            }
        }
        
        info = model_info.get(self.config.model, {})
        info['provider'] = 'groq'
        info['model'] = self.config.model
        
        return info


# ============================================================================
# FACTORY FUNCTION
# ============================================================================

def create_groq_client(
    model: str = 'llama-3.3-70b-versatile',
    temperature: float = 0.2,
    max_tokens: int = 4000,
    api_key: Optional[str] = None
) -> GroqClient:
    """
    Create a Groq client with sensible defaults
    
    Args:
        model: Model name
        temperature: Sampling temperature
        max_tokens: Maximum tokens
        api_key: API key (or use GROQ_API_KEY env var)
        
    Returns:
        GroqClient instance
    """
    
    config = LLMConfig(
        provider='groq',
        model=model,
        temperature=temperature,
        max_tokens=max_tokens,
        api_key=api_key
    )
    
    return GroqClient(config)


# ============================================================================
# EXAMPLE USAGE
# ============================================================================

if __name__ == '__main__':
    """
    Example usage of Groq client
    """
    
    import os
    
    # Create client
    client = create_groq_client(
        model='llama-3.3-70b-versatile',
        api_key=os.getenv('GROQ_API_KEY')
    )
    
    # Generate
    print("Generating with Groq (ultra-fast inference)...\n")
    
    response = client.generate(
        prompt="Write a Python function to calculate fibonacci numbers",
        system="You are a helpful Python programmer",
       
    )
    
    print(response.content)
    print(f"\n⚡ Stats:")
    print(f"   Duration: {response.metadata['duration']:.2f}s")
    print(f"   Tokens: {response.usage['total_tokens']}")
    print(f"   Speed: {response.metadata['tokens_per_second']:.0f} tokens/sec")
    print(f"   Cost: ${client.estimate_cost(response.usage['total_tokens']):.6f}")
    
    # Streaming example
    print("\n\nStreaming example:")
    print("-" * 60)
    
    for _ in client.generate_stream("Count from 1 to 50", callback=console_callback):
        pass
    
    print("\n" + "-" * 60)
