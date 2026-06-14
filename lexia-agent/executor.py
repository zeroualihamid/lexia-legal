"""
Script Executor — saves generated Python code to files and runs it
in the sandbox from skills/parquet-reader/scripts/sandbox.py.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from .models import AgentConfig, ExecutionResult


def ensure_output_dir(config: AgentConfig) -> Path:
    """Create the output directory for generated scripts if needed."""
    out = config.output_dir
    out.mkdir(parents=True, exist_ok=True)
    return out


def save_script(code: str, filename: str, config: AgentConfig) -> Path:
    """Write *code* to ``config.output_dir / filename`` and return the path."""
    out = ensure_output_dir(config)
    path = out / filename
    path.write_text(code, encoding="utf-8")
    return path


def execute_script(
    script_path: Path,
    config: AgentConfig,
    *,
    sandbox_path: Path | None = None,
) -> ExecutionResult:
    """Run a Python script inside the parquet-reader sandbox.

    If *sandbox_path* is ``None`` we look for it relative to the project root
    at ``skills/parquet-reader/scripts/sandbox.py``.
    """

    if sandbox_path is None:
        # Try to resolve relative to the config's skills_dir
        sandbox_path = config.skills_dir / "parquet-reader" / "scripts" / "sandbox.py"

    # In compiled releases, sandbox.py becomes a .so — fall back to .so or run raw
    if not sandbox_path.exists():
        so_candidates = sorted(sandbox_path.parent.glob("sandbox.cpython-*.so")) if sandbox_path.parent.is_dir() else []
        if so_candidates:
            # Invoke compiled sandbox via -c import
            sandbox_dir = str(so_candidates[0].parent)
            try:
                proc = subprocess.run(
                    [sys.executable, "-c",
                     f"import sys; sys.path.insert(0, {sandbox_dir!r}); "
                     f"from sandbox import main; main()",
                     str(script_path)],
                    capture_output=True, text=True,
                    timeout=config.sandbox_timeout,
                    cwd=str(config.data_dir.parent) if config.data_dir.is_dir() else None,
                )
                output = proc.stdout.strip()
                error = proc.stderr.strip() if proc.returncode != 0 else None
                result = _try_parse_result(output)
                return ExecutionResult(
                    success=proc.returncode == 0, output=output,
                    error=error, result=result,
                )
            except subprocess.TimeoutExpired:
                return ExecutionResult(success=False, error=f"Script timed out after {config.sandbox_timeout}s")
            except Exception as exc:
                return ExecutionResult(success=False, error=str(exc))
        # No sandbox found at all — run directly
        return _run_raw(script_path, config)

    try:
        proc = subprocess.run(
            [sys.executable, str(sandbox_path), str(script_path)],
            capture_output=True,
            text=True,
            timeout=config.sandbox_timeout,
            cwd=str(config.data_dir.parent)
            if config.data_dir.is_dir()
            else None,
        )
        output = proc.stdout.strip()
        error = proc.stderr.strip() if proc.returncode != 0 else None

        result = _try_parse_result(output)

        return ExecutionResult(
            success=proc.returncode == 0,
            output=output,
            error=error,
            result=result,
        )
    except subprocess.TimeoutExpired:
        return ExecutionResult(
            success=False,
            error=f"Script timed out after {config.sandbox_timeout}s",
        )
    except Exception as exc:
        return ExecutionResult(success=False, error=str(exc))


def _run_raw(script_path: Path, config: AgentConfig) -> ExecutionResult:
    """Execute a script directly with Python (no sandbox)."""
    try:
        proc = subprocess.run(
            [sys.executable, str(script_path)],
            capture_output=True,
            text=True,
            timeout=config.sandbox_timeout,
            cwd=str(config.data_dir.parent)
            if config.data_dir.is_dir()
            else None,
        )
        output = proc.stdout.strip()
        error = proc.stderr.strip() if proc.returncode != 0 else None
        result = _try_parse_result(output)
        return ExecutionResult(
            success=proc.returncode == 0,
            output=output,
            error=error,
            result=result,
        )
    except subprocess.TimeoutExpired:
        return ExecutionResult(
            success=False,
            error=f"Script timed out after {config.sandbox_timeout}s",
        )
    except Exception as exc:
        return ExecutionResult(success=False, error=str(exc))


def _try_parse_result(output: str) -> object:
    """Try to parse the last line of output as JSON."""
    if not output:
        return None
    # The last non-empty line is usually the result
    for line in reversed(output.splitlines()):
        line = line.strip()
        if not line:
            continue
        # Strip "Result: " prefix if present (sandbox convention)
        if line.startswith("Result: "):
            line = line[len("Result: "):]
        try:
            return json.loads(line)
        except (json.JSONDecodeError, ValueError):
            pass
    return output  # return raw text if no JSON found
