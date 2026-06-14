# nodes/input/query_input_node.py

"""
Query Input Node
Receives and validates user queries at the start of the workflow

This is typically the first node in the main workflow.
It handles:
- Query reception and validation
- Session initialization
- Input sanitization
- Query classification
- Initial logging and metrics
"""

from typing import Dict, Any, Optional
from dataclasses import dataclass
import re
from datetime import datetime

from nodes.base_node import BaseNode
from monitoring.logger import get_logger, set_trace_id, set_session_id, LogContext
from skill_registry import detect_skills_in_query

logger = get_logger(__name__)


# ============================================================================
# DATA STRUCTURES
# ============================================================================

@dataclass
class ValidatedQuery:
    """Validated and enriched user query"""
    raw_query: str
    sanitized_query: str
    session_id: str
    trace_id: str
    query_type: str  # 'data_processing', 'analysis', 'generation', 'unknown'
    complexity_estimate: str  # 'simple', 'moderate', 'complex'
    extracted_entities: Dict[str, Any]
    timestamp: str
    metadata: Dict[str, Any]
    
    def to_dict(self) -> Dict:
        """Convert to dictionary for storage in shared state"""
        return {
            'raw_query': self.raw_query,
            'sanitized_query': self.sanitized_query,
            'session_id': self.session_id,
            'trace_id': self.trace_id,
            'query_type': self.query_type,
            'complexity_estimate': self.complexity_estimate,
            'extracted_entities': self.extracted_entities,
            'timestamp': self.timestamp,
            'metadata': self.metadata
        }


# ============================================================================
# MAIN NODE
# ============================================================================

