"""
web_search tool — Search the web for information.

Tries providers in order: Tavily → DuckDuckGo (free fallback).
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict

from llm.base_llm import ToolResult
from services.tool_registry import Tool

logger = logging.getLogger(__name__)


def _search_tavily(query: str, max_results: int) -> str | None:
    """Search via Tavily API (returns LLM-friendly text)."""
    api_key = os.getenv("TAVILY_API_KEY")
    if not api_key:
        return None
    try:
        import httpx

        resp = httpx.post(
            "https://api.tavily.com/search",
            json={
                "api_key": api_key,
                "query": query,
                "max_results": max_results,
                "include_answer": True,
                "search_depth": "basic",
            },
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()

        lines = []
        answer = data.get("answer")
        if answer:
            lines.append(f"Summary: {answer}\n")

        for r in data.get("results", [])[:max_results]:
            title = r.get("title", "")
            url = r.get("url", "")
            content = r.get("content", "")
            lines.append(f"**{title}**\n{url}\n{content}\n")

        return "\n".join(lines) if lines else None
    except Exception as exc:
        logger.warning("Tavily search failed: %s", exc)
        return None


def _search_duckduckgo(query: str, max_results: int) -> str | None:
    """Search via DuckDuckGo (free, no API key)."""
    try:
        from duckduckgo_search import DDGS

        results = list(DDGS().text(query, max_results=max_results))
        if not results:
            return None

        lines = []
        for r in results:
            title = r.get("title", "")
            href = r.get("href", "")
            body = r.get("body", "")
            lines.append(f"**{title}**\n{href}\n{body}\n")

        return "\n".join(lines)
    except ImportError:
        logger.warning("duckduckgo_search not installed. pip install duckduckgo-search")
        return None
    except Exception as exc:
        logger.warning("DuckDuckGo search failed: %s", exc)
        return None


def _handle_web_search(args: Dict[str, Any], ctx: Dict[str, Any]) -> ToolResult:
    """Search the web for information."""
    query = args.get("query", "").strip()
    if not query:
        return ToolResult(tool_use_id="", content="No search query provided.", is_error=True)

    max_results = args.get("max_results", 5)

    # Try Tavily first, fallback to DuckDuckGo
    result_text = _search_tavily(query, max_results)
    if result_text is None:
        result_text = _search_duckduckgo(query, max_results)

    if result_text is None:
        return ToolResult(
            tool_use_id="",
            content="Web search is unavailable. Set TAVILY_API_KEY or install duckduckgo-search.",
            is_error=True,
        )

    return ToolResult(tool_use_id="", content=result_text)


web_search_tool = Tool(
    name="web_search",
    description=(
        "Search the web for current information, news, documentation, or facts "
        "that are not available in the local data. Returns titles, URLs, and snippets."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "The search query.",
            },
            "max_results": {
                "type": "integer",
                "description": "Max results to return (default 5).",
                "default": 5,
            },
        },
        "required": ["query"],
    },
    handler=_handle_web_search,
    category="external",
)
