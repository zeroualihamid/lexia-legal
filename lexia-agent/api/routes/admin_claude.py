"""Admin endpoint: run Claude Code (headless) to enhance a skill + its CTE graph.

``POST /admin/claude/stream`` spawns the ``claude`` CLI in print/stream-json mode
with a scoped MCP server (``mcp/brikz_mcp_server.py``) that exposes typed
skill/CTE/DTO tools. The CLI's NDJSON output is parsed into SSE events for the
brikz-admin chat panel. ``POST /admin/claude/abort/{run_id}`` kills a run.

Auth: the agent process must carry a Claude subscription token
(``CLAUDE_CODE_OAUTH_TOKEN`` from ``claude setup-token``) or ``ANTHROPIC_API_KEY``.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from api.sse_streaming import SSEEvent

logger = logging.getLogger(__name__)
router = APIRouter()

_CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "claude")
_RUNS_DIR = Path("/app/data/.claude/runs")
_MCP_SERVER = "/app/mcp/brikz_mcp_server.py"
_MAX_CONCURRENT = int(os.environ.get("LEXIA_CLAUDE_MAX_RUNS", "2"))

_runs: Dict[str, asyncio.subprocess.Process] = {}
_sem = asyncio.Semaphore(_MAX_CONCURRENT)

_MCP_TOOLS = [
    "mcp__brikz__list_dtos",
    "mcp__brikz__read_dto",
    "mcp__brikz__get_skill",
    "mcp__brikz__update_skill",
    "mcp__brikz__list_ctes",
    "mcp__brikz__get_cte",
    "mcp__brikz__upsert_cte",
    "mcp__brikz__execute_cte",
    # Read the conversation(s) behind a reported response problem so the agent can
    # diagnose what actually went wrong before correcting the skill + its CTEs.
    "mcp__brikz__list_conversations",
    "mcp__brikz__read_conversation",
]

# Filesystem tools (real shell-equivalent commands) so Claude Code can inspect &
# fix data configs, skills, prompts and conversation files directly under /app.
# Writes are confined to /app + /tmp by the MCP server; disk-admin (fdisk/mkfs/
# mount/umount/fsck) is inert unless an operator sets LEXIA_FS_ALLOW_DISK_ADMIN=1.
_FS_TOOLS = [
    "mcp__brikz__pwd", "mcp__brikz__cd", "mcp__brikz__ls", "mcp__brikz__tree",
    "mcp__brikz__cat", "mcp__brikz__less", "mcp__brikz__head", "mcp__brikz__tail",
    "mcp__brikz__grep", "mcp__brikz__find",
    "mcp__brikz__df", "mcp__brikz__du", "mcp__brikz__lsblk", "mcp__brikz__blkid",
    "mcp__brikz__mkdir", "mcp__brikz__touch", "mcp__brikz__cp", "mcp__brikz__mv",
    "mcp__brikz__rm", "mcp__brikz__rmdir", "mcp__brikz__ln",
    "mcp__brikz__chmod", "mcp__brikz__chown",
    "mcp__brikz__fdisk", "mcp__brikz__mkfs", "mcp__brikz__mount",
    "mcp__brikz__umount", "mcp__brikz__fsck",
]

_FS_INSTRUCTION = (
    "\n\n---\n\n## Outils système de fichiers\n"
    "Tu disposes d'outils MCP de système de fichiers, à utiliser par leur nom comme "
    "des commandes shell, pour inspecter ET corriger les fichiers du projet sous "
    "`/app` (configs `config/`, skills `prompts/skills/`, prompts `prompts/` & "
    "`llm/prompts/`, conversations `data/cte_reviews/`, données `data/`) :\n"
    "- Naviguer/voir : `pwd`, `cd`, `ls`, `tree`, `cat`, `less`, `head`, `tail`.\n"
    "- Chercher : `grep`, `find`.\n"
    "- Gérer : `mkdir`, `touch`, `cp`, `mv`, `rm`, `rmdir`, `ln`.\n"
    "- Espace/permissions : `df`, `du`, `lsblk`, `blkid`, `chmod`, `chown`.\n"
    "Les écritures/suppressions sont limitées à `/app` et `/tmp` (tout autre chemin "
    "est refusé). Les outils d'administration disque (`fdisk`, `mkfs`, `mount`, "
    "`umount`, `fsck`) sont désactivés par défaut. Utilise ces outils avec prudence : "
    "vérifie (`ls`/`cat`/`grep`) AVANT de modifier ou supprimer, et n'utilise jamais "
    "`rm`/`mv` sans avoir confirmé la cible."
)

# Human-in-the-loop for the non-interactive chat runs. AskUserQuestion is
# auto-allowed with EMPTY answers in --print mode, so the agent must not wait
# for the result: the admin UI renders the question card with clickable options
# and the user's choice arrives as the NEXT chat message (with history context).
_HITL_INSTRUCTION = (
    "\n\n---\n\n## Information manquante (human-in-the-loop)\n"
    "Si une information OBLIGATOIRE manque pour agir (ex. locataire de "
    "rattachement, type de badge, priorité d'un ticket), pose UNE question via "
    "l'outil `AskUserQuestion`, avec des options CONCRÈTES issues des outils "
    "(ex. les noms réels de `building_list(resource='tenants')`), et des "
    "valeurs par défaut raisonnables en première option.\n"
    "IMPORTANT : la session est non interactive — `AskUserQuestion` te renverra "
    "une réponse VIDE. Ne la considère pas comme un refus et ne reformule pas la "
    "question en texte. Termine ton tour par UNE seule phrase courte du type : "
    "« Sélectionnez une option ci-dessus — je continue dès votre réponse. » "
    "L'administrateur répondra dans son PROCHAIN message : reprends alors "
    "l'action immédiatement, sans redemander ce qui a déjà été répondu.\n"
    "N'utilise PAS `AskUserQuestion` si l'information peut être déduite des "
    "outils ou si une valeur par défaut évidente existe (indique-la alors dans "
    "ta réponse)."
)


class EnhanceRequest(BaseModel):
    skill_directory_name: str
    instructions: str = ""
    dto: str = ""
    max_questions: int = 5


def _oauth_token() -> Optional[str]:
    """Subscription (Pro/Max) auth token, under either accepted variable name."""
    return (
        os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")
        or os.environ.get("ANTHROPIC_AUTH_TOKEN")
        or None
    )


def _auth_token() -> Optional[str]:
    """Any usable Claude auth — OAuth subscription first, then API key."""
    return _oauth_token() or os.environ.get("ANTHROPIC_API_KEY")


def _claude_subprocess_env() -> Dict[str, str]:
    """Environment for the spawned ``claude`` CLI.

    Claude Code prefers ``ANTHROPIC_API_KEY`` when both it and a subscription
    token are present — and on this deployment the API key has no credits
    ("Credit balance is too low"). So when a subscription OAuth token exists,
    mirror it to ``ANTHROPIC_AUTH_TOKEN`` (the var the CLI reads for Bearer auth)
    and DROP the API key from the child env so the CLI uses the subscription.

    Only the ``claude`` child gets this sanitized env; ``ANTHROPIC_API_KEY``
    stays in the service environment for the main agent / other providers.
    """
    env = os.environ.copy()
    oauth = _oauth_token()
    if oauth:
        env["ANTHROPIC_AUTH_TOKEN"] = oauth
        env["CLAUDE_CODE_OAUTH_TOKEN"] = oauth
        env.pop("ANTHROPIC_API_KEY", None)
    return env


def _resolve_skill(directory_name: str) -> tuple[Dict[str, Any], str, str]:
    """(frontmatter, body, canonical_directory_name). 404 if the skill is missing.

    The caller may pass the skill's name or a hyphen/underscore variant; we
    resolve it to the real on-disk folder so --add-dir / LEXIA_SKILL_DIR are
    correct (otherwise a name≠folder mismatch 404s even though the skill exists).
    """
    from api.routes.skills import _read_skill_file  # raises 404 if missing

    data = _read_skill_file(directory_name)
    return data["frontmatter"], data["body"], str(data.get("directory_name") or directory_name)


def _graph_id_for(skill_name: str) -> str:
    from services.cte_graph.library_graph_cache import graph_id_for_library

    return graph_id_for_library(skill_name)


def _source_binding_for_dto(dto: str) -> tuple[str, str]:
    """Derive ``(parquet_source, source_view)`` from a DTO.

    Defensive fallback for skills whose SKILL.md frontmatter does not declare a
    ``source_view`` / ``parquet_source`` (e.g. a skill created in the admin UI
    with only a ``dto`` set). Without a binding the MCP server can't register the
    DuckDB view, so every ``upsert_cte`` / ``execute_cte`` the enhance agent runs
    fails. The DTO slug (directory name minus the ``_dto`` suffix) is the source
    view name, and CSV/XLSX uploads cache their parquet at
    ``data/parquet/<slug>_data.parquet``. Returns ``("", "")`` when *dto* is empty.
    """
    dto = (dto or "").strip()
    if not dto:
        return "", ""
    slug = dto[:-4] if dto.endswith("_dto") else dto
    parquet_dir = Path("/app/data/parquet")
    for cand in (parquet_dir / f"{slug}_data.parquet", parquet_dir / f"{slug}.parquet"):
        if cand.exists():
            return str(cand), slug
    # File not found yet — still return the conventional binding so the agent
    # sees the intended source; execution will surface a clear missing-file error.
    return str(parquet_dir / f"{slug}_data.parquet"), slug


# Dedicated, version-controlled "how to author CTEs" skill, baked into the image
# (part of deployment). Injected into every enhance run's system prompt so the
# agent always follows the same reliable, tested-CTE methodology.
_PLAYBOOK_PATH = Path("/app/prompts/cte_authoring_playbook.md")


def _load_playbook() -> str:
    try:
        return _PLAYBOOK_PATH.read_text(encoding="utf-8").strip()
    except Exception:
        return ""


# Correction mode — appended to every enhance run. When the operator's
# instructions describe a PROBLEM with the agent's responses (wrong figure, wrong
# scope, missing year filter, off-topic, etc.) the run is a FIX, not an
# enrichment: diagnose the artifact that produced the bad answer and correct it
# (the CTE *and* the SKILL.md), rather than only adding new questions.
_CORRECTION_BLOCK = (
    "\n\n---\n\n## Mode correction — réparer un problème de réponse\n"
    "Si les instructions de l'opérateur décrivent un PROBLÈME constaté dans une "
    "réponse de l'agent (mauvais chiffre, mauvais périmètre, ventilation non "
    "demandée, mauvaise année/exercice, hors-sujet, résultat vide…), ta priorité "
    "n'est PAS d'ajouter de nouvelles questions : c'est de DIAGNOSTIQUER puis de "
    "CORRIGER l'artefact fautif — la CTE **et** le SKILL.md.\n"
    "1. **Reproduire / localiser** : si une conversation est citée, "
    "`read_conversation` (sinon `list_conversations` pour retrouver le tour "
    "concerné) pour voir la question exacte, la CTE exécutée et le résultat. "
    "`list_ctes` + `get_cte` pour lire le SQL EXACT de la/les CTE en cause.\n"
    "2. **Diagnostiquer** la cause racine, p. ex. : valeur de filtre codée en dur "
    "au lieu d'un `$param` ; FILTRE manquant (somme de toutes les années alors que "
    "l'on demande une année précise) ; mauvais axe de regroupement / ventilation "
    "superflue ; mauvaise mesure ou colonne ; jointure/échelle erronée.\n"
    "3. **Corriger la CTE** via `upsert_cte` (même nom pour remplacer la version "
    "fautive) : SQL paramétré, périmètre exact, colonnes RÉELLES de `read_dto`. "
    "Crée une CTE manquante seulement si aucune existante ne convient.\n"
    "4. **Re-tester (OBLIGATOIRE)** : `execute_cte(...)` avec des valeurs d'exemple "
    "reproduisant le cas signalé — vérifie que le résultat est désormais correct "
    "(bon périmètre, `row_count > 0`, chiffre cohérent).\n"
    "5. **Mettre à jour le SKILL.md** (`update_skill`) : documente le périmètre "
    "corrigé, les `$param`, et au besoin renforce les alias / la règle de choix de "
    "CTE pour que ce type de question route vers la BONNE CTE à l'avenir.\n"
    "6. **Résumer** : ce qui était faux, la correction appliquée (CTE + skill) et "
    "la preuve par `execute_cte`. N'invente aucun chiffre."
)


def _system_prompt(max_questions: int) -> str:
    playbook = _load_playbook()
    run_params = (
        "\n\n---\n\n## Paramètres de cette exécution\n"
        f"- Si l'opérateur signale un problème de réponse → applique le **Mode "
        "correction** ci-dessus (corrige la CTE fautive + le SKILL.md).\n"
        f"- Sinon (enrichissement) : propose et traite jusqu'à **{max_questions}** "
        "questions métier concrètes, ancrées sur les colonnes réelles de la DTO "
        "(catégorielles → regroupements, numériques → mesures).\n"
        "- Termine par le tableau récapitulatif des CTE créées/corrigées (§3.6 du playbook)."
    )
    if playbook:
        return playbook + _CORRECTION_BLOCK + run_params
    # Fallback (playbook file unavailable) — concise inline methodology.
    return (
        "Tu es un ingénieur analytics Brikz. Ta mission : ENRICHIR UN SEUL skill et sa "
        "bibliothèque de CTE. Tu agis EXCLUSIVEMENT via les outils `mcp__brikz__*` "
        "(et Read pour inspecter des fichiers). Boucle :\n"
        "1. `get_skill` + `read_dto(<dto>)` + `list_ctes` pour comprendre le skill, les "
        "colonnes RÉELLES de la source et les CTE existantes.\n"
        f"2. Propose jusqu'à {max_questions} questions métier concrètes, ancrées sur les "
        "colonnes réelles de la DTO (catégorielles → regroupements, numériques → mesures).\n"
        "3. Pour chaque question : écris une CTE PARAMÉTRÉE (valeurs de filtre en `$param`, "
        "jamais en dur ; référence la vue source ou des CTE existantes), `upsert_cte(...)` "
        "(corrige et réessaie si la validation rejette des colonnes), puis "
        "`execute_cte(cte_name=..., parameters={…valeurs d'exemple…})` et EXIGE row_count > 0.\n"
        "4. `update_skill(...)` : documente les nouveaux axes/KPI + chaque CTE et la "
        "question associée, étends les alias. Préserve les sections existantes, écris en "
        "français.\n"
        "5. Termine par un résumé concis des changements.\n"
        "N'invente JAMAIS de chiffres : toute valeur provient d'un `execute_cte`. Utilise "
        "les noms de colonnes EXACTS renvoyés par `read_dto`. Crée les CTE de base avant "
        "les CTE composites (les `depends_on` doivent déjà exister)."
        + _CORRECTION_BLOCK
    )


def _user_prompt(req: EnhanceRequest, skill_name: str, dto: str, graph_id: str) -> str:
    return (
        f"Améliore le skill « {skill_name} » (dossier `{req.skill_directory_name}`).\n"
        f"DTO liée : {dto or '(non précisée — utilise list_dtos/read_dto)'}\n"
        f"Graphe CTE cible : {graph_id}\n"
        f"Nombre de questions max : {req.max_questions}\n"
        "Instructions de l'opérateur (peuvent décrire un PROBLÈME de réponse à "
        f"corriger — voir « Mode correction ») : {req.instructions.strip() or '(aucune)'}"
    )


def _events_from_claude_line(line: str) -> List[SSEEvent]:
    """Map one stream-json NDJSON object to zero or more SSE events (tolerant)."""
    line = line.strip()
    if not line:
        return []
    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        return []
    t = obj.get("type")
    out: List[SSEEvent] = []
    if t == "system":
        out.append(SSEEvent(event="claude_system", data={"subtype": obj.get("subtype"), "tools": obj.get("tools")}))
    elif t == "assistant":
        for block in (obj.get("message", {}) or {}).get("content", []) or []:
            bt = block.get("type")
            if bt == "text" and block.get("text"):
                out.append(SSEEvent(event="assistant_delta", data={"text": block["text"]}))
            elif bt == "thinking" and block.get("thinking"):
                out.append(SSEEvent(event="thinking", data={"text": block["thinking"]}))
            elif bt == "tool_use":
                out.append(SSEEvent(event="tool_start", data={"tool": block.get("name"), "input": block.get("input")}))
    elif t == "user":
        for block in (obj.get("message", {}) or {}).get("content", []) or []:
            if block.get("type") == "tool_result":
                content = block.get("content")
                if isinstance(content, list):
                    content = " ".join(c.get("text", "") for c in content if isinstance(c, dict))
                out.append(SSEEvent(event="tool_result", data={"content": str(content)[:16000], "is_error": block.get("is_error", False)}))
    elif t == "result":
        out.append(SSEEvent(event="result", data={"result": obj.get("result"), "is_error": bool(obj.get("is_error")), "subtype": obj.get("subtype")}))
    return out


async def _spawn_and_stream(run_id: str, args: list, started_data: Dict[str, Any]):
    """Spawn ``claude`` and stream its NDJSON stdout as SSE (shared by enhance + judge)."""
    if _sem.locked() and _sem._value <= 0:  # type: ignore[attr-defined]
        yield SSEEvent(event="error", data={"message": "Trop d'analyses Claude en cours, réessayez."}).to_sse_payload()
        return
    await _sem.acquire()
    proc: Optional[asyncio.subprocess.Process] = None
    try:
        yield SSEEvent(event="run_started", data=started_data).to_sse_payload()
        proc = await asyncio.create_subprocess_exec(
            *args, cwd="/app",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env=_claude_subprocess_env(),
            # A single stream-json line can carry a large tool_result (e.g. a full
            # conversation); raise the default 64KB readline buffer to 16MB.
            limit=16 * 1024 * 1024,
        )
        _runs[run_id] = proc
        assert proc.stdout is not None
        while True:
            try:
                raw = await asyncio.wait_for(proc.stdout.readline(), timeout=20.0)
            except asyncio.TimeoutError:
                yield SSEEvent(event="heartbeat", data={"run_id": run_id}).to_sse_payload()
                continue
            if not raw:
                break
            for ev in _events_from_claude_line(raw.decode("utf-8", "replace")):
                yield ev.to_sse_payload()
        rc = await proc.wait()
        if rc != 0:
            err = ""
            if proc.stderr is not None:
                err = (await proc.stderr.read()).decode("utf-8", "replace")[-1500:]
            yield SSEEvent(event="error", data={"message": f"claude exited with code {rc}", "stderr": err}).to_sse_payload()
        yield SSEEvent(event="done", data={"run_id": run_id}).to_sse_payload()
    except Exception as exc:  # noqa: BLE001
        logger.exception("Claude run failed")
        yield SSEEvent(event="error", data={"message": str(exc)}).to_sse_payload()
    finally:
        _runs.pop(run_id, None)
        if proc is not None and proc.returncode is None:
            try:
                proc.terminate()
            except ProcessLookupError:
                pass
        _sem.release()


async def _spawn_collect(run_id: str, args: list, timeout: float = 900.0) -> Dict[str, Any]:
    """Run ``claude`` to completion (no streaming) and return its final result.

    Used by the cron/audit job, which fires a judge run per flagged conversation
    and only needs the outcome. Returns ``{result, is_error, rc, tool_calls}``.
    """
    async with _sem:
        proc = await asyncio.create_subprocess_exec(
            *args, cwd="/app",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env=_claude_subprocess_env(), limit=16 * 1024 * 1024,
        )
        _runs[run_id] = proc
        try:
            try:
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
            except asyncio.TimeoutError:
                proc.kill()
                return {"result": "", "is_error": True, "rc": -1, "tool_calls": 0,
                        "error": f"timeout after {int(timeout)}s"}
            result_text, is_error, tool_calls = "", False, 0
            for raw in stdout.decode("utf-8", "replace").splitlines():
                for ev in _events_from_claude_line(raw):
                    if ev.event == "tool_start":
                        tool_calls += 1
                    elif ev.event == "result":
                        result_text = str(ev.data.get("result") or "")
                        is_error = bool(ev.data.get("is_error"))
            rc = proc.returncode or 0
            out: Dict[str, Any] = {
                "result": result_text, "is_error": is_error or rc != 0,
                "rc": rc, "tool_calls": tool_calls,
            }
            if rc != 0 and stderr:
                out["error"] = stderr.decode("utf-8", "replace")[-1000:]
            return out
        finally:
            _runs.pop(run_id, None)


@router.post("/stream", summary="Enhance a skill + its CTE graph with Claude Code (SSE)")
async def enhance_stream(req: EnhanceRequest):
    fm, _body, skill_dir = _resolve_skill(req.skill_directory_name)  # 404 if missing
    if not _auth_token():
        raise HTTPException(
            status_code=400,
            detail="Claude Code n'est pas authentifié : définissez CLAUDE_CODE_OAUTH_TOKEN "
            "(via `claude setup-token`) ou ANTHROPIC_API_KEY dans l'environnement de l'agent.",
        )

    skill_name = fm.get("name") or skill_dir
    dto = (req.dto or fm.get("dto") or "").strip()
    source_view = str(fm.get("source_view", "")).strip()
    parquet_source = str(fm.get("parquet_source", "")).strip()
    # Fall back to the DTO's conventional source binding when the skill's
    # frontmatter doesn't declare one — otherwise the MCP server registers no
    # DuckDB view and every upsert_cte/execute_cte the agent runs fails.
    if not (parquet_source and source_view) and dto:
        ps, sv = _source_binding_for_dto(dto)
        parquet_source = parquet_source or ps
        source_view = source_view or sv
    graph_id = _graph_id_for(skill_name)
    run_id = "cc-" + uuid.uuid4().hex[:12]

    run_dir = _RUNS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    cfg_path = run_dir / "brikz-mcp.json"
    cfg_path.write_text(
        json.dumps(
            {
                "mcpServers": {
                    "brikz": {
                        "command": "python",
                        "args": [_MCP_SERVER],
                        "env": {
                            "LEXIA_SKILL_DIR": skill_dir,
                            "LEXIA_TARGET_GRAPH_ID": graph_id,
                            "LEXIA_PARQUET_SOURCE": parquet_source,
                            "LEXIA_SOURCE_VIEW": source_view,
                        },
                    }
                }
            }
        )
    )

    args = [
        _CLAUDE_BIN, "--print", "--output-format", "stream-json", "--verbose",
        "--permission-mode", "acceptEdits",
        "--mcp-config", str(cfg_path), "--strict-mcp-config",
        "--allowedTools", *_MCP_TOOLS, *_FS_TOOLS, "Read", "Grep", "Glob",
        "--add-dir", f"/app/prompts/skills/{skill_dir}",
        "--append-system-prompt", _system_prompt(req.max_questions) + _FS_INSTRUCTION,
        _user_prompt(req, skill_name, dto, graph_id),
    ]

    started = {"run_id": run_id, "skill": req.skill_directory_name, "dto": dto, "graph_id": graph_id}
    return EventSourceResponse(
        _spawn_and_stream(run_id, args, started),
        headers={"X-Run-ID": run_id, "X-Accel-Buffering": "no"},
    )


@router.post("/abort/{run_id}", summary="Abort a running Claude Code enhance run")
async def abort_run(run_id: str):
    proc = _runs.get(run_id)
    if proc is None:
        raise HTTPException(status_code=404, detail=f"Run not found or already finished: {run_id}")
    try:
        proc.terminate()
    except ProcessLookupError:
        pass
    return {"success": True, "run_id": run_id}


# ── CTE analyse + improvement agent (judge → optimize) ───────────────────────

# Read/analysis tools always available. `upsert_cte` (write) is added ONLY in
# auto-approval mode; in manual mode the agent emits proposals the operator
# approves via POST /admin/claude/apply-cte.
_JUDGE_READ_TOOLS = [
    "mcp__brikz__list_conversations",
    "mcp__brikz__read_conversation",
    "mcp__brikz__list_dtos",
    "mcp__brikz__read_dto",
    "mcp__brikz__list_ctes",
    "mcp__brikz__get_cte",
    "mcp__brikz__execute_cte",
]


class JudgeRequest(BaseModel):
    session_id: str = ""
    instructions: str = ""
    # "auto" → the agent applies CTE changes directly; "manual" → it proposes
    # changes the operator approves (default, safer).
    approval_mode: str = "manual"
    # Optional explicit CTE graph; otherwise resolved from the conversation's CTEs.
    graph_id: str = ""


def _resolve_graph_for_session(session_id: str) -> str:
    """Find the CTE graph that holds this conversation's CTEs (by node name)."""
    names: set[str] = set()
    try:
        from services import conversation_review

        data = conversation_review.load_conversation_turns(session_id) if session_id else None
        for turn in (data or {}).get("turns", []):
            for n in turn.get("cte_names") or []:
                if str(n).strip():
                    names.add(str(n).strip())
            for c in turn.get("ctes") or []:
                lbl = str(c.get("label") or "").split("\n")[0].strip()
                if lbl:
                    names.add(lbl)
    except Exception:
        pass
    if not names:
        return ""
    import glob
    import pickle

    for p in glob.glob("/app/data/cte_graphs/*.pkl"):
        stem = Path(p).stem
        if stem.startswith("_backup"):
            continue
        try:
            with open(p, "rb") as fh:
                g = pickle.load(fh)
            if names & {str(n) for n in g.nodes()}:
                return stem
        except Exception:
            continue
    return ""


