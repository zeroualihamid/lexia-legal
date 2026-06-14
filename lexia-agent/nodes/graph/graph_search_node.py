# nodes/graph/graph_search_node.py

"""
Graph Search Node
Searches the reasoning graph for similar, reusable code

This node:
- Searches for semantically similar code in the graph
- Ranks results by similarity and success rate
- Evaluates if found code is suitable for reuse
- Provides code and metadata for potential reuse
- Routes to debate or generation based on findings

Key to enabling code reuse across workflows.
"""

from typing import Dict, Any, List, Optional, Tuple
from dataclasses import dataclass, field
from datetime import datetime

from nodes.base_node import BaseNode
from nodes.utils.step_requirements import plan_step_to_requirements
from graph.reasoning_graph import ReasoningGraph
from monitoring.logger import get_logger

logger = get_logger(__name__)


def _set_step_requirements_for_generation(shared: Dict[str, Any], prep_result: Dict[str, Any]) -> None:
    """Set shared['step_requirements'] from current plan step so CodeGenerationNode uses it."""
    step = prep_result.get('step') or {}
    current_index = shared.get('current_step_index', 0)
    shared['step_requirements'] = plan_step_to_requirements(step, current_index)


# ============================================================================
# DATA STRUCTURES
# ============================================================================

@dataclass
class SearchResult:
    """Individual search result from the graph"""
    node_id: str
    code: str
    similarity: float
    success_rate: float
    total_executions: int
    average_duration: float
    metadata: Dict[str, Any]
    last_used: Optional[str] = None
    
    @property
    def quality_score(self) -> float:
        """
        Combined quality score
        
        Formula: similarity * 0.6 + success_rate * 0.3 + recency_bonus * 0.1
        """
        base_score = (self.similarity * 0.6) + (self.success_rate * 0.3)
        
        # Recency bonus (used recently = higher score)
        recency_bonus = 0.1 if self.total_executions > 5 else 0.05
        
        return min(1.0, base_score + recency_bonus)
    
    def to_dict(self) -> Dict:
        return {
            'node_id': self.node_id,
            'code': self.code,
            'similarity': self.similarity,
            'success_rate': self.success_rate,
            'total_executions': self.total_executions,
            'average_duration': self.average_duration,
            'quality_score': self.quality_score,
            'metadata': self.metadata,
            'last_used': self.last_used
        }


@dataclass
class GraphSearchResult:
    """Result of graph search operation"""
    found_matches: bool
    best_match: Optional[SearchResult]
    all_matches: List[SearchResult] = field(default_factory=list)
    search_query: str = ""
    total_searched: int = 0
    search_time: float = 0.0
    
    def to_dict(self) -> Dict:
        return {
            'found_matches': self.found_matches,
            'best_match': self.best_match.to_dict() if self.best_match else None,
            'all_matches': [m.to_dict() for m in self.all_matches],
            'search_query': self.search_query,
            'total_searched': self.total_searched,
            'search_time': self.search_time,
            'num_matches': len(self.all_matches)
        }


# ============================================================================
# MAIN NODE
# ============================================================================

