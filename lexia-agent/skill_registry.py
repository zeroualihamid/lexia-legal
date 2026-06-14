from __future__ import annotations

from dataclasses import dataclass
from difflib import SequenceMatcher
from functools import lru_cache
from pathlib import Path
from typing import Dict, Iterable, List, Optional
import re
import unicodedata

import yaml


_PROJECT_ROOT = Path(__file__).resolve().parent
_SKILLS_DIR = _PROJECT_ROOT / "prompts" / "skills"


@dataclass(frozen=True)
class SkillDefinition:
    directory_name: str
    name: str
    description: str
    aliases: tuple[str, ...]
    skill_path: Path
    content: str
    # Optional data-source binding (from frontmatter). When set, the agent
    # scopes its pre-loop (augmentation, schema, new-CTE source) to this source
    # so it builds CTEs against the skill's data, not the default source.
    source_view: str = ""
    parquet_source: str = ""

    @property
    def canonical_names(self) -> tuple[str, ...]:
        ordered: list[str] = []
        for candidate in (self.name, self.directory_name, *self.aliases):
            cleaned = str(candidate).strip()
            if cleaned and cleaned not in ordered:
                ordered.append(cleaned)
        return tuple(ordered)


def skills_dir() -> Path:
    return _SKILLS_DIR


def _normalize_name(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value or "")
    ascii_only = normalized.encode("ascii", "ignore").decode("ascii")
    lowered = ascii_only.lower()
    lowered = re.sub(r"[^a-z0-9]+", " ", lowered)
    return re.sub(r"\s+", " ", lowered).strip()


def _extract_frontmatter(content: str) -> dict:
    if not content.startswith("---"):
        return {}

    end = content.find("\n---", 3)
    if end == -1:
        return {}

    raw = content[3:end].strip()
    parsed = yaml.safe_load(raw) or {}
    return parsed if isinstance(parsed, dict) else {}


@lru_cache(maxsize=1)
def load_skill_definitions() -> tuple[SkillDefinition, ...]:
    definitions: list[SkillDefinition] = []
    if not _SKILLS_DIR.exists():
        return tuple()

    # Release builds replace SKILL.md with an encrypted SKILL.md.enc. Collect
    # both, deduplicating by parent directory so each skill only loads once.
    candidates: dict[Path, Path] = {}
    for pattern in ("SKILL.md", "SKILL.md.enc"):
        for skill_file in sorted(_SKILLS_DIR.rglob(pattern)):
            candidates.setdefault(skill_file.parent, skill_file)

    # Lazy import to avoid a circular dependency at module load time.
    from prompt_loader import _read_prompt_file  # type: ignore[attr-defined]

    for parent_dir, skill_file in sorted(candidates.items()):
        # Always pass the .md path; _read_prompt_file transparently picks
        # the .enc variant when present.
        md_path = parent_dir / "SKILL.md"
        content = _read_prompt_file(md_path)
        if not content:
            continue

        frontmatter = _extract_frontmatter(content)
        directory_name = parent_dir.name
        name = str(frontmatter.get("name") or directory_name).strip()
        description = str(frontmatter.get("description") or "").strip()

        raw_aliases = frontmatter.get("aliases") or []
        if isinstance(raw_aliases, str):
            aliases = tuple(a.strip() for a in raw_aliases.split(",") if a.strip())
        elif isinstance(raw_aliases, list):
            aliases = tuple(str(a).strip() for a in raw_aliases if str(a).strip())
        else:
            aliases = tuple()

        definitions.append(
            SkillDefinition(
                directory_name=directory_name,
                name=name,
                description=description,
                aliases=aliases,
                skill_path=skill_file,
                content=content,
                source_view=str(frontmatter.get("source_view") or "").strip(),
                parquet_source=str(frontmatter.get("parquet_source") or "").strip(),
            )
        )

    return tuple(definitions)


def iter_skill_definitions() -> Iterable[SkillDefinition]:
    return load_skill_definitions()


def resolve_skill(skill_name: str) -> Optional[SkillDefinition]:
    target = _normalize_name(skill_name)
    if not target:
        return None

    for skill in load_skill_definitions():
        candidates = skill.canonical_names
        if any(_normalize_name(candidate) == target for candidate in candidates):
            return skill

    return None


# Common French/English function words that must not count as topical keywords.
_STOPWORDS = frozenset(
    "la le les des de du un une au aux en par pour avec sans sur sous dans entre "
    "vers chez et ou ni que qui quoi dont quel quelle quels quelles est sont ete "
    "plus moins rapport autre autres ce cet cette ces son sa ses leur leurs the "
    "of to and for with explique donne montre analyse calcule affiche pourquoi "
    "comment quand combien faire fait selon ainsi cela elle ils elles nous vous".split()
)


def _content_tokens(text: str) -> List[str]:
    """Significant (>=4-char, non-stopword) normalized tokens of *text*."""
    return [w for w in _normalize_name(text).split() if len(w) >= 4 and w not in _STOPWORDS]


@lru_cache(maxsize=64)
def _skill_keywords(directory_name: str) -> frozenset:
    """Topical keyword set drawn from a skill's name + description + aliases."""
    skill = next(
        (s for s in load_skill_definitions() if s.directory_name == directory_name), None
    )
    if skill is None:
        return frozenset()
    blob = " ".join([skill.name, skill.description, *skill.aliases])
    return frozenset(_content_tokens(blob))