def _graph_binding(graph_id: str) -> tuple[str, str]:
    """(parquet_source, source_view) for a graph, for CTE validation/execution."""
    if not graph_id:
        return "", ""
    try:
        from services.cte_graph.repository import get_repository

        repo = get_repository(graph_id)
        return str(repo.parquet_source() or ""), str(repo.source_view() or "")
    except Exception:
        return "", ""


def _judge_system_prompt(approval_mode: str) -> str:
    common = (
        "Tu es un agent d'ANALYSE et d'AMÉLIORATION proactive des CTE de Brikz. On te "
        "fournit une conversation (question utilisateur → CTE exécutée → résultat). Tu "
        "agis via les outils `mcp__brikz__*`.\n"
        "Pour CHAQUE tour de la conversation :\n"
        "1. `read_conversation` (question + CTE + résultat), `get_cte` (SQL exact), "
        "`read_dto` (colonnes RÉELLES de la source).\n"
        "2. Évalue l'OPTIMALITÉ de la/les CTE :\n"
        "   • bon axe de regroupement et bonne mesure pour la question ;\n"
        "   • résultat non vide et cohérent ;\n"
        "   • PARAMÉTRAGE : une bonne CTE ne code PAS en dur les valeurs de filtre "
        "(année/exercice, catégorie, branche, type…) — ces valeurs doivent être des "
        "paramètres DuckDB `$nom`. Une CTE figée (ex. `WHERE EXERSTAT = 2025 AND "
        "LIBECATE = 'RC A.V.A'`, nom `primes_rc_ava_2025`) est SOUS-OPTIMALE : elle ne "
        "se réutilise pas et fait exploser le nombre de CTE.\n"
        "3. Donne un VERDICT par tour, en tout début de ligne : `VERDICT: BONNE` / "
        "`VERDICT: A_AMELIORER` / `VERDICT: MAUVAISE`, + justification courte.\n"
        "4. Pour toute CTE A_AMELIORER ou MAUVAISE, CONÇOIS une meilleure CTE GÉNÉRIQUE "
        "et PARAMÉTRÉE : remplace les littéraux de filtre par `$nom`, donne un nom "
        "générique sans valeur (ex. `primes_par_categorie`), pour répondre aussi aux "
        "requêtes SIMILAIRES. Utilise les colonnes EXACTES de `read_dto` ; ne fabrique "
        "jamais de données.\n"
    )
    if approval_mode == "auto":
        return common + (
            "5. APPLIQUE directement l'amélioration : `upsert_cte` (CTE paramétrée), puis "
            "`execute_cte(cte_name=…, parameters={…})` avec des valeurs d'exemple pour "
            "EXIGER row_count > 0. Si tu remplaces une CTE figée par une CTE générique, "
            "dis-le clairement.\n"
            "6. SKILL (optionnel mais recommandé si la mauvaise réponse vient du "
            "routage ou de la documentation) : identifie le skill concerné — son "
            "graphe de CTE est `cte-prof-<slug>` ; retrouve le dossier via "
            "`Grep`/`Glob` sur `prompts/skills/*/SKILL.md` (le `name` du skill se "
            "slugifie en `<slug>`). Puis `get_skill(directory_name=…)` et "
            "`update_skill(directory_name=…, …)` pour corriger le périmètre documenté, "
            "renforcer les alias et la règle de choix de CTE afin que ce type de "
            "question route vers la BONNE CTE. Préserve les sections, écris en français.\n"
            "Termine par une synthèse (bonnes / à améliorer / mauvaises + CTE "
            "créées/remplacées + skill ajusté). Réponds en français, markdown clair."
        )
    return common + (
        "5. NE MODIFIE RIEN toi-même (mode approbation manuelle). Pour CHAQUE amélioration, "
        "émets UN bloc de proposition à approuver, EXACTEMENT à ce format (JSON valide sur "
        "UNE ligne, un bloc par CTE) :\n"
        "```cte-proposal\n"
        '{"action":"replace","name":"<nom_generique>","replaces":"<ancien_nom_ou_vide>",'
        '"description":"<courte>","parameters":["p1","p2"],"depends_on":[],'
        '"sql":"SELECT ... WHERE col = $p1 AND col2 = $p2 ..."}\n'
        "```\n"
        "`action` ∈ replace|create. `sql` = CORPS du CTE (commence par SELECT), avec des "
        "paramètres `$nom` (jamais de valeurs en dur). Termine par une synthèse. "
        "L'opérateur approuvera chaque proposition. Réponds en français, markdown clair."
    )


