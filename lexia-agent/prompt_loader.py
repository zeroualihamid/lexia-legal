"""
Prompt Loader — reads markdown prompt files from the prompts/ directory
and composes them into system / user prompts for the LLM.

Template files live under ``prompts/templates/<category>/<name>.md`` and use
``{{variable}}`` placeholders for runtime substitution.
"""

from __future__ import annotations

import logging
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional

from services.parquet_datasource_map import list_enabled_parquet_filenames

logger = logging.getLogger(__name__)

_PROJECT_ROOT = Path(__file__).resolve().parent
_PROMPTS_DIR = _PROJECT_ROOT / "prompts"
_TEMPLATES_DIR = _PROMPTS_DIR / "templates"

_VAR_RE = re.compile(r"\{\{(\w+)\}\}")

# ── Prompt encryption support ────────────────────────────────────────────────
# In release builds, .md files are encrypted to .md.enc using Fernet.
# The key below is a placeholder replaced by scripts/build_release.py before
# Cython compilation, so it ends up baked into the .so binary.
_PROMPT_KEY: Optional[bytes] = None  # replaced at build time with b"..."
_fernet_cipher = None


def _get_cipher():
    """Lazily initialize the Fernet cipher (only in release builds)."""
    global _fernet_cipher
    if _fernet_cipher is not None:
        return _fernet_cipher
    if _PROMPT_KEY is None:
        return None
    try:
        from cryptography.fernet import Fernet
        _fernet_cipher = Fernet(_PROMPT_KEY)
        return _fernet_cipher
    except Exception as exc:
        logger.warning("Could not initialize prompt decryption: %s", exc)
        return None


def _read_prompt_file(path: Path) -> str:
    """Read a prompt file, transparently decrypting .enc variants.

    Lookup order:
      1. ``path.md.enc`` — decrypted with Fernet if available
      2. ``path.md`` — plain text (dev mode)
    """
    enc_path = path.with_suffix(path.suffix + ".enc")
    if enc_path.is_file():
        cipher = _get_cipher()
        if cipher is not None:
            try:
                return cipher.decrypt(enc_path.read_bytes()).decode("utf-8").strip()
            except Exception as exc:
                logger.error("Failed to decrypt %s: %s", enc_path.name, exc)
                return ""
        else:
            logger.warning("Encrypted prompt %s found but no decryption key", enc_path.name)
            return ""
    if path.is_file():
        return path.read_text(encoding="utf-8").strip()
    return ""


