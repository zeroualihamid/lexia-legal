# nodes/execution/result_handler_node.py

"""
Result Handler Node
Processes execution results and updates the reasoning graph

This node:
- Analyzes execution results (success/failure)
- Updates graph with execution data
- Extracts insights from output
- Determines next action
- Provides feedback for retries if needed
"""

from typing import Dict, Any, Optional, List
from dataclasses import dataclass
from datetime import datetime

from nodes.base_node import BaseNode
from monitoring.logger import get_logger

logger = get_logger(__name__)


@dataclass
class ProcessedResult:
    """Processed execution result with insights"""
    success: bool
    should_retry: bool
    insights: Dict[str, Any]
    feedback: List[str]
    next_action: str
    metadata: Dict[str, Any]
    
    def to_dict(self) -> Dict:
        return {
            'success': self.success,
            'should_retry': self.should_retry,
            'insights': self.insights,
            'feedback': self.feedback,
            'next_action': self.next_action,
            'metadata': self.metadata
        }


class ResultHandlerNode(BaseNode):
    """
    Result Handler Node - Process execution results
    
    Responsibilities:
    1. Analyze execution results
    2. Update reasoning graph with outcome
    3. Extract insights from output
    4. Determine if retry is needed
    5. Provide feedback for improvement
    6. Route to next step or retry
    
    This node closes the loop by feeding execution results back to the graph.
    """
    
    def __init__(self, name: Optional[str] = None):
        super().__init__(name or "ResultHandler")
        self.graph = None
    
    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        """Prepare result processing"""
        self.log_entry(shared)
        
        # Get execution result
        exec_result = shared.get('execution_result')
        
        if not exec_result:
            raise ValueError("No execution result to process")
        
        # Get code information
        code_path = shared.get('code_path')
        code = shared.get('approved_code') or shared.get('last_generated_code')
        
        # Get step information
        plan_steps = shared.get('plan_steps', [])
        current_index = shared.get('current_step_index', 0)
        current_step = plan_steps[current_index] if current_index < len(plan_steps) else {}
        
        # Get graph node ID if code was from graph
        best_match = shared.get('best_match')
        node_id = best_match.get('node_id') if best_match else None
        
        # Get configuration
        config = self.get_config(shared)
        
        # Reuse the shared ReasoningGraph instance (loaded once at workflow creation)
        if self.graph is None:
            self.graph = shared.get('reasoning_graph')
        if self.graph is None:
            try:
                from graph.reasoning_graph import ReasoningGraph
                self.graph = ReasoningGraph(config)
                shared['reasoning_graph'] = self.graph
            except Exception as e:
                self.logger.warning(f"Could not initialize ReasoningGraph: {e}")
                self.graph = None
        
        # Get retry information
        execution_attempts = shared.get('execution_attempts', 0)
        max_attempts = getattr(config, 'max_execution_attempts', 3)
        
        self.logger.info(
            f"Processing execution result (attempt {execution_attempts + 1}/{max_attempts})"
        )
        
        return {
            'exec_result': exec_result,
            'code': code,
            'code_path': code_path,
            'step': current_step,
            'node_id': node_id,
            'execution_attempts': execution_attempts,
            'max_attempts': max_attempts
        }
    
    def exec(self, prep_result: Dict[str, Any]) -> ProcessedResult:
        """
        Process execution result
        
        Steps:
        1. Analyze success/failure
        2. Extract insights from output
        3. Update graph with result
        4. Determine if retry needed
        5. Generate feedback
        """
        
        exec_result = prep_result['exec_result']
        code = prep_result['code']
        node_id = prep_result['node_id']
        step = prep_result['step']
        
        success = exec_result['success']
        duration = exec_result['duration']
        
        self.logger.info(
            f"Execution {'succeeded' if success else 'failed'} in {duration:.2f}s"
        )
        
        # Extract insights from execution
        insights = self._extract_insights(exec_result)
        
        # Update reasoning graph (best-effort — graph may not be available)
        if self.graph:
            try:
                if node_id:
                    self.logger.debug(f"Updating graph node: {node_id}")
                    self.graph.update_execution_result(
                        node_id=node_id,
                        success=success,
                        duration=duration,
                        metadata={'step_id': step.get('id')}
                    )
                else:
                    self.logger.debug("Adding new node to graph")
                    new_node_id = self.graph.add_node(
                        code=code,
                        metadata={
                            'step_id': step.get('id'),
                            'step_description': step.get('description'),
                            'created_from': 'generation'
                        },
                        description=step.get('description', '')
                    )
                    self.graph.update_execution_result(
                        node_id=new_node_id,
                        success=success,
                        duration=duration
                    )
                self.graph.save()
            except Exception as e:
                self.logger.warning(f"Graph update failed (non-fatal): {e}")
        
        # Determine if retry is needed
        should_retry, feedback = self._should_retry_execution(
            exec_result=exec_result,
            attempts=prep_result['execution_attempts'],
            max_attempts=prep_result['max_attempts']
        )
        
        # Determine next action
        if success:
            next_action = 'proceed_to_next_step'
        elif should_retry:
            next_action = 'retry_execution'
        else:
            next_action = 'mark_failed'
        
        self.logger.info(f"Next action: {next_action}")
        
        return ProcessedResult(
            success=success,
            should_retry=should_retry,
            insights=insights,
            feedback=feedback,
            next_action=next_action,
            metadata={
                'duration': duration,
                'exit_code': exec_result.get('exit_code'),
                'timed_out': exec_result.get('timed_out', False)
            }
        )
    
    def post(
        self,
        shared: Dict[str, Any],
        prep_result: Dict[str, Any],
        exec_result: ProcessedResult
    ) -> str:
        """Store processed results and route"""
        
        # Store processed result
        shared['processed_result'] = exec_result.to_dict()
        
        # Update execution attempts
        shared['execution_attempts'] = prep_result['execution_attempts'] + 1
        
        # Update step results
        if 'step_results' in shared and shared['step_results']:
            shared['step_results'][-1].update({
                'final_success': exec_result.success,
                'insights': exec_result.insights,
                'processed_at': datetime.now().isoformat()
            })
        
        # Store feedback for potential retry
        if exec_result.feedback:
            shared['execution_feedback'] = exec_result.feedback
        
        # Store execution stdout in step results for ResponseFormatterNode
        raw_result = shared.get('execution_result', {})
        if 'step_results' in shared and shared['step_results']:
            shared['step_results'][-1]['stdout'] = raw_result.get('stdout', '')
            shared['step_results'][-1]['stderr'] = raw_result.get('stderr', '')

        # Route based on next action
        if exec_result.next_action == 'proceed_to_next_step':
            # Advance to next step and reset state for next step
            current_index = shared.get('current_step_index', 0)
            shared['current_step_index'] = current_index + 1
            shared['generation_attempts'] = 0
            shared['execution_attempts'] = 0
            shared.pop('generation_feedback', None)
            self.logger.info(
                f"✓ Step {current_index} executed successfully, moving to step {current_index + 1}"
            )
            self.log_exit('success')
            return 'success'
        
        elif exec_result.next_action == 'retry_execution':
            # Store error as generation_feedback so CodeGenerationNode can fix it
            raw_stderr = raw_result.get('stderr', '')
            shared['generation_feedback'] = {
                'errors': exec_result.feedback or [f"Execution error: {raw_stderr[:500]}"]
            }
            # Remove stale step_results entry — CodeWriterNode will create a fresh one
            if 'step_results' in shared and shared['step_results']:
                shared['step_results'].pop()
            # Clear stale code state
            shared.pop('code_path', None)
            shared.pop('execution_result', None)
            self.logger.warning(
                f"Execution failed, routing back to code generation with error feedback "
                f"(attempt {shared.get('generation_attempts', 0)})"
            )
            self.log_exit('retry')
            return 'retry'

        else:  # mark_failed
            self.logger.error("Execution failed after max attempts, giving up on this step")
            # Advance to next step so the workflow doesn't get stuck
            current_index = shared.get('current_step_index', 0)
            shared['current_step_index'] = current_index + 1
            shared['generation_attempts'] = 0
            shared.pop('generation_feedback', None)
            self.log_exit('failed')
            return 'failed'
    
    # ========================================================================
    # ANALYSIS METHODS
    # ========================================================================
    
    def _extract_insights(self, exec_result: Dict) -> Dict[str, Any]:
        """
        Extract insights from execution output
        
        Analyzes stdout/stderr to find useful information
        """
        
        insights = {
            'has_output': False,
            'has_errors': False,
            'error_type': None,
            'output_summary': None
        }
        
        stdout = exec_result.get('stdout', '')
        stderr = exec_result.get('stderr', '')
        
        # Check for output
        if stdout and len(stdout.strip()) > 0:
            insights['has_output'] = True
            insights['output_summary'] = stdout[:200]  # First 200 chars
        
        # Analyze errors
        if stderr and len(stderr.strip()) > 0:
            insights['has_errors'] = True
            insights['error_type'] = self._classify_error(stderr)
            insights['error_summary'] = stderr[:200]
        
        # Check for timeout
        if exec_result.get('timed_out'):
            insights['timed_out'] = True
            insights['error_type'] = 'timeout'
        
        return insights
    
    def _classify_error(self, stderr: str) -> str:
        """
        Classify error type from stderr
        
        Returns error category
        """
        
        stderr_lower = stderr.lower()
        
        # Common error patterns
        if 'importerror' in stderr_lower or 'modulenotfounderror' in stderr_lower:
            return 'import_error'
        
        elif 'nameerror' in stderr_lower:
            return 'name_error'
        
        elif 'typeerror' in stderr_lower:
            return 'type_error'
        
        elif 'valueerror' in stderr_lower:
            return 'value_error'
        
        elif 'keyerror' in stderr_lower:
            return 'key_error'
        
        elif 'filenotfounderror' in stderr_lower:
            return 'file_not_found'
        
        elif 'memoryerror' in stderr_lower:
            return 'memory_error'
        
        elif 'syntaxerror' in stderr_lower:
            return 'syntax_error'
        
        elif 'indentationerror' in stderr_lower:
            return 'indentation_error'
        
        else:
            return 'unknown_error'
    
    def _should_retry_execution(
        self,
        exec_result: Dict,
        attempts: int,
        max_attempts: int
    ) -> tuple[bool, List[str]]:
        """
        Determine if code should be regenerated after execution failure.

        Since we regenerate code (not re-execute the same code), ALL error types
        are retryable — the LLM can fix syntax errors, import errors, type errors, etc.
        Only max attempts exhaustion stops the retry loop.

        Returns:
            (should_retry, feedback_list)
        """

        feedback = []

        # Don't retry if successful
        if exec_result['success']:
            return False, []

        # Don't retry if max attempts reached
        if attempts >= max_attempts:
            feedback.append(f"Maximum attempts ({max_attempts}) reached")
            return False, feedback

        # Parse error for feedback to the LLM
        stderr = exec_result.get('stderr', '')

        if 'importerror' in stderr.lower() or 'modulenotfounderror' in stderr.lower():
            feedback.append(f"ImportError — fix the import: {stderr[:300]}")

        elif 'syntaxerror' in stderr.lower() or 'indentationerror' in stderr.lower():
            feedback.append(f"SyntaxError — fix the code syntax: {stderr[:300]}")

        elif 'typeerror' in stderr.lower() or 'valueerror' in stderr.lower():
            feedback.append(f"TypeError/ValueError — ensure correct types (use pd.to_numeric for numeric columns): {stderr[:300]}")

        elif 'keyerror' in stderr.lower():
            feedback.append(f"KeyError — column name does not exist, use only columns from the schema: {stderr[:300]}")

        elif 'filenotfounderror' in stderr.lower():
            feedback.append(
                f"FileNotFoundError — use the exact parquet paths from config/datasources.yaml "
                f"(AVAILABLE DATA SOURCES in the prompt): {stderr[:300]}"
            )

        elif exec_result.get('timed_out'):
            feedback.append("Execution timed out — simplify the computation")

        else:
            feedback.append(f"Execution failed — fix this error: {stderr[:300]}")

        return True, feedback


