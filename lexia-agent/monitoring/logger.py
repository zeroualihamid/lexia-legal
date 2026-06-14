# monitoring/logger.py

"""
Structured Logging System for Coding Workflow System

Provides:
- Structured JSON logging for production
- Colored console logging for development
- Request tracing with trace IDs
- Context management
- Performance logging
- Multiple output handlers
- Log level management
"""

import logging
import sys
import json
import time
import traceback
from typing import Dict, Any, Optional
from pathlib import Path
from datetime import datetime
from contextvars import ContextVar
import uuid

try:
    import structlog
    STRUCTLOG_AVAILABLE = True
except ImportError:
    STRUCTLOG_AVAILABLE = False


# ============================================================================
# CONTEXT VARIABLES FOR REQUEST TRACING
# ============================================================================

# Trace ID for correlating log messages across the workflow
trace_id_var: ContextVar[Optional[str]] = ContextVar('trace_id', default=None)

# Session ID for user sessions
session_id_var: ContextVar[Optional[str]] = ContextVar('session_id', default=None)

# Additional context (user, workflow, etc.)
log_context_var: ContextVar[Dict[str, Any]] = ContextVar('log_context', default={})


# ============================================================================
# COLOR CODES FOR CONSOLE OUTPUT
# ============================================================================

class Colors:
    """ANSI color codes for terminal output"""
    RESET = "\033[0m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    
    # Foreground colors
    BLACK = "\033[30m"
    RED = "\033[31m"
    GREEN = "\033[32m"
    YELLOW = "\033[33m"
    BLUE = "\033[34m"
    MAGENTA = "\033[35m"
    CYAN = "\033[36m"
    WHITE = "\033[37m"
    
    # Bright foreground colors
    BRIGHT_RED = "\033[91m"
    BRIGHT_GREEN = "\033[92m"
    BRIGHT_YELLOW = "\033[93m"
    BRIGHT_BLUE = "\033[94m"
    BRIGHT_MAGENTA = "\033[95m"
    BRIGHT_CYAN = "\033[96m"


# ============================================================================
# CUSTOM FORMATTERS
# ============================================================================

class ColoredConsoleFormatter(logging.Formatter):
    """
    Formatter for colored console output
    Makes logs readable during development
    """
    
    LEVEL_COLORS = {
        'DEBUG': Colors.CYAN,
        'INFO': Colors.GREEN,
        'WARNING': Colors.YELLOW,
        'ERROR': Colors.RED,
        'CRITICAL': Colors.BRIGHT_RED + Colors.BOLD,
    }
    
    def format(self, record: logging.LogRecord) -> str:
        """Format log record with colors"""
        
        # Add color to level name
        level_color = self.LEVEL_COLORS.get(record.levelname, Colors.RESET)
        colored_level = f"{level_color}{record.levelname:8s}{Colors.RESET}"
        
        # Format timestamp
        timestamp = datetime.fromtimestamp(record.created).strftime('%H:%M:%S.%f')[:-3]
        
        # Get trace ID if available
        trace_id = trace_id_var.get()
        trace_str = f"[{trace_id[:8]}]" if trace_id else ""
        
        # Format logger name (limit length)
        logger_name = record.name
        if len(logger_name) > 25:
            logger_name = "..." + logger_name[-22:]
        
        # Build message
        message = record.getMessage()
        
        # Add exception info if present
        if record.exc_info:
            message += "\n" + "".join(traceback.format_exception(*record.exc_info))
        
        # Combine all parts
        return (
            f"{Colors.DIM}{timestamp}{Colors.RESET} "
            f"{colored_level} "
            f"{Colors.BRIGHT_BLUE}{logger_name:25s}{Colors.RESET} "
            f"{trace_str} "
            f"{message}"
        )


