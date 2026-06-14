"""Background CTE-authoring jobs (non-blocking delegation to Claude Code).

When the chat agent (DeepSeek / LangChain) cannot answer a question with the
existing CTE library, it returns clarifying questions to the user **immediately**
and fires a Claude Code CTE-authoring run in the BACKGROUND. The 30–90 s the
expert agent needs to design + test new CTEs is hidden behind the
human-in-the-loop clarification dialogue: by the time the user replies, the new
CTEs exist (persisted to the graph, instantly reusable via the fast path).

Design notes:
- One job per session at a time (the user is answering clarifications meanwhile).
- The job runs in a daemon thread and spawns ``claude`` bound to the session's
  CTE graph + data source, with the CTE-authoring playbook as system prompt.
- It writes nothing the user sees; it only persists reusable CTEs. Progress is
  observable via :func:`get_job` (status + the CTE names created).
- Fails closed: any error just marks the job failed; the chat is unaffected.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
import uuid
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# session_id -> {job_id, status: running|done|failed, query, graph_id, created:[...]}
_jobs: Dict[str, Dict[str, Any]] = {}
_lock = threading.Lock()

# Authoring a tested CTE through the full Claude Code + MCP loop (first upsert
# loads the embedding model) realistically takes 2–4 min. This is background work
# hidden behind the clarification dialogue, so a generous ceiling is fine.
_MAX_RUNTIME_S = 300


def has_active_job(session_id: str) -> bool:
    with _lock:
        j = _jobs.get(session_id)
        return bool(j and j.get("status") == "running")


def get_job(session_id: str) -> Optional[Dict[str, Any]]:
    """Latest background job for *session_id* (copy), or ``None``."""
    with _lock:
        j = _jobs.get(session_id)
        return dict(j) if j else None


def consume_completed_job(session_id: str) -> Optional[Dict[str, Any]]:
    """Pop a *completed* job for the session (once), so the next chat turn can
    announce the new CTEs and answer with them. Running/failed jobs are left in
    place (running: still authoring; failed: nothing to announce)."""
    with _lock:
        j = _jobs.get(session_id)
        if j and j.get("status") == "done" and j.get("created"):
            return _jobs.pop(session_id)
        if j and j.get("status") == "failed":
            _jobs.pop(session_id, None)  # clear so a future hard query can retry
        return None


def _graph_nodes(graph_id: str) -> List[str]:
    try:
        from services.cte_graph.repository import get_repository

        return list(get_repository(graph_id).load().nodes())
    except Exception:
        return []


def start_cte_job(
    session_id: str,
    query: str,
    *,
    graph_id: str,
    parquet_source: str = "",
    source_view: str = "",
) -> Optional[str]:
    """Fire a background Claude Code run that designs CTEs to answer *query*.

    Non-blocking. Returns a job id, or ``None`` when delegation is unavailable
    (Claude Code not authenticated, no target graph, or a job already running
    for this session).
    """
    if not graph_id:
        return None
    try:
        from api.routes.admin_claude import _auth_token

        if not _auth_token():
            return None
    except Exception:
        return None

    with _lock:
        cur = _jobs.get(session_id)
        if cur and cur.get("status") == "running":
            return None  # one background authoring job per session
        job_id = "bg-" + uuid.uuid4().hex[:10]
        _jobs[session_id] = {
            "job_id": job_id,
            "status": "running",
            "query": query,
            "graph_id": graph_id,
            "created": [],
        }

    threading.Thread(
        target=_run_job,
        args=(job_id, session_id, query, graph_id, parquet_source, source_view),
        daemon=True,
    ).start()
    logger.info(
        "Background CTE job %s started (session=%s graph=%s): %s",
        job_id, session_id, graph_id, query[:80],
    )
    return job_id


def _run_job(
    job_id: str,
    session_id: str,
    query: str,
    graph_id: str,
    parquet_source: str,
    source_view: str,
) -> None:
    try:
        from api.routes.admin_claude import (
            _CLAUDE_BIN,
            _MCP_SERVER,
            _MCP_TOOLS,
            _RUNS_DIR,
            _claude_subprocess_env,
            _load_playbook,
        )

        before = set(_graph_nodes(graph_id))

        run_dir = _RUNS_DIR / job_id
        run_dir.mkdir(parents=True, exist_ok=True)
        env_mcp: Dict[str, str] = {"BRIKZ_TARGET_GRAPH_ID": graph_id}
        if parquet_source:
            env_mcp["BRIKZ_PARQUET_SOURCE"] = parquet_source
        if source_view:
            env_mcp["BRIKZ_SOURCE_VIEW"] = source_view
        cfg = run_dir / "brikz-mcp.json"
        cfg.write_text(
            json.dumps(
                {"mcpServers": {"brikz": {"command": "python", "args": [_MCP_SERVER], "env": env_mcp}}}
            )
        )

        playbook = _load_playbook()
        system = (
            (playbook + "\n\n---\n\n" if playbook else "")
            + "## Mission (arrière-plan)\n"
            "Conçois, ENREGISTRE (`upsert_cte`) et TESTE (`execute_cte`, row_count>0) "
            "les CTE PARAMÉTRÉES nécessaires pour répondre à la question ci-dessous, "
            "DANS CE graphe et sa source. Crée les fondations avant les composites. "
            "Tu ne réponds PAS à l'utilisateur — tu ne fais que laisser des CTE "
            "réutilisables, correctement validées."
        )
        user = f"Question à outiller par des CTE réutilisables :\n{query}"
        args = [
            _CLAUDE_BIN, "--print", "--output-format", "json", "--verbose",
            "--permission-mode", "acceptEdits",
            "--mcp-config", str(cfg), "--strict-mcp-config",
            "--allowedTools", *_MCP_TOOLS, "Read", "Grep", "Glob",
            "--append-system-prompt", system,
            user,
        ]
        subprocess.run(
            args, cwd="/app", env=_claude_subprocess_env(),
            timeout=_MAX_RUNTIME_S, capture_output=True,
        )

        created = sorted(set(_graph_nodes(graph_id)) - before)
        with _lock:
            j = _jobs.get(session_id)
            if j and j.get("job_id") == job_id:
                j["status"] = "done"
                j["created"] = created
        logger.info("Background CTE job %s done (session=%s): created=%s", job_id, session_id, created)
    except Exception as exc:
        logger.warning("Background CTE job %s failed: %s", job_id, exc)
        with _lock:
            j = _jobs.get(session_id)
            if j and j.get("job_id") == job_id:
                j["status"] = "failed"