def _judge_user_prompt(req: JudgeRequest, graph_id: str) -> str:
    if req.session_id.strip():
        target = (
            f"Analyse et améliore les CTE de la conversation `{req.session_id.strip()}`."
        )
    else:
        target = (
            "Appelle `list_conversations`, choisis la conversation la plus récente "
            "ayant des CTE, et analyse-la."
        )
    gline = f"Graphe CTE cible : {graph_id or '(défaut)'}\n"
    return (
        f"{target}\n{gline}"
        f"Instructions de l'opérateur : {req.instructions.strip() or '(aucune)'}"
    )


def _prepare_judge_run(req: JudgeRequest) -> tuple[str, list, Dict[str, Any]]:
    """Build (run_id, claude argv, started-event data) for a judge run.

    Shared by the SSE ``judge_stream`` endpoint and the non-streaming audit job
    so both spawn an identical Claude Code "analyse + fix CTEs" run.
    """
    mode = "auto" if str(req.approval_mode).strip().lower() == "auto" else "manual"
    graph_id = (req.graph_id or "").strip() or _resolve_graph_for_session(req.session_id)
    parquet_source, source_view = _graph_binding(graph_id)

    run_id = "cj-" + uuid.uuid4().hex[:12]
    run_dir = _RUNS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    cfg_path = run_dir / "brikz-mcp.json"
    mcp_env: Dict[str, str] = {}
    if graph_id:
        mcp_env["LEXIA_TARGET_GRAPH_ID"] = graph_id
    if parquet_source:
        mcp_env["LEXIA_PARQUET_SOURCE"] = parquet_source
    if source_view:
        mcp_env["LEXIA_SOURCE_VIEW"] = source_view
    server: Dict[str, Any] = {"command": "python", "args": [_MCP_SERVER]}
    if mcp_env:
        server["env"] = mcp_env
    cfg_path.write_text(json.dumps({"mcpServers": {"brikz": server}}))

    tools = list(_JUDGE_READ_TOOLS)
    sys_prompt = _judge_system_prompt(mode)
    if mode == "auto":
        # Auto mode may write: fix CTEs AND (optionally) the skill doc/routing,
        # plus the filesystem tools to correct config/prompt/conversation files.
        tools += ["mcp__brikz__upsert_cte", "mcp__brikz__get_skill", "mcp__brikz__update_skill"]
        tools += _FS_TOOLS
        sys_prompt += _FS_INSTRUCTION
    args = [
        _CLAUDE_BIN, "--print", "--output-format", "stream-json", "--verbose",
        "--permission-mode", "acceptEdits",
        "--mcp-config", str(cfg_path), "--strict-mcp-config",
        "--allowedTools", *tools, "Read", "Grep", "Glob",
        "--append-system-prompt", sys_prompt,
        _judge_user_prompt(req, graph_id),
    ]
    started = {
        "run_id": run_id, "mode": "judge", "session_id": req.session_id,
        "approval_mode": mode, "graph_id": graph_id,
    }
    return run_id, args, started