class JSONFormatter(logging.Formatter):
    """
    Formatter for JSON structured logging
    Perfect for production and log aggregation systems
    """
    
    def format(self, record: logging.LogRecord) -> str:
        """Format log record as JSON"""
        
        # Base log data
        log_data = {
            'timestamp': datetime.fromtimestamp(record.created).isoformat(),
            'level': record.levelname,
            'logger': record.name,
            'message': record.getMessage(),
            'module': record.module,
            'function': record.funcName,
            'line': record.lineno,
        }
        
        # Add trace ID
        trace_id = trace_id_var.get()
        if trace_id:
            log_data['trace_id'] = trace_id
        
        # Add session ID
        session_id = session_id_var.get()
        if session_id:
            log_data['session_id'] = session_id
        
        # Add extra context
        context = log_context_var.get()
        if context:
            log_data['context'] = context
        
        # Add exception info
        if record.exc_info:
            log_data['exception'] = {
                'type': record.exc_info[0].__name__,
                'message': str(record.exc_info[1]),
                'traceback': traceback.format_exception(*record.exc_info)
            }
        
        # Add any extra fields from the record
        for key, value in record.__dict__.items():
            if key not in ['name', 'msg', 'args', 'created', 'filename', 'funcName',
                          'levelname', 'lineno', 'module', 'msecs', 'message',
                          'pathname', 'process', 'processName', 'relativeCreated',
                          'thread', 'threadName', 'exc_info', 'exc_text', 'stack_info']:
                log_data[key] = value
        
        return json.dumps(log_data)


# ============================================================================
# PERFORMANCE LOGGER
# ============================================================================

class PerformanceLogger:
    """
    Context manager for logging performance metrics
    
    Usage:
        with PerformanceLogger(logger, "operation_name"):
            # do work
            pass
    """
    
    def __init__(self, logger: logging.Logger, operation: str, level: int = logging.INFO):
        self.logger = logger
        self.operation = operation
        self.level = level
        self.start_time = None
    
    def __enter__(self):
        self.start_time = time.time()
        self.logger.log(self.level, f"Starting {self.operation}")
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        duration = time.time() - self.start_time
        
        if exc_type is None:
            self.logger.log(
                self.level,
                f"Completed {self.operation} in {duration:.3f}s"
            )
        else:
            self.logger.error(
                f"Failed {self.operation} after {duration:.3f}s: {exc_val}"
            )
        
        return False  # Don't suppress exceptions


# ============================================================================
# LOGGER CONFIGURATION
# ============================================================================

class LoggerConfig:
    """Configuration for logger setup"""
    
    def __init__(
        self,
        log_level: str = "INFO",
        log_format: str = "colored",  # "colored", "json", or "simple"
        log_file: Optional[str] = None,
        max_bytes: int = 10485760,  # 10MB
        backup_count: int = 5,
        enable_console: bool = True,
        enable_file: bool = False,
        propagate: bool = False
    ):
        self.log_level = log_level.upper()
        self.log_format = log_format
        self.log_file = log_file
        self.max_bytes = max_bytes
        self.backup_count = backup_count
        self.enable_console = enable_console
        self.enable_file = enable_file
        self.propagate = propagate
    
    @classmethod
    def from_env(cls):
        """Create configuration from environment variables"""
        import os
        
        return cls(
            log_level=os.getenv('LOG_LEVEL', 'INFO'),
            log_format=os.getenv('LOG_FORMAT', 'colored'),
            log_file=os.getenv('LOG_FILE'),
            enable_console=os.getenv('LOG_CONSOLE', 'true').lower() == 'true',
            enable_file=os.getenv('LOG_FILE_ENABLE', 'false').lower() == 'true',
        )


# ============================================================================
# LOGGER SETUP
# ============================================================================

_configured_loggers: Dict[str, logging.Logger] = {}
_default_config: Optional[LoggerConfig] = None


def setup_logging(config: Optional[LoggerConfig] = None) -> None:
    """
    Setup logging configuration for the entire application
    
    Args:
        config: Logger configuration (defaults to environment-based config)
    """
    global _default_config
    
    if config is None:
        config = LoggerConfig.from_env()
    
    _default_config = config
    
    # Get root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(getattr(logging, config.log_level))
    
    # Remove existing handlers
    root_logger.handlers.clear()
    
    # Console handler
    if config.enable_console:
        console_handler = logging.StreamHandler(sys.stdout)
        console_handler.setLevel(getattr(logging, config.log_level))
        
        if config.log_format == 'json':
            console_handler.setFormatter(JSONFormatter())
        elif config.log_format == 'colored':
            console_handler.setFormatter(ColoredConsoleFormatter())
        else:
            console_handler.setFormatter(
                logging.Formatter(
                    '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
                )
            )
        
        root_logger.addHandler(console_handler)
    
    # File handler
    if config.enable_file and config.log_file:
        from logging.handlers import RotatingFileHandler
        
        # Ensure log directory exists
        log_path = Path(config.log_file)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        
        file_handler = RotatingFileHandler(
            config.log_file,
            maxBytes=config.max_bytes,
            backupCount=config.backup_count
        )
        file_handler.setLevel(getattr(logging, config.log_level))
        file_handler.setFormatter(JSONFormatter())  # Always JSON for files
        
        root_logger.addHandler(file_handler)
    
    root_logger.propagate = config.propagate


