# nodes/base_node.py

"""
Base Node Class for PocketFlow Workflow Nodes

Provides common utilities, error handling, logging, and patterns
for all workflow nodes in the coding workflow system.
"""

from pocketflow import Node as PocketFlowNode
from typing import Any, Dict, Optional, Callable
from functools import wraps
import time
import traceback

from monitoring.logger import get_logger


# ============================================================================
# DECORATORS FOR NODE METHODS
# ============================================================================


def log_execution(func: Callable) -> Callable:
    """Decorator to log node execution time"""

    @wraps(func)
    def wrapper(self, *args, **kwargs):
        start_time = time.time()
        self.logger.debug(f"Starting {func.__name__}")

        try:
            result = func(self, *args, **kwargs)
            duration = time.time() - start_time
            self.logger.debug(f"Completed {func.__name__} in {duration:.3f}s")
            return result
        except Exception as e:
            duration = time.time() - start_time
            self.logger.error(f"Failed {func.__name__} after {duration:.3f}s: {str(e)}")
            raise

    return wrapper


def retry_on_failure(max_attempts: int = 3, delay: float = 1.0):
    """Decorator to retry node execution on failure"""

    def decorator(func: Callable) -> Callable:
        @wraps(func)
        def wrapper(self, *args, **kwargs):
            last_exception = None

            for attempt in range(1, max_attempts + 1):
                try:
                    return func(self, *args, **kwargs)
                except Exception as e:
                    last_exception = e
                    if attempt < max_attempts:
                        self.logger.warning(
                            f"Attempt {attempt}/{max_attempts} failed: {str(e)}. "
                            f"Retrying in {delay}s..."
                        )
                        time.sleep(delay)
                    else:
                        self.logger.error(
                            f"All {max_attempts} attempts failed. Last error: {str(e)}"
                        )

            raise last_exception

        return wrapper

    return decorator


# ============================================================================
# BASE NODE CLASS
# ============================================================================