@router.post("/judge/stream", summary="Analyse + improve CTEs over a conversation (SSE)")
async def judge_stream(req: JudgeRequest):
    if not _auth_token():
        raise HTTPException(
            status_code=400,
            detail="Claude Code n'est pas authentifié : définissez CLAUDE_CODE_OAUTH_TOKEN "
            "(via `claude setup-token`) ou ANTHROPIC_API_KEY dans l'environnement de l'agent.",
        )
    run_id, args, started = _prepare_judge_run(req)
    return EventSourceResponse(
        _spawn_and_stream(run_id, args, started),
        headers={"X-Run-ID": run_id, "X-Accel-Buffering": "no"},
    )


class ApplyCteRequest(BaseModel):
    name: str
    sql: str
    description: str = ""
    parameters: List[str] = []
    depends_on: List[str] = []
    graph_id: str = ""


@router.post("/apply-cte", summary="Apply an approved CTE proposal (manual-approval upsert)")
async def apply_cte(req: ApplyCteRequest):
    if not req.name.strip() or not req.sql.strip():
        raise HTTPException(status_code=400, detail="name et sql sont requis.")
    from services.cte_graph.repository import CTERepositoryError, get_repository

    try:
        repo = get_repository(req.graph_id.strip() or None)
        saved = repo.upsert_cte(
            req.name.strip(),
            req.sql,
            req.description,
            depends_on=[str(d) for d in (req.depends_on or [])],
            parameters=[str(p).lstrip("$").strip() for p in (req.parameters or []) if str(p).strip()],
        )
        return {"success": True, "graph_id": repo.graph_id, **saved}
    except CTERepositoryError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))