def get_logger(name: str) -> logging.Logger:
    """
    Get a logger instance for a module
    
    Args:
        name: Name of the logger (usually __name__)
        
    Returns:
        logging.Logger: Configured logger instance
    
    Usage:
        logger = get_logger(__name__)
        logger.info("Hello world")
    """
    if name in _configured_loggers:
        return _configured_loggers[name]
    
    # Ensure logging is setup
    if _default_config is None:
        setup_logging()
    
    logger = logging.getLogger(name)
    _configured_loggers[name] = logger
    
    return logger


# ============================================================================
# CONTEXT MANAGEMENT
# ============================================================================

def set_trace_id(trace_id: Optional[str] = None) -> str:
    """
    Set trace ID for the current execution context
    
    Args:
        trace_id: Trace ID to set (generates UUID if None)
        
    Returns:
        str: The trace ID that was set
    """
    if trace_id is None:
        trace_id = str(uuid.uuid4())
    
    trace_id_var.set(trace_id)
    return trace_id


def get_trace_id() -> Optional[str]:
    """Get current trace ID"""
    return trace_id_var.get()


def set_session_id(session_id: str) -> None:
    """Set session ID for the current execution context"""
    session_id_var.set(session_id)


def get_session_id() -> Optional[str]:
    """Get current session ID"""
    return session_id_var.get()


def set_log_context(**kwargs) -> None:
    """
    Set additional context for logging
    
    Usage:
        set_log_context(user_id="123", workflow_id="abc")
    """
    current = log_context_var.get()
    updated = {**current, **kwargs}
    log_context_var.set(updated)


def clear_log_context() -> None:
    """Clear all log context"""
    trace_id_var.set(None)
    session_id_var.set(None)
    log_context_var.set({})


class LogContext:
    """
    Context manager for setting log context
    
    Usage:
        with LogContext(trace_id="abc", session_id="123", user="john"):
            logger.info("This will include context")
    """
    
    def __init__(
        self,
        trace_id: Optional[str] = None,
        session_id: Optional[str] = None,
        **kwargs
    ):
        self.trace_id = trace_id
        self.session_id = session_id
        self.context = kwargs
        self.previous_trace = None
        self.previous_session = None
        self.previous_context = None
    
    def __enter__(self):
        # Save previous values
        self.previous_trace = trace_id_var.get()
        self.previous_session = session_id_var.get()
        self.previous_context = log_context_var.get()
        
        # Set new values
        if self.trace_id is not None:
            set_trace_id(self.trace_id)
        elif self.previous_trace is None:
            set_trace_id()  # Generate new trace ID
        
        if self.session_id is not None:
            set_session_id(self.session_id)
        
        if self.context:
            set_log_context(**self.context)
        
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        # Restore previous values
        trace_id_var.set(self.previous_trace)
        session_id_var.set(self.previous_session)
        log_context_var.set(self.previous_context)
        
        return False


# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

def log_function_call(logger: logging.Logger):
    """
    Decorator to log function calls with arguments and results
    
    Usage:
        @log_function_call(logger)
        def my_function(arg1, arg2):
            return result
    """
    def decorator(func):
        def wrapper(*args, **kwargs):
            logger.debug(
                f"Calling {func.__name__} with args={args}, kwargs={kwargs}"
            )
            
            try:
                result = func(*args, **kwargs)
                logger.debug(f"{func.__name__} returned: {result}")
                return result
            except Exception as e:
                logger.error(
                    f"{func.__name__} raised {type(e).__name__}: {e}",
                    exc_info=True
                )
                raise
        
        return wrapper
    return decorator