# ============================================================================
# EXECUTION STATISTICS
# ============================================================================

class ExecutionStatistics:
    """Track execution statistics across workflow"""
    
    def __init__(self):
        self.total_executions = 0
        self.successful_executions = 0
        self.failed_executions = 0
        self.total_duration = 0.0
        self.error_types = {}
    
    def record_execution(
        self,
        success: bool,
        duration: float,
        error_type: Optional[str] = None
    ):
        """Record an execution"""
        self.total_executions += 1
        self.total_duration += duration
        
        if success:
            self.successful_executions += 1
        else:
            self.failed_executions += 1
            
            if error_type:
                self.error_types[error_type] = self.error_types.get(error_type, 0) + 1
    
    @property
    def success_rate(self) -> float:
        """Calculate success rate"""
        if self.total_executions == 0:
            return 0.0
        return self.successful_executions / self.total_executions
    
    @property
    def average_duration(self) -> float:
        """Calculate average duration"""
        if self.total_executions == 0:
            return 0.0
        return self.total_duration / self.total_executions
    
    def to_dict(self) -> Dict:
        """Export statistics"""
        return {
            'total_executions': self.total_executions,
            'successful': self.successful_executions,
            'failed': self.failed_executions,
            'success_rate': self.success_rate,
            'total_duration': self.total_duration,
            'average_duration': self.average_duration,
            'error_types': self.error_types
        }