class GraphSearchNode(BaseNode):
    """
    Graph Search Node - Find reusable code in the reasoning graph
    
    Responsibilities:
    1. Extract search query from current step
    2. Search reasoning graph for similar code
    3. Rank results by quality score
    4. Evaluate if best match is suitable for reuse
    5. Provide recommendations for reuse or generation
    6. Route to debate (if found) or generation (if not found)
    
    This is the key node that enables code reuse.
    """
    
    def __init__(
        self,
        name: Optional[str] = None,
        similarity_threshold: float = 0.75,
        min_executions_for_trust: int = 3,
        top_k_results: int = 5
    ):
        super().__init__(name or "GraphSearch")
        self.similarity_threshold = similarity_threshold
        self.min_executions_for_trust = min_executions_for_trust
        self.top_k_results = top_k_results
        
        # Will be initialized in prep
        self.graph = None
        self.evaluator = ReuseEvaluator(similarity_threshold)
    
    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        """Prepare data for graph search"""
        self.log_entry(shared)
        
        config = self.get_config(shared)
        
        # Reuse the shared ReasoningGraph instance (loaded once at workflow creation)
        if self.graph is None:
            self.graph = shared.get('reasoning_graph')
        if self.graph is None:
            self.graph = ReasoningGraph(config)
            shared['reasoning_graph'] = self.graph
            logger.info(f"Loaded reasoning graph with {len(self.graph.node_index)} nodes")
        
        # Get current step
        plan_steps = shared.get('plan_steps', [])
        current_index = shared.get('current_step_index', 0)
        
        if current_index >= len(plan_steps):
            raise ValueError("No current step to search for")
        
        current_step = plan_steps[current_index]
        
        # Extract search query from step
        search_query = self._build_search_query(current_step)
        
        # Get configuration
        similarity_threshold = getattr(
            config,
            'similarity_threshold',
            self.similarity_threshold
        )
        
        return {
            'step': current_step,
            'search_query': search_query,
            'step_index': current_index,
            'similarity_threshold': similarity_threshold
        }
    
    def exec(self, prep_result: Dict[str, Any]) -> GraphSearchResult:
        """
        Search the reasoning graph for similar code
        
        Steps:
        1. Search graph using semantic similarity
        2. Filter by similarity threshold
        3. Rank by quality score
        4. Evaluate best match for reuse
        """
        import time
        
        search_query = prep_result['search_query']
        step = prep_result['step']
        threshold = prep_result['similarity_threshold']
        
        logger.info(f"Searching graph for: '{search_query[:50]}...'")
        logger.debug(f"Similarity threshold: {threshold}")
        
        # Start timing
        start_time = time.time()
        
        # Search the graph
        similar_nodes = self.graph.search_similar(
            query=search_query,
            threshold=threshold,
            top_k=self.top_k_results
        )
        
        search_duration = time.time() - start_time
        
        logger.info(f"Found {len(similar_nodes)} similar nodes in {search_duration:.3f}s")
        
        # If no matches found
        if not similar_nodes:
            logger.info("No similar code found in graph")
            return GraphSearchResult(
                found_matches=False,
                best_match=None,
                all_matches=[],
                search_query=search_query,
                total_searched=len(self.graph.node_index),
                search_time=search_duration
            )
        
        # Convert to SearchResult objects
        search_results = []
        for node in similar_nodes:
            # Calculate similarity (already provided by graph search)
            similarity = getattr(node, 'similarity', 0.0)
            
            search_result = SearchResult(
                node_id=node.id,
                code=node.code,
                similarity=similarity,
                success_rate=node.success_rate,
                total_executions=node.total_executions,
                average_duration=node.average_duration,
                metadata=node.metadata,
                last_used=node.last_used.isoformat() if node.last_used else None
            )
            search_results.append(search_result)
        
        # Sort by quality score
        search_results.sort(key=lambda x: x.quality_score, reverse=True)
        
        # Get best match
        best_match = search_results[0]
        
        logger.info(
            f"Best match: similarity={best_match.similarity:.2f}, "
            f"success_rate={best_match.success_rate:.2f}, "
            f"quality_score={best_match.quality_score:.2f}"
        )
        
        # Evaluate if suitable for reuse
        is_suitable = self.evaluator.evaluate(best_match, step)
        
        if is_suitable:
            logger.info("✓ Best match is suitable for reuse")
        else:
            logger.warning("✗ Best match does not meet reuse criteria")
        
        return GraphSearchResult(
            found_matches=True,
            best_match=best_match,
            all_matches=search_results,
            search_query=search_query,
            total_searched=len(self.graph.node_index),
            search_time=search_duration
        )
    
    def post(
        self,
        shared: Dict[str, Any],
        prep_result: Dict[str, Any],
        exec_result: GraphSearchResult
    ) -> str:
        """Store results and route to next node"""
        
        # Store search results
        shared['graph_search_result'] = exec_result.to_dict()
        
        if exec_result.found_matches and exec_result.best_match:
            # Store best match for easy access
            shared['best_match'] = exec_result.best_match.to_dict()
            shared['search_results'] = [r.to_dict() for r in exec_result.all_matches]
            
            # Check if suitable for reuse
            is_suitable = self.evaluator.evaluate(
                exec_result.best_match,
                prep_result['step']
            )
            
            if is_suitable:
                # Route to debate with reused code
                logger.info("Routing to debate with reused code")
                
                # Increment current_step_index to move to next step
                current_index = shared.get('current_step_index', 0)
                shared['current_step_index'] = current_index + 1
                logger.info(f"Step {current_index} completed (reused code), moving to step {current_index + 1}")
                
                self.log_exit('found_similar')
                return 'found_similar'
            else:
                # Best match not good enough, generate new
                logger.info("Best match not suitable, routing to generation")
                _set_step_requirements_for_generation(shared, prep_result)
                self.log_exit('no_match')
                return 'no_match'

        else:
            # No matches found, generate new code
            logger.info("No matches found, routing to generation")
            shared['best_match'] = None
            shared['search_results'] = []
            _set_step_requirements_for_generation(shared, prep_result)
            self.log_exit('no_match')
            return 'no_match'
    
    # ========================================================================
    # HELPER METHODS
    # ========================================================================
    
    def _build_search_query(self, step: Dict[str, Any]) -> str:
        """
        Build search query from step information
        
        Combines:
        - Step description
        - Expected inputs/outputs
        - Key requirements
        """
        
        query_parts = []
        
        # Main description
        description = step.get('description', '')
        if description:
            query_parts.append(description)
        
        # Add input/output information if available
        inputs = step.get('inputs', [])
        if inputs:
            query_parts.append(f"inputs: {', '.join(inputs)}")
        
        outputs = step.get('outputs', [])
        if outputs:
            query_parts.append(f"outputs: {', '.join(outputs)}")
        
        # Add key constraints or requirements
        constraints = step.get('constraints', [])
        if constraints:
            # Only add first 2 constraints to keep query focused
            query_parts.extend(constraints[:2])
        
        # Combine into single query
        query = ' '.join(query_parts)
        
        return query