def log_performance(logger: logging.Logger, operation: str, level: int = logging.INFO):
    """
    Decorator for logging performance of functions
    
    Usage:
        @log_performance(logger, "data_processing")
        def process_data(data):
            return result
    """
    def decorator(func):
        def wrapper(*args, **kwargs):
            start_time = time.time()
            
            try:
                result = func(*args, **kwargs)
                duration = time.time() - start_time
                logger.log(
                    level,
                    f"{operation} completed in {duration:.3f}s"
                )
                return result
            except Exception as e:
                duration = time.time() - start_time
                logger.error(
                    f"{operation} failed after {duration:.3f}s: {e}",
                    exc_info=True
                )
                raise
        
        return wrapper
    return decorator


def configure_third_party_loggers(level: str = "WARNING"):
    """
    Configure third-party library loggers to reduce noise
    
    Args:
        level: Log level for third-party loggers
    """
    noisy_loggers = [
        'urllib3',
        'requests',
        'docker',
        'anthropic',
        'openai',
        'transformers',
        'httpx',
        'httpcore',
    ]
    
    for logger_name in noisy_loggers:
        logging.getLogger(logger_name).setLevel(getattr(logging, level.upper()))


# ============================================================================
# SPECIALIZED LOGGERS
# ============================================================================

class WorkflowLogger:
    """
    Specialized logger for workflow execution
    Provides structured logging for workflow steps
    """
    
    def __init__(self, logger: logging.Logger):
        self.logger = logger
    
    def log_workflow_start(self, workflow_id: str, query: str):
        """Log workflow start"""
        self.logger.info(
            "Workflow started",
            extra={
                'workflow_id': workflow_id,
                'query': query,
                'event': 'workflow_start'
            }
        )
    
    def log_workflow_end(self, workflow_id: str, success: bool, duration: float):
        """Log workflow end"""
        self.logger.info(
            f"Workflow {'completed' if success else 'failed'}",
            extra={
                'workflow_id': workflow_id,
                'success': success,
                'duration': duration,
                'event': 'workflow_end'
            }
        )
    
    def log_node_start(self, node_name: str):
        """Log node start"""
        self.logger.debug(
            f"Node started: {node_name}",
            extra={'node': node_name, 'event': 'node_start'}
        )
    
    def log_node_end(self, node_name: str, duration: float, next_node: str):
        """Log node end"""
        self.logger.debug(
            f"Node completed: {node_name} -> {next_node}",
            extra={
                'node': node_name,
                'duration': duration,
                'next_node': next_node,
                'event': 'node_end'
            }
        )
    
    def log_step_result(self, step_id: str, success: bool, reused: bool):
        """Log step execution result"""
        self.logger.info(
            f"Step {step_id}: {'✓' if success else '✗'} ({'reused' if reused else 'generated'})",
            extra={
                'step_id': step_id,
                'success': success,
                'reused': reused,
                'event': 'step_result'
            }
        )


# ============================================================================
# INITIALIZATION
# ============================================================================

# Setup logging when module is imported
setup_logging()

# Configure noisy third-party loggers
configure_third_party_loggers()


# ============================================================================
# EXAMPLE USAGE
# ============================================================================

if __name__ == '__main__':
    """
    Examples of logger usage
    """
    
    # Get a logger
    logger = get_logger(__name__)
    
    # Basic logging
    logger.debug("Debug message")
    logger.info("Info message")
    logger.warning("Warning message")
    logger.error("Error message")
    
    # With trace context
    with LogContext(trace_id="abc123", session_id="user-456", user="john"):
        logger.info("This log has trace context")
        
        # Nested context
        with LogContext(workflow_id="wf-789"):
            logger.info("This log has additional context")
    
    # Performance logging
    with PerformanceLogger(logger, "data_processing"):
        time.sleep(0.1)
    
    # Function decorator
    @log_performance(logger, "calculation")
    def calculate(x, y):
        return x + y
    
    result = calculate(5, 3)
    
    # Exception logging
    try:
        raise ValueError("Something went wrong")
    except Exception:
        logger.exception("An error occurred")
    
    # Workflow logger
    wf_logger = WorkflowLogger(logger)
    wf_logger.log_workflow_start("wf-123", "Load and process data")
    wf_logger.log_node_start("LoadDataNode")
    time.sleep(0.05)
    wf_logger.log_node_end("LoadDataNode", 0.05, "ProcessDataNode")
    wf_logger.log_workflow_end("wf-123", True, 0.5)