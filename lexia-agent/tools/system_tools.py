"""System interaction tools for the agent.

Implements the "machine-native" toolkit requested for the agent loop:

* ``write_file``  — create/overwrite a text file (sandboxed under the
                     project root with a per-root allowlist).
* ``edit_file``   — exact string replacement inside an existing file
                     (single occurrence by default; ``replace_all`` for
                     bulk renames).
* ``glob_files``  — fast pattern-based discovery of files relative to
                     the project root.
* ``grep_files``  — content search with a regular expression over a
                     filtered set of files.
* ``shell_exec``  — bounded subprocess execution restricted to an
                     allowlist of binaries (git, ls, cat, python, pytest,
                     ruff, mypy, npm, pnpm, …).  Always pinned to the
                     project root, with an aggressive timeout.

Sandbox model
─────────────
Every path the agent passes through ``write_file`` / ``edit_file`` is
resolved relative to the project root and rejected if it escapes a
small whitelist of writable subtrees (data, prompts, brikz-agent code,
brikz-frontend, brikz-mcp, tests, docs).  ``shell_exec`` further
constrains the command head to a static allowlist so the agent cannot
``rm -rf`` the workspace by accident.
"""

from __future__ import annotations

import logging
import re
import shlex
import subprocess
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from llm.base_llm import ToolResult
from services.tool_registry import Tool

logger = logging.getLogger(__name__)


_PROJECT_ROOT = Path(__file__).resolve().parent.parent
# Repo root (one level above brikz-agent) is also reachable so the
# agent can grep across siblings (brikz-frontend, brikz-mcp, tests, docs).
_REPO_ROOT = _PROJECT_ROOT.parent

# Subtrees the agent may *write* to.  Relative to repo root.
_WRITE_ALLOWED_DIRS: List[Path] = [
    _PROJECT_ROOT / "data",
    _PROJECT_ROOT / "prompts",
    _PROJECT_ROOT / "config",
    _PROJECT_ROOT / "tools",
    _PROJECT_ROOT / "nodes",
    _PROJECT_ROOT / "flows",
    _PROJECT_ROOT / "tests",
    _PROJECT_ROOT / "services",
    _PROJECT_ROOT / "api",
    _PROJECT_ROOT / "utils",
    _REPO_ROOT / "brikz-frontend" / "src",
    _REPO_ROOT / "brikz-mcp" / "src",
    _REPO_ROOT / "docs",
    _REPO_ROOT / "tests",
]

# Subtrees the agent may *read* from (write-allowed dirs are implicitly
# read-allowed).  We expose a slightly larger surface for read-only
# queries (glob/grep) so the agent can cross-reference siblings.
_READ_ALLOWED_DIRS: List[Path] = [
    _REPO_ROOT,
]

# Write tools cap on input size (1 MB).  Larger payloads are almost
# certainly mistakes (e.g. uploading binary data through the LLM).
_WRITE_MAX_BYTES = 1_000_000

# File-content search caps.
_GREP_MAX_FILES = 5_000
_GREP_MAX_MATCHES = 500

# Glob caps.
_GLOB_MAX_RESULTS = 1_000

# Shell allowlist — the *first* token of the command must be in this set.
_SHELL_ALLOWLIST: set = {
    # Inspection / navigation
    "ls", "cat", "head", "tail", "wc", "tree", "stat", "file",
    "find", "rg", "grep", "sed",
    # Git (read + safe writes)
    "git",
    # Python ecosystem
    "python", "python3", "pip", "pytest", "ruff", "mypy", "black",
    # Node / pnpm / npm (front-end)
    "node", "npm", "pnpm", "npx",
    # Misc safe utilities
    "echo", "true", "false",
}

_SHELL_TIMEOUT_S = 60
_SHELL_OUTPUT_TRUNCATE = 20_000


# ── Path validation helpers ────────────────────────────────────────────────


def _resolve(path_str: str, *, allowed: Iterable[Path]) -> Optional[Path]:
    """Resolve *path_str* and ensure it lives under one of the *allowed* dirs.

    Accepts both absolute paths and paths relative to the repo root.
    Returns ``None`` when the path escapes every allowed subtree.
    """
    if not path_str:
        return None
    raw = Path(path_str)
    if not raw.is_absolute():
        # Try relative to project root first (most common), then repo root.
        candidate = (_PROJECT_ROOT / raw).resolve()
        if not _is_under_any(candidate, allowed):
            candidate = (_REPO_ROOT / raw).resolve()
    else:
        candidate = raw.resolve()
    if _is_under_any(candidate, allowed):
        return candidate
    return None


def _is_under_any(path: Path, roots: Iterable[Path]) -> bool:
    for root in roots:
        try:
            path.relative_to(root.resolve())
            return True
        except ValueError:
            continue
    return False


