"""
file_reader tool — Read files from the data directory (sandboxed).
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict

from llm.base_llm import ToolResult
from services.tool_registry import Tool

logger = logging.getLogger(__name__)

# Sandboxed to these directories only
_ALLOWED_ROOTS = [
    Path("data"),
    Path("config"),
    Path("classes/dtos"),
]


def _handle_read_file(args: Dict[str, Any], ctx: Dict[str, Any]) -> ToolResult:
    """Read a file from an allowed directory."""
    file_path = args.get("file_path", "").strip()
    if not file_path:
        return ToolResult(tool_use_id="", content="file_path is required.", is_error=True)

    target = Path(file_path).resolve()

    # Security: ensure the file is under an allowed root
    project_root = Path(__file__).resolve().parent.parent
    allowed = False
    for root in _ALLOWED_ROOTS:
        abs_root = (project_root / root).resolve()
        try:
            target.relative_to(abs_root)
            allowed = True
            break
        except ValueError:
            continue

    if not allowed:
        return ToolResult(
            tool_use_id="",
            content=f"Access denied: '{file_path}' is outside allowed directories ({', '.join(str(r) for r in _ALLOWED_ROOTS)}).",
            is_error=True,
        )

    if not target.exists():
        return ToolResult(tool_use_id="", content=f"File not found: {file_path}", is_error=True)

    if not target.is_file():
        # List directory contents
        if target.is_dir():
            entries = sorted(target.iterdir())
            lines = [f"Directory: {file_path}", f"Entries ({len(entries)}):"]
            for e in entries[:100]:
                kind = "dir" if e.is_dir() else "file"
                size = e.stat().st_size if e.is_file() else 0
                lines.append(f"  [{kind}] {e.name} ({size:,} bytes)" if kind == "file" else f"  [{kind}] {e.name}/")
            return ToolResult(tool_use_id="", content="\n".join(lines))
        return ToolResult(tool_use_id="", content=f"Not a file: {file_path}", is_error=True)

    max_bytes = args.get("max_bytes", 50_000)

    # Handle parquet files specially
    if target.suffix == ".parquet":
        try:
            import pyarrow.parquet as pq
            pf = pq.ParquetFile(target)
            schema = pf.schema_arrow
            lines = [
                f"Parquet file: {target.name}",
                f"Rows: {pf.metadata.num_rows:,}",
                f"Columns: {pf.metadata.num_columns}",
                "Schema:",
            ]
            for i in range(len(schema)):
                f = schema.field(i)
                lines.append(f"  {f.name}: {f.type}")
            return ToolResult(tool_use_id="", content="\n".join(lines))
        except Exception as exc:
            return ToolResult(tool_use_id="", content=f"Error reading parquet: {exc}", is_error=True)

    # Read text files
    try:
        content = target.read_text(encoding="utf-8", errors="replace")
        if len(content) > max_bytes:
            content = content[:max_bytes] + f"\n... (truncated at {max_bytes:,} bytes)"
        return ToolResult(tool_use_id="", content=content)
    except Exception as exc:
        return ToolResult(tool_use_id="", content=f"Error reading file: {exc}", is_error=True)


file_reader_tool = Tool(
    name="read_file",
    description=(
        "Read a file from the project's data/, config/, or classes/dtos/ directories. "
        "For parquet files, returns schema and metadata. For text files, returns content. "
        "For directories, lists entries."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "file_path": {
                "type": "string",
                "description": "Path to the file (relative to project root, e.g., 'data/parquet/oracle_env_ca_view.parquet').",
            },
            "max_bytes": {
                "type": "integer",
                "description": "Max bytes to read for text files (default 50000).",
                "default": 50000,
            },
        },
        "required": ["file_path"],
    },
    handler=_handle_read_file,
    category="read-only",
)