class QueryInputNode(BaseNode):
    """
    Query Input Node - Entry point for user queries
    
    Responsibilities:
    1. Receive user query from API/CLI/interface
    2. Validate query format and content
    3. Sanitize input to prevent injection attacks
    4. Initialize session and trace IDs
    5. Classify query type
    6. Extract entities (file names, operations, etc.)
    7. Estimate query complexity
    8. Store validated query in shared state
    
    This node sets up the foundation for the entire workflow.
    """
    
    def __init__(self, name: Optional[str] = None):
        super().__init__(name or "QueryInput")
        self.validator = QueryValidator()
        self.classifier = QueryClassifier()
        self.entity_extractor = EntityExtractor()
    
    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        """
        Prepare input data
        
        The query can come from various sources:
        - API request: shared['api_request']['query']
        - CLI: shared['cli_query']
        - Direct: shared['user_query']
        """
        self.log_entry(shared)
        
        # Try to get query from different sources
        query = None
        source = None
        
        # Check API request
        if 'api_request' in shared and 'query' in shared['api_request']:
            query = shared['api_request']['query']
            source = 'api'
        
        # Check CLI
        elif 'cli_query' in shared:
            query = shared['cli_query']
            source = 'cli'
        
        # Check direct input
        elif 'user_query' in shared:
            query = shared['user_query']
            source = 'direct'
        
        # Check for interactive input
        elif shared.get('interactive_mode'):
            query = self._get_interactive_input()
            source = 'interactive'
        
        if query is None:
            self.logger.error("No query found in shared state")
            raise ValueError(
                "QueryInputNode requires a query in shared state. "
                "Expected keys: 'api_request.query', 'cli_query', or 'user_query'"
            )
        
        # Get or create session ID
        session_id = (
            shared.get('session_id') or
            shared.get('api_request', {}).get('session_id') or
            self._generate_session_id()
        )
        
        # Get any additional metadata
        metadata = shared.get('metadata', {})
        metadata['source'] = source
        
        return {
            'query': query,
            'session_id': session_id,
            'metadata': metadata
        }
    
    def exec(self, prep_result: Dict[str, Any]) -> ValidatedQuery:
        """
        Validate and enrich the query
        
        Steps:
        1. Validate query format
        2. Sanitize input
        3. Generate trace ID
        4. Classify query type
        5. Extract entities
        6. Estimate complexity
        """
        query = prep_result['query']
        session_id = prep_result['session_id']
        metadata = prep_result['metadata']
        
        # Set up logging context
        trace_id = set_trace_id()
        set_session_id(session_id)
        
        with LogContext(
            trace_id=trace_id,
            session_id=session_id,
            source=metadata.get('source')
        ):
            self.logger.info(f"Received query: '{query[:100]}...'")
            
            # Step 1: Validate
            validation_result = self.validator.validate(query)
            if not validation_result.is_valid:
                self.logger.error(f"Query validation failed: {validation_result.errors}")
                raise ValueError(
                    f"Invalid query: {', '.join(validation_result.errors)}"
                )
            
            # Step 2: Sanitize
            sanitized_query = self.validator.sanitize(query)
            self.logger.debug(f"Query sanitized: '{sanitized_query[:100]}...'")
            
            # Step 3: Classify query type
            query_type = self.classifier.classify(sanitized_query)
            self.logger.info(f"Query classified as: {query_type}")
            
            # Step 4: Extract entities
            entities = self.entity_extractor.extract(sanitized_query)
            if entities:
                self.logger.debug(f"Extracted entities: {entities}")

            matched_skills = detect_skills_in_query(sanitized_query)
            if matched_skills:
                metadata['selected_skills'] = [skill.directory_name for skill in matched_skills]
                self.logger.info(
                    "Detected requested skills: %s",
                    ", ".join(skill.directory_name for skill in matched_skills),
                )
            
            # Step 5: Estimate complexity
            complexity = self.classifier.estimate_complexity(sanitized_query, entities)
            self.logger.info(f"Estimated complexity: {complexity}")
            
            # Step 6: Create validated query object
            validated_query = ValidatedQuery(
                raw_query=query,
                sanitized_query=sanitized_query,
                session_id=session_id,
                trace_id=trace_id,
                query_type=query_type,
                complexity_estimate=complexity,
                extracted_entities=entities,
                timestamp=datetime.now().isoformat(),
                metadata=metadata
            )
            
            self.logger.info("Query validation and enrichment complete")
            
            return validated_query
    
    def post(
        self,
        shared: Dict[str, Any],
        prep_result: Dict[str, Any],
        exec_result: ValidatedQuery
    ) -> str:
        """
        Store validated query and route to next node
        """
        # Store validated query in multiple formats
        shared['validated_query'] = exec_result.to_dict()
        shared['user_query'] = exec_result.sanitized_query
        shared['session_id'] = exec_result.session_id
        shared['trace_id'] = exec_result.trace_id
        
        # Store extracted entities for easy access
        shared['query_entities'] = exec_result.extracted_entities
        shared['selected_skills'] = exec_result.metadata.get('selected_skills', [])
        
        # Store query metadata
        if 'workflow_metadata' not in shared:
            shared['workflow_metadata'] = {}
        
        shared['workflow_metadata'].update({
            'query_received_at': exec_result.timestamp,
            'query_type': exec_result.query_type,
            'complexity_estimate': exec_result.complexity_estimate,
            'source': exec_result.metadata.get('source')
        })
        
        # Log metrics
        self._log_metrics(exec_result)
        
        self.logger.info("Query input processing complete")
        self.log_exit('default')
        
        return 'default'
    
    # ========================================================================
    # HELPER METHODS
    # ========================================================================
    
    def _get_interactive_input(self) -> str:
        """Get query from interactive console input"""
        try:
            query = input("Enter your query: ").strip()
            return query
        except (EOFError, KeyboardInterrupt):
            self.logger.warning("Interactive input cancelled")
            raise ValueError("No query provided")
    
    def _generate_session_id(self) -> str:
        """Generate a new session ID"""
        import uuid
        session_id = f"session-{uuid.uuid4().hex[:12]}"
        self.logger.debug(f"Generated new session ID: {session_id}")
        return session_id
    
    def _log_metrics(self, validated_query: ValidatedQuery):
        """Log metrics about the query"""
        try:
            # Log to metrics system if available
            metrics_data = {
                'event': 'query_received',
                'query_type': validated_query.query_type,
                'complexity': validated_query.complexity_estimate,
                'query_length': len(validated_query.raw_query),
                'entities_count': len(validated_query.extracted_entities),
                'source': validated_query.metadata.get('source')
            }
            
            self.logger.debug(f"Query metrics: {metrics_data}")
            
            # Could send to Prometheus, StatsD, etc.
            # metrics_client.increment('queries_received', tags=metrics_data)
            
        except Exception as e:
            self.logger.warning(f"Failed to log metrics: {e}")


# ============================================================================
# QUERY VALIDATOR
# ============================================================================

@dataclass
class ValidationResult:
    """Result of query validation"""
    is_valid: bool
    errors: list
    warnings: list