def _denied(path_str: str, *, allowed: Iterable[Path]) -> ToolResult:
    rel_roots = ", ".join(
        str(r.relative_to(_REPO_ROOT)) for r in allowed if r != _REPO_ROOT
    ) or "<repo root>"
    return ToolResult(
        tool_use_id="",
        content=(
            f"Accès refusé: {path_str!r} est hors des dossiers autorisés "
            f"({rel_roots})."
        ),
        is_error=True,
    )


# ── write_file ─────────────────────────────────────────────────────────────


def _handle_write_file(args: Dict[str, Any], ctx: Dict[str, Any]) -> ToolResult:
    file_path = (args.get("file_path") or "").strip()
    content   = args.get("content")
    if not file_path:
        return ToolResult(tool_use_id="", content="`file_path` est requis.", is_error=True)
    if content is None:
        return ToolResult(tool_use_id="", content="`content` est requis.", is_error=True)

    target = _resolve(file_path, allowed=_WRITE_ALLOWED_DIRS)
    if target is None:
        return _denied(file_path, allowed=_WRITE_ALLOWED_DIRS)

    body = content if isinstance(content, str) else str(content)
    if len(body.encode("utf-8", errors="replace")) > _WRITE_MAX_BYTES:
        return ToolResult(
            tool_use_id="",
            content=f"Contenu trop volumineux (>{_WRITE_MAX_BYTES} octets).",
            is_error=True,
        )

    target.parent.mkdir(parents=True, exist_ok=True)
    existed = target.is_file()
    target.write_text(body, encoding="utf-8")
    return ToolResult(
        tool_use_id="",
        content=(
            f"{'Mis à jour' if existed else 'Créé'} {target.relative_to(_REPO_ROOT)} "
            f"({len(body)} caractères)."
        ),
    )


write_file_tool = Tool(
    name="write_file",
    description=(
        "Écrit (ou écrase) un fichier texte dans le projet. Sandboxé aux "
        "sous-arbres autorisés (data, prompts, config, tools, nodes, flows, "
        "tests, brikz-frontend/src, brikz-mcp/src, docs)."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "file_path": {
                "type": "string",
                "description": "Chemin (relatif au repo ou absolu sous le repo).",
            },
            "content": {
                "type": "string",
                "description": "Contenu textuel complet à écrire (UTF-8).",
            },
        },
        "required": ["file_path", "content"],
    },
    handler=_handle_write_file,
    category="write",
)


# ── edit_file ──────────────────────────────────────────────────────────────


def _handle_edit_file(args: Dict[str, Any], ctx: Dict[str, Any]) -> ToolResult:
    file_path  = (args.get("file_path") or "").strip()
    old_string = args.get("old_string")
    new_string = args.get("new_string")
    replace_all = bool(args.get("replace_all"))

    if not file_path or old_string is None or new_string is None:
        return ToolResult(
            tool_use_id="",
            content="`file_path`, `old_string` et `new_string` sont requis.",
            is_error=True,
        )

    target = _resolve(file_path, allowed=_WRITE_ALLOWED_DIRS)
    if target is None:
        return _denied(file_path, allowed=_WRITE_ALLOWED_DIRS)
    if not target.is_file():
        return ToolResult(tool_use_id="", content=f"Fichier introuvable: {file_path}", is_error=True)

    text = target.read_text(encoding="utf-8")
    occurrences = text.count(old_string)
    if occurrences == 0:
        return ToolResult(
            tool_use_id="",
            content=f"`old_string` introuvable dans {target.relative_to(_REPO_ROOT)}.",
            is_error=True,
        )
    if occurrences > 1 and not replace_all:
        return ToolResult(
            tool_use_id="",
            content=(
                f"`old_string` apparaît {occurrences}x dans "
                f"{target.relative_to(_REPO_ROOT)}; précisez plus de contexte ou "
                f"`replace_all=true`."
            ),
            is_error=True,
        )

    new_text = text.replace(old_string, new_string)
    target.write_text(new_text, encoding="utf-8")
    return ToolResult(
        tool_use_id="",
        content=(
            f"Patché {target.relative_to(_REPO_ROOT)} "
            f"({occurrences} occurrence{'s' if occurrences > 1 else ''} remplacée{'s' if occurrences > 1 else ''})."
        ),
    )


edit_file_tool = Tool(
    name="edit_file",
    description=(
        "Remplace une chaîne exacte dans un fichier texte sandboxé. "
        "Par défaut, exige une unique occurrence (sécurité). Mettre "
        "`replace_all=true` pour un renommage en masse."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "file_path":  {"type": "string"},
            "old_string": {"type": "string", "description": "Texte exact à remplacer."},
            "new_string": {"type": "string", "description": "Nouveau texte."},
            "replace_all": {
                "type": "boolean",
                "description": "Si true, remplace toutes les occurrences.",
                "default": False,
            },
        },
        "required": ["file_path", "old_string", "new_string"],
    },
    handler=_handle_edit_file,
    category="write",
)


