# nodes/input/context_retrieval_node.py

"""
Context Retrieval Node
Retrieves relevant conversation history and context for query augmentation

This node:
- Fetches conversation history for the current session
- Performs semantic search for relevant past conversations
- Extracts dependency information from previous steps
- Builds rich context for query augmentation
- Handles context window management
"""

from typing import Dict, Any, List, Optional
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from nodes.base_node import BaseNode
from conversation.history_manager import ConversationHistoryManager
from monitoring.logger import get_logger

logger = get_logger(__name__)


# ============================================================================
# DATA STRUCTURES
# ============================================================================

@dataclass
class Message:
    """Individual conversation message"""
    id: str
    session_id: str
    role: str  # 'user', 'assistant', 'system'
    content: str
    timestamp: datetime
    metadata: Dict[str, Any] = field(default_factory=dict)
    
    def to_dict(self) -> Dict:
        return {
            'id': self.id,
            'session_id': self.session_id,
            'role': self.role,
            'content': self.content,
            'timestamp': self.timestamp.isoformat(),
            'metadata': self.metadata
        }


@dataclass
class ConversationContext:
    """Retrieved conversation context"""
    session_id: str
    current_query: str
    
    # Recent conversation history
    recent_messages: List[Message] = field(default_factory=list)
    
    # Semantically similar past conversations
    similar_conversations: List[Dict[str, Any]] = field(default_factory=list)
    
    # Previous steps in current workflow
    previous_steps: List[Dict[str, Any]] = field(default_factory=list)
    
    # Extracted dependencies
    dependencies: Dict[str, Any] = field(default_factory=dict)
    
    # Context statistics
    total_messages: int = 0
    context_window_tokens: int = 0
    retrieval_timestamp: str = field(default_factory=lambda: datetime.now().isoformat())
    
    def to_dict(self) -> Dict:
        """Convert to dictionary for storage"""
        return {
            'session_id': self.session_id,
            'current_query': self.current_query,
            'recent_messages': [msg.to_dict() for msg in self.recent_messages],
            'similar_conversations': self.similar_conversations,
            'previous_steps': self.previous_steps,
            'dependencies': self.dependencies,
            'total_messages': self.total_messages,
            'context_window_tokens': self.context_window_tokens,
            'retrieval_timestamp': self.retrieval_timestamp
        }
    
    def get_formatted_history(self, max_messages: int = 10) -> str:
        """Format recent messages as readable text"""
        messages = self.recent_messages[-max_messages:]
        
        formatted = []
        for msg in messages:
            role = msg.role.upper()
            content = msg.content[:200] + "..." if len(msg.content) > 200 else msg.content
            formatted.append(f"[{role}]: {content}")
        
        return "\n".join(formatted)


# ============================================================================
# MAIN NODE
# ============================================================================