def write_prompt_file(path: Path, content: str) -> Path:
    """Persist a prompt file, re-encrypting when a Fernet cipher is available.

    Release mode (cipher available):
        - encrypt ``content`` with Fernet and write to ``path.md.enc``
        - remove any stale plaintext ``path.md`` sibling
        - return the ``.enc`` path that was written

    Dev mode (no cipher):
        - write plaintext to ``path.md``
        - return the plaintext path

    Callers pass the logical ``.md`` path; this helper picks the correct
    on-disk variant so downstream code never has to know about encryption.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    cipher = _get_cipher()
    if cipher is not None:
        enc_path = path.with_suffix(path.suffix + ".enc")
        token = cipher.encrypt(content.encode("utf-8"))
        enc_path.write_bytes(token)
        # Remove any stray plaintext so the encrypted version is authoritative.
        if path.is_file():
            try:
                path.unlink()
            except OSError as exc:
                logger.warning("Could not remove stale plaintext %s: %s", path, exc)
        return enc_path
    path.write_text(content, encoding="utf-8")
    # If a stale .enc exists (e.g. dev against a release checkout), drop it so
    # future reads don't see a stale encrypted copy.
    enc_path = path.with_suffix(path.suffix + ".enc")
    if enc_path.is_file():
        try:
            enc_path.unlink()
        except OSError as exc:
            logger.warning("Could not remove stale encrypted %s: %s", enc_path, exc)
    return path


def delete_prompt_file(path: Path) -> bool:
    """Remove both plaintext and encrypted variants of a prompt file.

    Returns True if at least one variant was deleted.
    """
    deleted = False
    for candidate in (path, path.with_suffix(path.suffix + ".enc")):
        if candidate.is_file():
            try:
                candidate.unlink()
                deleted = True
            except OSError as exc:
                logger.warning("Could not delete %s: %s", candidate, exc)
    return deleted


def prompt_file_exists(path: Path) -> bool:
    """Return True if either the plaintext or encrypted variant exists."""
    return path.is_file() or path.with_suffix(path.suffix + ".enc").is_file()


# ── Low-level helpers ────────────────────────────────────────────────────────

def load_prompt(path: Path) -> str:
    """Read a single prompt file, returning its text (or empty string)."""
    return _read_prompt_file(path)


def load_all_prompts(prompts_dir: Path) -> dict[str, str]:
    """Load every *.md (or *.md.enc) file in *prompts_dir* into a name→content dict.

    File names (without extension) become the keys:
        prompts/system_prompt.md  →  {"system_prompt": "…"}
    """
    prompts: dict[str, str] = {}
    if not prompts_dir.is_dir():
        return prompts
    # Collect .md and .md.enc files, deduplicating by stem
    seen: set[str] = set()
    for md_file in sorted(prompts_dir.glob("*.md")):
        key = md_file.stem
        if key not in seen:
            content = _read_prompt_file(md_file)
            if content:
                prompts[key] = content
            seen.add(key)
    for enc_file in sorted(prompts_dir.glob("*.md.enc")):
        key = enc_file.stem.removesuffix(".md")
        if key not in seen:
            # Build the .md path for _read_prompt_file to find the .enc
            md_path = enc_file.with_name(key + ".md")
            content = _read_prompt_file(md_path)
            if content:
                prompts[key] = content
            seen.add(key)
    return prompts


# ── Template engine ──────────────────────────────────────────────────────────

def _template_path(category: str, name: str) -> Path:
    return _TEMPLATES_DIR / category / f"{name}.md"


def load_template(category: str, name: str) -> str:
    """Load a raw template from ``prompts/templates/<category>/<name>.md``.

    In release builds, transparently decrypts ``.md.enc`` variants.
    """
    path = _template_path(category, name)
    content = _read_prompt_file(path)
    if not content:
        logger.warning("Prompt template not found: %s/%s", category, name)
    return content


def render_template(category: str, name: str, **variables: Any) -> str:
    """Load a template and substitute ``{{key}}`` placeholders.

    Missing keys are replaced with empty strings so the prompt never contains
    raw ``{{…}}`` markers.
    """
    raw = load_template(category, name)
    if not raw:
        return ""

    def _replace(m: re.Match) -> str:
        key = m.group(1)
        val = variables.get(key)
        return str(val) if val is not None else ""

    return _VAR_RE.sub(_replace, raw)


# ── Template inventory (for the UI) ─────────────────────────────────────────

def list_template_categories() -> List[str]:
    """Return sorted list of category directory names."""
    if not _TEMPLATES_DIR.is_dir():
        return []
    return sorted(d.name for d in _TEMPLATES_DIR.iterdir() if d.is_dir())


def list_templates(category: Optional[str] = None) -> List[Dict[str, str]]:
    """Return list of ``{category, name, path}`` for all templates.

    Recognises both ``*.md`` (dev) and ``*.md.enc`` (release) variants and
    deduplicates by stem so each template surfaces exactly once.

    If *category* is given, only that subdirectory is scanned.
    """
    results: List[Dict[str, str]] = []
    if not _TEMPLATES_DIR.is_dir():
        return results
    dirs = [_TEMPLATES_DIR / category] if category else (
        d for d in sorted(_TEMPLATES_DIR.iterdir()) if d.is_dir()
    )
    for d in dirs:
        if not d.is_dir():
            continue
        cat = d.name
        seen: set[str] = set()
        # Collect plaintext first, then fall back to encrypted counterparts.
        for md in sorted(d.glob("*.md")):
            if md.stem in seen:
                continue
            seen.add(md.stem)
            results.append({
                "category": cat,
                "name": md.stem,
                "path": str(md.relative_to(_PROJECT_ROOT)),
            })
        for enc in sorted(d.glob("*.md.enc")):
            # "<name>.md.enc" → stem is "<name>.md" on Path, strip .md manually.
            stem = enc.name.removesuffix(".md.enc")
            if stem in seen:
                continue
            seen.add(stem)
            # Surface the logical .md path for consistency with dev mode.
            md_path = enc.with_name(f"{stem}.md")
            results.append({
                "category": cat,
                "name": stem,
                "path": str(md_path.relative_to(_PROJECT_ROOT)),
            })
    return results


# ── Compose (existing API kept intact) ──────────────────────────────────────

def compose_system_prompt(
    prompts: dict[str, str],
    skills_context: str,
    data_dir: Path | None = None,
) -> str:
    """Build the full system prompt sent to the thinking LLM."""
    parts: list[str] = []

    if "system_prompt" in prompts:
        parts.append(prompts["system_prompt"])

    if skills_context:
        parts.append(
            "# Available Skills\n\n"
            "Below are the skills you can use to generate Python scripts.\n"
            "Use the scripts, references, and patterns described in each skill.\n\n"
            + skills_context
        )

    if data_dir and data_dir.is_dir():
        files = list_enabled_parquet_filenames(data_dir)
        if files:
            parts.append(
                "# Available Data Files\n\n"
                f"Directory: `{data_dir}`\n\n"
                + "\n".join(f"- `{f}`" for f in files)
            )

    return "\n\n---\n\n".join(parts)