class BaseNode(PocketFlowNode):
    """
    Base class for all workflow nodes

    Provides:
    - Logging with node-specific logger
    - Error handling utilities
    - Shared state access helpers
    - Common validation methods
    - Execution tracking
    - Debugging utilities

    All custom nodes should inherit from this class.

    Usage:
        class MyNode(BaseNode):
            def exec(self, prep_result):
                # Your logic here
                return result
    """

    def __init__(self, name: Optional[str] = None):
        """
        Initialize base node

        Args:
            name: Optional node name (defaults to class name)
        """
        super().__init__()
        self.name = name or self.__class__.__name__
        self.logger = get_logger(self.name)

        # Execution tracking
        self._execution_count = 0
        self._total_execution_time = 0.0
        self._last_execution_time = 0.0
        self._last_error = None

    # ========================================================================
    # POCKETFLOW REQUIRED METHODS (Can be overridden)
    # ========================================================================

    def prep(self, shared: Dict[str, Any]) -> Any:
        """
        Prepare data before execution (optional)

        Override this to extract and prepare data from shared state
        before the main execution.

        Args:
            shared: Shared state dictionary

        Returns:
            Any: Data to pass to exec()

        Default: Returns None (no preparation needed)
        """
        return None

    def exec(self, prep_result: Any) -> Any:
        """
        Execute the node's main logic (REQUIRED - must override)

        This is the only required method. Implement your node's
        core functionality here.

        Args:
            prep_result: Result from prep() method

        Returns:
            Any: Result to pass to post()

        Raises:
            NotImplementedError: If not overridden
        """
        raise NotImplementedError(f"{self.name}.exec() must be implemented in subclass")

    def post(self, shared: Dict[str, Any], prep_result: Any, exec_result: Any) -> str:
        """
        Post-process results and determine routing (optional)

        Override this to:
        - Store results in shared state
        - Determine which node to execute next
        - Perform cleanup

        Args:
            shared: Shared state dictionary (modify in-place)
            prep_result: Result from prep()
            exec_result: Result from exec()

        Returns:
            str: Next node name or 'default' for next in sequence

        Default: Returns 'default' (continue to next node)
        """
        return "default"

    # ========================================================================
    # HELPER METHODS - Shared State Access
    # ========================================================================

    def get_config(self, shared: Dict[str, Any]) -> Any:
        """
        Get configuration from shared state

        Args:
            shared: Shared state dictionary

        Returns:
            Configuration object or None
        """
        return shared.get("config")

    def get_from_shared(
        self, shared: Dict[str, Any], key: str, default: Any = None
    ) -> Any:
        """
        Safely get value from shared state

        Args:
            shared: Shared state dictionary
            key: Key to retrieve
            default: Default value if key not found

        Returns:
            Value from shared state or default
        """
        return shared.get(key, default)

    def set_in_shared(self, shared: Dict[str, Any], key: str, value: Any) -> None:
        """
        Set value in shared state

        Args:
            shared: Shared state dictionary
            key: Key to set
            value: Value to store
        """
        shared[key] = value
        self.logger.debug(f"Set shared['{key}'] = {type(value).__name__}")

    def update_shared(self, shared: Dict[str, Any], updates: Dict[str, Any]) -> None:
        """
        Update multiple values in shared state

        Args:
            shared: Shared state dictionary
            updates: Dictionary of key-value pairs to update
        """
        shared.update(updates)
        self.logger.debug(f"Updated {len(updates)} items in shared state")

    def require_from_shared(self, shared: Dict[str, Any], key: str) -> Any:
        """
        Get required value from shared state (raises if missing)

        Args:
            shared: Shared state dictionary
            key: Required key

        Returns:
            Value from shared state

        Raises:
            KeyError: If key is not found
        """
        if key not in shared:
            raise KeyError(
                f"{self.name} requires '{key}' in shared state, but it was not found"
            )
        return shared[key]

    # ========================================================================
    # HELPER METHODS - Logging
    # ========================================================================

    def log_entry(self, shared: Dict[str, Any]) -> None:
        """
        Log entry into this node

        Args:
            shared: Shared state dictionary
        """
        self.logger.info(f"→ Entering {self.name}")
        self._execution_count += 1

    def log_exit(self, label: str, *args, **kwargs) -> None:
        """
        Log exit from this node

        Args:
            next_node: Name of next node to execute
        """
        self.logger.info(f"← Exiting {self.name} → {label}")

    def log_data(self, message: str, data: Any = None) -> None:
        """
        Log data during execution

        Args:
            message: Log message
            data: Optional data to log (will be truncated if large)
        """
        if data is not None:
            data_str = str(data)
            if len(data_str) > 200:
                data_str = data_str[:200] + "..."
            self.logger.debug(f"{message}: {data_str}")
        else:
            self.logger.debug(message)

    # ========================================================================
    # HELPER METHODS - Error Handling
    # ========================================================================

    def handle_error(
        self,
        error: Exception,
        shared: Dict[str, Any],
        return_route: str = "error_handler",
    ) -> str:
        """
        Handle errors during node execution

        Override for custom error handling behavior.

        Args:
            error: The exception that occurred
            shared: Shared state dictionary
            return_route: Route to return (node name or 'end')

        Returns:
            str: Route to take (usually 'error_handler' or 'end')
        """
        self._last_error = error

        # Log error with full traceback
        self.logger.error(f"Error in {self.name}: {str(error)}", exc_info=True)

        # Store error in shared state
        if "errors" not in shared:
            shared["errors"] = []

        shared["errors"].append(
            {
                "node": self.name,
                "error": str(error),
                "type": type(error).__name__,
                "traceback": traceback.format_exc(),
            }
        )

        # Also store last error for easy access
        shared["last_error"] = {
            "node": self.name,
            "error": str(error),
            "type": type(error).__name__,
        }

        return return_route

    def validate_input(self, value: Any, expected_type: type, name: str) -> None:
        """
        Validate input type

        Args:
            value: Value to validate
            expected_type: Expected type
            name: Name of the value (for error messages)

        Raises:
            TypeError: If value is not of expected type
        """
        if not isinstance(value, expected_type):
            raise TypeError(
                f"{self.name} expected {name} to be {expected_type.__name__}, "
                f"got {type(value).__name__}"
            )

    def validate_not_none(self, value: Any, name: str) -> None:
        """
        Validate that value is not None

        Args:
            value: Value to check
            name: Name of the value (for error messages)

        Raises:
            ValueError: If value is None
        """
        if value is None:
            raise ValueError(f"{self.name} requires {name}, but got None")

    def validate_not_empty(self, value: Any, name: str) -> None:
        """
        Validate that value is not empty

        Args:
            value: Value to check (string, list, dict, etc.)
            name: Name of the value (for error messages)

        Raises:
            ValueError: If value is empty
        """
        if not value:
            raise ValueError(f"{self.name} requires {name}, but got empty value")

    # ========================================================================
    # HELPER METHODS - Execution Tracking
    # ========================================================================

    def start_execution_timer(self) -> float:
        """
        Start execution timer

        Returns:
            float: Start time (use with end_execution_timer)
        """
        return time.time()

    def end_execution_timer(self, start_time: float) -> float:
        """
        End execution timer and update metrics

        Args:
            start_time: Start time from start_execution_timer()

        Returns:
            float: Duration in seconds
        """
        duration = time.time() - start_time
        self._last_execution_time = duration
        self._total_execution_time += duration
        return duration

    def get_execution_stats(self) -> Dict[str, Any]:
        """
        Get execution statistics for this node

        Returns:
            dict: Statistics including count, total time, average time
        """
        avg_time = (
            self._total_execution_time / self._execution_count
            if self._execution_count > 0
            else 0.0
        )

        return {
            "node_name": self.name,
            "execution_count": self._execution_count,
            "total_execution_time": self._total_execution_time,
            "average_execution_time": avg_time,
            "last_execution_time": self._last_execution_time,
            "last_error": str(self._last_error) if self._last_error else None,
        }

    # ========================================================================
    # HELPER METHODS - Debugging
    # ========================================================================

    def debug_shared_state(self, shared: Dict[str, Any]) -> None:
        """
        Log current shared state for debugging

        Args:
            shared: Shared state dictionary
        """
        self.logger.debug("=" * 60)
        self.logger.debug(f"SHARED STATE in {self.name}")
        self.logger.debug("=" * 60)

        for key, value in shared.items():
            value_type = type(value).__name__

            # Truncate large values
            if isinstance(value, str) and len(value) > 100:
                value_preview = value[:100] + "..."
            elif isinstance(value, (list, dict)) and len(str(value)) > 100:
                value_preview = f"{value_type} with {len(value)} items"
            else:
                value_preview = str(value)

            self.logger.debug(f"  {key}: {value_preview} ({value_type})")

        self.logger.debug("=" * 60)

    def assert_shared_keys(self, shared: Dict[str, Any], required_keys: list) -> None:
        """
        Assert that required keys exist in shared state

        Args:
            shared: Shared state dictionary
            required_keys: List of required key names

        Raises:
            KeyError: If any required key is missing
        """
        missing_keys = [key for key in required_keys if key not in shared]

        if missing_keys:
            raise KeyError(
                f"{self.name} requires keys {missing_keys} in shared state, "
                f"but they are missing"
            )

    # ========================================================================
    # HELPER METHODS - Common Patterns
    # ========================================================================

    def extract_code_from_response(self, response: str) -> str:
        """
        Extract Python code from LLM response

        Handles markdown code blocks and plain text.

        Args:
            response: LLM response that may contain code

        Returns:
            str: Extracted code
        """
        # Remove markdown code blocks if present
        if "```python" in response:
            code = response.split("```python")[1].split("```")[0]
        elif "```" in response:
            code = response.split("```")[1].split("```")[0]
        else:
            code = response

        return code.strip()

    def increment_counter(self, shared: Dict[str, Any], counter_name: str) -> int:
        """
        Increment a counter in shared state

        Args:
            shared: Shared state dictionary
            counter_name: Name of counter to increment

        Returns:
            int: New counter value
        """
        current = shared.get(counter_name, 0)
        new_value = current + 1
        shared[counter_name] = new_value
        return new_value

    def check_max_attempts(
        self,
        shared: Dict[str, Any],
        attempt_key: str = "generation_attempts",
        max_key: str = "max_attempts",
        default_max: int = 3,
    ) -> tuple[int, int, bool]:
        """
        Check if maximum attempts reached

        Args:
            shared: Shared state dictionary
            attempt_key: Key for current attempt count
            max_key: Key for maximum attempts
            default_max: Default max if not in shared

        Returns:
            tuple: (current_attempt, max_attempts, should_retry)
        """
        current = shared.get(attempt_key, 0)
        maximum = shared.get(max_key, default_max)
        should_retry = current < maximum

        return current, maximum, should_retry

    def route_based_on_condition(
        self,
        condition: bool,
        true_route: str = "default",
        false_route: str = "alternative",
    ) -> str:
        """
        Simple conditional routing helper

        Args:
            condition: Boolean condition
            true_route: Route if condition is True
            false_route: Route if condition is False

        Returns:
            str: Route name
        """
        return true_route if condition else false_route

    # ========================================================================
    # MAGIC METHODS
    # ========================================================================

    def __repr__(self) -> str:
        """String representation of node"""
        return f"<{self.__class__.__name__}(name='{self.name}')>"

    def __str__(self) -> str:
        """Human-readable string"""
        return self.name


