"""
Skills & Prompt Templates API
==============================

CRUD endpoints for:
- Skill definitions (``prompts/skills/<directory_name>/SKILL.md``)
- Prompt templates  (``prompts/templates/<category>/<name>.md``)
"""

from __future__ import annotations

import logging
import re
import shutil
import unicodedata
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from prompt_loader import (
    list_template_categories,
    list_templates,
    load_template,
    _TEMPLATES_DIR,
    _read_prompt_file,
    write_prompt_file,
    delete_prompt_file,
    prompt_file_exists,
)
from skill_registry import load_skill_definitions, skills_dir

logger = logging.getLogger(__name__)

router = APIRouter()

_SKILLS_DIR = skills_dir()


def _dtos_dir() -> Path:
    """Where auto-generated DTO modules live.

    Runtime-mutable, so it must be the writable copy under ``data/`` (not the
    read-only ``classes/`` shipped in release builds).
    """
    return Path(__file__).resolve().parents[2] / "data" / "classes" / "dtos"


_DTO_FILE_SUFFIX = "_dto.py"


def _extract_dto_columns(file_path: Path) -> List[Dict[str, Any]]:
    """Statically extract a DTO's column declarations.

    DTOs declare their schema via ``ColumnClass(column_name=..., description=...,
    type=..., is_categorical=...)`` calls inside a ``ColumnsClasses(columns=[...])``
    constructor returned by ``get_columns_descriptions()``. We never *import*
    the DTO (that would pull pyarrow + execute arbitrary code); instead we
    parse the source with ``ast`` and walk every ``ColumnClass(...)`` call,
    pulling out the keyword arguments that are simple string/bool/number
    constants. Anything dynamic (a variable, an f-string, …) is ignored —
    in practice DTOs are auto-generated so they only contain literals.

    Returns a list of ``{column_name, description, type, is_categorical}``
    dicts. Used by the AI skill-creation flow to ground the LLM in the
    actual columns of the data sources the user picked.
    """
    columns: List[Dict[str, Any]] = []
    try:
        import ast

        tree = ast.parse(file_path.read_text(encoding="utf-8", errors="ignore"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            func_name: Optional[str] = None
            if isinstance(func, ast.Attribute):
                func_name = func.attr
            elif isinstance(func, ast.Name):
                func_name = func.id
            if func_name != "ColumnClass":
                continue

            col: Dict[str, Any] = {}
            for kw in node.keywords:
                if kw.arg is None or not isinstance(kw.value, ast.Constant):
                    continue
                if kw.arg in ("column_name", "description", "type") and isinstance(kw.value.value, str):
                    col[kw.arg] = kw.value.value
                elif kw.arg == "is_categorical":
                    col[kw.arg] = bool(kw.value.value)
            if "column_name" in col:
                columns.append(col)
    except Exception:
        logger.warning("Could not parse columns for %s", file_path, exc_info=True)
    return columns


def _format_dto_grounding(meta: Dict[str, str], columns: List[Dict[str, Any]]) -> str:
    """Render one DTO into a compact, LLM-readable section.

    Uses a markdown table for the columns so the LLM can scan name/type
    without us having to spend tokens on prose. Empty descriptions are
    rendered as a short placeholder rather than a blank cell so the LLM
    doesn't hallucinate that the column is special.
    """
    slug = meta.get("slug") or meta.get("directory_name") or ""
    directory_name = meta.get("directory_name", "")
    description = (meta.get("file_description") or "").strip() or "_(no file description provided)_"

    lines = [
        f"### Dataset `{slug}` ({directory_name})",
        description,
    ]
    if columns:
        lines.append("")
        lines.append("Columns:")
        lines.append("| # | Name | Type | Categorical | Description |")
        lines.append("|---|------|------|-------------|-------------|")
        for idx, col in enumerate(columns, start=1):
            name = (col.get("column_name") or "").replace("|", "\\|")
            ctype = (col.get("type") or "").replace("|", "\\|")
            cat = "yes" if col.get("is_categorical") else "no"
            desc = (col.get("description") or "").replace("\n", " ").replace("|", "\\|") or "_(no description)_"
            lines.append(f"| {idx} | `{name}` | {ctype} | {cat} | {desc} |")
    else:
        lines.append("")
        lines.append("_(No columns declared in this DTO.)_")
    return "\n".join(lines)


def _load_dto_grounding(directory_names: List[str]) -> str:
    """Build a combined grounding block for ``directory_names``.

    Silently skips entries that don't resolve to a file under ``data/classes/dtos``
    so a stale alias persisted on a skill never crashes the chat endpoint.
    Returns ``""`` when no DTO could be resolved — callers use that to decide
    whether to inject a "## Données ciblées" section at all.
    """
    if not directory_names:
        return ""
    dtos_dir = _dtos_dir()
    if not dtos_dir.exists():
        return ""

    sections: List[str] = []
    for dn in directory_names:
        if not isinstance(dn, str) or not dn:
            continue
        path = dtos_dir / f"{dn}.py"
        if not path.is_file():
            logger.info("DTO grounding requested for unknown DTO '%s' — skipping", dn)
            continue
        meta = _extract_dto_metadata(path)
        cols = _extract_dto_columns(path)
        sections.append(_format_dto_grounding(meta, cols))

    return "\n\n".join(sections)


def _extract_dto_metadata(file_path: Path) -> Dict[str, str]:
    """Best-effort extraction of a DTO's display metadata.

    DTOs are tiny generated Python files; rather than importing them (which
    pulls ``pyarrow`` etc. and runs arbitrary code), we parse the source
    statically:

    - ``description``: prefer the string literal returned by
      ``get_file_description()``; fall back to the module docstring.
    - ``slug``: file stem without the trailing ``_dto`` suffix
      (e.g. ``ca_view_dto.py`` → ``ca_view``).
    """
    slug = file_path.stem
    if slug.endswith("_dto"):
        slug = slug[: -len("_dto")]

    description = ""
    module_doc = ""
    try:
        source = file_path.read_text(encoding="utf-8", errors="ignore")
        import ast

        tree = ast.parse(source)
        module_doc = (ast.get_docstring(tree) or "").strip()

        for node in tree.body:
            if isinstance(node, ast.FunctionDef) and node.name == "get_file_description":
                for stmt in node.body:
                    if isinstance(stmt, ast.Return) and isinstance(stmt.value, ast.Constant) \
                            and isinstance(stmt.value.value, str):
                        description = stmt.value.value.strip()
                        break
                break
    except Exception:
        # File unreadable / unparseable — leave description empty rather than
        # blowing up the whole list endpoint.
        logger.warning("Could not parse DTO metadata for %s", file_path, exc_info=True)

    if not description:
        description = module_doc

    return {
        "directory_name": file_path.stem,  # e.g. ca_view_dto
        "slug": slug,                       # e.g. ca_view
        "module_path": f"classes.dtos.{file_path.stem}",
        "file_description": description,
    }


@router.get("/dtos", summary="List available column DTOs (for skill scoping)")
async def list_skill_dtos():
    """Enumerate the DTOs auto-generated for connected data sources.

    Used by the skill-creation UI to let the user scope a skill to one or
    more datasets instead of typing free-form aliases. We return both the
    full module name (``directory_name``) and the human slug (``slug``)
    derived from the filename so the UI can show e.g. ``ca_view``
    while persisting ``ca_view_dto`` as the alias.
    """
    dtos_dir = _dtos_dir()
    if not dtos_dir.exists():
        return {"dtos": [], "count": 0}

    items: List[Dict[str, str]] = []
    for path in sorted(dtos_dir.glob(f"*{_DTO_FILE_SUFFIX}")):
        if path.name.startswith("_"):
            continue
        items.append(_extract_dto_metadata(path))
    return {"dtos": items, "count": len(items)}


class SkillUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    content_body: Optional[str] = None
    aliases: Optional[List[str]] = None
    # DTO directory_name (e.g. ``ca_view_dto``) the skill is bound to — its
    # data source / column schema. Persisted in the SKILL.md frontmatter as
    # ``dto`` (empty string clears the binding).
    dto: Optional[str] = None


class SkillCreate(BaseModel):
    directory_name: str
    name: str
    description: str = ""
    content_body: str = ""
    aliases: List[str] = []
    dto: str = ""


def _slugify(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value)
    ascii_only = normalized.encode("ascii", "ignore").decode("ascii").lower()
    slug = re.sub(r"[^a-z0-9]+", "_", ascii_only).strip("_")
    return slug or "skill"


def _slug_variants(value: str) -> set:
    """A token plus its hyphen/underscore variants (lowercased)."""
    v = (value or "").strip()
    return {x for x in (v, v.replace("-", "_"), v.replace("_", "-"),
                        v.lower(), v.lower().replace("-", "_"), v.lower().replace("_", "-")) if x}


def resolve_skill_directory(identifier: str) -> Optional[str]:
    """Canonical SKILL.md folder name for *identifier*.

    Tolerant: *identifier* may be the folder name, the skill's ``name`` (which
    can differ, e.g. folder ``analyste_cte_retail`` vs name
    ``analyste-cte-retail``), or a hyphen/underscore variant of either. Returns
    the on-disk folder name, or ``None`` when no skill matches.
    """
    ident = (identifier or "").strip()
    if not ident:
        return None
    if prompt_file_exists(_SKILLS_DIR / ident / "SKILL.md"):
        return ident  # exact folder — fast path
    wanted = _slug_variants(ident)
    try:
        for s in load_skill_definitions():
            if (_slug_variants(s.directory_name) & wanted) or (_slug_variants(s.name) & wanted):
                return s.directory_name
    except Exception:  # pragma: no cover - defensive
        logger.warning("resolve_skill_directory failed for %r", identifier, exc_info=True)
    return None


def _read_skill_file(directory_name: str) -> Dict[str, Any]:
    resolved = resolve_skill_directory(directory_name)
    if not resolved:
        raise HTTPException(status_code=404, detail=f"Skill not found: {directory_name}")
    skill_file = _SKILLS_DIR / resolved / "SKILL.md"
    if not prompt_file_exists(skill_file):
        raise HTTPException(status_code=404, detail=f"Skill not found: {directory_name}")
    content = _read_prompt_file(skill_file)
    frontmatter, body = _split_frontmatter(content)
    return {"frontmatter": frontmatter, "body": body, "path": skill_file, "directory_name": resolved}


def _split_frontmatter(content: str) -> tuple[dict, str]:
    if not content.startswith("---"):
        return {}, content
    end = content.find("\n---", 3)
    if end == -1:
        return {}, content
    raw_fm = content[3:end].strip()
    fm = yaml.safe_load(raw_fm) or {}
    body = content[end + 4:].lstrip("\n")
    return (fm if isinstance(fm, dict) else {}), body


def _render_skill_file(frontmatter: dict, body: str) -> str:
    fm_str = yaml.dump(frontmatter, default_flow_style=False, allow_unicode=True, sort_keys=False).strip()
    return f"---\n{fm_str}\n---\n\n{body}"


def _invalidate_cache() -> None:
    load_skill_definitions.cache_clear()


@router.get("", summary="List available skills")
async def list_skills():
    _invalidate_cache()
    skills = load_skill_definitions()
    return {
        "skills": [
            {
                "name": s.name,
                "description": s.description,
                "directory_name": s.directory_name,
                "aliases": list(s.aliases),
            }
            for s in skills
        ],
        "count": len(skills),
    }


@router.get("/{directory_name}", summary="Get a single skill")
async def get_skill(directory_name: str):
    data = _read_skill_file(directory_name)
    fm = data["frontmatter"]
    return {
        "directory_name": directory_name,
        "name": fm.get("name", directory_name),
        "description": fm.get("description", ""),
        "aliases": fm.get("aliases", []),
        "content_body": data["body"],
        # Data-source binding (DTO directory_name); also surface source_view /
        # parquet_source if the skill declares them.
        "dto": fm.get("dto", ""),
        "source_view": fm.get("source_view", ""),
        "parquet_source": fm.get("parquet_source", ""),
    }


@router.put("/{directory_name}", summary="Update a skill")
async def update_skill(directory_name: str, body: SkillUpdate):
    data = _read_skill_file(directory_name)
    fm = data["frontmatter"]

    if body.name is not None:
        fm["name"] = body.name
    if body.description is not None:
        fm["description"] = body.description
    if body.aliases is not None:
        fm["aliases"] = body.aliases
    if body.dto is not None:
        dto = body.dto.strip()
        if dto:
            fm["dto"] = dto
        else:
            fm.pop("dto", None)

    new_body = body.content_body if body.content_body is not None else data["body"]
    content = _render_skill_file(fm, new_body)

    skill_file: Path = data["path"]
    written_path = write_prompt_file(skill_file, content)
    _invalidate_cache()

    logger.info("Updated skill '%s' (wrote %s)", directory_name, written_path.name)
    return {"success": True, "directory_name": directory_name}


@router.post("", summary="Create a new skill", status_code=201)
async def create_skill(body: SkillCreate):
    dir_name = _slugify(body.directory_name) or _slugify(body.name)
    skill_dir = _SKILLS_DIR / dir_name
    skill_file = skill_dir / "SKILL.md"
    if prompt_file_exists(skill_file):
        raise HTTPException(status_code=409, detail=f"Skill already exists: {dir_name}")

    skill_dir.mkdir(parents=True, exist_ok=True)
    fm: dict = {"name": body.name}
    if body.description:
        fm["description"] = body.description
    if body.dto and body.dto.strip():
        fm["dto"] = body.dto.strip()
    if body.aliases:
        fm["aliases"] = body.aliases

    content = _render_skill_file(fm, body.content_body or f"# {body.name}\n")
    written_path = write_prompt_file(skill_file, content)
    _invalidate_cache()

    logger.info("Created skill '%s' (wrote %s)", dir_name, written_path.name)
    return {"success": True, "directory_name": dir_name}


@router.delete("/{directory_name}", summary="Delete a skill")
async def delete_skill(directory_name: str):
    skill_dir = _SKILLS_DIR / directory_name
    if not skill_dir.exists():
        raise HTTPException(status_code=404, detail=f"Skill not found: {directory_name}")

    shutil.rmtree(skill_dir)
    _invalidate_cache()

    logger.info("Deleted skill '%s'", directory_name)
    return {"success": True, "directory_name": directory_name}


# ── AI Skill Generation ──────────────────────────────────────────────────────

class SkillChatMessage(BaseModel):
    role: str  # "user" or "assistant"
    content: str


class SkillContext(BaseModel):
    """Snapshot of the skill the user is editing — sent so the LLM can
    propose targeted modifications instead of generating a brand new skill.
    Only used when the frontend opens the AI chat from the *edit* view.
    """
    directory_name: str
    name: str
    description: str = ""
    aliases: List[str] = []
    content_body: str = ""


class SkillChatRequest(BaseModel):
    messages: List[SkillChatMessage]
    # Optional: when present, the assistant operates in EDIT mode and
    # produces a revised SKILL.md that reuses ``current_skill.directory_name``
    # so the frontend can apply the diff in-place (PUT /skills/{dir}) rather
    # than POST'ing a new skill.
    current_skill: Optional[SkillContext] = None
    # Optional (CREATE mode only): the ``directory_name`` of every DTO the
    # user ticked in the multi-select. The backend statically parses each
    # DTO's ``ColumnClass(...)`` declarations and injects the resulting
    # column tables into the system prompt so the LLM grounds its
    # generated skill in the *actual* schema of the data, not in
    # hallucinated column names.
    selected_dtos: List[str] = []
    # When True, append a strong "FINALIZE NOW" instruction to the
    # conversation so the LLM emits the final ```skill block instead of
    # continuing to ask clarifying questions. Fired by the frontend's
    # "Créer le skill" button when the user wants to lock in the
    # current discussion without one more chat round.
    finalize: bool = False


_SKILL_SYSTEM_PROMPT_CREATE = """\
You are a skill-design assistant for an LLM-powered data analytics agent called Brikz.
The user will describe a skill they want to create through a conversation.

Your job:
1. Ask clarifying questions to understand the skill's use-case, goals, data scope, \
expected outputs, and aliases (keywords that should trigger this skill).
2. Once you have enough information, generate the complete SKILL.md content.

{dto_grounding_section}\
When you are ready to generate, return your response in this EXACT format:

```skill
---
name: <slug-name>
description: >
  <1-3 sentence description>
aliases:
{aliases_hint}
---

# <Skill Title>

## Vue d'ensemble
<overview>

## Scope data et axes analytiques
<data scope and axes>

## Règles métier
<business rules>

## Format de sortie attendu
<expected output format>
```

Rules:
- Write in the SAME LANGUAGE as the user (French if they write in French).
- The skill guide should be detailed and actionable for an LLM agent.
- Always include concrete examples of queries this skill should handle.
- Keep asking questions until you understand: purpose, target data, business rules, output format.
- When the user says they are satisfied or asks you to generate, produce the final ```skill block.
{dto_grounding_rules}\
"""


_DTO_GROUNDING_SECTION_TEMPLATE = """\

## Données ciblées (ground truth)

The user has scoped this skill to the following dataset(s). Treat the column \
tables below as the *only* source of truth about what data is available — \
do NOT invent columns that are not listed, and prefer column names verbatim \
(including special characters like ``%`` or ``Z_Raw_…``) when writing \
examples, SQL hints or business rules:

{grounding}

The DTO ``directory_name`` values above are already wired as the skill's \
aliases — you don't need to re-suggest them. Focus the conversation on \
*what* analyses to produce on these columns, not on guessing the data \
shape.

"""


_DTO_GROUNDING_RULES = """\
- Ground every assertion in the columns listed under "Données ciblées" — \
  reference real column names, never invented ones.
- When proposing analytical axes or KPIs, reuse the categorical columns \
  flagged ``yes`` in the table as natural grouping dimensions and the \
  numeric columns as natural measures.
"""


_FINALIZE_INSTRUCTION = """\
FINALIZE NOW.

The user has clicked "Créer le skill" — stop asking clarifying questions, \
take everything we have discussed so far (plus the dataset context if any) \
and produce the COMPLETE final SKILL.md immediately.

Hard requirements:
- Your reply MUST start with the ```skill fenced block. No preamble.
- Do NOT ask any more questions; the form is about to be submitted.
- Fill every section of the template substantively. If the conversation \
  is sparse, infer reasonable defaults from the dataset context and the \
  most recent user message, and produce a usable skill anyway.
- ``aliases`` MUST be exactly the DTO ``directory_name`` values that the \
  system prompt listed under "Données ciblées". If none were listed, \
  pick 2-3 short keywords from the user's request.
- Use real column names verbatim (including ``%`` or ``Z_Raw_…`` prefixes) \
  in any examples / business rules.
"""


_SKILL_BLOCK_RE = re.compile(
    r"```(?:skill|markdown)?[ \t]*(?:\r?\n)?(.*?)```",
    re.DOTALL | re.IGNORECASE,
)


def _normalise_aliases(value: Any) -> List[str]:
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    if not isinstance(value, list):
        return []
    aliases: List[str] = []
    for item in value:
        if isinstance(item, str) and item.strip():
            aliases.append(item.strip())
    return aliases


def _build_skill_draft(
    raw_skill_text: str,
    current_skill: Optional[SkillContext],
    selected_dtos: Optional[List[str]],
) -> Dict[str, Any]:
    fm, body_text = _split_frontmatter(raw_skill_text.strip())
    name = str(fm.get("name") or "").strip()
    if not name:
        heading = re.search(r"^#\s+(.+)$", body_text, re.MULTILINE)
        name = heading.group(1).strip() if heading else (
            current_skill.name if current_skill is not None else "new_skill"
        )

    if current_skill is not None:
        directory_name = current_skill.directory_name
    else:
        directory_name = _slugify(str(fm.get("directory_name") or name or "new_skill"))

    aliases = _normalise_aliases(fm.get("aliases", []))
    if current_skill is None and selected_dtos:
        seen = set()
        merged: List[str] = []
        for alias in list(selected_dtos) + aliases:
            if not isinstance(alias, str):
                continue
            alias = alias.strip()
            if not alias or alias in seen:
                continue
            seen.add(alias)
            merged.append(alias)
        aliases = merged

    return {
        "name": name,
        "description": str(fm.get("description") or "").strip(),
        "aliases": aliases,
        "content_body": body_text,
        "directory_name": directory_name,
    }


def _extract_skill_draft(
    assistant_text: str,
    current_skill: Optional[SkillContext],
    selected_dtos: Optional[List[str]],
) -> Optional[Dict[str, Any]]:
    match = _SKILL_BLOCK_RE.search(assistant_text)
    if match:
        return _build_skill_draft(match.group(1), current_skill, selected_dtos)
    stripped = assistant_text.strip()
    if stripped.startswith("---"):
        return _build_skill_draft(stripped, current_skill, selected_dtos)
    return None


_SKILL_SYSTEM_PROMPT_EDIT_TEMPLATE = """\
You are a skill-editing assistant for an LLM-powered data analytics agent called Brikz.
The user already has an EXISTING skill and wants to MODIFY it through conversation.

## Current skill
- name: {name}
- directory_name: {directory_name}
- aliases: {aliases}
- description: {description}

## Current SKILL.md body
```markdown
{content_body}
```

Your job:
1. Read the current skill carefully.
2. Understand what the user wants to change (add a section, rewrite a part, tighten aliases, \
broaden scope, fix examples, etc.). Ask clarifying questions ONLY when the request is ambiguous.
3. When you have enough information, output the full revised SKILL.md as a ```skill block. \
Do NOT change ``directory_name`` — keep it exactly equal to ``{directory_name}`` so the \
frontend can apply the edit in place. You MAY adjust ``name``, ``description``, ``aliases``, \
and the body. Preserve any sections the user did not ask to change.

When you are ready to produce the revised skill, return it in this EXACT format:

```skill
---
name: {name}
description: >
  <updated 1-3 sentence description>
aliases:
  - <alias1>
  - <alias2>
---

<full revised markdown body — keep all sections the user did not ask to change>
```

Rules:
- Write in the SAME LANGUAGE as the user (and as the existing skill — currently looks like the language used in the body above).
- Be surgical: do not rewrite the whole skill just because one paragraph needs work.
- Always include concrete examples in the body.
- ``directory_name`` MUST stay equal to ``{directory_name}``.
"""


def _build_skill_system_prompt(
    current_skill: Optional[SkillContext],
    selected_dtos: Optional[List[str]] = None,
) -> str:
    """Return the system prompt for ``ai_generate_skill``.

    - Edit mode (``current_skill`` set): existing template, unchanged.
      The skill's own body is already ground truth, so any DTO grounding
      passed in would just be noise.
    - Create mode (no ``current_skill``): if ``selected_dtos`` is given,
      we inject a "Données ciblées" section listing each DTO's columns
      (parsed statically — no imports). The LLM is then told to reuse
      those exact column names and to treat the categorical/numeric
      hints as analytical axes/measures. Aliases for the generated
      skill are pre-locked to the DTO ``directory_name`` values the
      frontend already shows as chips.
    """
    if current_skill is not None:
        aliases_str = ", ".join(current_skill.aliases) if current_skill.aliases else "(none)"
        return _SKILL_SYSTEM_PROMPT_EDIT_TEMPLATE.format(
            name=current_skill.name or current_skill.directory_name,
            directory_name=current_skill.directory_name,
            aliases=aliases_str,
            description=current_skill.description or "(empty)",
            content_body=current_skill.content_body or "(empty)",
        )

    grounding = _load_dto_grounding(selected_dtos or [])
    if grounding:
        grounding_section = _DTO_GROUNDING_SECTION_TEMPLATE.format(grounding=grounding)
        grounding_rules = _DTO_GROUNDING_RULES
        aliases_hint_lines = [f"  - {dn}" for dn in (selected_dtos or []) if isinstance(dn, str) and dn]
        aliases_hint = "\n".join(aliases_hint_lines) if aliases_hint_lines else "  - <alias1>\n  - <alias2>"
    else:
        grounding_section = ""
        grounding_rules = ""
        aliases_hint = "  - <alias1>\n  - <alias2>"

    return _SKILL_SYSTEM_PROMPT_CREATE.format(
        dto_grounding_section=grounding_section,
        dto_grounding_rules=grounding_rules,
        aliases_hint=aliases_hint,
    )


@router.post("/ai-generate", summary="AI-assisted skill creation/edit chat")
async def ai_generate_skill(body: SkillChatRequest):
    """Multi-turn chat endpoint.

    - Create mode (no ``current_skill``): asks clarifying questions and
      eventually produces a fresh ``skill`` block.
    - Edit mode (with ``current_skill``): grounds the assistant in the
      existing SKILL.md and asks it to propose targeted modifications,
      reusing the same ``directory_name`` so the caller can PUT the diff.
    """
    from llm.llm_factory import get_llm
    from config import get_settings

    settings = get_settings()
    client, _ = get_llm()

    system_prompt = _build_skill_system_prompt(body.current_skill, body.selected_dtos)
    messages = [{"role": "system", "content": system_prompt}]
    for m in body.messages:
        messages.append({"role": m.role, "content": m.content})

    # Finalize round-trip — appended *after* the user's history so it acts
    # as the final, overriding instruction. Lowering temperature here keeps
    # the closing skill block tight and deterministic.
    temperature = 0.5
    if body.finalize:
        messages.append({"role": "user", "content": _FINALIZE_INSTRUCTION})
        temperature = 0.2

    try:
        response = client.chat.completions.create(
            model=settings.llm.model,
            messages=messages,
            temperature=temperature,
            max_tokens=4096,
        )
        assistant_text = response.choices[0].message.content.strip()
        skill_draft = _extract_skill_draft(
            assistant_text,
            body.current_skill,
            body.selected_dtos,
        )

        return {"message": assistant_text, "skill_draft": skill_draft}
    except Exception as e:
        logger.error("AI skill generation failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"LLM call failed: {e}")


# ── Prompt Templates API ─────────────────────────────────────────────────────

class TemplateUpdate(BaseModel):
    content: str


@router.get("/templates/list", summary="List prompt templates")
async def list_prompt_templates(
    category: Optional[str] = Query(None, description="Filter by category"),
):
    templates = list_templates(category)
    categories = list_template_categories()
    return {"templates": templates, "categories": categories, "count": len(templates)}


@router.get("/templates/{category}/{name}", summary="Get a prompt template")
async def get_prompt_template(category: str, name: str):
    content = load_template(category, name)
    if not content:
        raise HTTPException(status_code=404, detail=f"Template not found: {category}/{name}")
    return {"category": category, "name": name, "content": content}


@router.put("/templates/{category}/{name}", summary="Update a prompt template")
async def update_prompt_template(category: str, name: str, body: TemplateUpdate):
    path = _TEMPLATES_DIR / category / f"{name}.md"
    if not prompt_file_exists(path):
        raise HTTPException(status_code=404, detail=f"Template not found: {category}/{name}")
    written_path = write_prompt_file(path, body.content)
    logger.info("Updated template %s/%s (wrote %s)", category, name, written_path.name)
    return {"success": True, "category": category, "name": name}


class PromptImproveRequest(BaseModel):
    content: str
    instruction: str = ""


@router.post("/templates/improve", summary="AI-assisted prompt improvement")
async def improve_prompt_template(body: PromptImproveRequest):
    """Use LLM to improve / rewrite a prompt template based on user instruction."""
    from llm.llm_factory import get_llm
    from config import get_settings

    settings = get_settings()
    client, _ = get_llm()

    user_instruction = body.instruction.strip() or "Improve this prompt to be clearer, more precise, and more effective."

    system_msg = (
        "You are a prompt engineering expert. The user will give you a system prompt template "
        "used inside an LLM-powered application, along with an instruction on how to improve it.\n"
        "Rules:\n"
        "- Preserve every {{variable}} placeholder exactly as-is.\n"
        "- Keep the same language (French or English) as the original.\n"
        "- Return ONLY the improved prompt text, no explanations or markdown fences.\n"
        "- Maintain the original intent and structure while making it more effective."
    )

    try:
        response = client.chat.completions.create(
            model=settings.llm.model,
            messages=[
                {"role": "system", "content": system_msg},
                {"role": "user", "content": (
                    f"## Instruction\n{user_instruction}\n\n"
                    f"## Current prompt\n{body.content}"
                )},
            ],
            temperature=0.4,
            max_tokens=4096,
        )
        improved = response.choices[0].message.content.strip()
        return {"improved": improved}
    except Exception as e:
        logger.error("Prompt improvement failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"LLM call failed: {e}")
