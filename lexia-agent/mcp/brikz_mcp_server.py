"""Stdio MCP server exposing Brikz skill + CTE tools to Claude Code.

Launched per enhance-run by the ``claude`` CLI (``--mcp-config``). Tools are
backed by the agent's in-process functions so Claude Code can read a data
source's DTO, list/read/create/execute CTEs, and update a SKILL.md — without
shell access.

The run is scoped via env vars set by the spawning endpoint:
    LEXIA_SKILL_DIR        — skill directory_name being enhanced
    LEXIA_TARGET_GRAPH_ID  — the CTE graph (cte-prof-<skill>) to read/write
    LEXIA_PARQUET_SOURCE   — parquet the new CTEs validate/execute against
    LEXIA_SOURCE_VIEW      — DuckDB view name for that parquet

Run:  python /app/mcp/brikz_mcp_server.py   (cwd /app, stdio transport)
"""
from __future__ import annotations

import os
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

# Importable when launched as a bare script from the claude subprocess.
sys.path.insert(0, "/app")

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("brikz")

_GRAPH_ID = os.environ.get("LEXIA_TARGET_GRAPH_ID", "").strip()
_PARQUET_SOURCE = os.environ.get("LEXIA_PARQUET_SOURCE", "").strip()
_SOURCE_VIEW = os.environ.get("LEXIA_SOURCE_VIEW", "").strip()


# Lexia building-management backend (NestJS REST). Internal compose DNS by
# default; the API persists to Postgres (container lexia-legal-postgres).
_BACKEND_URL = (
    os.environ.get("LEXIA_BACKEND_URL") or "http://lexia-backend:3000"
).rstrip("/")


def _bind() -> None:
    """Bind the active CTE graph + data source for this run (idempotent)."""
    from services.cte_graph.repository import set_active_cte_graph, set_active_cte_source

    if _GRAPH_ID:
        set_active_cte_graph(_GRAPH_ID)
    if _PARQUET_SOURCE or _SOURCE_VIEW:
        set_active_cte_source(_PARQUET_SOURCE, _SOURCE_VIEW)


# ── DTO (data source schema) ─────────────────────────────────────────────────


@mcp.tool()
def list_dtos() -> List[str]:
    """List available DTO stems (data-source column schemas), e.g. ``ca_view_dto``."""
    from api.routes.skills import _dtos_dir

    d = _dtos_dir()
    return sorted(p.stem for p in d.glob("*_dto.py")) if d.exists() else []


@mcp.tool()
def read_dto(dto: str) -> str:
    """Return the column schema of a DTO: names, types, descriptions, categorical flags.

    Use the EXACT column names returned here when writing CTE SQL.
    """
    from api.routes.skills import _load_dto_grounding

    return _load_dto_grounding([dto]) or f"(no columns found for DTO '{dto}')"


# ── Skill ────────────────────────────────────────────────────────────────────


@mcp.tool()
def get_skill(directory_name: str) -> Dict[str, Any]:
    """Return a skill's frontmatter (name, description, aliases, dto, …) + markdown body."""
    from api.routes.skills import _read_skill_file

    data = _read_skill_file(directory_name)
    return {"frontmatter": data["frontmatter"], "body": data["body"]}


@mcp.tool()
def update_skill(
    directory_name: str,
    name: str = "",
    description: str = "",
    aliases: Optional[List[str]] = None,
    content_body: str = "",
    dto: str = "",
) -> Dict[str, Any]:
    """Update a skill's frontmatter/body. Empty string / None = leave that field unchanged."""
    from api.routes.skills import _read_skill_file, _render_skill_file
    from prompt_loader import write_prompt_file
    from skill_registry import load_skill_definitions

    data = _read_skill_file(directory_name)
    fm = data["frontmatter"]
    if name:
        fm["name"] = name
    if description:
        fm["description"] = description
    if aliases is not None:
        fm["aliases"] = aliases
    if dto:
        fm["dto"] = dto
    body = content_body if content_body else data["body"]
    write_prompt_file(data["path"], _render_skill_file(fm, body))
    load_skill_definitions.cache_clear()
    return {"success": True, "directory_name": directory_name}


# ── CTE library (scoped to the active graph) ─────────────────────────────────


@mcp.tool()
def list_ctes() -> List[Dict[str, Any]]:
    """List CTEs in the skill's graph: name, description, depends_on, projects."""
    _bind()
    from services.cte_graph.repository import get_repository

    return get_repository().list_ctes()