# ============================================================================
# SPECIALIZED BASE NODES
# ============================================================================


class LLMNode(BaseNode):
    """
    Base class for nodes that interact with LLMs

    Provides common LLM interaction patterns
    """

    def __init__(self, name: Optional[str] = None):
        super().__init__(name)
        self._llm_client = None

    def get_llm_client(self, shared: Dict[str, Any]):
        """
        Get or create LLM client

        Args:
            shared: Shared state dictionary

        Returns:
            LLM client instance
        """
        if self._llm_client is None:
            from llm.llm_factory import create_llm_client

            config = self.get_config(shared)
            self._llm_client = create_llm_client(config)

        return self._llm_client

    def generate_with_llm(self, shared: Dict[str, Any], prompt: str) -> str:
        """
        Generate text using LLM

        Args:
            shared: Shared state dictionary
            prompt: Prompt to send to LLM

        Returns:
            str: LLM response
        """
        llm = self.get_llm_client(shared)
        self.logger.debug(f"Sending prompt to LLM ({len(prompt)} chars)")

        response = llm.generate(prompt)

        # LLM clients may return either a raw string or an LLMResponse object.
        if isinstance(response, str):
            response_text = response
        else:
            response_text = getattr(response, "content", str(response))

        self.logger.debug(f"Received response from LLM ({len(response_text)} chars)")
        return response_text


