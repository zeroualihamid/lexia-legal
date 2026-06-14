"""Decoupled chart generation.

Charts MUST NOT block the data-token stream — user-perceived latency is
the priority. When the agent calls the ``chart`` tool we:

  1. Mint a fresh ``chart_id`` and return it to the agent immediately.
  2. Schedule the actual ``chart_flow`` on a background asyncio task (or
     a thread when no running event loop is available).
  3. Write the rendered artefact to ``data/charts/<chart_id>.{png,json}``.
  4. The frontend polls / fetches the artefact via its id when ready.

Status is tracked in-process via ``CHART_STATUS`` so the existing chat
streaming endpoint can include progress markers when desired.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

from agent.config import get_section

logger = logging.getLogger(__name__)


CHART_STATUS: Dict[str, Dict[str, Any]] = {}
"""``{chart_id: {"status": "pending|done|error", "path": ..., "error": ...}}``"""


def schedule_chart(query: str, chart_type: Optional[str] = None) -> str:
    """Schedule a chart generation. Returns the chart_id."""
    chart_id = uuid.uuid4().hex
    CHART_STATUS[chart_id] = {"status": "pending"}

    if not (get_section("chart") or {}).get("async_generation", True):
        # Synchronous fallback when explicitly disabled in config.
        _render_chart_blocking(chart_id, query, chart_type)
        return chart_id

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop is not None:
        loop.create_task(_render_chart_async(chart_id, query, chart_type))
    else:
        # No event loop (e.g. CLI/test) → fire-and-forget thread.
        t = threading.Thread(
            target=_render_chart_blocking,
            args=(chart_id, query, chart_type),
            daemon=True,
        )
        t.start()
    return chart_id


def get_chart_status(chart_id: str) -> Dict[str, Any]:
    return dict(CHART_STATUS.get(chart_id, {"status": "unknown"}))


# ── Internals ───────────────────────────────────────────────────────────────


async def _render_chart_async(chart_id: str, query: str, chart_type: Optional[str]) -> None:
    await asyncio.to_thread(_render_chart_blocking, chart_id, query, chart_type)


def _render_chart_blocking(chart_id: str, query: str, chart_type: Optional[str]) -> None:
    try:
        from flows.chart_flow import run_chart_flow
        out_dir = Path((get_section("chart") or {}).get("output_dir") or "data/charts")
        out_dir.mkdir(parents=True, exist_ok=True)

        # Pass output paths so the flow writes directly into our managed dir.
        result = run_chart_flow(
            query=query,
            chart_type=chart_type,
            output_path=str(out_dir / f"{chart_id}.png"),
        )
        CHART_STATUS[chart_id] = {
            "status": "done",
            "path": str(out_dir / f"{chart_id}.png"),
            "result": result if isinstance(result, dict) else None,
        }
        logger.info("Chart %s rendered", chart_id)
    except Exception as exc:
        logger.exception("Chart %s failed: %s", chart_id, exc)
        CHART_STATUS[chart_id] = {"status": "error", "error": str(exc)}