class QueryValidator:
    """
    Validates and sanitizes user queries
    
    Checks:
    - Length constraints
    - Character restrictions
    - Injection patterns
    - Format requirements
    """
    
    MIN_QUERY_LENGTH = 3
    MAX_QUERY_LENGTH = 5000
    
    # Patterns that might indicate injection attempts
    SUSPICIOUS_PATTERNS = [
        r'<script[^>]*>',  # Script tags
        r'javascript:',     # JavaScript protocol
        r'on\w+\s*=',      # Event handlers
        r'eval\s*\(',      # Eval calls
        r'exec\s*\(',      # Exec calls
    ]
    
    def validate(self, query: str) -> ValidationResult:
        """
        Validate query
        
        Returns:
            ValidationResult with validation status and any errors
        """
        errors = []
        warnings = []
        
        # Check type
        if not isinstance(query, str):
            errors.append("Query must be a string")
            return ValidationResult(False, errors, warnings)
        
        # Check length
        if len(query.strip()) < self.MIN_QUERY_LENGTH:
            errors.append(f"Query too short (minimum {self.MIN_QUERY_LENGTH} characters)")
        
        if len(query) > self.MAX_QUERY_LENGTH:
            errors.append(f"Query too long (maximum {self.MAX_QUERY_LENGTH} characters)")
        
        # Check for suspicious patterns
        for pattern in self.SUSPICIOUS_PATTERNS:
            if re.search(pattern, query, re.IGNORECASE):
                warnings.append(f"Suspicious pattern detected: {pattern}")
        
        # Check for empty after stripping
        if not query.strip():
            errors.append("Query is empty or contains only whitespace")
        
        is_valid = len(errors) == 0
        
        return ValidationResult(is_valid, errors, warnings)
    
    def sanitize(self, query: str) -> str:
        """
        Sanitize query to remove potentially harmful content
        
        Returns:
            Sanitized query string
        """
        # Strip leading/trailing whitespace
        sanitized = query.strip()
        
        # Replace multiple spaces with single space
        sanitized = re.sub(r'\s+', ' ', sanitized)
        
        # Remove any null bytes
        sanitized = sanitized.replace('\x00', '')
        
        # Remove control characters (except newlines and tabs)
        sanitized = ''.join(
            char for char in sanitized 
            if char in '\n\t' or not (0 <= ord(char) < 32)
        )
        
        return sanitized


# ============================================================================
# QUERY CLASSIFIER
# ============================================================================

class QueryClassifier:
    """
    Classify queries into categories based on content
    
    Categories:
    - data_processing: Load, transform, filter data
    - analysis: Calculate, analyze, summarize
    - generation: Create reports, visualizations
    - unknown: Cannot determine type
    """
    
    # Keywords for classification
    KEYWORDS = {
        'data_processing': [
            'load', 'read', 'import', 'fetch', 'get',
            'filter', 'select', 'where', 'join', 'merge',
            'transform', 'convert', 'parse', 'extract',
            'parquet', 'csv', 'excel', 'json', 'file'
        ],
        'analysis': [
            'calculate', 'compute', 'analyze', 'count',
            'sum', 'average', 'mean', 'median', 'std',
            'group', 'aggregate', 'summarize', 'statistics',
            'correlation', 'trend', 'pattern'
        ],
        'generation': [
            'create', 'generate', 'build', 'make',
            'plot', 'chart', 'graph', 'visualize',
            'report', 'export', 'save', 'write'
        ]
    }
    
    def classify(self, query: str) -> str:
        """
        Classify query into a category
        
        Returns:
            Category name ('data_processing', 'analysis', 'generation', 'unknown')
        """
        query_lower = query.lower()
        
        scores = {category: 0 for category in self.KEYWORDS}
        
        # Count keyword matches for each category
        for category, keywords in self.KEYWORDS.items():
            for keyword in keywords:
                if keyword in query_lower:
                    scores[category] += 1
        
        # Return category with highest score
        if max(scores.values()) > 0:
            return max(scores.items(), key=lambda x: x[1])[0]
        
        return 'unknown'
    
    def estimate_complexity(
        self,
        query: str,
        entities: Dict[str, Any]
    ) -> str:
        """
        Estimate query complexity
        
        Returns:
            'simple', 'moderate', or 'complex'
        """
        complexity_score = 0
        
        # Query length
        if len(query) > 200:
            complexity_score += 2
        elif len(query) > 100:
            complexity_score += 1
        
        # Number of entities
        entity_count = sum(len(v) if isinstance(v, list) else 1 for v in entities.values())
        if entity_count > 5:
            complexity_score += 2
        elif entity_count > 2:
            complexity_score += 1
        
        # Multiple operations
        operations = ['and', 'then', 'also', 'after', 'before']
        operation_count = sum(1 for op in operations if op in query.lower())
        if operation_count > 2:
            complexity_score += 2
        elif operation_count > 0:
            complexity_score += 1
        
        # Complex keywords
        complex_keywords = [
            'join', 'merge', 'pivot', 'reshape',
            'correlation', 'regression', 'cluster'
        ]
        if any(kw in query.lower() for kw in complex_keywords):
            complexity_score += 2
        
        # Determine complexity level
        if complexity_score >= 4:
            return 'complex'
        elif complexity_score >= 2:
            return 'moderate'
        else:
            return 'simple'


