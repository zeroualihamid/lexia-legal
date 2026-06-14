# agents/base_agent.py

"""
Base Agent Interface
Abstract base class for all adversarial agents

Defines the contract that all agents must implement:
- analyze_code()
- generate_arguments()
- respond_to_feedback()
"""

from abc import ABC, abstractmethod
from typing import Dict, Any, List, Optional
from dataclasses import dataclass

from monitoring.logger import get_logger

logger = get_logger(__name__)


@dataclass
class AgentResponse:
    """Base response structure for all agents"""
    confidence: float  # 0.0 to 1.0
    arguments: List[str]
    metadata: Dict[str, Any]
    
    def to_dict(self) -> Dict:
        return {
            'confidence': self.confidence,
            'arguments': self.arguments,
            'metadata': self.metadata
        }


class BaseAgent(ABC):
    """
    Base Agent Interface
    
    All adversarial agents (Proposer, Challenger) inherit from this.
    Provides common functionality and enforces interface contract.
    """
    
    def __init__(self, config, llm_client=None):
        """
        Initialize agent
        
        Args:
            config: Configuration object
            llm_client: Optional LLM client (will create if not provided)
        """
        self.config = config
        self.llm_client = llm_client or self._create_llm_client()
        self.logger = get_logger(self.__class__.__name__)
        
        # Agent state
        self.history = []
        self.current_round = 0
    
    @abstractmethod
    def analyze_code(self, code: str, metadata: Optional[Dict] = None) -> AgentResponse:
        """
        Analyze code and generate initial response
        
        Args:
            code: Code to analyze
            metadata: Optional context metadata
            
        Returns:
            AgentResponse with analysis
        """
        pass
    
    @abstractmethod
    def generate_arguments(
        self,
        code: str,
        context: Dict[str, Any]
    ) -> List[str]:
        """
        Generate arguments about the code
        
        Args:
            code: Code to argue about
            context: Context information
            
        Returns:
            List of argument strings
        """
        pass
    
    @abstractmethod
    def respond_to_feedback(
        self,
        feedback: Dict[str, Any],
        previous_response: AgentResponse
    ) -> AgentResponse:
        """
        Respond to feedback from another agent
        
        Args:
            feedback: Feedback from other agent
            previous_response: Agent's previous response
            
        Returns:
            Updated AgentResponse
        """
        pass
    
    def update_history(self, action: str, data: Dict[str, Any]):
        """Update agent's action history"""
        self.history.append({
            'round': self.current_round,
            'action': action,
            'data': data
        })
    
    def increment_round(self):
        """Increment current round counter"""
        self.current_round += 1
    
    def reset(self):
        """Reset agent state"""
        self.history = []
        self.current_round = 0
        self.logger.debug("Agent state reset")
    
    def _create_llm_client(self):
        """Create LLM client"""
        from llm.llm_factory import create_llm_client
        return create_llm_client(self.config)
    
    def _call_llm(self, prompt: str) -> str:
        """
        Call LLM with prompt
        
        Args:
            prompt: Prompt string
            
        Returns:
            LLM response
        """
        try:
            response = self.llm_client.generate(prompt)
            return response
        except Exception as e:
            self.logger.error(f"LLM call failed: {e}")
            raise
    
    def __repr__(self) -> str:
        return f"<{self.__class__.__name__}(round={self.current_round})>"