# Global statistics
_stats = ExecutionStatistics()


def get_execution_stats() -> ExecutionStatistics:
    """Get global execution statistics"""
    return _stats


# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

def parse_execution_output(stdout: str) -> Dict[str, Any]:
    """
    Parse structured output from execution
    
    If code prints JSON or structured data, extract it
    """
    
    import json
    import re
    
    # Try to find JSON in output
    json_pattern = r'\{[^{}]*\}'
    matches = re.findall(json_pattern, stdout)
    
    parsed_data = {}
    
    for match in matches:
        try:
            data = json.loads(match)
            parsed_data.update(data)
        except:
            continue
    
    return parsed_data


def format_execution_summary(exec_result: Dict) -> str:
    """
    Format execution result as readable summary
    
    Returns:
        str: Formatted summary
    """
    
    lines = []
    
    success = exec_result['success']
    duration = exec_result['duration']
    
    lines.append("=" * 60)
    lines.append("EXECUTION SUMMARY")
    lines.append("=" * 60)
    
    # Status
    status = "✓ SUCCESS" if success else "✗ FAILED"
    lines.append(f"Status: {status}")
    lines.append(f"Duration: {duration:.2f}s")
    lines.append(f"Exit Code: {exec_result.get('exit_code', 'N/A')}")
    
    # Output
    stdout = exec_result.get('stdout', '')
    if stdout:
        lines.append(f"\nOutput:")
        lines.append(stdout[:500])  # First 500 chars
        if len(stdout) > 500:
            lines.append("... (truncated)")
    
    # Errors
    stderr = exec_result.get('stderr', '')
    if stderr:
        lines.append(f"\nErrors:")
        lines.append(stderr[:500])
        if len(stderr) > 500:
            lines.append("... (truncated)")
    
    lines.append("=" * 60)
    
    return '\n'.join(lines)
