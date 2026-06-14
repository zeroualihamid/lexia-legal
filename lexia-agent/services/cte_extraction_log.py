"""Purpose-built log of CTE extractions per /chat turn, for the admin review.

The conversation *memory* store is unsuitable for reviewing CTE pertinence: the
full-agent path stores the **augmented** query (LangChain history input), the
card-generation sessions store **sub-agent** prompts, and the fast-path stores
no CTE metadata. So we append a clean record per /chat turn here:

    { ts, original_query, augmented_query, cte_mode, cte_names, ctes[], results[], response }

``cte_mode`` ∈ reused | generated | ran | none — whether the answer REUSED an
existing CTE (fast-path / library hit), GENERATED a new one, ran ad-hoc CTE SQL,
or used no CTE. One JSONL file per session under ``data/cte_reviews/``.
"""
from __future__ import annotations

import glob
import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

_DIR = Path("data/cte_reviews")


def _safe(session_id: str) -> str:
    return "".join(c if (c.isalnum() or c in "-_.") else "_" for c in (session_id or "default"))[:120]


def _path(session_id: str) -> Path:
    return _DIR / f"{_safe(session_id)}.jsonl"


def _mode(shared: Dict[str, Any]) -> str:
    if shared.get("fast_path") or shared.get("cte_hit"):
        return "reused"
    if shared.get("cte_created"):
        return "generated"
    if shared.get("sql_queries"):
        return "ran"
    return "none"


def append_record(session_id: str, original_query: str, shared: Dict[str, Any]) -> None:
    """Append one turn's CTE-extraction record (best-effort, never raises)."""
    try:
        sql_queries = shared.get("sql_queries") or []
        if not sql_queries and not (shared.get("final_response") or shared.get("answer")):
            return  # nothing worth logging
        _DIR.mkdir(parents=True, exist_ok=True)
        ctes = [
            {"label": q.get("label", ""), "sql": q.get("sql", "")}
            for q in sql_queries
            if isinstance(q, dict)
        ]
        results = [
            {
                "label": r.get("label", ""),
                "columns": r.get("columns") or [],
                "row_count": r.get("row_count"),
                "rows": (r.get("rows") or [])[:5],
                "error": r.get("error"),
            }
            for r in (shared.get("sql_results") or [])
            if isinstance(r, dict)
        ]
        names: List[str] = []
        if shared.get("fast_path_cte"):
            names.append(str(shared["fast_path_cte"]))
        if shared.get("cte_created"):
            names.append(str(shared["cte_created"]))
        names += [(c["label"] or "").split("\n")[0][:60] for c in ctes]
        rec = {
            "ts": time.time(),
            "original_query": original_query,
            "augmented_query": shared.get("augmented_query", ""),
            "cte_mode": _mode(shared),
            "cte_names": list(dict.fromkeys([n for n in names if n])),
            "ctes": ctes,
            "results": results,
            "response": str(shared.get("final_response") or shared.get("answer") or "")[:4000],
        }
        with open(_path(session_id), "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False, default=str) + "\n")
    except Exception:
        pass


def _read(p: Path) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    try:
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    except Exception:
        pass
    return out


def list_sessions(limit: int = 200) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for p in glob.glob(str(_DIR / "*.jsonl")):
        recs = _read(Path(p))
        if not recs:
            continue
        last = recs[-1]
        out.append(
            {
                "session_id": Path(p).stem,
                "turns": len(recs),
                "cte_turns": sum(1 for r in recs if r.get("ctes")),
                "last_query": (last.get("original_query") or "")[:160],
                "updated_at": last.get("ts", 0.0),
            }
        )
    out.sort(key=lambda x: x["updated_at"], reverse=True)
    return out[:limit]


def load_session(session_id: str) -> Optional[Dict[str, Any]]:
    p = _path(session_id)
    if not p.exists():
        return None
    return {"session_id": session_id, "turn_count": 0, "records": _read(p)}


# ── Per-turn (flattened) access ──────────────────────────────────────────────
# A client may reuse a single session_id across many distinct questions, which
# would collapse them into one file. For review we treat EACH turn as its own
# conversation: ``conv_id = "<session-stem>::<record-index>"``.
_SEP = "::"


def _split_conv(conv_id: str) -> tuple[str, Optional[int]]:
    if _SEP in conv_id:
        stem, _, idx = conv_id.rpartition(_SEP)
        try:
            return stem, int(idx)
        except ValueError:
            return conv_id, None
    return conv_id, None


def list_records(limit: int = 200) -> List[Dict[str, Any]]:
    """One entry per /chat turn across all sessions, newest first (nothing hidden)."""
    out: List[Dict[str, Any]] = []
    for p in glob.glob(str(_DIR / "*.jsonl")):
        stem = Path(p).stem
        for idx, r in enumerate(_read(Path(p))):
            out.append(
                {
                    "session_id": f"{stem}{_SEP}{idx}",
                    "turns": 1,
                    "cte_turns": 1 if r.get("ctes") else 0,
                    "last_query": (r.get("original_query") or "")[:160],
                    "updated_at": r.get("ts", 0.0),
                    "cte_mode": r.get("cte_mode", "none"),
                    "cte_names": r.get("cte_names", []),
                }
            )
    out.sort(key=lambda x: x["updated_at"], reverse=True)
    return out[:limit]


def load_record(conv_id: str) -> Optional[Dict[str, Any]]:
    """Load a single turn by ``conv_id`` (``stem::idx``); whole session if no index."""
    stem, idx = _split_conv(conv_id)
    p = _path(stem)
    if not p.exists():
        return None
    recs = _read(p)
    if idx is None:
        return {"session_id": conv_id, "records": recs}
    if 0 <= idx < len(recs):
        return {"session_id": conv_id, "records": [recs[idx]]}
    return None


def delete_record(conv_id: str) -> None:
    """Delete one turn (``stem::idx``) — rewriting the file — or the whole session."""
    stem, idx = _split_conv(conv_id)
    p = _path(stem)
    if not p.exists():
        return
    if idx is None:
        p.unlink(missing_ok=True)
        return
    recs = _read(p)
    if 0 <= idx < len(recs):
        del recs[idx]
    if recs:
        with open(p, "w", encoding="utf-8") as f:
            for r in recs:
                f.write(json.dumps(r, ensure_ascii=False, default=str) + "\n")
    else:
        p.unlink(missing_ok=True)


def delete_session(session_id: str) -> None:
    _path(session_id).unlink(missing_ok=True)


def delete_all() -> int:
    n = 0
    for p in glob.glob(str(_DIR / "*.jsonl")):
        Path(p).unlink(missing_ok=True)
        n += 1
    return n
