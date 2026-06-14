# monitoring/node_output_logger.py

"""
Node output file logger for debugging.

Writes each node's output (after post) to a file under brikz-agent/logs/
when log_node_outputs is enabled. Can be disabled via config or LOG_NODE_OUTPUTS=false.
"""

import json
from pathlib import Path
from typing import Any, Dict, Optional
from datetime import datetime, timezone

# Max chars to log per value / per payload to avoid huge files
_MAX_STRING_LEN = 2000
_MAX_DICT_KEYS = 50


def _project_root() -> Path:
    """Resolve brikz-agent project root (parent of monitoring)."""
    return Path(__file__).resolve().parent.parent


def _logs_dir() -> Path:
    """Directory for log files (brikz-agent/logs)."""
    d = _project_root() / "logs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _sanitize(value: Any, depth: int = 0) -> Any:
    """Make value JSON-serializable and limit size for logging."""
    if depth > 5:
        return "<max_depth>"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value[:_MAX_STRING_LEN] + ("..." if len(value) > _MAX_STRING_LEN else "")
    if isinstance(value, (list, tuple)):
        return [_sanitize(v, depth + 1) for v in list(value)[:100]]
    if isinstance(value, dict):
        items = list(value.items())[:_MAX_DICT_KEYS]
        return {str(k): _sanitize(v, depth + 1) for k, v in items}
    try:
        s = repr(value)
        return s[:_MAX_STRING_LEN] + ("..." if len(s) > _MAX_STRING_LEN else "")
    except Exception:
        return "<non-serializable>"


def _is_enabled() -> bool:
    try:
        from config.settings import settings
        return getattr(settings, "log_node_outputs", False)
    except Exception:
        return False


def log_node_output(
    node_name: str,
    shared: Dict[str, Any],
    prep_res: Any,
    exec_res: Any,
    action: str,
) -> None:
    """
    Write one node's output to logs/node_outputs.log when node output logging is enabled.

    Safe to call every time; no-op when log_node_outputs is False.
    """
    if not _is_enabled():
        return
    try:
        log_dir = _logs_dir()
        log_file = log_dir / "node_outputs.log"
        # Build a small snapshot of shared (keys we care about for debugging)
        debug_keys = (
            "augmented_query", "plan_steps", "current_step_index",
            "routing_decision", "last_generated_code", "step_results",
            "final_response", "user_query", "schemas", "conversation_context",
        )
        shared_snapshot = {}
        for k in debug_keys:
            if k in shared:
                shared_snapshot[k] = _sanitize(shared[k])
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "node": node_name,
            "action": action,
            "shared_snapshot": shared_snapshot,
            "prep_res_summary": _sanitize(prep_res),
            "exec_res_summary": _sanitize(exec_res),
        }
        line = json.dumps(entry, default=str) + "\n"
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        # Do not break the workflow if file logging fails
        pass
