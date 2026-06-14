# nodes/output/response_formatter_node.py

"""
Response Formatter Node
Formats workflow results into a user-friendly response

This node:
- Formats execution results for user display
- Creates clear, actionable responses
- Includes success/failure summaries
- Provides code file locations
- Suggests next steps
- Handles different output formats (text, JSON, markdown)
"""

from typing import Dict, Any, Optional, List
from datetime import datetime
from pathlib import Path

from nodes.base_node import BaseNode
from conversation.history_manager import ConversationHistoryManager
from monitoring.logger import get_logger

logger = get_logger(__name__)


class ResponseFormatterNode(BaseNode):
    """
    Response Formatter Node - Format final user response
    
    Responsibilities:
    1. Extract workflow results
    2. Format in user-friendly way
    3. Include relevant details (code, outputs, errors)
    4. Provide actionable next steps
    5. Support multiple output formats
    
    This is the final node that creates the response shown to the user.
    """
    
    def __init__(
        self,
        name: Optional[str] = None,
        output_format: str = 'text'
    ):
        super().__init__(name or "ResponseFormatter")
        self.output_format = output_format  # 'text', 'json', 'markdown'
        self.history_manager = None
    
    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        """Prepare data for response formatting"""
        self.log_entry(shared)
        
        # Get original query
        original_query = shared.get('user_query', '')

        # Direct answer (no code execution, just text from LLM)
        direct_answer = shared.get('direct_answer')
        
        # Get step results
        step_results = shared.get('step_results', [])
        
        # Get workflow metadata
        workflow_metadata = shared.get('workflow_metadata', {})
        
        # Get execution summary
        total_steps = len(step_results)
        successful_steps = sum(1 for s in step_results if s.get('final_success', False))
        
        # Get code files
        code_files = [
            s.get('code_path') for s in step_results 
            if s.get('code_path')
        ]
        
        # Get any errors
        errors = []
        for step in step_results:
            if not step.get('final_success') and step.get('error'):
                errors.append({
                    'step_id': step.get('step_id'),
                    'error': step.get('error')
                })

        if direct_answer:
            self.logger.info("Formatting direct answer response")
        else:
            self.logger.info(
                f"Formatting response for {total_steps} steps "
                f"({successful_steps} successful)"
            )
        
        return {
            'original_query': original_query,
            'direct_answer': direct_answer,
            'step_results': step_results,
            'total_steps': total_steps,
            'successful_steps': successful_steps,
            'code_files': code_files,
            'errors': errors,
            'workflow_metadata': workflow_metadata
        }
    
    def exec(self, prep_result: Dict[str, Any]) -> Dict[str, Any]:
        """
        Format the final response
        
        Creates user-facing response based on workflow results
        """

        # Direct answer — pass through as-is (already markdown)
        direct_answer = prep_result.get('direct_answer')
        if direct_answer:
            return {
                'response': direct_answer,
                'format': self.output_format,
                'metrics': {'direct_answer': True},
                'success': True,
            }
        
        if self.output_format == 'json':
            response = self._format_json(prep_result)
        elif self.output_format == 'markdown':
            response = self._format_markdown(prep_result)
        else:  # text
            response = self._format_text(prep_result)
        
        # Calculate metrics
        metrics = self._calculate_metrics(prep_result)
        
        return {
            'response': response,
            'format': self.output_format,
            'metrics': metrics,
            'success': prep_result['successful_steps'] > 0
        }
    
    def post(
        self,
        shared: Dict[str, Any],
        prep_result: Dict[str, Any],
        exec_result: Dict[str, Any]
    ) -> str:
        """Store formatted response"""
        
        # Store final response
        shared['final_response'] = exec_result['response']
        shared['response_format'] = exec_result['format']
        shared['response_metrics'] = exec_result['metrics']

        self._store_chat_turn(shared, exec_result)
        
        self.logger.info(
            f"Response formatted ({len(exec_result['response'])} chars)"
        )
        
        self.log_exit('end')
        return 'end'

    def _store_chat_turn(self, shared: Dict[str, Any], exec_result: Dict[str, Any]) -> None:
        """Persist the actual user/assistant turn for future conversational context."""
        session_id = shared.get('session_id')
        if not session_id:
            return

        config = self.get_config(shared)
        if self.history_manager is None:
            self.history_manager = ConversationHistoryManager(config)

        user_query = (shared.get('user_query') or '').strip()
        final_response = (exec_result.get('response') or '').strip()
        run_id = shared.get('run_id')

        if user_query:
            self.history_manager.add_message(
                session_id=session_id,
                role='user',
                content=user_query,
                metadata={
                    'chat_turn': True,
                    'kind': 'user_query',
                    'run_id': run_id,
                },
            )

        if final_response:
            self.history_manager.add_message(
                session_id=session_id,
                role='assistant',
                content=final_response,
                metadata={
                    'chat_turn': True,
                    'kind': 'final_response',
                    'run_id': run_id,
                    'response_format': exec_result.get('format'),
                    'success': bool(exec_result.get('success', False)),
                },
            )
    
    # ========================================================================
    # FORMAT METHODS
    # ========================================================================
    
    def _format_text(self, prep_result: Dict) -> str:
        """Format as plain text"""
        
        lines = []
        
        # Header
        lines.append("=" * 60)
        lines.append("WORKFLOW EXECUTION COMPLETE")
        lines.append("=" * 60)
        lines.append("")
        
        # Summary
        total = prep_result['total_steps']
        successful = prep_result['successful_steps']
        
        if successful == total:
            lines.append(f"✓ All {total} steps completed successfully!")
        elif successful > 0:
            lines.append(f"⚠ {successful} of {total} steps completed ({total - successful} failed)")
        else:
            lines.append(f"✗ All {total} steps failed")
        
        lines.append("")
        
        # Step details
        if prep_result['step_results']:
            lines.append("Step Details:")
            lines.append("-" * 60)

            for i, step in enumerate(prep_result['step_results'], 1):
                step_id = step.get('step_id', f'step-{i}')
                description = step.get('description', '')
                success = step.get('final_success', False)
                duration = step.get('duration', 0)

                status = "✓" if success else "✗"
                line = f"{i}. {status} {step_id}"

                if duration > 0:
                    line += f" ({duration:.2f}s)"

                lines.append(line)

                # Add description
                if description:
                    lines.append(f"   {description}")

                # Add code path if available
                if step.get('code_path'):
                    lines.append(f"   Code: {step['code_path']}")

                # Add execution output if available
                stdout = step.get('stdout', '').strip()
                if stdout:
                    lines.append(f"   Output:")
                    for out_line in stdout.split('\n')[:10]:
                        lines.append(f"     {out_line}")
                    if len(stdout.split('\n')) > 10:
                        lines.append(f"     ... ({len(stdout.split(chr(10)))} lines total)")

                # Add error if failed
                if not success and step.get('stderr'):
                    error_preview = str(step['stderr'])[:200]
                    lines.append(f"   Error: {error_preview}")
                elif not success and step.get('error'):
                    error_preview = str(step['error'])[:200]
                    lines.append(f"   Error: {error_preview}")

            lines.append("")
        
        # Code files
        if prep_result['code_files']:
            lines.append("Generated Code Files:")
            lines.append("-" * 60)
            for code_file in prep_result['code_files']:
                lines.append(f"  • {code_file}")
            lines.append("")
        
        # Errors summary
        if prep_result['errors']:
            lines.append("Errors:")
            lines.append("-" * 60)
            for error in prep_result['errors']:
                lines.append(f"  • {error['step_id']}: {error['error']}")
            lines.append("")
        
        # Footer
        lines.append("=" * 60)
        
        return '\n'.join(lines)
    
    def _format_markdown(self, prep_result: Dict) -> str:
        """Format as Markdown"""
        
        lines = []
        
        # Title
        lines.append("# Workflow Execution Complete")
        lines.append("")
        
        # Summary
        total = prep_result['total_steps']
        successful = prep_result['successful_steps']
        
        if successful == total:
            lines.append(f"✅ **All {total} steps completed successfully!**")
        elif successful > 0:
            lines.append(f"⚠️ **{successful} of {total} steps completed** ({total - successful} failed)")
        else:
            lines.append(f"❌ **All {total} steps failed**")
        
        lines.append("")
        
        # Steps
        if prep_result['step_results']:
            lines.append("## Steps Executed")
            lines.append("")
            
            for i, step in enumerate(prep_result['step_results'], 1):
                step_id = step.get('step_id', f'step-{i}')
                success = step.get('final_success', False)
                duration = step.get('duration', 0)
                
                status = "✅" if success else "❌"
                line = f"{i}. {status} **{step_id}**"
                
                if duration > 0:
                    line += f" _{duration:.2f}s_"
                
                lines.append(line)
                
                stdout = step.get('stdout', '').strip()
                if stdout:
                    lines.append("")
                    lines.append("**Output:**")
                    lines.append("")
                    has_table = '|' in stdout and '---' in stdout
                    if has_table:
                        for out_line in stdout.split('\n'):
                            lines.append(out_line)
                    else:
                        lines.append("```")
                        for out_line in stdout.split('\n'):
                            lines.append(out_line)
                        lines.append("```")
                
                if step.get('code_path'):
                    lines.append(f"   - Code: `{step['code_path']}`")
                
                if not success and step.get('error'):
                    lines.append(f"   - Error: {step['error']}")
                elif not success and step.get('stderr'):
                    lines.append(f"   - Error: `{str(step['stderr'])[:300]}`")
                
                lines.append("")
        
        # Code files
        if prep_result['code_files']:
            lines.append("## Generated Code")
            lines.append("")
            for code_file in prep_result['code_files']:
                lines.append(f"- `{code_file}`")
            lines.append("")
        
        return '\n'.join(lines)
    
    def _format_json(self, prep_result: Dict) -> str:
        """Format as JSON"""
        
        import json
        
        response_data = {
            'status': 'success' if prep_result['successful_steps'] > 0 else 'failure',
            'summary': {
                'total_steps': prep_result['total_steps'],
                'successful_steps': prep_result['successful_steps'],
                'failed_steps': prep_result['total_steps'] - prep_result['successful_steps']
            },
            'steps': [
                {
                    'step_id': step.get('step_id'),
                    'description': step.get('description', ''),
                    'success': step.get('final_success', False),
                    'duration': step.get('duration', 0),
                    'code_path': step.get('code_path'),
                    'stdout': step.get('stdout', ''),
                    'error': step.get('stderr') or step.get('error')
                }
                for step in prep_result['step_results']
            ],
            'code_files': prep_result['code_files'],
            'timestamp': datetime.now().isoformat()
        }
        
        return json.dumps(response_data, indent=2)
    
    def _calculate_metrics(self, prep_result: Dict) -> Dict[str, Any]:
        """Calculate response metrics"""
        
        step_results = prep_result['step_results']
        
        total_duration = sum(s.get('duration', 0) for s in step_results)
        
        return {
            'total_steps': prep_result['total_steps'],
            'successful_steps': prep_result['successful_steps'],
            'failed_steps': prep_result['total_steps'] - prep_result['successful_steps'],
            'success_rate': (
                prep_result['successful_steps'] / prep_result['total_steps']
                if prep_result['total_steps'] > 0 else 0
            ),
            'total_duration': total_duration,
            'average_step_duration': (
                total_duration / prep_result['total_steps']
                if prep_result['total_steps'] > 0 else 0
            ),
            'code_files_generated': len(prep_result['code_files'])
        }