# ── Generic assistant chat (one panel per admin section) ─────────────────────

# Read-oriented tools: a section assistant inspects sources/DTOs/CTEs/prompts and
# advises. Writes (update_skill / upsert_cte) stay reserved for the dedicated
# enhance/judge panels; execute_cte is read-only SQL so it is allowed.
_CHAT_TOOLS = [
    "mcp__brikz__list_dtos",
    "mcp__brikz__read_dto",
    "mcp__brikz__list_ctes",
    "mcp__brikz__get_cte",
    "mcp__brikz__execute_cte",
    "mcp__brikz__list_conversations",
    "mcp__brikz__read_conversation",
    "mcp__brikz__get_skill",
]

# Extra tools for the Data-page datasource analyser (scope == "data"): audit the
# yaml ⨯ DTO ⨯ parquet alignment and safely prune orphans.
_DATASOURCE_TOOLS = [
    "mcp__brikz__audit_datasources",
    "mcp__brikz__prune_datasource_file",
    "mcp__brikz__remove_datasource_entry",
]

# Cross-Tower building-management tools: typed CRUD over the brikz-backend REST
# API (Postgres ct_* tables). Lets the admin chat agent add users, tenants,
# badges, visitors, tickets, providers and Back-of-House elements directly.
_BUILDING_TOOLS = [
    "mcp__brikz__building_list",
    "mcp__brikz__building_create",
    "mcp__brikz__building_update",
    "mcp__brikz__building_delete",
    "mcp__brikz__building_dashboard",
]

