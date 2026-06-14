# graph/reasoning_graph.py

"""
Reasoning Graph - Main Interface
Central graph for storing and retrieving code patterns with semantic search

This is the main interface for the code knowledge graph.
It provides high-level operations for:
- Adding code nodes
- Searching for similar code
- Building execution history
- Graph analytics
"""

from typing import Dict, Any, List, Optional, Tuple
from pathlib import Path
import hashlib

from graph.node import GraphNode
from graph.embeddings.code_embedder import CodeEmbedder
from graph.storage.networkx_backend import NetworkXBackend
from monitoring.logger import get_logger

logger = get_logger(__name__)


class ReasoningGraph:
    """
    Main reasoning graph for code patterns
    
    Features:
    - Semantic code search using embeddings
    - Execution history tracking
    - Success rate analytics
    - Pattern clustering
    
    Usage:
        graph = ReasoningGraph(config)
        
        # Add code
        node_id = graph.add_node(
            code="df = pd.read_parquet('data.parquet')",
            metadata={'operation': 'data_loading'}
        )
        
        # Search for similar code
        similar = graph.search_similar(
            query="load parquet file",
            threshold=0.75,
            top_k=5
        )
        
        # Update after execution
        graph.update_execution_result(node_id, success=True, duration=1.5)
    """
    
    def __init__(
        self,
        config,
        storage_backend: str = "networkx",
        enable_embeddings: bool = True
    ):
        self.config = config
        self.enable_embeddings = enable_embeddings
        
        # Initialize storage backend
        self.backend = self._initialize_backend(storage_backend)
        
        # Initialize embedder
        self.embedder = None
        if enable_embeddings:
            try:
                self.embedder = CodeEmbedder(config)
                logger.info("Code embedder initialized")
            except Exception as e:
                logger.warning(f"Failed to initialize embedder: {e}")
                self.enable_embeddings = False
        
        # Node index for fast lookup
        self.node_index: Dict[str, GraphNode] = {}
        
        # Load existing graph
        self._load_graph()
        
        logger.info(
            f"ReasoningGraph initialized with {len(self.node_index)} nodes"
        )
    
    # ========================================================================
    # MAIN OPERATIONS
    # ========================================================================
    
    def add_node(
        self,
        code: str,
        metadata: Optional[Dict] = None,
        description: Optional[str] = None
    ) -> str:
        """
        Add a code node to the graph
        
        Args:
            code: Python code string
            metadata: Optional metadata
            description: Optional description
            
        Returns:
            str: Node ID
        """
        
        # Generate code hash for deduplication
        code_hash = self._hash_code(code)
        
        # Check if code already exists
        existing_node = self._find_by_hash(code_hash)
        if existing_node:
            logger.debug(f"Code already exists in graph: {existing_node.id}")
            return existing_node.id
        
        # Generate embedding if enabled
        embedding = None
        if self.enable_embeddings and self.embedder:
            try:
                embedding = self.embedder.embed_code(code)
            except Exception as e:
                logger.warning(f"Failed to generate embedding: {e}")
        
        # Create node
        node = GraphNode(
            code=code,
            code_hash=code_hash,
            embedding=embedding,
            description=description or "",
            metadata=metadata or {}
        )
        
        # Add to backend and index
        self.backend.add_node(node)
        self.node_index[node.id] = node
        
        logger.info(f"Added node {node.id[:8]}... to graph")
        
        return node.id
    
    def search_similar(
        self,
        query: str,
        threshold: float = 0.75,
        top_k: int = 5,
        min_executions: int = 0
    ) -> List[GraphNode]:
        """
        Search for similar code using semantic similarity
        
        Args:
            query: Search query (natural language or code)
            threshold: Minimum similarity threshold (0-1)
            top_k: Number of results to return
            min_executions: Minimum execution count filter
            
        Returns:
            List of similar nodes ranked by similarity
        """
        
        if not self.enable_embeddings or not self.embedder:
            logger.warning("Embeddings not available, returning empty results")
            return []
        
        # Generate query embedding
        try:
            query_embedding = self.embedder.embed_query(query)
        except Exception as e:
            logger.error(f"Failed to generate query embedding: {e}")
            return []
        
        # Search in backend
        results = self.backend.search_similar(
            embedding=query_embedding,
            threshold=threshold,
            top_k=top_k
        )
        
        # Filter by minimum executions
        if min_executions > 0:
            results = [
                node for node in results
                if node.total_executions >= min_executions
            ]
        
        # Sort by quality score
        results.sort(key=lambda x: x.quality_score, reverse=True)
        
        logger.info(f"Found {len(results)} similar nodes for query")
        
        return results[:top_k]
    
    def get_node(self, node_id: str) -> Optional[GraphNode]:
        """Get node by ID"""
        return self.node_index.get(node_id)
    
    def update_execution_result(
        self,
        node_id: str,
        success: bool,
        duration: float,
        metadata: Optional[Dict] = None
    ):
        """
        Update node with execution result
        
        Args:
            node_id: Node ID
            success: Whether execution succeeded
            duration: Execution duration in seconds
            metadata: Optional execution metadata
        """
        
        node = self.get_node(node_id)
        if not node:
            logger.warning(f"Node {node_id} not found")
            return
        
        # Update execution stats
        node.update_execution_stats(success, duration)
        
        # Update metadata if provided
        if metadata:
            node.metadata.update(metadata)
        
        # Persist changes
        self.backend.update_node(node)
        
        logger.debug(
            f"Updated node {node_id[:8]}...: "
            f"success={success}, duration={duration:.2f}s"
        )
    
    def get_statistics(self) -> Dict[str, Any]:
        """Get graph statistics"""
        
        if not self.node_index:
            return {
                'total_nodes': 0,
                'total_executions': 0,
                'average_success_rate': 0.0
            }
        
        total_executions = sum(n.total_executions for n in self.node_index.values())
        total_successes = sum(n.successful_executions for n in self.node_index.values())
        
        avg_success_rate = (
            total_successes / total_executions if total_executions > 0 else 0.0
        )
        
        return {
            'total_nodes': len(self.node_index),
            'total_executions': total_executions,
            'average_success_rate': avg_success_rate,
            'nodes_with_embeddings': sum(
                1 for n in self.node_index.values() if n.embedding
            )
        }
    
    def save(self):
        """Save graph to storage"""
        self.backend.save()
        logger.info("Graph saved to storage")
    
    # ========================================================================
    # PRIVATE METHODS
    # ========================================================================
    
    def _initialize_backend(self, backend_type: str):
        """Initialize storage backend"""
        
        if backend_type == "networkx":
            return NetworkXBackend(self.config)
        
        # Add other backends as needed
        # elif backend_type == "neo4j":
        #     return Neo4jBackend(self.config)
        
        else:
            logger.warning(f"Unknown backend {backend_type}, using NetworkX")
            return NetworkXBackend(self.config)
    
    def _load_graph(self):
        """Load graph from storage"""
        
        try:
            nodes = self.backend.load()
            
            for node in nodes:
                self.node_index[node.id] = node
            
            logger.info(f"Loaded {len(nodes)} nodes from storage")
        
        except Exception as e:
            logger.warning(f"Failed to load graph: {e}")
    
    def _hash_code(self, code: str) -> str:
        """Generate hash for code deduplication"""
        
        # Normalize code (remove whitespace variations)
        normalized = '\n'.join(line.strip() for line in code.split('\n'))
        
        return hashlib.sha256(normalized.encode()).hexdigest()
    
    def _find_by_hash(self, code_hash: str) -> Optional[GraphNode]:
        """Find node by code hash"""
        
        for node in self.node_index.values():
            if node.code_hash == code_hash:
                return node
        
        return None
