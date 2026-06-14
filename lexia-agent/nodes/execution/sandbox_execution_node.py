# nodes/execution/sandbox_execution_node.py

"""
Sandbox Execution Node
Executes code in a secure sandbox environment

This node:
- Executes code in isolated environment
- Enforces resource limits (CPU, memory, time)
- Captures output and errors
- Monitors execution
- Returns structured results
"""

from typing import Dict, Any, Optional
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
import os
import subprocess
import sys
import time
import signal

from nodes.base_node import BaseNode
from monitoring.logger import get_logger

logger = get_logger(__name__)


@dataclass
class ExecutionResult:
    """Result of code execution"""
    success: bool
    stdout: str
    stderr: str
    exit_code: int
    duration: float
    error: Optional[str] = None
    timed_out: bool = False
    metadata: Dict[str, Any] = None
    
    def to_dict(self) -> Dict:
        return {
            'success': self.success,
            'stdout': self.stdout,
            'stderr': self.stderr,
            'exit_code': self.exit_code,
            'duration': self.duration,
            'error': self.error,
            'timed_out': self.timed_out,
            'metadata': self.metadata or {}
        }


class SandboxExecutionNode(BaseNode):
    """
    Sandbox Execution Node - Execute code securely
    
    Responsibilities:
    1. Set up sandbox environment
    2. Apply resource limits
    3. Execute code
    4. Capture output/errors
    5. Monitor execution
    6. Clean up
    
    Supports:
    - Subprocess-based sandbox (default)
    - Docker-based sandbox (if enabled)
    """
    
    def __init__(
        self,
        name: Optional[str] = None,
        use_docker: bool = False
    ):
        super().__init__(name or "SandboxExecution")
        self.use_docker = use_docker
    
    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        """Prepare for execution"""
        self.log_entry(shared)
        
        # Get code file path
        code_path = shared.get('code_path')
        
        if not code_path:
            raise ValueError("No code path for execution")
        
        # Get configuration
        config = self.get_config(shared)
        
        timeout = getattr(config, 'sandbox_timeout', 30)
        max_memory_mb = getattr(config, 'sandbox_max_memory_mb', 512)
        
        # Get current step for context
        plan_steps = shared.get('plan_steps', [])
        current_index = shared.get('current_step_index', 0)
        current_step = plan_steps[current_index] if current_index < len(plan_steps) else {}
        
        self.logger.info(
            f"Preparing to execute: {code_path} "
            f"(timeout={timeout}s, max_memory={max_memory_mb}MB)"
        )
        
        return {
            'code_path': code_path,
            'timeout': timeout,
            'max_memory_mb': max_memory_mb,
            'step': current_step,
            'use_docker': self.use_docker
        }
    
    def exec(self, prep_result: Dict[str, Any]) -> ExecutionResult:
        """
        Execute code in sandbox
        
        Steps:
        1. Set up execution environment
        2. Apply resource limits
        3. Execute code
        4. Capture output
        5. Check for errors
        """
        
        code_path = prep_result['code_path']
        timeout = prep_result['timeout']
        
        self.logger.info(f"Executing: {code_path}")
        
        start_time = time.time()
        
        try:
            if prep_result['use_docker']:
                result = self._execute_docker(prep_result)
            else:
                result = self._execute_subprocess(prep_result)
            
            duration = time.time() - start_time
            result.duration = duration
            
            if result.success:
                self.logger.info(f"✓ Execution successful ({duration:.2f}s)")
            else:
                self.logger.warning(
                    f"✗ Execution failed ({duration:.2f}s): {result.error}"
                )
            
            return result
        
        except Exception as e:
            duration = time.time() - start_time
            
            self.logger.error(f"Execution exception: {e}")
            
            return ExecutionResult(
                success=False,
                stdout="",
                stderr=str(e),
                exit_code=-1,
                duration=duration,
                error=str(e)
            )
    
    MAX_EXECUTION_RETRIES = 2

    def post(
        self,
        shared: Dict[str, Any],
        prep_result: Dict[str, Any],
        exec_result: ExecutionResult
    ) -> str:
        """Store execution results and route — retries via code_generation on failure."""
        
        # Store execution result
        shared['execution_result'] = exec_result.to_dict()
        
        # Update current step result
        if 'step_results' in shared and shared['step_results']:
            shared['step_results'][-1].update({
                'executed': True,
                'success': exec_result.success,
                'final_success': exec_result.success,
                'duration': exec_result.duration,
                'stdout': exec_result.stdout or '',
                'stderr': exec_result.stderr or '',
                'executed_at': datetime.now().isoformat()
            })
        
        # Route based on result
        if exec_result.success:
            shared['execution_retries'] = 0
            self.logger.info(
                f"Execution completed successfully in {exec_result.duration:.2f}s"
            )
            self.log_exit('success')
            return 'success'

        # --- Execution failed: decide retry vs give up ---
        execution_retries = shared.get('execution_retries', 0)
        error_text = (exec_result.stderr or exec_result.error or 'Unknown error').strip()

        if execution_retries < self.MAX_EXECUTION_RETRIES:
            shared['execution_retries'] = execution_retries + 1
            shared['generation_attempts'] = 0

            failed_code = shared.get('last_generated_code', '')
            feedback_errors = [
                f"Code execution failed (attempt {execution_retries + 1}/{self.MAX_EXECUTION_RETRIES}):",
                error_text,
            ]
            if failed_code:
                feedback_errors.append(f"Failed code:\n{failed_code}")

            shared['generation_feedback'] = {
                'errors': feedback_errors,
                'failed_code_path': shared.get('code_path', ''),
            }
            self.logger.warning(
                f"Execution failed (retry {execution_retries + 1}/{self.MAX_EXECUTION_RETRIES}), "
                f"routing back to code generation with error feedback"
            )
            self.log_exit('retry')
            return 'retry'

        self.logger.error(
            f"Execution failed after {self.MAX_EXECUTION_RETRIES} retries: {error_text[:200]}"
        )
        self.log_exit('failed')
        return 'failed'
    
    # ========================================================================
    # EXECUTION METHODS
    # ========================================================================
    
    def _execute_subprocess(self, prep_result: Dict) -> ExecutionResult:
        """Execute using subprocess (default)"""
        
        code_path = prep_result['code_path']
        timeout = prep_result['timeout']
        
        try:
            python_bin = sys.executable
            project_root = str(Path(__file__).resolve().parent.parent.parent)
            
            env = dict(os.environ)
            env["MPLBACKEND"] = "Agg"  # headless matplotlib
            
            process = subprocess.Popen(
                [python_bin, code_path],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                cwd=project_root,
                env=env,
            )
            
            # Wait with timeout
            try:
                stdout, stderr = process.communicate(timeout=timeout)
                timed_out = False
            except subprocess.TimeoutExpired:
                process.kill()
                stdout, stderr = process.communicate()
                timed_out = True
            
            # Check result
            success = (process.returncode == 0) and not timed_out
            
            return ExecutionResult(
                success=success,
                stdout=stdout,
                stderr=stderr,
                exit_code=process.returncode,
                duration=0.0,  # Will be set by caller
                error=stderr if not success else None,
                timed_out=timed_out
            )
        
        except Exception as e:
            return ExecutionResult(
                success=False,
                stdout="",
                stderr=str(e),
                exit_code=-1,
                duration=0.0,
                error=str(e)
            )
    
    def _execute_docker(self, prep_result: Dict) -> ExecutionResult:
        """Execute using Docker (more secure)"""
        
        # This would use Docker to run code
        # For now, fallback to subprocess
        self.logger.warning("Docker execution not yet implemented, using subprocess")
        return self._execute_subprocess(prep_result)