# Dedicated, version-controlled methodology for the Data-page analyser, injected
# as the "data" scope's system prompt (baked into the image like the CTE playbook).
_DATASOURCE_PLAYBOOK_PATH = Path("/app/prompts/datasource_analyser_playbook.md")


def _load_datasource_playbook() -> str:
    try:
        return _DATASOURCE_PLAYBOOK_PATH.read_text(encoding="utf-8").strip()
    except Exception:
        return ""

_CHAT_SCOPES = {
    "data": (
        "Tu assistes un administrateur sur la section « Données » de Brikz : sources "
        "de données, fichiers Parquet, schémas de colonnes et qualité des données. "
        "Aide à comprendre/diagnostiquer une source : colonnes réelles via "
        "`read_dto`/`list_dtos`, aperçus via `execute_cte(sql=…)` (lecture seule, "
        "n'invente JAMAIS de chiffres), CTE existantes via `list_ctes`/`get_cte`. "
        "Propose des améliorations de schéma (descriptions, types, colonnes "
        "catégorielles) et signale les anomalies."
    ),
    "connectors": (
        "Tu assistes un administrateur sur la section « Connecteurs » de Brikz "
        "(Oracle, Supabase, SQL Server, MinIO, CSV…). Aide à configurer un connecteur, "
        "expliquer chaque champ (host/port/service/bucket…), diagnostiquer pourquoi "
        "une source n'est pas enregistrée ou ne se rafraîchit pas. Utilise Read/Grep "
        "pour inspecter `config/datasources.yaml` et les fichiers de connecteurs si "
        "besoin. Ne révèle JAMAIS de secrets/mots de passe en clair."
    ),
    "prompts": (
        "Tu assistes un administrateur sur la section « Prompts » de Brikz : les "
        "templates de prompts du moteur (sous `prompts/` et `llm/prompts/`). Aide à "
        "rédiger, clarifier et améliorer un template : structure, variables de "
        "substitution, exemples, concision, robustesse. Utilise Read/Grep pour lire "
        "les templates existants et `get_skill` pour le contexte métier."
    ),
    "cte": (
        "Tu assistes un administrateur sur la section « CTE Graph » de Brikz : la "
        "bibliothèque de CTE (Common Table Expressions) réutilisables. Aide à "
        "explorer/expliquer une CTE (`list_ctes`/`get_cte`), la tester en lecture "
        "via `execute_cte` et proposer des CTE dérivées. N'invente jamais de données."
    ),
    "building": (
        "Tu assistes le gestionnaire de l'immeuble Cross-Tower. Tu gères les données "
        "opérationnelles via les outils `building_*` (persistées en Postgres, "
        "visibles immédiatement dans l'application) : utilisateurs (comptes de "
        "connexion), locataires (tenants), badges, visiteurs, tickets, prestataires, "
        "parking et éléments Back-of-House (CVC, ascenseurs, quais, locaux "
        "techniques…).\n"
        "Règles : `building_list` D'ABORD pour résoudre les ids (tenantId, "
        "providerId…) — n'invente JAMAIS un id. Pour créer : `building_create` "
        "(ex. visitors → {name, tenantId, company, expectedAt} ; users → {email, "
        "password, name} ; boh → {name, category, location}). Pour modifier : "
        "`building_update` (ex. badge {status: 'active'}, visiteur "
        "{status: 'checked_in'}). Confirme chaque écriture avec l'enregistrement "
        "retourné. Réponds en français."
    ),
    "general": (
        "Tu assistes un administrateur Brikz. Tu peux inspecter les sources/DTO, les "
        "CTE, les conversations et les fichiers du projet en lecture seule pour "
        "répondre. Tu peux aussi gérer les données de l'immeuble Cross-Tower "
        "(locataires, badges, visiteurs, utilisateurs, tickets, prestataires, "
        "Back-of-House) via les outils `building_*` — `building_list` d'abord pour "
        "résoudre les ids, puis `building_create`/`building_update`. N'invente "
        "jamais de données ; toute valeur vient d'un outil."
    ),
}


