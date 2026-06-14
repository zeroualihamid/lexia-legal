# graph/embeddings/similarity_search.py

"""
Similarity Search
Fast semantic similarity search using cosine similarity or FAISS
"""

from typing import List, Tuple, Optional
import numpy as np

from monitoring.logger import get_logger

logger = get_logger(__name__)


class SimilaritySearch:
    """
    Similarity search engine for embeddings
    
    Supports:
    - Simple cosine similarity (default)
    - FAISS for large-scale (optional)
    
    Usage:
        search = SimilaritySearch()
        
        # Add embeddings
        search.add("node-1", [0.1, 0.2, ...])
        search.add("node-2", [0.3, 0.4, ...])
        
        # Search
        results = search.search(
            query_embedding=[0.15, 0.25, ...],
            threshold=0.75,
            top_k=5
        )
    """
    
    def __init__(self, use_faiss: bool = False):
        self.use_faiss = use_faiss
        
        # Simple storage: {node_id: embedding}
        self.embeddings: dict = {}
        self.node_ids: List[str] = []
        
        # FAISS index (if enabled)
        self.faiss_index = None
        
        if use_faiss:
            try:
                import faiss
                self._init_faiss()
                logger.info("FAISS enabled for similarity search")
            except ImportError:
                logger.warning("FAISS not available, using cosine similarity")
                self.use_faiss = False
    
    def _init_faiss(self):
        """Initialize FAISS index"""
        import faiss
        
        # Will be initialized when first embedding is added
        self.faiss_index = None
    
    def add(self, node_id: str, embedding: List[float]):
        """Add embedding to index"""
        
        embedding_array = np.array(embedding, dtype=np.float32)
        
        if self.use_faiss:
            self._add_faiss(node_id, embedding_array)
        else:
            self.embeddings[node_id] = embedding_array
            if node_id not in self.node_ids:
                self.node_ids.append(node_id)
    
    def update(self, node_id: str, embedding: List[float]):
        """Update existing embedding"""
        
        # For simplicity, treat as add (will overwrite)
        self.add(node_id, embedding)
    
    def search(
        self,
        query_embedding: List[float],
        threshold: float = 0.75,
        top_k: int = 5
    ) -> List[Tuple[str, float]]:
        """
        Search for similar embeddings
        
        Args:
            query_embedding: Query vector
            threshold: Minimum similarity (0-1)
            top_k: Number of results
            
        Returns:
            List of (node_id, similarity_score) tuples
        """
        
        if not self.embeddings and not self.faiss_index:
            return []
        
        query_array = np.array(query_embedding, dtype=np.float32)
        
        if self.use_faiss and self.faiss_index:
            return self._search_faiss(query_array, threshold, top_k)
        else:
            return self._search_cosine(query_array, threshold, top_k)
    
    def _search_cosine(
        self,
        query: np.ndarray,
        threshold: float,
        top_k: int
    ) -> List[Tuple[str, float]]:
        """Search using cosine similarity"""
        
        if not self.embeddings:
            return []
        
        # Calculate similarities
        similarities = []
        
        for node_id, embedding in self.embeddings.items():
            similarity = self._cosine_similarity(query, embedding)
            
            if similarity >= threshold:
                similarities.append((node_id, similarity))
        
        # Sort by similarity (descending)
        similarities.sort(key=lambda x: x[1], reverse=True)
        
        return similarities[:top_k]
    
    def _search_faiss(
        self,
        query: np.ndarray,
        threshold: float,
        top_k: int
    ) -> List[Tuple[str, float]]:
        """Search using FAISS"""
        
        import faiss
        
        if not self.faiss_index:
            return []
        
        # Reshape query for FAISS
        query = query.reshape(1, -1)
        
        # Search
        distances, indices = self.faiss_index.search(query, top_k)
        
        # Convert distances to similarities
        # FAISS returns L2 distance, convert to cosine similarity
        results = []
        for idx, distance in zip(indices[0], distances[0]):
            if idx >= 0 and idx < len(self.node_ids):
                # Convert L2 distance to similarity
                similarity = 1 / (1 + distance)
                
                if similarity >= threshold:
                    node_id = self.node_ids[idx]
                    results.append((node_id, float(similarity)))
        
        return results
    
    def _add_faiss(self, node_id: str, embedding: np.ndarray):
        """Add to FAISS index"""
        
        import faiss
        
        # Initialize index if needed
        if self.faiss_index is None:
            dimension = len(embedding)
            self.faiss_index = faiss.IndexFlatL2(dimension)
        
        # Add to index
        self.faiss_index.add(embedding.reshape(1, -1))
        
        # Track node ID
        if node_id not in self.node_ids:
            self.node_ids.append(node_id)
    
    @staticmethod
    def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
        """Calculate cosine similarity between two vectors"""
        
        dot_product = np.dot(a, b)
        norm_a = np.linalg.norm(a)
        norm_b = np.linalg.norm(b)
        
        if norm_a == 0 or norm_b == 0:
            return 0.0
        
        return float(dot_product / (norm_a * norm_b))
    
    def size(self) -> int:
        """Get number of indexed embeddings"""
        return len(self.embeddings) if not self.use_faiss else len(self.node_ids)
    
    def clear(self):
        """Clear all embeddings"""
        self.embeddings.clear()
        self.node_ids.clear()
        
        if self.use_faiss:
            self.faiss_index = None