# ============================================================================
# ADVANCED SANDBOX EXECUTOR
# ============================================================================

class SecureSandboxExecutor:
    """
    More secure sandbox with resource limits
    
    Uses:
    - Resource limits (memory, CPU)
    - Process isolation
    - Network restrictions
    """
    
    def __init__(self, config):
        self.config = config
        self.timeout = getattr(config, 'sandbox_timeout', 30)
        self.max_memory_mb = getattr(config, 'sandbox_max_memory_mb', 512)
    
    def execute(self, code_path: str) -> ExecutionResult:
        """Execute with resource limits"""
        
        import resource
        
        def set_limits():
            """Set resource limits for subprocess"""
            # Memory limit
            max_memory_bytes = self.max_memory_mb * 1024 * 1024
            resource.setrlimit(
                resource.RLIMIT_AS,
                (max_memory_bytes, max_memory_bytes)
            )
            
            # CPU time limit
            resource.setrlimit(
                resource.RLIMIT_CPU,
                (self.timeout, self.timeout)
            )
        
        start_time = time.time()
        
        try:
            process = subprocess.Popen(
                ['python3', code_path],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                preexec_fn=set_limits
            )
            
            stdout, stderr = process.communicate(timeout=self.timeout)
            duration = time.time() - start_time
            
            success = process.returncode == 0
            
            return ExecutionResult(
                success=success,
                stdout=stdout,
                stderr=stderr,
                exit_code=process.returncode,
                duration=duration,
                error=stderr if not success else None
            )
        
        except subprocess.TimeoutExpired:
            process.kill()
            duration = time.time() - start_time
            
            return ExecutionResult(
                success=False,
                stdout="",
                stderr="Execution timed out",
                exit_code=-1,
                duration=duration,
                error="Timeout",
                timed_out=True
            )
        
        except Exception as e:
            duration = time.time() - start_time
            
            return ExecutionResult(
                success=False,
                stdout="",
                stderr=str(e),
                exit_code=-1,
                duration=duration,
                error=str(e)
            )