class ChatRequest(BaseModel):
    message: str
    scope: str = "general"
    context: str = ""
    # CTE graph the user is currently viewing. When set, the MCP server is bound
    # to THIS graph (+ its source) so list_ctes/get_cte/execute_cte operate inside
    # it, instead of falling back to the default (insurance) library.
    graph_id: str = ""


def _chat_system_prompt(scope: str, graph_id: str = "") -> str:
    # The "data" scope IS the datasource analyser: use its dedicated playbook and
    # allow the controlled prune/remove tools (so don't append the read-only rule).
    if scope == "data":
        playbook = _load_datasource_playbook() or _CHAT_SCOPES["data"]
        return playbook + (
            "\n\nRègles : agis via les outils `mcp__brikz__*` (dont "
            "`audit_datasources`, `prune_datasource_file`, `remove_datasource_entry`) "
            "et Read/Grep/Glob. Tu ne supprimes des fichiers QUE via "
            "`prune_datasource_file` (jamais via le shell), et UNIQUEMENT ceux "
            "confirmés orphelins par `audit_datasources`. En cas de doute, signale "
            "plutôt que supprimer. Réponds en français, markdown clair."
        )
    intro = _CHAT_SCOPES.get(scope, _CHAT_SCOPES["general"])
    scoped = ""
    if graph_id:
        scoped = (
            f"\n\nPÉRIMÈTRE STRICT — graphe « {graph_id} » :\n"
            "Tu es ENFERMÉ dans CE graphe de CTE et sa source de données. "
            "`list_ctes`/`get_cte`/`execute_cte` ciblent déjà UNIQUEMENT ce graphe. "
            "Règles impératives :\n"
            "- Réponds EXCLUSIVEMENT avec les CTE renvoyées par `list_ctes` de ce "
            "graphe ; choisis la plus pertinente et exécute-la (`execute_cte`).\n"
            "- N'utilise JAMAIS une CTE, une vue/source parquet ou un graphe qui "
            "n'appartient pas à ce périmètre. N'écris pas de SQL ad hoc vers un autre "
            "fichier parquet.\n"
            "- Si AUCUNE CTE de `list_ctes` ne répond à la question, dis-le clairement "
            "et suggère d'en créer une via le panneau « affiner le skill » — ne va "
            "PAS chercher ailleurs (autre source, autre bibliothèque)."
        )
    return (
        intro + scoped + "\n\n"
        "Règles : agis via les outils `mcp__brikz__*` et Read/Grep/Glob. Privilégie "
        "la LECTURE ; ne modifie/supprime un fichier que si l'administrateur le "
        "demande explicitement, via les outils dédiés (skills/CTE) ou les outils "
        "système de fichiers (toujours sous `/app`), après avoir vérifié la cible. "
        "Réponds en français, en markdown clair et concis. Si une donnée est "
        "nécessaire, récupère-la avec un outil plutôt que de la deviner."
    )


def _chat_user_prompt(req: ChatRequest) -> str:
    parts = []
    if req.context.strip():
        parts.append(f"Contexte de la section :\n{req.context.strip()}")
    parts.append(f"Message de l'administrateur :\n{req.message.strip()}")
    return "\n\n".join(parts)


@router.post("/chat/stream", summary="Section assistant chat with Claude Code (SSE)")
async def chat_stream(req: ChatRequest):
    if not req.message.strip():
        raise HTTPException(status_code=400, detail="Message vide.")
    if not _auth_token():
        raise HTTPException(
            status_code=400,
            detail="Claude Code n'est pas authentifié : définissez CLAUDE_CODE_OAUTH_TOKEN "
            "(via `claude setup-token`) ou ANTHROPIC_API_KEY dans l'environnement de l'agent.",
        )
    run_id = "ch-" + uuid.uuid4().hex[:12]
    run_dir = _RUNS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    cfg_path = run_dir / "brikz-mcp.json"
    # Bind the MCP server to the graph the user is viewing so the agent stays
    # enclosed in it (otherwise it falls back to the default insurance library).
    graph_id = (req.graph_id or "").strip()
    server: Dict[str, Any] = {"command": "python", "args": [_MCP_SERVER]}
    if graph_id:
        parquet_source, source_view = _graph_binding(graph_id)
        env = {"LEXIA_TARGET_GRAPH_ID": graph_id}
        if parquet_source:
            env["LEXIA_PARQUET_SOURCE"] = parquet_source
        if source_view:
            env["LEXIA_SOURCE_VIEW"] = source_view
        server["env"] = env
    cfg_path.write_text(json.dumps({"mcpServers": {"brikz": server}}))
    chat_tools = list(_CHAT_TOOLS) + _FS_TOOLS + _BUILDING_TOOLS
    if req.scope == "data":
        chat_tools += _DATASOURCE_TOOLS
    args = [
        _CLAUDE_BIN, "--print", "--output-format", "stream-json", "--verbose",
        "--permission-mode", "acceptEdits",
        "--mcp-config", str(cfg_path), "--strict-mcp-config",
        "--allowedTools", *chat_tools, "Read", "Grep", "Glob", "AskUserQuestion",
        "--append-system-prompt",
        _chat_system_prompt(req.scope, graph_id) + _FS_INSTRUCTION + _HITL_INSTRUCTION,
        _chat_user_prompt(req),
    ]
    started = {"run_id": run_id, "mode": "chat", "scope": req.scope, "graph_id": graph_id}
    return EventSourceResponse(
        _spawn_and_stream(run_id, args, started),
        headers={"X-Run-ID": run_id, "X-Accel-Buffering": "no"},
    )


# ── Automated audit (cron): grade recent conversations, auto-fix the bad ones ──
#
# Driven by the brikz-backend BullMQ cron worker (POST /admin/claude/audit). It
# scores each recent response with a CHEAP LLM pass (no Claude Code), flags the
# unsatisfactory ones, and — when auto_fix is on — fires the Claude Code judge in
# AUTO mode per flagged conversation to correct the CTE (and, where it helps, the
# SKILL.md routing). Engine prompt TEMPLATES are NOT auto-edited (they affect every
# user and are code-baked) — prompt-level issues are surfaced in the report only.

_SEVERITY_ORDER = {"none": 0, "low": 1, "medium": 2, "high": 3}