# ============================================================================
# REUSE EVALUATOR
# ============================================================================

class ReuseEvaluator:
    """
    Evaluates if found code is suitable for reuse
    
    Criteria:
    - Similarity above threshold
    - Success rate acceptable
    - Sufficient execution history
    - No major incompatibilities
    """
    
    def __init__(self, similarity_threshold: float = 0.75):
        self.similarity_threshold = similarity_threshold
        self.min_success_rate = 0.7
        self.min_executions = 3
    
    def evaluate(
        self,
        search_result: SearchResult,
        step: Dict[str, Any]
    ) -> bool:
        """
        Evaluate if search result is suitable for reuse
        
        Returns:
            bool: True if suitable for reuse
        """
        
        reasons_to_reject = []
        
        # Check similarity
        if search_result.similarity < self.similarity_threshold:
            reasons_to_reject.append(
                f"Similarity {search_result.similarity:.2f} below threshold {self.similarity_threshold}"
            )
        
        # Check success rate (only if has execution history)
        if search_result.total_executions > 0:
            if search_result.success_rate < self.min_success_rate:
                reasons_to_reject.append(
                    f"Success rate {search_result.success_rate:.2f} below minimum {self.min_success_rate}"
                )
        
        # Check execution history (prefer proven code)
        if search_result.total_executions < self.min_executions:
            # This is a warning, not a rejection
            logger.debug(
                f"Code has only {search_result.total_executions} executions "
                f"(prefer {self.min_executions}+)"
            )
        
        # Check for explicit incompatibilities
        incompatibilities = self._check_incompatibilities(search_result, step)
        if incompatibilities:
            reasons_to_reject.extend(incompatibilities)
        
        # Decide
        if reasons_to_reject:
            logger.debug(f"Rejecting reuse: {', '.join(reasons_to_reject)}")
            return False
        
        return True
    
    def _check_incompatibilities(
        self,
        search_result: SearchResult,
        step: Dict[str, Any]
    ) -> List[str]:
        """
        Check for incompatibilities between found code and current step
        
        Returns:
            List of incompatibility reasons (empty if compatible)
        """
        
        incompatibilities = []
        
        # Check if step explicitly forbids reuse
        if step.get('force_generate'):
            incompatibilities.append("Step explicitly requires new generation")
        
        # Check version compatibility (if metadata includes version info)
        step_version = step.get('metadata', {}).get('required_version')
        code_version = search_result.metadata.get('version')
        
        if step_version and code_version:
            if step_version != code_version:
                incompatibilities.append(
                    f"Version mismatch: need {step_version}, found {code_version}"
                )
        
        # Check library dependencies
        step_libraries = set(step.get('required_libraries', []))
        code_libraries = set(search_result.metadata.get('libraries', []))
        
        if step_libraries and code_libraries:
            missing = step_libraries - code_libraries
            if missing:
                incompatibilities.append(
                    f"Missing required libraries: {missing}"
                )
        
        return incompatibilities