# ============================================================================
# ENTITY EXTRACTOR
# ============================================================================

class EntityExtractor:
    """
    Extract entities from queries
    
    Entities:
    - File names and paths
    - Column names
    - Operations
    - Date/time references
    """
    
    def extract(self, query: str) -> Dict[str, Any]:
        """
        Extract entities from query
        
        Returns:
            Dictionary of extracted entities
        """
        entities = {
            'file_references': [],
            'column_names': [],
            'operations': [],
            'date_references': []
        }
        
        # Extract file references
        entities['file_references'] = self._extract_file_references(query)
        
        # Extract column names (quoted strings)
        entities['column_names'] = self._extract_column_names(query)
        
        # Extract operations
        entities['operations'] = self._extract_operations(query)
        
        # Extract date references
        entities['date_references'] = self._extract_date_references(query)
        
        # Remove empty lists
        entities = {k: v for k, v in entities.items() if v}
        
        return entities
    
    def _extract_file_references(self, query: str) -> list:
        """Extract file paths and names"""
        files = []
        
        # Common file extensions
        patterns = [
            r'\b\w+\.parquet\b',
            r'\b\w+\.csv\b',
            r'\b\w+\.xlsx?\b',
            r'\b\w+\.json\b',
            r'\b\w+\.txt\b',
        ]
        
        for pattern in patterns:
            matches = re.findall(pattern, query, re.IGNORECASE)
            files.extend(matches)
        
        return list(set(files))  # Remove duplicates
    
    def _extract_column_names(self, query: str) -> list:
        """Extract column names (usually quoted)"""
        columns = []
        
        # Single quotes
        columns.extend(re.findall(r"'([^']+)'", query))
        
        # Double quotes
        columns.extend(re.findall(r'"([^"]+)"', query))
        
        return list(set(columns))
    
    def _extract_operations(self, query: str) -> list:
        """Extract operation keywords"""
        operations = []
        
        operation_keywords = [
            'load', 'read', 'filter', 'select', 'group',
            'calculate', 'sum', 'count', 'average', 'sort',
            'merge', 'join', 'export', 'save'
        ]
        
        query_lower = query.lower()
        for op in operation_keywords:
            if op in query_lower:
                operations.append(op)
        
        return operations
    
    def _extract_date_references(self, query: str) -> list:
        """Extract date/time references"""
        dates = []
        
        # Month names
        months = [
            'january', 'february', 'march', 'april', 'may', 'june',
            'july', 'august', 'september', 'october', 'november', 'december'
        ]
        
        query_lower = query.lower()
        for month in months:
            if month in query_lower:
                dates.append(month)
        
        # Year patterns
        years = re.findall(r'\b(20\d{2}|19\d{2})\b', query)
        dates.extend(years)
        
        return dates


# ============================================================================
# EXAMPLE USAGE
# ============================================================================

if __name__ == '__main__':
    """
    Example usage of QueryInputNode
    """
    
    # Create node
    node = QueryInputNode()
    
    # Simulate shared state with query
    shared = {
        'user_query': 'Load sales.parquet and calculate monthly revenue for 2023',
        'session_id': 'test-session-123'
    }
    
    # Execute node
    prep_result = node.prep(shared)
    validated_query = node.exec(prep_result)
    node.post(shared, prep_result, validated_query)
    
    # Check results
    print("Validated Query:")
    print(f"  Raw: {validated_query.raw_query}")
    print(f"  Sanitized: {validated_query.sanitized_query}")
    print(f"  Type: {validated_query.query_type}")
    print(f"  Complexity: {validated_query.complexity_estimate}")
    print(f"  Entities: {validated_query.extracted_entities}")
    print(f"  Session ID: {validated_query.session_id}")
    print(f"  Trace ID: {validated_query.trace_id}")