# ============================================================================
# SPECIALIZED FORMATTERS
# ============================================================================

class CompactResponseFormatter(ResponseFormatterNode):
    """Compact response format for simple queries"""
    
    def _format_text(self, prep_result: Dict) -> str:
        """Compact text format"""
        
        total = prep_result['total_steps']
        successful = prep_result['successful_steps']
        
        if successful == total:
            return f"✓ Completed {total} steps successfully. Code files: {len(prep_result['code_files'])}"
        else:
            return f"⚠ Completed {successful}/{total} steps. {total - successful} failed."


class DetailedResponseFormatter(ResponseFormatterNode):
    """Detailed response with execution logs"""
    
    def _format_text(self, prep_result: Dict) -> str:
        """Detailed text format including logs"""
        
        # Get base format
        response = super()._format_text(prep_result)
        
        # Add execution logs
        lines = [response, "", "Execution Logs:", "-" * 60]
        
        for step in prep_result['step_results']:
            if step.get('stdout'):
                lines.append(f"\nStep {step.get('step_id')} output:")
                lines.append(step['stdout'][:500])  # First 500 chars
        
        return '\n'.join(lines)


# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

def create_success_response(
    step_results: List[Dict],
    code_files: List[str]
) -> str:
    """
    Create a success response
    
    Returns:
        str: Formatted success message
    """
    
    num_steps = len(step_results)
    num_files = len(code_files)
    
    message = f"✓ Successfully completed {num_steps} step{'s' if num_steps != 1 else ''}"
    
    if num_files > 0:
        message += f" and generated {num_files} code file{'s' if num_files != 1 else ''}"
    
    message += "."
    
    return message


