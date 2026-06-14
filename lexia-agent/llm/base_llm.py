# llm/base_llm.py

"""
Base LLM Interface
Abstract base class for all LLM client implementations

Defines the contract that all LLM clients must implement,
providing a consistent interface regardless of the underlying provider.
"""

from abc import ABC, abstractmethod
from typing import Dict, Any, List, Optional
from dataclasses import dataclass, field

from monitoring.logger import get_logger

logger = get_logger(__name__)


# ============================================================================
# DATA STRUCTURES
# ============================================================================

@dataclass
class ToolDefinition:
    """Definition of a tool the LLM can call."""
    name: str
    description: str
    input_schema: Dict[str, Any]  # JSON Schema


@dataclass
class ToolCall:
    """A tool invocation requested by the LLM."""
    id: str
    name: str
    arguments: Dict[str, Any]


@dataclass
class ToolResult:
    """Result of executing a tool, to feed back to the LLM."""
    tool_use_id: str
    content: str
    is_error: bool = False


@dataclass
class LLMResponse:
    """
    Standardized LLM response

    All LLM implementations return this structure for consistency.
    """
    content: str
    model: str
    usage: Dict[str, int]  # tokens, cost info
    metadata: Dict[str, Any]
    tool_calls: List[ToolCall] = field(default_factory=list)
    stop_reason: Optional[str] = None  # "end_turn", "tool_use", etc.

    @property
    def has_tool_calls(self) -> bool:
        return len(self.tool_calls) > 0

    def to_dict(self) -> Dict:
        return {
            'content': self.content,
            'model': self.model,
            'usage': self.usage,
            'metadata': self.metadata,
            'tool_calls': [{'id': tc.id, 'name': tc.name, 'arguments': tc.arguments} for tc in self.tool_calls],
            'stop_reason': self.stop_reason,
        }


@dataclass
class LLMConfig:
    """Configuration for LLM clients"""
    provider: str  # 'anthropic', 'openai', 'groq', 'vllm', 'local'
    model: str
    temperature: float = 0.2
    max_tokens: int = 4000
    api_key: Optional[str] = None
    base_url: Optional[str] = None
    timeout: int = 180
    max_retries: int = 3

    def to_dict(self) -> Dict:
        return {
            'provider': self.provider,
            'model': self.model,
            'temperature': self.temperature,
            'max_tokens': self.max_tokens
        }


# ============================================================================
# BASE LLM CLIENT
# ============================================================================

class BaseLLM(ABC):
    """
    Abstract base class for LLM clients
    
    All LLM implementations must inherit from this and implement:
    - generate()
    - generate_stream()
    - count_tokens()
    
    Example:
        class MyLLM(BaseLLM):
            def generate(self, prompt: str, **kwargs) -> LLMResponse:
                # Implementation
                pass
    """
    
    def __init__(self, config: LLMConfig):
        """
        Initialize LLM client
        
        Args:
            config: LLMConfig with provider settings
        """
        self.config = config
        self.logger = get_logger(self.__class__.__name__)
        
        self.logger.info(
            f"Initialized {config.provider} LLM "
            f"(model: {config.model}, temp: {config.temperature})"
        )
    
    # ========================================================================
    # ABSTRACT METHODS (Must Implement)
    # ========================================================================
    
    @abstractmethod
    def generate(
        self,
        prompt: str,
        system: Optional[str] = None,
        **kwargs
    ) -> LLMResponse:
        """
        Generate completion from prompt
        
        Args:
            prompt: User prompt
            system: Optional system message
            **kwargs: Additional provider-specific arguments
            
        Returns:
            LLMResponse with generated content
        """
        pass
    
    @abstractmethod
    def generate_stream(
        self,
        prompt: str,
        system: Optional[str] = None,
        **kwargs
    ):
        """
        Generate streaming completion
        
        Args:
            prompt: User prompt
            system: Optional system message
            **kwargs: Additional provider-specific arguments
            
        Yields:
            Chunks of generated content
        """
        pass
    
    @abstractmethod
    def count_tokens(self, text: str) -> int:
        """
        Count tokens in text
        
        Args:
            text: Text to count
            
        Returns:
            Number of tokens
        """
        pass
    
    # ========================================================================
    # TOOL-CALLING (Override in subclasses that support it)
    # ========================================================================

    def generate_with_tools(
        self,
        messages: List[Dict[str, Any]],
        tools: List[ToolDefinition],
        system: Optional[str] = None,
        **kwargs,
    ) -> LLMResponse:
        """
        Generate a response that may include tool calls.

        Args:
            messages: Conversation messages in provider format
                      (list of {"role": ..., "content": ...}).
            tools: Available tool definitions.
            system: Optional system prompt.

        Returns:
            LLMResponse — check ``has_tool_calls`` / ``stop_reason``.
        """
        raise NotImplementedError(
            f"{self.__class__.__name__} does not support tool calling. "
            "Override generate_with_tools() to enable it."
        )

    # ========================================================================
    # OPTIONAL METHODS (Can Override)
    # ========================================================================
    
    def validate_config(self) -> bool:
        """
        Validate configuration
        
        Returns:
            True if valid
        """
        if not self.config.api_key:
            self.logger.warning("No API key provided")
            return False
        
        if self.config.temperature < 0 or self.config.temperature > 2:
            self.logger.warning(f"Invalid temperature: {self.config.temperature}")
            return False
        
        return True
    
    def get_model_info(self) -> Dict[str, Any]:
        """
        Get model information
        
        Returns:
            Dict with model details
        """
        return {
            'provider': self.config.provider,
            'model': self.config.model,
            'max_tokens': self.config.max_tokens,
            'temperature': self.config.temperature
        }
    
    def estimate_cost(self, tokens: int) -> float:
        """
        Estimate cost for token count
        
        Args:
            tokens: Number of tokens
            
        Returns:
            Estimated cost in USD
        """
        # Override in subclasses with actual pricing
        return 0.0
    
    def __repr__(self) -> str:
        return (
            f"<{self.__class__.__name__}("
            f"model={self.config.model}, "
            f"temp={self.config.temperature})>"
        )


# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

def create_llm_config(
    provider: str,
    model: str,
    temperature: float = 0.2,
    max_tokens: int = 4000,
    api_key: Optional[str] = None
) -> LLMConfig:
    """
    Create LLM configuration
    
    Args:
        provider: Provider name
        model: Model name
        temperature: Temperature
        max_tokens: Max tokens
        api_key: API key
        
    Returns:
        LLMConfig instance
    """
    return LLMConfig(
        provider=provider,
        model=model,
        temperature=temperature,
        max_tokens=max_tokens,
        api_key=api_key
    )