_AUDIT_SYSTEM = (
    "Tu es un auditeur QUALITÉ pour Brikz, un agent d'analyse de données "
    "financières. On te donne une QUESTION d'un utilisateur et la RÉPONSE produite "
    "par l'agent. Évalue si la réponse est SATISFAISANTE : elle répond précisément à "
    "la question, dans le BON PÉRIMÈTRE (bonne année/exercice, pas de ventilation non "
    "demandée, bon axe de regroupement et bonne mesure), sans erreur ni message "
    "d'échec, avec un résultat non vide et cohérent.\n"
    "Considère INSATISFAISANT notamment : hors-sujet ; erreur/exception ; « max "
    "iterations » ; résultat vide ; mauvais périmètre (p. ex. somme de toutes les "
    "années alors qu'une année précise est demandée, ou ventilation par produit/"
    "branche non demandée) ; chiffre manifestement incohérent ; réponse qui esquive "
    "la question.\n"
    "Réponds STRICTEMENT par un objet JSON sur UNE seule ligne, sans aucun texte "
    'autour : {"satisfied": true|false, "severity": "none|low|medium|high", '
    '"reason": "<courte explication en français>"}. '
    "severity = none si satisfaisant ; sinon low / medium / high selon la gravité."
)


def _evaluate_response_satisfaction(query: str, response: str) -> Dict[str, Any]:
    """Cheap LLM grade of one (question, answer) pair. Fails OPEN (satisfied)."""
    q = (query or "").strip()
    r = (response or "").strip()
    if not q or not r:
        return {"satisfied": True, "severity": "none", "reason": "question/réponse vide"}
    prompt = f"QUESTION :\n{q}\n\nRÉPONSE DE L'AGENT :\n{r[:4000]}"
    try:
        from llm.llm_factory import create_client_for_task

        client = create_client_for_task("agent")
        resp = client.generate(prompt, system=_AUDIT_SYSTEM, max_tokens=300, temperature=0.0)
        text = (getattr(resp, "content", "") or "").strip()
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("audit satisfaction eval failed: %s", exc)
        return {"satisfied": True, "severity": "none", "reason": f"éval indisponible: {exc}"}
    import re as _re

    m = _re.search(r"\{.*\}", text, _re.DOTALL)
    if not m:
        return {"satisfied": True, "severity": "none", "reason": "éval non parsable"}
    try:
        obj = json.loads(m.group(0))
    except Exception:
        return {"satisfied": True, "severity": "none", "reason": "JSON d'éval invalide"}
    sat = bool(obj.get("satisfied", True))
    sev = str(obj.get("severity") or ("none" if sat else "medium")).strip().lower()
    if sev not in _SEVERITY_ORDER:
        sev = "none" if sat else "medium"
    return {"satisfied": sat, "severity": sev, "reason": str(obj.get("reason") or "")[:500]}


class AuditRequest(BaseModel):
    limit: int = 50            # how many recent conversations to scan
    since_seconds: int = 0     # 0 = no window; else only convos updated within it
    max_eval: int = 30         # cap on LLM satisfaction evaluations per run
    min_severity: str = "medium"  # flag threshold: low|medium|high
    auto_fix: bool = False     # fire the Claude Code judge to fix flagged convos
    max_fixes: int = 3         # cap on auto-fix runs per audit
    fix_timeout: int = 900     # per-fix Claude Code timeout (seconds)


@router.post("/audit", summary="Grade recent conversations; optionally auto-fix the bad ones")
async def audit_conversations(req: AuditRequest):
    import time

    from services import conversation_review

    if req.auto_fix and not _auth_token():
        raise HTTPException(
            status_code=400,
            detail="auto_fix requiert un token Claude (CLAUDE_CODE_OAUTH_TOKEN / "
            "ANTHROPIC_API_KEY) pour lancer les corrections.",
        )

    convos = conversation_review.list_conversations(limit=max(1, req.limit))
    now = time.time()
    candidates: List[Dict[str, Any]] = []
    for c in convos:
        updated = float(c.get("updated_at") or 0)
        if req.since_seconds and updated and (now - updated) > req.since_seconds:
            continue
        candidates.append(c)
        if len(candidates) >= max(1, req.max_eval):
            break

    eval_sem = asyncio.Semaphore(4)

    async def _eval_one(c: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        sid = str(c.get("session_id") or "")
        if not sid:
            return None
        data = await asyncio.to_thread(
            conversation_review.load_conversation_turns, sid, sample_rows=0
        )
        turns = (data or {}).get("turns", [])
        if not turns:
            return None
        last = turns[-1]
        q = last.get("query") or c.get("last_query") or ""
        r = last.get("response") or ""
        async with eval_sem:
            v = await asyncio.to_thread(_evaluate_response_satisfaction, q, r)
        return {
            "session_id": sid,
            "query": q,
            "cte_names": last.get("cte_names") or [],
            "satisfied": v["satisfied"],
            "severity": v["severity"],
            "reason": v["reason"],
        }

    audited = [x for x in await asyncio.gather(*[_eval_one(c) for c in candidates]) if x]
    threshold = _SEVERITY_ORDER.get(str(req.min_severity).lower(), 2)
    flagged = [
        a for a in audited
        if not a["satisfied"] and _SEVERITY_ORDER.get(a["severity"], 0) >= threshold
    ]
    flagged.sort(key=lambda a: _SEVERITY_ORDER.get(a["severity"], 0), reverse=True)

    fixed: List[Dict[str, Any]] = []
    if req.auto_fix and flagged:
        for a in flagged[: max(0, req.max_fixes)]:
            instructions = (
                f"Problème détecté à l'audit qualité (gravité {a['severity']}) : "
                f"{a['reason']}. Corrige la/les CTE et le périmètre pour que la question "
                f"« {a['query']} » obtienne une réponse correcte."
            )
            jr = JudgeRequest(
                session_id=a["session_id"], approval_mode="auto", instructions=instructions
            )
            try:
                run_id, args, _started = _prepare_judge_run(jr)
                res = await _spawn_collect(run_id, args, timeout=float(req.fix_timeout))
                fixed.append({
                    "session_id": a["session_id"],
                    "severity": a["severity"],
                    "is_error": bool(res.get("is_error")),
                    "tool_calls": res.get("tool_calls", 0),
                    "summary": (res.get("result") or "")[:1500],
                    "error": res.get("error"),
                })
            except Exception as exc:  # noqa: BLE001
                logger.exception("audit auto-fix failed for %s", a["session_id"])
                fixed.append({"session_id": a["session_id"], "is_error": True, "error": str(exc)})

    logger.info(
        "audit: scanned=%d flagged=%d auto_fix=%s fixed=%d",
        len(audited), len(flagged), req.auto_fix, len(fixed),
    )
    return {
        "audited": len(audited),
        "flagged_count": len(flagged),
        "flagged": flagged,
        "auto_fix": req.auto_fix,
        "min_severity": req.min_severity,
        "fixed": fixed,
    }