# ── glob_files ─────────────────────────────────────────────────────────────


def _handle_glob_files(args: Dict[str, Any], ctx: Dict[str, Any]) -> ToolResult:
    pattern = (args.get("pattern") or "").strip()
    if not pattern:
        return ToolResult(tool_use_id="", content="`pattern` est requis.", is_error=True)

    base_str = (args.get("base_dir") or "").strip()
    if base_str:
        base = _resolve(base_str, allowed=_READ_ALLOWED_DIRS)
        if base is None:
            return _denied(base_str, allowed=_READ_ALLOWED_DIRS)
    else:
        base = _PROJECT_ROOT

    if not pattern.startswith("**/") and "/" not in pattern[:3]:
        pattern = "**/" + pattern

    try:
        matches = list(base.glob(pattern))
    except (NotImplementedError, ValueError) as exc:
        return ToolResult(
            tool_use_id="",
            content=f"Pattern invalide: {pattern!r} ({exc})",
            is_error=True,
        )

    matches = [m for m in matches if _is_under_any(m, _READ_ALLOWED_DIRS)]
    matches.sort(key=lambda p: (0 if p.is_file() else 1, str(p)))
    matches = matches[:_GLOB_MAX_RESULTS]
    if not matches:
        return ToolResult(tool_use_id="", content=f"Aucun fichier trouvé pour {pattern!r}.")

    lines = [f"{len(matches)} résultat(s) sous {base.relative_to(_REPO_ROOT)}/{pattern}"]
    for m in matches:
        kind = "DIR " if m.is_dir() else "FILE"
        lines.append(f"  [{kind}] {m.relative_to(_REPO_ROOT)}")
    return ToolResult(tool_use_id="", content="\n".join(lines))


glob_files_tool = Tool(
    name="glob_files",
    description=(
        "Trouve des fichiers par pattern glob (ex: '**/*.sql', "
        "'data/reporting/sql/accounting/*.sql'). Si `base_dir` n'est pas "
        "fourni, la recherche démarre depuis brikz-agent/."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "pattern":  {
                "type": "string",
                "description": "Pattern glob (ex: '**/*.py', 'data/**/*.yaml').",
            },
            "base_dir": {
                "type": "string",
                "description": "Dossier racine pour la recherche (relatif au repo).",
            },
        },
        "required": ["pattern"],
    },
    handler=_handle_glob_files,
    category="read-only",
)


# ── grep_files ─────────────────────────────────────────────────────────────


def _iter_files(base: Path, glob_pattern: Optional[str]) -> Iterable[Path]:
    pattern = glob_pattern or "**/*"
    if not pattern.startswith("**/") and "/" not in pattern[:3]:
        pattern = "**/" + pattern
    n = 0
    for p in base.glob(pattern):
        if not p.is_file():
            continue
        if n >= _GREP_MAX_FILES:
            break
        n += 1
        yield p


def _handle_grep_files(args: Dict[str, Any], ctx: Dict[str, Any]) -> ToolResult:
    pattern = args.get("pattern")
    if not pattern:
        return ToolResult(tool_use_id="", content="`pattern` (regex) est requis.", is_error=True)

    glob_pattern = args.get("glob")
    base_str = (args.get("base_dir") or "").strip()
    if base_str:
        base = _resolve(base_str, allowed=_READ_ALLOWED_DIRS)
        if base is None:
            return _denied(base_str, allowed=_READ_ALLOWED_DIRS)
    else:
        base = _PROJECT_ROOT

    flags = 0
    if args.get("case_insensitive"):
        flags |= re.IGNORECASE
    try:
        regex = re.compile(pattern, flags)
    except re.error as exc:
        return ToolResult(
            tool_use_id="",
            content=f"Regex invalide: {exc}",
            is_error=True,
        )

    matches: List[str] = []
    file_count = 0
    for path in _iter_files(base, glob_pattern):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        file_hit = False
        for lineno, line in enumerate(text.splitlines(), start=1):
            if regex.search(line):
                file_hit = True
                rel = path.relative_to(_REPO_ROOT)
                matches.append(f"{rel}:{lineno}: {line.rstrip()[:300]}")
                if len(matches) >= _GREP_MAX_MATCHES:
                    break
        if file_hit:
            file_count += 1
        if len(matches) >= _GREP_MAX_MATCHES:
            break

    if not matches:
        return ToolResult(tool_use_id="", content=f"Aucune correspondance pour /{pattern}/.")
    out = [
        f"{len(matches)} correspondance(s) dans {file_count} fichier(s) "
        f"(base={base.relative_to(_REPO_ROOT)}, glob={glob_pattern or '**/*'})",
        "",
    ]
    out.extend(matches)
    return ToolResult(tool_use_id="", content="\n".join(out))