def _fuzzy_keyword_hits(query_tokens: List[str], keywords: frozenset) -> int:
    """Count query tokens that equal or closely match (typo-tolerant) a keyword."""
    if not query_tokens or not keywords:
        return 0
    hits = 0
    for qt in query_tokens:
        if qt in keywords or any(
            SequenceMatcher(None, qt, kw).ratio() >= 0.84 for kw in keywords
        ):
            hits += 1
    return hits


def _description_embedding_sims(text: str) -> Dict[str, float]:
    """Cosine sim of *text* vs each skill description. Returns {} if unavailable."""
    try:
        import numpy as np

        from services.cte_graph.library_graph_cache import (
            get_agent_cte_embedding_service,
        )

        emb = get_agent_cte_embedding_service()

        def _norm(s: str):
            v = np.asarray(emb.encode_one(s or ""), dtype=np.float32)
            return v / (float(np.linalg.norm(v)) + 1e-9)

        qv = _norm(text)
        return {
            s.directory_name: float(qv @ _norm(s.description or s.name))
            for s in load_skill_definitions()
        }
    except Exception:
        return {}


def detect_skills_in_query(query: str, history: str = "") -> List[SkillDefinition]:
    """Rank skills relevant to *query* (and optional conversation *history*).

    Combines three signals so wording variants and typos still route correctly:
    exact alias/name substring (strong), typo-tolerant keyword overlap against
    the skill *description*, and embedding similarity of the description. Returns
    candidates sorted by score (best first); empty when nothing is relevant.
    """
    skills = load_skill_definitions()
    ctx = f"{query} {history}".strip()
    if not skills or not _normalize_name(ctx):
        return []

    query_norm = _normalize_name(ctx)
    q_tokens = _content_tokens(ctx)
    emb_sims = _description_embedding_sims(ctx)

    scored: list[tuple[float, SkillDefinition]] = []
    for skill in skills:
        exact = any(
            _normalize_name(c) and _normalize_name(c) in query_norm
            for c in skill.canonical_names
        )
        kw = _fuzzy_keyword_hits(q_tokens, _skill_keywords(skill.directory_name))
        emb = emb_sims.get(skill.directory_name, 0.0)
        # Keep a skill only when at least one signal is meaningful, so unrelated
        # queries match nothing.
        if not (exact or kw >= 1 or emb >= 0.45):
            continue
        score = (10.0 if exact else 0.0) + float(kw) + max(0.0, emb)
        scored.append((score, skill))

    scored.sort(key=lambda t: t[0], reverse=True)
    return [s for _, s in scored]


def select_routing_skill(
    matched: List[SkillDefinition],
) -> Optional[SkillDefinition]:
    """Pick the skill that should drive data routing among *matched* (ranked).

    Prefers the highest-ranked skill that declares a data source
    (``source_view``/``parquet_source``) — that's the one that knows which data
    the answer must come from — falling back to the top-ranked skill otherwise.
    """
    for skill in matched:
        if skill.source_view or skill.parquet_source:
            return skill
    return matched[0] if matched else None


def build_skills_summary() -> str:
    lines: list[str] = []
    for skill in load_skill_definitions():
        aliases = [a for a in skill.aliases if a and a != skill.name]
        aliases_text = f" (alias: {', '.join(aliases)})" if aliases else ""
        lines.append(f"- {skill.name}{aliases_text}: {skill.description}")
    return "\n".join(lines)


def build_skills_context_for_query(query: str, *, include_full_content: bool = True) -> str:
    """Return the domain-expertise context relevant to *query*.

    This is the single entry point the LangChain agent uses to inject skills:

    - When one or more skills match the query (by name/alias, via
      :func:`detect_skills_in_query`), their **full content** is returned so the
      agent has the exact formulas/règles métier it needs to design or execute a
      CTE (e.g. ``"donne le MNI"`` → the *indicateurs-bancaires-comex* skill,
      which carries the marge-nette-d'intérêt formula).
    - When nothing matches, a compact **catalogue** of all skills is returned
      (name + aliases + description) so the agent still knows what expertise
      exists and can reason about which formulas apply — without bloating the
      prompt with every skill's full body.

    Returns ``""`` only when no skills are installed at all.
    """
    if not (query or "").strip():
        return build_skills_summary()
    try:
        matches = detect_skills_in_query(query)
    except Exception:  # pragma: no cover - defensive
        matches = []
    if matches:
        # Lead with the source-bound routing skill (its data details matter most),
        # and cap the injected set to avoid bloating the system prompt.
        routing = select_routing_skill(matches)
        if routing is not None:
            matches = [routing] + [m for m in matches if m.directory_name != routing.directory_name]
        return build_selected_skills_context(matches[:2], include_full_content=include_full_content)
    return build_skills_summary()


def build_selected_skills_context(skills: Iterable[SkillDefinition], include_full_content: bool = False) -> str:
    chunks: list[str] = []
    for skill in skills:
        header = [
            f"Skill: {skill.name}",
            f"Directory: {skill.directory_name}",
        ]
        if skill.aliases:
            header.append(f"Aliases: {', '.join(skill.aliases)}")
        if skill.description:
            header.append(f"Description: {skill.description}")

        if include_full_content:
            body = skill.content
        else:
            body = "\n".join(
                line for line in skill.content.splitlines()[:120]
            ).strip()

        chunks.append("\n".join(header) + "\n\n" + body)

    return "\n\n".join(chunk for chunk in chunks if chunk.strip())
