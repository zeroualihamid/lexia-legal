# graph/node.py

"""
Graph Node Definition
Represents a code pattern/execution in the reasoning graph
"""

from typing import Dict, Any, List, Optional
from dataclasses import dataclass, field
from datetime import datetime
import uuid


@dataclass
class GraphNode:
    """
    Node in the reasoning graph representing a code pattern
    
    Each node represents:
    - A piece of code that was executed
    - Its execution history and success rate
    - Semantic embedding for similarity search
    - Metadata about the code
    """
    
    # Identity
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    
    # Code content
    code: str = ""
    code_hash: Optional[str] = None  # Hash for deduplication
    
    # Semantic information
    embedding: Optional[List[float]] = None
    description: str = ""
    
    # Execution history
    total_executions: int = 0
    successful_executions: int = 0
    failed_executions: int = 0
    
    # Performance metrics
    average_duration: float = 0.0
    min_duration: float = float('inf')
    max_duration: float = 0.0
    
    # Timestamps
    created_at: datetime = field(default_factory=datetime.now)
    last_used: Optional[datetime] = None
    
    # Metadata
    metadata: Dict[str, Any] = field(default_factory=dict)
    
    # Graph properties
    in_degree: int = 0   # Number of incoming edges
    out_degree: int = 0  # Number of outgoing edges
    
    @property
    def success_rate(self) -> float:
        """Calculate success rate"""
        if self.total_executions == 0:
            return 0.0
        return self.successful_executions / self.total_executions
    
    @property
    def failure_rate(self) -> float:
        """Calculate failure rate"""
        return 1.0 - self.success_rate
    
    @property
    def quality_score(self) -> float:
        """
        Overall quality score combining multiple factors
        
        Formula: success_rate * 0.6 + execution_count_factor * 0.3 + recency * 0.1
        """
        # Success rate component (0-0.6)
        success_component = self.success_rate * 0.6
        
        # Execution count component (0-0.3)
        # More executions = more confidence
        exec_factor = min(self.total_executions / 20.0, 1.0)
        exec_component = exec_factor * 0.3
        
        # Recency component (0-0.1)
        recency_component = 0.1 if self.total_executions > 5 else 0.05
        
        return success_component + exec_component + recency_component
    
    def update_execution_stats(
        self,
        success: bool,
        duration: float
    ):
        """Update execution statistics"""
        self.total_executions += 1
        
        if success:
            self.successful_executions += 1
        else:
            self.failed_executions += 1
        
        # Update duration stats
        self.average_duration = (
            (self.average_duration * (self.total_executions - 1) + duration) /
            self.total_executions
        )
        self.min_duration = min(self.min_duration, duration)
        self.max_duration = max(self.max_duration, duration)
        
        # Update last used timestamp
        self.last_used = datetime.now()
    
    def to_dict(self) -> Dict:
        """Convert to dictionary for storage"""
        return {
            'id': self.id,
            'code': self.code,
            'code_hash': self.code_hash,
            'embedding': self.embedding,
            'description': self.description,
            'total_executions': self.total_executions,
            'successful_executions': self.successful_executions,
            'failed_executions': self.failed_executions,
            'success_rate': self.success_rate,
            'average_duration': self.average_duration,
            'min_duration': self.min_duration if self.min_duration != float('inf') else 0.0,
            'max_duration': self.max_duration,
            'created_at': self.created_at.isoformat(),
            'last_used': self.last_used.isoformat() if self.last_used else None,
            'metadata': self.metadata,
            'in_degree': self.in_degree,
            'out_degree': self.out_degree,
            'quality_score': self.quality_score
        }
    
    @classmethod
    def from_dict(cls, data: Dict) -> 'GraphNode':
        """Create node from dictionary"""
        node = cls(
            id=data.get('id', str(uuid.uuid4())),
            code=data.get('code', ''),
            code_hash=data.get('code_hash'),
            embedding=data.get('embedding'),
            description=data.get('description', ''),
            total_executions=data.get('total_executions', 0),
            successful_executions=data.get('successful_executions', 0),
            failed_executions=data.get('failed_executions', 0),
            average_duration=data.get('average_duration', 0.0),
            min_duration=data.get('min_duration', float('inf')),
            max_duration=data.get('max_duration', 0.0),
            metadata=data.get('metadata', {}),
            in_degree=data.get('in_degree', 0),
            out_degree=data.get('out_degree', 0)
        )
        
        # Parse timestamps
        if data.get('created_at'):
            node.created_at = datetime.fromisoformat(data['created_at'])
        if data.get('last_used'):
            node.last_used = datetime.fromisoformat(data['last_used'])
        
        return node
    
    def __repr__(self) -> str:
        return (
            f"GraphNode(id={self.id[:8]}..., "
            f"executions={self.total_executions}, "
            f"success_rate={self.success_rate:.2%})"
        )
