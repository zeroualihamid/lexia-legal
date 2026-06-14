# nodes/output/conversation_update_node.py

"""
Conversation Update Node
Stores workflow results in conversation history for context retention

This node:
- Saves step execution results to conversation
- Updates conversation context with outcomes
- Stores code and results for future reference
- Enables conversation continuity
- Provides context for next queries
"""

from typing import Dict, Any, Optional
from datetime import datetime

from nodes.base_node import BaseNode
from conversation.history_manager import ConversationHistoryManager
from monitoring.logger import get_logger

logger = get_logger(__name__)


class ConversationUpdateNode(BaseNode):
    """
    Conversation Update Node - Store results in conversation history
    
    Responsibilities:
    1. Extract key results from workflow execution
    2. Format results for conversation storage
    3. Update conversation history
    4. Store code artifacts
    5. Maintain conversation continuity
    
    This ensures the assistant "remembers" what was executed
    for future queries in the session.
    """
    
    def __init__(self, name: Optional[str] = None):
        super().__init__(name or "ConversationUpdate")
        self.history_manager = None
    
    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        """Prepare conversation update data"""
        self.log_entry(shared)
        
        # Initialize history manager if needed
        if self.history_manager is None:
            config = self.get_config(shared)
            self.history_manager = ConversationHistoryManager(config)
        
        # Get session ID
        session_id = self.require_from_shared(shared, 'session_id')
        
        # Get original query
        original_query = shared.get('user_query', '')
        
        # Get step results
        step_results = shared.get('step_results', [])
        
        # Get execution statistics
        total_steps = len(step_results)
        successful_steps = sum(1 for s in step_results if s.get('success', False))
        
        # Get workflow metadata
        workflow_metadata = shared.get('workflow_metadata', {})
        
        self.logger.info(
            f"Preparing conversation update for {total_steps} steps "
            f"({successful_steps} successful)"
        )
        
        return {
            'session_id': session_id,
            'original_query': original_query,
            'step_results': step_results,
            'total_steps': total_steps,
            'successful_steps': successful_steps,
            'workflow_metadata': workflow_metadata
        }
    
    def exec(self, prep_result: Dict[str, Any]) -> Dict[str, Any]:
        """
        Update conversation history with results
        
        Steps:
        1. Format workflow summary
        2. Create assistant message with results
        3. Store in conversation history
        4. Store individual step details if needed
        """
        
        session_id = prep_result['session_id']
        original_query = prep_result['original_query']
        step_results = prep_result['step_results']
        total_steps = prep_result['total_steps']
        successful_steps = prep_result['successful_steps']
        
        # Build conversation message about execution
        message_content = self._build_result_message(
            original_query=original_query,
            step_results=step_results,
            total_steps=total_steps,
            successful_steps=successful_steps
        )
        
        # Store workflow metadata as a system artifact so it does not pollute
        # user-facing conversational context on follow-up turns.
        message_id = self.history_manager.add_message(
            session_id=session_id,
            role='system',
            content=message_content,
            metadata={
                'workflow_artifact': True,
                'workflow_execution': True,
                'total_steps': total_steps,
                'successful_steps': successful_steps,
                'step_ids': [s.get('step_id') for s in step_results]
            }
        )
        
        self.logger.info(f"Added workflow result to conversation: {message_id}")
        
        # Optionally store detailed step information
        if step_results:
            self._store_step_details(session_id, step_results)
        
        return {
            'message_id': message_id,
            'stored_steps': len(step_results),
            'message_content': message_content,
            'success': True
        }
    
    def post(
        self,
        shared: Dict[str, Any],
        prep_result: Dict[str, Any],
        exec_result: Dict[str, Any]
    ) -> str:
        """Store update confirmation"""
        
        # Store conversation update result
        shared['conversation_updated'] = exec_result
        
        self.logger.info(
            f"Conversation updated with {exec_result['stored_steps']} steps"
        )
        
        self.log_exit('default')
        return 'default'
    
    # ========================================================================
    # HELPER METHODS
    # ========================================================================
    
    def _build_result_message(
        self,
        original_query: str,
        step_results: list,
        total_steps: int,
        successful_steps: int
    ) -> str:
        """
        Build formatted message about workflow results
        
        Returns:
            str: Formatted message for conversation
        """
        
        lines = []
        
        # Summary
        if successful_steps == total_steps:
            lines.append(f"✓ Successfully completed all {total_steps} steps for your request.")
        elif successful_steps > 0:
            lines.append(
                f"Completed {successful_steps} of {total_steps} steps "
                f"({total_steps - successful_steps} failed)."
            )
        else:
            lines.append(f"✗ All {total_steps} steps failed.")
        
        # Step details
        if step_results:
            lines.append("\nSteps executed:")
            
            for i, step_result in enumerate(step_results, 1):
                step_id = step_result.get('step_id', f'step-{i}')
                success = step_result.get('success', False)
                code_path = step_result.get('code_path', '')
                duration = step_result.get('duration', 0)
                
                status = "✓" if success else "✗"
                
                # Get step description if available
                description = ""
                if code_path:
                    # Extract description from filename
                    from pathlib import Path
                    filename = Path(code_path).stem
                    # Remove step number prefix
                    description = filename.split('_', 2)[-1].replace('_', ' ')
                
                line = f"{i}. {status} {description or step_id}"
                
                if duration > 0:
                    line += f" ({duration:.2f}s)"
                
                lines.append(line)
        
        # Code files
        code_files = [
            s.get('code_path') for s in step_results 
            if s.get('code_path')
        ]
        
        if code_files:
            lines.append(f"\nGenerated {len(code_files)} code file(s).")
        
        return '\n'.join(lines)
    
    def _store_step_details(
        self,
        session_id: str,
        step_results: list
    ):
        """
        Store detailed step information in conversation
        
        Stores each step as a separate message for better context retrieval
        """
        
        for step_result in step_results:
            step_id = step_result.get('step_id', '')
            code_path = step_result.get('code_path', '')
            success = step_result.get('success', False)
            
            if code_path and success:
                # Store successful step details
                detail_message = (
                    f"Step {step_id} code stored at: {code_path}"
                )
                
                self.history_manager.add_message(
                    session_id=session_id,
                    role='system',
                    content=detail_message,
                    metadata={
                        'workflow_artifact': True,
                        'step_detail': True,
                        'step_id': step_id,
                        'code_path': code_path
                    }
                )