grep_files_tool = Tool(
    name="grep_files",
    description=(
        "Recherche par expression régulière dans le contenu des fichiers "
        "(équivalent ripgrep). Filtrer le périmètre avec `glob` "
        "(ex: '**/*.sql'). Renvoie path:line: contenu pour chaque hit."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "pattern": {
                "type": "string",
                "description": "Expression régulière Python.",
            },
            "glob": {
                "type": "string",
                "description": "Filtre glob optionnel (ex: '**/*.py').",
            },
            "base_dir": {
                "type": "string",
                "description": "Dossier racine (par défaut brikz-agent/).",
            },
            "case_insensitive": {
                "type": "boolean",
                "description": "Recherche insensible à la casse.",
                "default": False,
            },
        },
        "required": ["pattern"],
    },
    handler=_handle_grep_files,
    category="read-only",
)


# ── shell_exec ─────────────────────────────────────────────────────────────


def _handle_shell_exec(args: Dict[str, Any], ctx: Dict[str, Any]) -> ToolResult:
    command = (args.get("command") or "").strip()
    if not command:
        return ToolResult(tool_use_id="", content="`command` est requis.", is_error=True)

    try:
        tokens = shlex.split(command, posix=True)
    except ValueError as exc:
        return ToolResult(tool_use_id="", content=f"Commande mal formée: {exc}", is_error=True)
    if not tokens:
        return ToolResult(tool_use_id="", content="Commande vide.", is_error=True)

    head = Path(tokens[0]).name
    if head not in _SHELL_ALLOWLIST:
        return ToolResult(
            tool_use_id="",
            content=(
                f"Binaire {head!r} non autorisé. Autorisés: "
                f"{', '.join(sorted(_SHELL_ALLOWLIST))}."
            ),
            is_error=True,
        )
    if any(tok in {"&&", "||", ";", "|", ">", ">>", "<"} for tok in tokens):
        return ToolResult(
            tool_use_id="",
            content="Opérateurs shell (&&, ||, ;, |, >) interdits — exécutez une commande à la fois.",
            is_error=True,
        )

    cwd_arg = (args.get("cwd") or "").strip()
    if cwd_arg:
        cwd = _resolve(cwd_arg, allowed=_READ_ALLOWED_DIRS)
        if cwd is None or not cwd.is_dir():
            return _denied(cwd_arg, allowed=_READ_ALLOWED_DIRS)
    else:
        cwd = _PROJECT_ROOT

    timeout_s = max(1, min(int(args.get("timeout") or _SHELL_TIMEOUT_S), _SHELL_TIMEOUT_S))

    try:
        proc = subprocess.run(
            tokens,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
        )
    except FileNotFoundError:
        return ToolResult(
            tool_use_id="",
            content=f"Binaire introuvable: {tokens[0]}",
            is_error=True,
        )
    except subprocess.TimeoutExpired:
        return ToolResult(
            tool_use_id="",
            content=f"Timeout dépassé ({timeout_s}s) pour: {command}",
            is_error=True,
        )

    out = (proc.stdout or "")[:_SHELL_OUTPUT_TRUNCATE]
    err = (proc.stderr or "")[:_SHELL_OUTPUT_TRUNCATE]
    text = (
        f"$ {command}\n"
        f"cwd: {cwd.relative_to(_REPO_ROOT)}\n"
        f"exit: {proc.returncode}\n"
        f"--- stdout ---\n{out}\n"
        f"--- stderr ---\n{err}"
    )
    return ToolResult(tool_use_id="", content=text, is_error=proc.returncode != 0)


shell_exec_tool = Tool(
    name="shell_exec",
    description=(
        "Exécute une commande shell dans le repo (cwd par défaut: brikz-agent/). "
        "Liste blanche stricte: git, python, pytest, ruff, mypy, npm, pnpm, "
        "ls, cat, head, tail, wc, find, rg, grep, sed, echo, etc. "
        "Pas d'opérateurs shell (&&, |, >, ;) — une commande à la fois. "
        "Timeout par défaut 60 s."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "command": {
                "type": "string",
                "description": "Commande à exécuter (premier token doit être dans la liste blanche).",
            },
            "cwd": {
                "type": "string",
                "description": "Dossier de travail (relatif au repo).",
            },
            "timeout": {
                "type": "integer",
                "description": "Timeout en secondes (max 60).",
                "default": _SHELL_TIMEOUT_S,
            },
        },
        "required": ["command"],
    },
    handler=_handle_shell_exec,
    category="external",
)