class ContextRetrievalNode(BaseNode):
    """
    Context Retrieval Node - Fetches relevant conversation context
    
    Responsibilities:
    1. Get conversation history for current session
    2. Perform semantic search for similar past conversations
    3. Extract dependencies from previous workflow steps
    4. Identify referenced entities (files, variables, etc.)
    5. Build comprehensive context object
    6. Manage context window size
    
    This provides rich context for query augmentation.
    """
    
    def __init__(
        self,
        name: Optional[str] = None,
        max_recent_messages: int = 10,
        max_similar_conversations: int = 5,
        context_window_days: int = 7,
        enable_semantic_search: bool = True
    ):
        super().__init__(name or "ContextRetrieval")
        
        # Configuration
        self.max_recent_messages = max_recent_messages
        self.max_similar_conversations = max_similar_conversations
        self.context_window_days = context_window_days
        self.enable_semantic_search = enable_semantic_search
        
        # Will be initialized in prep
        self.history_manager = None
        self.dependency_extractor = DependencyExtractor()
    
    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        """Prepare data for context retrieval"""
        self.log_entry(shared)
        
        # Get configuration
        config = self.get_config(shared)
        
        # Initialize conversation history manager
        if self.history_manager is None:
            self.history_manager = ConversationHistoryManager(config)
        
        # Get session ID and query
        session_id = self.require_from_shared(shared, 'session_id')
        
        # Get current query (sanitized version)
        current_query = shared.get('user_query') or shared.get('validated_query', {}).get('sanitized_query')
        
        if not current_query:
            self.logger.warning("No current query found for context retrieval")
            current_query = ""
        
        # Get any existing workflow steps
        previous_steps = shared.get('step_results', [])
        
        return {
            'session_id': session_id,
            'current_query': current_query,
            'previous_steps': previous_steps,
            'config': config
        }
    
    def exec(self, prep_result: Dict[str, Any]) -> ConversationContext:
        """
        Retrieve conversation context
        
        Steps:
        1. Fetch recent conversation history
        2. Perform semantic search for similar conversations (if enabled)
        3. Extract dependencies from previous steps
        4. Build context object
        """
        session_id = prep_result['session_id']
        current_query = prep_result['current_query']
        previous_steps = prep_result['previous_steps']
        
        self.logger.info(f"Retrieving context for session: {session_id}")
        
        # Step 1: Get recent conversation history
        recent_messages = self._get_recent_history(session_id)
        self.logger.info(f"Retrieved {len(recent_messages)} recent messages")
        
        # Step 2: Get similar conversations (semantic search)
        similar_conversations = []
        if self.enable_semantic_search and current_query:
            similar_conversations = self._get_similar_conversations(
                current_query,
                session_id
            )
            self.logger.info(f"Found {len(similar_conversations)} similar conversations")
        
        # Step 3: Extract dependencies
        dependencies = self.dependency_extractor.extract_dependencies(
            current_query=current_query,
            recent_messages=recent_messages,
            previous_steps=previous_steps
        )
        
        if dependencies:
            self.logger.debug(f"Extracted dependencies: {dependencies}")
        
        # Step 4: Build context object
        context = ConversationContext(
            session_id=session_id,
            current_query=current_query,
            recent_messages=recent_messages,
            similar_conversations=similar_conversations,
            previous_steps=previous_steps,
            dependencies=dependencies,
            total_messages=len(recent_messages)
        )
        
        # Estimate token count
        context.context_window_tokens = self._estimate_tokens(context)
        
        self.logger.info(
            f"Context retrieval complete. "
            f"Messages: {len(recent_messages)}, "
            f"Similar: {len(similar_conversations)}, "
            f"Est. tokens: {context.context_window_tokens}"
        )
        
        return context
    
    def post(
        self,
        shared: Dict[str, Any],
        prep_result: Dict[str, Any],
        exec_result: ConversationContext
    ) -> str:
        """Store context in shared state"""
        
        # Store full context object
        shared['conversation_context'] = exec_result.to_dict()
        
        # Store for easy access
        shared['conversation_history'] = [msg.to_dict() for msg in exec_result.recent_messages]
        shared['previous_steps'] = exec_result.previous_steps
        shared['context_dependencies'] = exec_result.dependencies
        
        # Store formatted history for prompts
        shared['formatted_history'] = exec_result.get_formatted_history()
        
        # Update workflow metadata
        if 'workflow_metadata' not in shared:
            shared['workflow_metadata'] = {}
        
        shared['workflow_metadata'].update({
            'context_messages_count': exec_result.total_messages,
            'context_tokens_estimate': exec_result.context_window_tokens,
            'context_retrieved_at': exec_result.retrieval_timestamp
        })
        
        self.logger.info("Context stored in shared state")
        self.log_exit('default')
        
        return 'default'
    
    # ========================================================================
    # PRIVATE METHODS
    # ========================================================================
    
    def _get_recent_history(self, session_id: str) -> List[Message]:
        """Get recent conversation history for the session"""
        
        try:
            # Get messages from history manager
            messages_data = self.history_manager.get_history(
                session_id=session_id,
                limit=self.max_recent_messages
            )
            
            # Convert to Message objects
            messages = []
            for msg_data in messages_data:
                message = Message(
                    id=msg_data.get('id', ''),
                    session_id=msg_data.get('session_id', session_id),
                    role=msg_data.get('role', 'user'),
                    content=msg_data.get('content', ''),
                    timestamp=self._parse_timestamp(msg_data.get('timestamp')),
                    metadata=msg_data.get('metadata', {})
                )
                messages.append(message)
            
            return messages
        
        except Exception as e:
            self.logger.error(f"Failed to retrieve conversation history: {e}")
            return []
    
    def _get_similar_conversations(
        self,
        query: str,
        current_session_id: str
    ) -> List[Dict[str, Any]]:
        """
        Find similar conversations using semantic search
        
        This helps provide context from past similar queries.
        """
        
        try:
            # Use history manager's search functionality
            similar = self.history_manager.search_relevant(
                query=query,
                k=self.max_similar_conversations,
                exclude_session=current_session_id
            )
            
            return similar
        
        except Exception as e:
            self.logger.error(f"Failed to search similar conversations: {e}")
            return []
    
    def _estimate_tokens(self, context: ConversationContext) -> int:
        """
        Estimate approximate token count for the context
        
        Rough estimate: ~4 characters per token
        """
        
        total_chars = 0
        
        # Recent messages
        for msg in context.recent_messages:
            total_chars += len(msg.content)
        
        # Similar conversations
        for conv in context.similar_conversations:
            total_chars += len(conv.get('content', ''))
        
        # Previous steps
        for step in context.previous_steps:
            total_chars += len(str(step))
        
        # Rough token estimate
        estimated_tokens = total_chars // 4
        
        return estimated_tokens
    
    def _parse_timestamp(self, timestamp_str: Any) -> datetime:
        """Parse timestamp string to datetime object"""
        
        if isinstance(timestamp_str, datetime):
            return timestamp_str
        
        if isinstance(timestamp_str, str):
            try:
                return datetime.fromisoformat(timestamp_str.replace('Z', '+00:00'))
            except:
                pass
        
        # Fallback to current time
        return datetime.now()