class ValidationNode(BaseNode):
    """
    Base class for validation nodes

    Provides common validation patterns
    """

    def validate_and_route(
        self,
        shared: Dict[str, Any],
        is_valid: bool,
        errors: list,
        valid_route: str = "valid",
        invalid_retry_route: str = "invalid_retry",
        invalid_give_up_route: str = "invalid_give_up",
        attempt_key: str = "validation_attempts",
        max_attempts: int = 3,
    ) -> str:
        """
        Standard validation routing logic

        Args:
            shared: Shared state dictionary
            is_valid: Whether validation passed
            errors: List of validation errors
            valid_route: Route if valid
            invalid_retry_route: Route to retry
            invalid_give_up_route: Route when max attempts reached
            attempt_key: Key for attempt counter
            max_attempts: Maximum retry attempts

        Returns:
            str: Route to take
        """
        if is_valid:
            return valid_route

        # Store errors
        shared["validation_errors"] = errors

        # Check attempts
        current, maximum, should_retry = self.check_max_attempts(
            shared,
            attempt_key=attempt_key,
            max_key="max_attempts",
            default_max=max_attempts,
        )

        if should_retry:
            self.logger.info(
                f"Validation failed (attempt {current}/{maximum}), retrying"
            )
            return invalid_retry_route
        else:
            self.logger.error(f"Validation failed after {maximum} attempts, giving up")
            return invalid_give_up_route


# ============================================================================
# EXAMPLE USAGE
# ============================================================================


class ExampleNode(BaseNode):
    """
    Example node showing common patterns
    """

    def prep(self, shared):
        """Extract data from shared state"""
        self.log_entry(shared)

        # Validate required keys exist
        self.assert_shared_keys(shared, ["input_data", "config"])

        # Get data
        input_data = self.require_from_shared(shared, "input_data")

        # Validate input
        self.validate_not_none(input_data, "input_data")
        self.validate_input(input_data, str, "input_data")

        return input_data

    @log_execution
    def exec(self, prep_result):
        """Process the data"""
        start_time = self.start_execution_timer()

        # Do work
        result = prep_result.upper()

        # Track execution time
        duration = self.end_execution_timer(start_time)
        self.logger.info(f"Processing took {duration:.3f}s")

        return result

    def post(self, shared, prep_result, exec_result):
        """Store result and route"""
        # Store result
        self.set_in_shared(shared, "output_data", exec_result)

        # Log exit
        self.log_exit("next_node")

        return "default"
