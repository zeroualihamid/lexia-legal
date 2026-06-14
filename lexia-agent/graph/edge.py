# graph/edge.py

"""
Graph Edge Definition
Represents relationships between code patterns
"""

from enum import Enum
from dataclasses import dataclass
from typing import Dict, Any, Optional
from datetime import datetime


class EdgeType(Enum):
    """Types of relationships between nodes"""
    LEADS_TO = "leads_to"           # Sequential execution
    SIMILAR_TO = "similar_to"       # Similar functionality
    REFINES = "refines"             # Improved version
    DEPENDS_ON = "depends_on"       # Dependency relationship
    ALTERNATIVE_TO = "alternative_to"  # Different approach


@dataclass
class GraphEdge:
    """
    Edge in the reasoning graph
    
    Represents a relationship between two code nodes.
    """
    source_id: str
    target_id: str
    edge_type: EdgeType
    weight: float = 1.0
    metadata: Dict[str, Any] = None
    created_at: datetime = None
    
    def __post_init__(self):
        if self.metadata is None:
            self.metadata = {}
        if self.created_at is None:
            self.created_at = datetime.now()
    
    def to_dict(self) -> Dict:
        return {
            'source_id': self.source_id,
            'target_id': self.target_id,
            'edge_type': self.edge_type.value,
            'weight': self.weight,
            'metadata': self.metadata,
            'created_at': self.created_at.isoformat()
        }
    
    @classmethod
    def from_dict(cls, data: Dict) -> 'GraphEdge':
        return cls(
            source_id=data['source_id'],
            target_id=data['target_id'],
            edge_type=EdgeType(data['edge_type']),
            weight=data.get('weight', 1.0),
            metadata=data.get('metadata', {}),
            created_at=datetime.fromisoformat(data['created_at']) if 'created_at' in data else None
        )