def create_failure_response(
    step_results: List[Dict],
    errors: List[Dict]
) -> str:
    """
    Create a failure response
    
    Returns:
        str: Formatted failure message
    """
    
    num_steps = len(step_results)
    num_errors = len(errors)
    
    message = f"✗ Workflow failed with {num_errors} error{'s' if num_errors != 1 else ''} across {num_steps} steps."
    
    if errors:
        message += "\n\nErrors:\n"
        for error in errors[:3]:  # Show first 3 errors
            message += f"  • {error['step_id']}: {error['error']}\n"
        
        if len(errors) > 3:
            message += f"  ... and {len(errors) - 3} more"
    
    return message


def format_code_file_list(code_files: List[str]) -> str:
    """
    Format code files as a list
    
    Returns:
        str: Formatted list
    """
    
    if not code_files:
        return "No code files generated."
    
    lines = [f"Generated {len(code_files)} code file(s):"]
    
    for i, file_path in enumerate(code_files, 1):
        # Get just the filename
        filename = Path(file_path).name
        lines.append(f"  {i}. {filename}")
    
    return '\n'.join(lines)


def get_response_summary(formatted_response: str) -> Dict[str, Any]:
    """
    Extract summary from formatted response
    
    Returns:
        Dict: Summary information
    """
    
    return {
        'response_length': len(formatted_response),
        'line_count': len(formatted_response.split('\n')),
        'has_success_indicator': '✓' in formatted_response or '✅' in formatted_response,
        'has_failure_indicator': '✗' in formatted_response or '❌' in formatted_response
    }