# ============================================================================
# CONTEXT BUILDER
# ============================================================================

class ConversationContextBuilder:
    """
    Build rich context from conversation history
    
    Extracts relevant information from past conversation
    for use in current query processing
    """
    
    def __init__(self, history_manager: ConversationHistoryManager):
        self.history_manager = history_manager
    
    def build_context(
        self,
        session_id: str,
        current_query: str,
        max_messages: int = 10
    ) -> Dict[str, Any]:
        """
        Build context from conversation history
        
        Returns:
            Dict with context information
        """
        
        # Get recent messages
        messages = self.history_manager.get_history(
            session_id=session_id,
            limit=max_messages
        )
        
        # Extract previous executions
        previous_executions = []
        for msg in messages:
            metadata = msg.get('metadata', {})
            if metadata.get('workflow_execution'):
                previous_executions.append({
                    'total_steps': metadata.get('total_steps'),
                    'successful_steps': metadata.get('successful_steps'),
                    'step_ids': metadata.get('step_ids', [])
                })
        
        # Extract code files
        code_files = []
        for msg in messages:
            metadata = msg.get('metadata', {})
            if metadata.get('step_detail'):
                code_files.append({
                    'step_id': metadata.get('step_id'),
                    'path': metadata.get('code_path')
                })
        
        return {
            'recent_messages': messages,
            'previous_executions': previous_executions,
            'code_files': code_files,
            'total_messages': len(messages)
        }


# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

def format_step_result_for_storage(step_result: Dict) -> str:
    """
    Format step result for conversation storage
    
    Returns:
        str: Human-readable step result
    """
    
    step_id = step_result.get('step_id', 'unknown')
    success = step_result.get('success', False)
    duration = step_result.get('duration', 0)
    
    status = "succeeded" if success else "failed"
    
    message = f"Step {step_id} {status}"
    
    if duration > 0:
        message += f" in {duration:.2f}s"
    
    if success and step_result.get('code_path'):
        message += f". Code: {step_result['code_path']}"
    
    return message


def extract_workflow_summary(shared: Dict[str, Any]) -> Dict[str, Any]:
    """
    Extract workflow summary from shared state
    
    Returns:
        Dict: Summary information
    """
    
    step_results = shared.get('step_results', [])
    
    total_steps = len(step_results)
    successful_steps = sum(1 for s in step_results if s.get('success', False))
    failed_steps = total_steps - successful_steps
    
    total_duration = sum(s.get('duration', 0) for s in step_results)
    
    return {
        'total_steps': total_steps,
        'successful_steps': successful_steps,
        'failed_steps': failed_steps,
        'success_rate': successful_steps / total_steps if total_steps > 0 else 0,
        'total_duration': total_duration,
        'average_step_duration': total_duration / total_steps if total_steps > 0 else 0
    }