# ============================================================================
# DEPENDENCY EXTRACTOR
# ============================================================================

class DependencyExtractor:
    """
    Extract dependencies from conversation and previous steps
    
    Dependencies include:
    - References to previous outputs
    - File references from earlier steps
    - Variable references
    - Implicit dependencies (e.g., "the data" referring to previous load)
    """
    
    # Pronouns and references that indicate dependencies
    REFERENCE_PATTERNS = [
        'the data', 'the file', 'the result', 'the output',
        'it', 'them', 'those', 'that', 'this',
        'previous', 'earlier', 'above', 'from before'
    ]
    
    def extract_dependencies(
        self,
        current_query: str,
        recent_messages: List[Message],
        previous_steps: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """
        Extract dependencies from context
        
        Returns:
            Dictionary of dependencies
        """
        
        dependencies = {
            'has_references': False,
            'reference_patterns': [],
            'file_dependencies': [],
            'step_dependencies': [],
            'variable_dependencies': []
        }
        
        query_lower = current_query.lower()
        
        # Check for reference patterns
        for pattern in self.REFERENCE_PATTERNS:
            if pattern in query_lower:
                dependencies['has_references'] = True
                dependencies['reference_patterns'].append(pattern)
        
        # Extract file dependencies from previous steps
        for step in previous_steps:
            if 'code_path' in step:
                dependencies['file_dependencies'].append(step['code_path'])
            
            # Check if this step is referenced
            step_id = step.get('step_id', '')
            if step_id and step_id in query_lower:
                dependencies['step_dependencies'].append(step_id)
        
        # Extract variable dependencies from recent messages
        # Look for assignments in assistant messages
        for msg in recent_messages:
            if msg.role == 'assistant':
                # Simple pattern: look for "stored in", "saved as", etc.
                if 'stored in' in msg.content.lower() or 'saved as' in msg.content.lower():
                    # This is a simplified extraction
                    # In production, you'd use more sophisticated NLP
                    dependencies['variable_dependencies'].append({
                        'message_id': msg.id,
                        'content_snippet': msg.content[:100]
                    })
        
        return dependencies


# ============================================================================
# CONTEXT SUMMARIZER
# ============================================================================

class ContextSummarizer:
    """
    Summarize conversation context when it's too long
    
    This helps fit context into token limits while preserving
    the most important information.
    """
    
    def __init__(self, max_tokens: int = 2000):
        self.max_tokens = max_tokens
    
    def summarize(
        self,
        context: ConversationContext,
        current_token_count: int
    ) -> ConversationContext:
        """
        Summarize context if it exceeds token limit
        
        Strategy:
        1. Keep most recent messages
        2. Summarize older messages
        3. Keep only most relevant similar conversations
        """
        
        if current_token_count <= self.max_tokens:
            return context
        
        # Keep last 5 messages verbatim
        recent_to_keep = 5
        context.recent_messages = context.recent_messages[-recent_to_keep:]
        
        # Keep only top 2 similar conversations
        context.similar_conversations = context.similar_conversations[:2]
        
        # Recalculate token estimate
        context.context_window_tokens = self._estimate_tokens(context)
        
        return context
    
    def _estimate_tokens(self, context: ConversationContext) -> int:
        """Estimate tokens (same as in main node)"""
        total_chars = sum(len(msg.content) for msg in context.recent_messages)
        return total_chars // 4


# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

def format_context_for_prompt(context: ConversationContext) -> str:
    """
    Format context into a string suitable for LLM prompts
    
    Returns:
        Formatted context string
    """
    
    sections = []
    
    # Recent conversation
    if context.recent_messages:
        sections.append("RECENT CONVERSATION:")
        for msg in context.recent_messages[-5:]:  # Last 5 messages
            role = msg.role.upper()
            content = msg.content[:200]
            sections.append(f"  [{role}]: {content}")
    
    # Dependencies
    if context.dependencies.get('has_references'):
        sections.append("\nREFERENCED ELEMENTS:")
        if context.dependencies.get('file_dependencies'):
            sections.append(f"  Files: {', '.join(context.dependencies['file_dependencies'][:3])}")
        if context.dependencies.get('reference_patterns'):
            sections.append(f"  References: {', '.join(context.dependencies['reference_patterns'][:3])}")
    
    # Previous steps
    if context.previous_steps:
        sections.append(f"\nPREVIOUS STEPS: {len(context.previous_steps)} completed")
    
    return "\n".join(sections)


def get_referenced_files(context: ConversationContext) -> List[str]:
    """
    Extract all file references from context
    
    Returns:
        List of file paths/names
    """
    
    files = set()
    
    # From dependencies
    if context.dependencies.get('file_dependencies'):
        files.update(context.dependencies['file_dependencies'])
    
    # From messages
    for msg in context.recent_messages:
        # Simple pattern matching for file extensions
        import re
        file_patterns = r'\b\w+\.(parquet|csv|xlsx?|json|txt)\b'
        matches = re.findall(file_patterns, msg.content, re.IGNORECASE)
        files.update(matches)
    
    return list(files)


# ============================================================================
# EXAMPLE USAGE
# ============================================================================

if __name__ == '__main__':
    """
    Example usage of ContextRetrievalNode
    """
    
    from config.settings import settings
    
    # Create node
    node = ContextRetrievalNode(
        max_recent_messages=10,
        max_similar_conversations=5,
        enable_semantic_search=True
    )
    
    # Simulate shared state
    shared = {
        'config': settings,
        'session_id': 'test-session-123',
        'user_query': 'Now calculate the average for that data',
        'step_results': [
            {
                'step_id': 'step-1',
                'code_path': '/outputs/session/step_1.py',
                'success': True
            }
        ]
    }
    
    # Execute node
    try:
        prep_result = node.prep(shared)
        context = node.exec(prep_result)
        node.post(shared, prep_result, context)
        
        # Display results
        print("Context Retrieval Results:")
        print(f"  Recent messages: {len(context.recent_messages)}")
        print(f"  Similar conversations: {len(context.similar_conversations)}")
        print(f"  Dependencies found: {context.dependencies.get('has_references')}")
        print(f"  Estimated tokens: {context.context_window_tokens}")
        
        if context.dependencies.get('reference_patterns'):
            print(f"  References: {context.dependencies['reference_patterns']}")
        
        # Show formatted context
        print("\nFormatted Context:")
        print(format_context_for_prompt(context))
        
    except Exception as e:
        print(f"Error: {e}")