@mcp.tool()
def get_cte(name: str) -> Dict[str, Any]:
    """Return one CTE's SQL + metadata."""
    _bind()
    from services.cte_graph.repository import get_repository

    return get_repository().get_cte(name) or {"error": f"CTE not found: {name}"}


@mcp.tool()
def upsert_cte(
    name: str,
    sql: str,
    description: str = "",
    depends_on: Optional[List[str]] = None,
    projects: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Create/replace a CTE in the skill's graph.

    The CTE is validated (dry-run LIMIT 0) against the real parquet before it is
    persisted; on a column/SQL error the failure is returned so you can fix it.
    Create base CTEs before composites (``depends_on`` must already exist).
    """
    _bind()
    from services.cte_graph.repository import get_repository

    try:
        get_repository().upsert_cte(
            name, sql, description, depends_on=depends_on, projects=projects, validate=True
        )
        return {"success": True, "name": name}
    except Exception as exc:  # noqa: BLE001 — surface validation errors to the agent
        return {"success": False, "error": str(exc)}


# ── Conversations (for CTE-pertinence judging) ───────────────────────────────


@mcp.tool()
def list_conversations(limit: int = 50) -> List[Dict[str, Any]]:
    """List recent user conversations: session_id, turns, cte_turns, last_query."""
    from services.conversation_review import list_conversations as _lc

    return _lc(limit=limit)


@mcp.tool()
def read_conversation(session_id: str) -> Dict[str, Any]:
    """Read a conversation's turns: each user query + the CTE(s) and results that answered it.

    Use this to JUDGE whether the CTE extraction was pertinent for the question.
    """
    from services.conversation_review import load_conversation_turns

    data = load_conversation_turns(session_id)
    return data or {"error": f"Conversation not found: {session_id}"}


@mcp.tool()
def execute_cte(
    cte_name: str = "",
    sql: str = "",
    parameters: Optional[Dict[str, Any]] = None,
    max_rows: int = 50,
) -> Dict[str, Any]:
    """Execute a CTE (by ``cte_name``) or ad-hoc CTE-shaped SQL against the active source.

    Bind the CTE's ``$param`` filters via ``parameters`` — e.g.
    ``execute_cte(cte_name="primes_par_categorie", parameters={"exerstat": 2026,
    "libecate": "RC A.V.A"})``. This is how you TEST a parameterized CTE with real
    values WITHOUT hardcoding literals into the SQL.

    Returns columns + rows (truncated to ``max_rows``), plus ``missing_parameters``
    (declared ``$params`` left unbound → they evaluate to NULL). Use this to VALIDATE
    that a CTE returns non-empty, correct data before documenting/saving it.
    """
    _bind()
    from tools.accounting_tools import execute_accounting_cte_structured

    try:
        res = execute_accounting_cte_structured(
            cte_name=cte_name, sql=sql, parameters=parameters or {}, max_rows=max_rows
        )
        return {
            "columns": res.get("columns"),
            "row_count": res.get("row_count"),
            "rows": (res.get("rows") or [])[:max_rows],
            "parameters": res.get("parameters"),
            "missing_parameters": res.get("missing_parameters"),
            "sql": res.get("sql"),
            "error": res.get("error"),
        }
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)}


# ── Datasource alignment (admin Data-page analyser) ──────────────────────────


@mcp.tool()
def audit_datasources() -> Dict[str, Any]:
    """Cross-reference config/datasources.yaml ⨯ DTO classes ⨯ parquet files.

    READ-ONLY. Returns the declared datasources, the DTO schemas on disk, every
    parquet file (with what references it), and the mismatches: ``orphan_parquet``
    (a parquet referenced by NOTHING — candidate for deletion), ``orphan_dto`` (a
    schema with no parquet and no source), and ``missing_parquet`` (a file source
    with no cache yet). Call this FIRST to know the alignment state.
    """
    from services.datasource_audit import audit_datasources as _audit

    return _audit()


@mcp.tool()
def prune_datasource_file(path: str) -> Dict[str, Any]:
    """Delete ONE orphan file. Allowed ONLY under data/parquet/ or data/classes/dtos/.

    Any other path is REFUSED (it can never delete app code or config). Use only
    after ``audit_datasources`` flags the file as an orphan (``referenced_by`` empty).
    """
    from services.datasource_audit import prune_file

    return prune_file(path)


@mcp.tool()
def remove_datasource_entry(source_id: str) -> Dict[str, Any]:
    """Remove a ``data_sources`` entry (by ``source_id``) from config/datasources.yaml.

    Use to realign the YAML when a declared source no longer has any DTO/parquet
    and should be dropped.
    """
    from services.datasource_audit import remove_source_entry

    return remove_source_entry(source_id)


# ── Building management (Cross-Tower backend → Postgres) ─────────────────────
#
# Typed CRUD over the brikz-backend REST API so the admin chat agent can manage
# the building's operational data: users, tenants, badges, visitors, parking,
# tickets, providers and Back-of-House elements. All writes are persisted to
# Postgres (ct_* tables) and immediately visible in brikz-frontend.

_BUILDING_RESOURCES = {
    "tenants": "/api/tenants",
    "badges": "/api/badges",
    "visitors": "/api/visitors",
    "users": "/api/users",
    "boh": "/api/boh",
    "tickets": "/api/tickets",
    "providers": "/api/providers",
    "parking_spots": "/api/parking/spots",
    "parking_reservations": "/api/parking/reservations",
    "calendar_events": "/api/calendar/events",
}


def _backend_request(
    method: str, path: str, payload: Optional[Dict[str, Any]] = None
) -> Any:
    """JSON request to the brikz-backend REST API (no auth: in-process routes)."""
    import json as _json
    import urllib.error
    import urllib.request

    url = _BACKEND_URL + path
    data = _json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url, data=data, method=method, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode() or ""
            return _json.loads(body) if body else {"success": True}
    except urllib.error.HTTPError as exc:
        try:
            detail = _json.loads(exc.read().decode())
        except Exception:
            detail = {"error": str(exc)}
        return {"error": detail.get("error", str(exc)), "http_status": exc.code}
    except Exception as exc:  # noqa: BLE001 — surface network errors to the agent
        return {"error": f"backend unreachable at {url}: {exc}"}


@mcp.tool()
def building_list(resource: str, filters: Optional[Dict[str, str]] = None) -> Any:
    """List building records from the Cross-Tower backend (Postgres-backed).

    ``resource`` ∈ tenants | badges | visitors | users | boh | tickets |
    providers | parking_spots | parking_reservations | calendar_events.
    Optional ``filters`` become query-string params (e.g. badges:
    {"status": "pending"}; tickets: {"priority": "critical"}).
    """
    path = _BUILDING_RESOURCES.get(resource)
    if not path:
        return {"error": f"Unknown resource '{resource}'. Use one of: {', '.join(_BUILDING_RESOURCES)}"}
    if filters:
        from urllib.parse import urlencode

        path += "?" + urlencode(filters)
    return _backend_request("GET", path)


@mcp.tool()
def building_create(resource: str, payload: Dict[str, Any]) -> Any:
    """Create a building record (persisted to Postgres, visible in brikz-frontend).

    Required fields per resource:
      - tenants: name (+ floor, officeNumber, legalName, activity, contactName,
        contactEmail, contactPhone, billingEmail, registrationNumber, ice,
        taxId, leaseStart, leaseEnd, areaSqm, employees, status, notes)
      - badges: tenantId, holder, type (permanent|visitor|personal) (+ validUntil)
      - visitors: name (+ tenantId, company, email, phone, expectedAt, badgeId)
      - users: email, password (+ name) — creates a better-auth login account
      - boh: name, category (hvac|elevator|electrical|plumbing|security|
        loading_dock|storage|cleaning|other) (+ location, status, providerId,
        lastServiceAt, nextServiceAt, notes)
      - tickets: title, category (+ tenantId, location, priority)
      - providers: name, service (+ sla, status, legalName, contractRef,
        contactName, contactEmail, contactPhone, emergencyPhone, address, ice,
        insuranceExpiry, contractStart, contractEnd, certifications, notes)
      - parking_reservations: spotNumber, tenantId, visitorName, startTime, endTime
      - calendar_events: title, start, end (+ description, type, location)

    Use ``building_list`` first to resolve ids (e.g. tenantId) — never invent them.
    """
    path = _BUILDING_RESOURCES.get(resource)
    if not path:
        return {"error": f"Unknown resource '{resource}'. Use one of: {', '.join(_BUILDING_RESOURCES)}"}
    if resource == "parking_spots":
        return {"error": "parking_spots is read-only"}
    return _backend_request("POST", path, payload)


@mcp.tool()
def building_update(resource: str, record_id: str, payload: Dict[str, Any]) -> Any:
    """Update a building record by id (PATCH semantics: only sent fields change).

    Examples: badge status → {"status": "active"}; visitor check-in →
    {"status": "checked_in"}; ticket assignment → {"assignee": "ClimaTech",
    "status": "in_progress"}; BOH service date → {"lastServiceAt": "..."}.
    """
    path = _BUILDING_RESOURCES.get(resource)
    if not path:
        return {"error": f"Unknown resource '{resource}'. Use one of: {', '.join(_BUILDING_RESOURCES)}"}
    if resource in ("users", "parking_spots", "parking_reservations"):
        return {"error": f"{resource} updates are not supported via this tool"}
    return _backend_request("PATCH", f"{path}/{record_id}", payload)


@mcp.tool()
def building_delete(resource: str, record_id: str) -> Any:
    """Delete a building record by id. Only boh and calendar_events support delete."""
    path = _BUILDING_RESOURCES.get(resource)
    if not path:
        return {"error": f"Unknown resource '{resource}'. Use one of: {', '.join(_BUILDING_RESOURCES)}"}
    if resource not in ("boh", "calendar_events"):
        return {"error": f"{resource} does not support delete"}
    return _backend_request("DELETE", f"{path}/{record_id}")


@mcp.tool()
def building_dashboard() -> Any:
    """Cross-Tower dashboard snapshot: KPIs, priority tickets, provider SLAs."""
    return _backend_request("GET", "/api/dashboard")


# ── Filesystem tools (so Claude Code can run real shell-equivalent commands to ──
#    inspect & fix data configs, skills, prompts and conversations under /app).
#
# Safety model:
#   • Read/inspect tools run the real binary with the agent's args (split with
#     shlex — NO shell, so no pipes/redirects/chaining; stdin is /dev/null so
#     nothing blocks waiting for input).
#   • Write/destructive tools (mkdir/touch/cp/mv/rm/rmdir/ln/chmod/chown) take
#     typed params and REFUSE any target outside the writable roots (default
#     /app and /tmp), so the agent can fix project files but not the system.
#   • Disk-administration tools (fdisk/mkfs/mount/umount/fsck) exist by name but
#     are DISABLED unless an operator sets LEXIA_FS_ALLOW_DISK_ADMIN=1 — they
#     can destroy a filesystem and have no role in editing config/skill files.

_CWD = "/app"
_FS_WRITE_ROOTS = [
    Path(p) for p in os.environ.get("LEXIA_FS_ROOTS", "/app:/tmp").split(":") if p.strip()
]
_FS_ALLOW_DISK_ADMIN = os.environ.get("LEXIA_FS_ALLOW_DISK_ADMIN", "").lower() in ("1", "true", "yes")
_FS_TIMEOUT = int(os.environ.get("LEXIA_FS_TIMEOUT", "60"))
_FS_MAX_OUTPUT = 60_000


def _fs_resolve(path: str) -> Path:
    p = Path(path or ".")
    return p if p.is_absolute() else Path(_CWD) / p


def _fs_writable_error(path: str) -> Optional[str]:
    """Return an error string if *path* is outside the writable roots, else None."""
    rp = _fs_resolve(path).resolve()
    for root in _FS_WRITE_ROOTS:
        rr = root.resolve()
        if rp == rr or str(rp).startswith(str(rr) + os.sep):
            return None
    roots = ", ".join(str(r) for r in _FS_WRITE_ROOTS)
    return f"refused: '{rp}' is outside the writable roots ({roots})"


def _fs_run(argv: List[str]) -> Dict[str, Any]:
    """Run a command (no shell) in _CWD, capture output, never block on stdin."""
    try:
        proc = subprocess.run(
            argv, cwd=_CWD, capture_output=True, text=True,
            timeout=_FS_TIMEOUT, stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        return {"command": " ".join(argv), "error": f"timeout after {_FS_TIMEOUT}s"}
    except FileNotFoundError:
        return {"command": " ".join(argv), "error": f"command not found: {argv[0]}"}
    except Exception as exc:  # noqa: BLE001
        return {"command": " ".join(argv), "error": str(exc)}
    out = proc.stdout or ""
    truncated = len(out) > _FS_MAX_OUTPUT
    return {
        "command": " ".join(shlex.quote(a) for a in argv),
        "cwd": _CWD,
        "returncode": proc.returncode,
        "stdout": out[:_FS_MAX_OUTPUT],
        "stderr": (proc.stderr or "")[:8000],
        "truncated": truncated,
    }


def _fs_args(args: str) -> List[str]:
    try:
        return shlex.split(args or "")
    except ValueError:
        return (args or "").split()


def _disk_admin(cmd: str, args: str) -> Dict[str, Any]:
    if not _FS_ALLOW_DISK_ADMIN:
        return {
            "success": False, "disabled": True,
            "error": f"{cmd} is disabled in-container for safety. An operator must set "
            "LEXIA_FS_ALLOW_DISK_ADMIN=1 to enable it.",
        }
    return _fs_run([cmd, *_fs_args(args)])


# Navigation & location ───────────────────────────────────────────────────────
@mcp.tool()
def pwd() -> Dict[str, Any]:
    """Print the current working directory used by the other filesystem tools."""
    return {"cwd": _CWD}


@mcp.tool()
def cd(path: str) -> Dict[str, Any]:
    """Change the working directory for subsequent filesystem tools."""
    global _CWD
    p = _fs_resolve(path).resolve()
    if not p.exists() or not p.is_dir():
        return {"success": False, "error": f"not a directory: {p}"}
    _CWD = str(p)
    return {"success": True, "cwd": _CWD}


@mcp.tool()
def ls(args: str = "-la") -> Dict[str, Any]:
    """List directory contents (ls). `args` = flags/paths, e.g. '-la data/parquet'."""
    return _fs_run(["ls", *_fs_args(args)])


@mcp.tool()
def tree(args: str = "-L 2") -> Dict[str, Any]:
    """Show a directory as a visual tree (tree). `args` e.g. '-L 2 prompts/skills'."""
    return _fs_run(["tree", *_fs_args(args)])


# Viewing & searching ──────────────────────────────────────────────────────────
@mcp.tool()
def cat(args: str) -> Dict[str, Any]:
    """Display full file content (cat). `args` = file path(s)/flags."""
    return _fs_run(["cat", *_fs_args(args)])


@mcp.tool()
def less(args: str) -> Dict[str, Any]:
    """View a file (less, non-interactive). `args` = file path. Output is truncated."""
    return _fs_run(["less", "-FX", *_fs_args(args)])


@mcp.tool()
def head(args: str) -> Dict[str, Any]:
    """Show the first lines of a file (head). e.g. '-n 50 config/datasources.yaml'."""
    return _fs_run(["head", *_fs_args(args)])


@mcp.tool()
def tail(args: str) -> Dict[str, Any]:
    """Show the last lines of a file (tail). Do NOT use -f (it would block)."""
    return _fs_run(["tail", *_fs_args(args)])


@mcp.tool()
def grep(args: str) -> Dict[str, Any]:
    """Search text patterns in files (grep). e.g. '-rn EXERSTAT prompts/skills'."""
    return _fs_run(["grep", *_fs_args(args)])


@mcp.tool()
def find(args: str = ".") -> Dict[str, Any]:
    """Search the filesystem (find). e.g. '. -name *_dto.py'. Avoid -delete/-exec rm."""
    return _fs_run(["find", *_fs_args(args)])


# Storage & space ──────────────────────────────────────────────────────────────
@mcp.tool()
def df(args: str = "-h") -> Dict[str, Any]:
    """Show free/used disk space on mounted filesystems (df)."""
    return _fs_run(["df", *_fs_args(args)])


@mcp.tool()
def du(args: str = "-sh") -> Dict[str, Any]:
    """Estimate file/directory space usage (du). e.g. '-sh data/parquet'."""
    return _fs_run(["du", *_fs_args(args)])


@mcp.tool()
def lsblk(args: str = "") -> Dict[str, Any]:
    """List block storage devices (lsblk)."""
    return _fs_run(["lsblk", *_fs_args(args)])


@mcp.tool()
def blkid(args: str = "") -> Dict[str, Any]:
    """Show block-device attributes/UUIDs (blkid)."""
    return _fs_run(["blkid", *_fs_args(args)])


# File & directory management (writes confined to the writable roots) ──────────
@mcp.tool()
def mkdir(path: str, parents: bool = True) -> Dict[str, Any]:
    """Create a directory (mkdir). Confined to the writable roots."""
    err = _fs_writable_error(path)
    if err:
        return {"success": False, "error": err}
    return _fs_run(["mkdir", *(["-p"] if parents else []), str(_fs_resolve(path))])


@mcp.tool()
def touch(path: str) -> Dict[str, Any]:
    """Create an empty file / update its timestamp (touch). Confined to writable roots."""
    err = _fs_writable_error(path)
    if err:
        return {"success": False, "error": err}
    return _fs_run(["touch", str(_fs_resolve(path))])


@mcp.tool()
def cp(src: str, dest: str, recursive: bool = False) -> Dict[str, Any]:
    """Copy a file/directory (cp). The DESTINATION must be within the writable roots."""
    err = _fs_writable_error(dest)
    if err:
        return {"success": False, "error": err}
    flags = ["-r"] if recursive else []
    return _fs_run(["cp", *flags, str(_fs_resolve(src)), str(_fs_resolve(dest))])


@mcp.tool()
def mv(src: str, dest: str) -> Dict[str, Any]:
    """Move/rename a file/directory (mv). Both source and destination must be writable."""
    err = _fs_writable_error(src) or _fs_writable_error(dest)
    if err:
        return {"success": False, "error": err}
    return _fs_run(["mv", str(_fs_resolve(src)), str(_fs_resolve(dest))])


@mcp.tool()
def rm(path: str, recursive: bool = False, force: bool = False) -> Dict[str, Any]:
    """Delete a file/directory (rm). Confined to the writable roots."""
    err = _fs_writable_error(path)
    if err:
        return {"success": False, "error": err}
    flags = ""
    if recursive:
        flags += "r"
    if force:
        flags += "f"
    argv = ["rm"] + ([f"-{flags}"] if flags else []) + [str(_fs_resolve(path))]
    return _fs_run(argv)


@mcp.tool()
def rmdir(path: str) -> Dict[str, Any]:
    """Remove an EMPTY directory (rmdir). Confined to the writable roots."""
    err = _fs_writable_error(path)
    if err:
        return {"success": False, "error": err}
    return _fs_run(["rmdir", str(_fs_resolve(path))])


@mcp.tool()
def ln(target: str, link: str, symbolic: bool = True) -> Dict[str, Any]:
    """Create a hard/symbolic link (ln). The LINK path must be within the writable roots."""
    err = _fs_writable_error(link)
    if err:
        return {"success": False, "error": err}
    return _fs_run(["ln", *(["-s"] if symbolic else []), str(_fs_resolve(target)), str(_fs_resolve(link))])


# Permissions & ownership (confined to the writable roots) ─────────────────────
@mcp.tool()
def chmod(mode: str, path: str, recursive: bool = False) -> Dict[str, Any]:
    """Change file permissions (chmod). e.g. mode='644'. Confined to the writable roots."""
    err = _fs_writable_error(path)
    if err:
        return {"success": False, "error": err}
    return _fs_run(["chmod", *(["-R"] if recursive else []), mode, str(_fs_resolve(path))])


@mcp.tool()
def chown(owner: str, path: str, recursive: bool = False) -> Dict[str, Any]:
    """Change file owner/group (chown). e.g. owner='1000:1000'. Confined to writable roots."""
    err = _fs_writable_error(path)
    if err:
        return {"success": False, "error": err}
    return _fs_run(["chown", *(["-R"] if recursive else []), owner, str(_fs_resolve(path))])


# Low-level filesystem administration (DISABLED unless an operator opts in) ─────
@mcp.tool()
def fdisk(args: str = "-l") -> Dict[str, Any]:
    """Manipulate disk partition tables (fdisk). DISABLED unless LEXIA_FS_ALLOW_DISK_ADMIN=1."""
    return _disk_admin("fdisk", args)


@mcp.tool()
def mkfs(args: str) -> Dict[str, Any]:
    """Build a new filesystem (mkfs). DISABLED unless LEXIA_FS_ALLOW_DISK_ADMIN=1."""
    return _disk_admin("mkfs", args)


@mcp.tool()
def mount(args: str = "") -> Dict[str, Any]:
    """Attach a filesystem (mount). DISABLED unless LEXIA_FS_ALLOW_DISK_ADMIN=1."""
    return _disk_admin("mount", args)


@mcp.tool()
def umount(args: str) -> Dict[str, Any]:
    """Detach a mounted filesystem (umount). DISABLED unless LEXIA_FS_ALLOW_DISK_ADMIN=1."""
    return _disk_admin("umount", args)


@mcp.tool()
def fsck(args: str) -> Dict[str, Any]:
    """Check/repair a filesystem (fsck). DISABLED unless LEXIA_FS_ALLOW_DISK_ADMIN=1."""
    return _disk_admin("fsck", args)


if __name__ == "__main__":
    _bind()
    mcp.run()  # stdio transport