# ============================================================================
# SIMILARITY CALCULATOR
# ============================================================================

class SimilarityCalculator:
    """
    Calculate semantic similarity between queries and code
    
    This would typically use embeddings (CodeBERT, etc.)
    """
    
    @staticmethod
    def calculate_similarity(query: str, code: str) -> float:
        """
        Calculate similarity score between query and code
        
        In production, this would use:
        - Code embeddings (CodeBERT)
        - Semantic similarity (cosine distance)
        
        For now, simplified to keyword matching.
        
        Returns:
            float: Similarity score (0.0-1.0)
        """
        
        # Simplified similarity based on keyword overlap
        # In production, replace with embedding-based similarity
        
        query_lower = query.lower()
        code_lower = code.lower()
        
        # Common data processing keywords
        keywords = [
            'load', 'read', 'parquet', 'csv', 'filter', 'select',
            'calculate', 'sum', 'average', 'group', 'merge', 'join',
            'export', 'save', 'write'
        ]
        
        matches = 0
        total = 0
        
        for keyword in keywords:
            if keyword in query_lower:
                total += 1
                if keyword in code_lower:
                    matches += 1
        
        if total == 0:
            return 0.0
        
        return matches / total


# ============================================================================
# SEARCH STRATEGIES
# ============================================================================

class SearchStrategy:
    """Base class for search strategies"""
    
    def search(
        self,
        graph: ReasoningGraph,
        query: str,
        top_k: int
    ) -> List:
        raise NotImplementedError


class SemanticSearchStrategy(SearchStrategy):
    """Search using semantic similarity (embeddings)"""
    
    def search(self, graph, query, top_k):
        """Search using semantic embeddings"""
        return graph.search_similar(
            query=query,
            threshold=0.0,  # Get all, we'll filter later
            top_k=top_k
        )


class HybridSearchStrategy(SearchStrategy):
    """Combine semantic and keyword-based search"""
    
    def search(self, graph, query, top_k):
        """Hybrid search combining semantic and keyword matching"""
        
        # Get semantic results
        semantic_results = graph.search_similar(query=query, top_k=top_k * 2)
        
        # Re-rank with keyword boost
        for node in semantic_results:
            keyword_score = self._keyword_match_score(query, node.code)
            # Boost similarity with keyword score
            node.similarity = (node.similarity * 0.7) + (keyword_score * 0.3)
        
        # Sort by boosted similarity
        semantic_results.sort(key=lambda x: x.similarity, reverse=True)
        
        return semantic_results[:top_k]
    
    def _keyword_match_score(self, query: str, code: str) -> float:
        """Simple keyword matching score"""
        query_words = set(query.lower().split())
        code_words = set(code.lower().split())
        
        if not query_words:
            return 0.0
        
        matches = len(query_words & code_words)
        return matches / len(query_words)


# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

def format_search_results_for_display(results: List[SearchResult]) -> str:
    """
    Format search results as readable text
    
    Returns:
        str: Formatted results
    """
    
    if not results:
        return "No results found"
    
    lines = []
    lines.append(f"Found {len(results)} matches:\n")
    
    for i, result in enumerate(results, 1):
        lines.append(f"{i}. Node {result.node_id[:8]}...")
        lines.append(f"   Similarity: {result.similarity:.2%}")
        lines.append(f"   Success Rate: {result.success_rate:.2%}")
        lines.append(f"   Quality Score: {result.quality_score:.2%}")
        lines.append(f"   Executions: {result.total_executions}")
        lines.append(f"   Code Preview: {result.code[:100]}...")
        lines.append("")
    
    return "\n".join(lines)


def get_reuse_recommendation(
    search_result: GraphSearchResult,
    evaluator: ReuseEvaluator
) -> Dict[str, Any]:
    """
    Get recommendation about whether to reuse code
    
    Returns:
        Dict with recommendation and reasoning
    """
    
    if not search_result.found_matches:
        return {
            'recommend_reuse': False,
            'confidence': 0.0,
            'reasoning': 'No similar code found in graph'
        }
    
    best_match = search_result.best_match
    
    # Evaluate
    is_suitable = evaluator.evaluate(best_match, {})
    
    if is_suitable:
        return {
            'recommend_reuse': True,
            'confidence': best_match.quality_score,
            'reasoning': (
                f"High-quality match found (similarity={best_match.similarity:.2%}, "
                f"success_rate={best_match.success_rate:.2%})"
            ),
            'best_match_id': best_match.node_id
        }
    else:
        return {
            'recommend_reuse': False,
            'confidence': best_match.quality_score,
            'reasoning': 'Best match does not meet quality criteria',
            'best_match_id': best_match.node_id
        }


# ============================================================================
# EXAMPLE USAGE
# ============================================================================

if __name__ == '__main__':
    """
    Example usage of GraphSearchNode
    """
    
    from config.settings import settings
    
    # Create search node
    node = GraphSearchNode(
        similarity_threshold=0.75,
        top_k_results=5
    )
    
    # Simulate shared state
    shared = {
        'config': settings,
        'plan_steps': [
            {
                'id': 'step-1',
                'description': 'Load sales.parquet and filter by region',
                'inputs': ['file_path: str', 'region: str'],
                'outputs': ['DataFrame'],
                'constraints': ['Memory efficient', 'Handle missing data']
            }
        ],
        'current_step_index': 0
    }
    
    # Execute search
    try:
        prep_result = node.prep(shared)
        search_result = node.exec(prep_result)
        next_node = node.post(shared, prep_result, search_result)
        
        # Display results
        print("Graph Search Results:")
        print(f"  Found matches: {search_result.found_matches}")
        print(f"  Search time: {search_result.search_time:.3f}s")
        print(f"  Total nodes searched: {search_result.total_searched}")
        
        if search_result.found_matches:
            print(f"\nBest Match:")
            best = search_result.best_match
            print(f"  Node ID: {best.node_id}")
            print(f"  Similarity: {best.similarity:.2%}")
            print(f"  Success Rate: {best.success_rate:.2%}")
            print(f"  Quality Score: {best.quality_score:.2%}")
            print(f"  Executions: {best.total_executions}")
            
            print(f"\nAll Matches: {len(search_result.all_matches)}")
            for i, match in enumerate(search_result.all_matches[:3], 1):
                print(f"  {i}. Similarity: {match.similarity:.2%}, Quality: {match.quality_score:.2%}")
        
        print(f"\nNext Node: {next_node}")
        
    except Exception as e:
        print(f"Error: {e}")