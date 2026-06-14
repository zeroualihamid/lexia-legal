"""
Domain Subagent Registry
========================

Maps each platform domain to its configuration:
- primary data sources (always loaded)
- output directory for generated files
- prompt module for LLM system prompts

Built-in domains are defined here; user-created domains are persisted
to ``data/subagents/_custom_domains.json`` and merged at runtime.
Prompt overrides for built-in domains are in ``_prompt_overrides.json``.
"""

import importlib
import json
import os
import re
import threading
from pathlib import Path
from typing import Dict, Any, List, Optional

from monitoring.logger import get_logger

logger = get_logger(__name__)

_CUSTOM_DOMAINS_PATH = Path("data/subagents/_custom_domains.json")
_HIDDEN_BUILTINS_PATH = Path("data/subagents/_hidden_builtins.json")
_PROMPT_OVERRIDES_PATH = Path("data/subagents/_prompt_overrides.json")
_lock = threading.Lock()

_BUILTIN_AGENTS: Dict[str, Dict[str, Any]] = {
    "dashboard": {
        "name": "Dashboard",
        "primary_sources": ["ca_view"],
        "output_dir": "data/subagents/dashboard",
        "prompt_module": "llm.prompts.domains.dashboard",
        "description": "",
        "icon": "LayoutDashboard",
        "welcome_message": "Bienvenue sur le Dashboard.",
        "sample_questions": [
            
        ],
    },
}


def _load_custom_domains() -> Dict[str, Dict[str, Any]]:
    """Load user-created domains from disk."""
    if not _CUSTOM_DOMAINS_PATH.exists():
        return {}
    try:
        with open(_CUSTOM_DOMAINS_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"[registry] Failed to load custom domains: {e}")
        return {}


def _save_custom_domains(domains: Dict[str, Dict[str, Any]]) -> None:
    """Persist user-created domains to disk (atomic write)."""
    _CUSTOM_DOMAINS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = _CUSTOM_DOMAINS_PATH.with_suffix(".tmp")
    with _lock:
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(domains, f, ensure_ascii=False, indent=2)
            os.replace(str(tmp), str(_CUSTOM_DOMAINS_PATH))
        except Exception as e:
            logger.error(f"[registry] Failed to save custom domains: {e}")
            if tmp.exists():
                tmp.unlink(missing_ok=True)


def _load_hidden_builtins() -> set:
    """Load the set of built-in domain IDs that the user has hidden."""
    if not _HIDDEN_BUILTINS_PATH.exists():
        return set()
    try:
        with open(_HIDDEN_BUILTINS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
            return set(data) if isinstance(data, list) else set()
    except Exception as e:
        logger.error(f"[registry] Failed to load hidden builtins: {e}")
        return set()


def _load_prompt_overrides() -> Dict[str, Dict[str, str]]:
    """Load user overrides for built-in domain prompts."""
    if not _PROMPT_OVERRIDES_PATH.exists():
        return {}
    try:
        with open(_PROMPT_OVERRIDES_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"[registry] Failed to load prompt overrides: {e}")
        return {}


def _save_prompt_overrides(overrides: Dict[str, Dict[str, str]]) -> None:
    """Persist prompt overrides for built-in domains."""
    _PROMPT_OVERRIDES_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = _PROMPT_OVERRIDES_PATH.with_suffix(".tmp")
    with _lock:
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(overrides, f, ensure_ascii=False, indent=2)
            os.replace(str(tmp), str(_PROMPT_OVERRIDES_PATH))
        except Exception as e:
            logger.error(f"[registry] Failed to save prompt overrides: {e}")
            if tmp.exists():
                tmp.unlink(missing_ok=True)


def _save_hidden_builtins(hidden: set) -> None:
    """Persist hidden built-in domain IDs to disk."""
    _HIDDEN_BUILTINS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = _HIDDEN_BUILTINS_PATH.with_suffix(".tmp")
    with _lock:
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(sorted(hidden), f)
            os.replace(str(tmp), str(_HIDDEN_BUILTINS_PATH))
        except Exception as e:
            logger.error(f"[registry] Failed to save hidden builtins: {e}")
            if tmp.exists():
                tmp.unlink(missing_ok=True)


def _merged_agents() -> Dict[str, Dict[str, Any]]:
    """Return built-in (minus hidden) + custom domains merged together."""
    hidden = _load_hidden_builtins()
    merged = {k: v for k, v in _BUILTIN_AGENTS.items() if k not in hidden}
    merged.update(_load_custom_domains())
    return merged


# Public mutable reference — legacy code imports DOMAIN_AGENTS directly.
# We keep it as a property-like dict that always reflects the merged state.
DOMAIN_AGENTS = _merged_agents()


def _refresh_domain_agents() -> None:
    """Refresh the global DOMAIN_AGENTS dict in-place."""
    global DOMAIN_AGENTS
    fresh = _merged_agents()
    DOMAIN_AGENTS.clear()
    DOMAIN_AGENTS.update(fresh)


def get_domain_config(domain_id: str) -> Optional[Dict[str, Any]]:
    """Return the config dict for a domain, or None if unknown."""
    _refresh_domain_agents()
    return DOMAIN_AGENTS.get(domain_id)


def _get_builtin_prompts_from_module(domain_id: str) -> Optional[Dict[str, str]]:
    """Load prompts from the built-in module (e.g. llm.prompts.domains.dashboard)."""
    cfg = _BUILTIN_AGENTS.get(domain_id)
    if not cfg:
        return None
    try:
        mod = importlib.import_module(cfg["prompt_module"])
        return {
            "system": getattr(mod, "DOMAIN_SYSTEM_PROMPT", ""),
            "code": getattr(mod, "DOMAIN_CODE_PROMPT", ""),
        }
    except Exception as e:
        logger.warning(f"[registry] Could not load prompts for {domain_id}: {e}")
        return {"system": "", "code": ""}


def get_domain_prompts(domain_id: str) -> Optional[Dict[str, str]]:
    """Return effective system_prompt and code_prompt for a domain.
    Checks overrides first (built-in), then custom config, then built-in module
    (e.g. llm.prompts.domains.dashboard).
    """
    overrides = _load_prompt_overrides()
    if domain_id in overrides:
        return {
            "system": overrides[domain_id].get("system_prompt", ""),
            "code": overrides[domain_id].get("code_prompt", ""),
        }
    custom = _load_custom_domains()
    if domain_id in custom:
        return {
            "system": custom[domain_id].get("system_prompt", ""),
            "code": custom[domain_id].get("code_prompt", ""),
        }
    return _get_builtin_prompts_from_module(domain_id)


def clear_prompt_override(domain_id: str) -> bool:
    """Remove prompt override for a built-in domain. Next get_domain_prompts uses module default."""
    if domain_id not in _BUILTIN_AGENTS:
        raise ValueError(f"Domain '{domain_id}' is not a built-in")
    overrides = _load_prompt_overrides()
    if domain_id not in overrides:
        return True
    del overrides[domain_id]
    _save_prompt_overrides(overrides)
    _refresh_domain_agents()
    logger.info(f"[registry] Cleared prompt override for {domain_id}, using module default")
    return True


def list_domains() -> list[str]:
    """Return all registered domain IDs."""
    _refresh_domain_agents()
    return list(DOMAIN_AGENTS.keys())


def _slugify(text: str) -> str:
    """Turn a name into a safe domain ID slug."""
    text = text.lower().strip()
    text = re.sub(r"[àáâãäå]", "a", text)
    text = re.sub(r"[èéêë]", "e", text)
    text = re.sub(r"[ìíîï]", "i", text)
    text = re.sub(r"[òóôõö]", "o", text)
    text = re.sub(r"[ùúûü]", "u", text)
    text = re.sub(r"[ç]", "c", text)
    text = re.sub(r"[^a-z0-9]+", "_", text)
    return text.strip("_")[:40]


def create_domain(
    name: str,
    system_prompt: str,
    code_prompt: str = "",
    primary_sources: Optional[List[str]] = None,
    description: str = "",
    welcome_message: str = "",
    sample_questions: Optional[List[str]] = None,
    icon: str = "Bot",
) -> Dict[str, Any]:
    """
    Register a new custom domain subagent.

    Returns the full domain config dict (including generated ``domain_id``).
    """
    domain_id = _slugify(name)
    if not domain_id:
        raise ValueError("Invalid domain name — results in empty slug")

    _refresh_domain_agents()
    if domain_id in DOMAIN_AGENTS:
        raise ValueError(f"Domain '{domain_id}' already exists")

    output_dir = f"data/subagents/{domain_id}"
    Path(output_dir).mkdir(parents=True, exist_ok=True)

    config: Dict[str, Any] = {
        "name": name,
        "primary_sources": primary_sources or [],
        "output_dir": output_dir,
        "prompt_module": f"__custom__:{domain_id}",
        "system_prompt": system_prompt,
        "code_prompt": code_prompt,
        "custom": True,
        "description": description,
        "welcome_message": welcome_message or f"Bienvenue dans l'espace {name}.",
        "sample_questions": sample_questions or [],
        "icon": icon,
    }

    custom = _load_custom_domains()
    custom[domain_id] = config
    _save_custom_domains(custom)
    _refresh_domain_agents()

    logger.info(f"[registry] Created custom domain: {domain_id} ({name})")
    return {"domain_id": domain_id, **config}


def update_domain(
    domain_id: str,
    **updates: Any,
) -> Dict[str, Any]:
    """Update fields on a domain. Custom domains: full update. Built-in: prompt overrides only."""
    custom = _load_custom_domains()
    if domain_id in custom:
        allowed = {
            "name", "system_prompt", "code_prompt", "primary_sources",
            "description", "welcome_message", "sample_questions", "icon",
        }
        for key, val in updates.items():
            if key in allowed:
                custom[domain_id][key] = val
        _save_custom_domains(custom)
        _refresh_domain_agents()
        logger.info(f"[registry] Updated custom domain: {domain_id}")
        return {"domain_id": domain_id, **custom[domain_id]}

    if domain_id in _BUILTIN_AGENTS:
        prompt_updates = {k: v for k, v in updates.items() if k in ("system_prompt", "code_prompt")}
        if not prompt_updates:
            raise ValueError(f"Built-in domain '{domain_id}' can only update system_prompt and code_prompt")
        overrides = _load_prompt_overrides()
        current = get_domain_prompts(domain_id) or {"system": "", "code": ""}
        entry = overrides.get(domain_id, {})
        entry["system_prompt"] = prompt_updates.get("system_prompt", current["system"])
        entry["code_prompt"] = prompt_updates.get("code_prompt", current["code"])
        overrides[domain_id] = entry
        _save_prompt_overrides(overrides)
        _refresh_domain_agents()
        logger.info(f"[registry] Updated prompt override for built-in domain: {domain_id}")
        cfg = dict(_BUILTIN_AGENTS[domain_id])
        cfg["system_prompt"] = entry.get("system_prompt", "")
        cfg["code_prompt"] = entry.get("code_prompt", "")
        return {"domain_id": domain_id, **cfg}

    raise ValueError(f"Domain '{domain_id}' does not exist")


def delete_domain(domain_id: str) -> bool:
    """Remove a domain. Custom domains are fully deleted; built-in domains
    (except *dashboard*) are hidden from the active list."""
    if domain_id == "dashboard":
        raise ValueError("The Dashboard domain cannot be removed")

    custom = _load_custom_domains()
    if domain_id in custom:
        del custom[domain_id]
        _save_custom_domains(custom)
        _refresh_domain_agents()
        logger.info(f"[registry] Deleted custom domain: {domain_id}")
        return True

    if domain_id in _BUILTIN_AGENTS:
        hidden = _load_hidden_builtins()
        hidden.add(domain_id)
        _save_hidden_builtins(hidden)
        _refresh_domain_agents()
        logger.info(f"[registry] Hidden built-in domain: {domain_id}")
        return True

    raise ValueError(f"Domain '{domain_id}' does not exist")


def get_all_domain_details() -> List[Dict[str, Any]]:
    """Return full details for all *active* domains (for the frontend API).
    Dashboard is always first when present."""
    _refresh_domain_agents()
    result = []
    custom = _load_custom_domains()
    for did, cfg in DOMAIN_AGENTS.items():
        entry = {
            "domain_id": did,
            "name": cfg.get("name", did),
            "description": cfg.get("description", ""),
            "welcome_message": cfg.get("welcome_message", ""),
            "sample_questions": cfg.get("sample_questions", []),
            "icon": cfg.get("icon", "LayoutDashboard"),
            "custom": did in custom,
            "removable": did != "dashboard",
            "primary_sources": cfg.get("primary_sources", []),
        }
        result.append(entry)
    # Ensure Dashboard is first (default subagent)
    result.sort(key=lambda e: (0 if e["domain_id"] == "dashboard" else 1, e["domain_id"]))
    return result


def get_hidden_builtin_details() -> List[Dict[str, Any]]:
    """Return details for built-in domains that are currently hidden."""
    hidden = _load_hidden_builtins()
    result = []
    for did in sorted(hidden):
        cfg = _BUILTIN_AGENTS.get(did)
        if not cfg:
            continue
        result.append({
            "domain_id": did,
            "name": cfg.get("name", did),
            "description": cfg.get("description", ""),
            "icon": cfg.get("icon", "LayoutDashboard"),
        })
    return result


def restore_domain(domain_id: str) -> bool:
    """Un-hide a previously hidden built-in domain."""
    hidden = _load_hidden_builtins()
    if domain_id not in hidden:
        raise ValueError(f"Domain '{domain_id}' is not hidden")
    hidden.discard(domain_id)
    _save_hidden_builtins(hidden)
    _refresh_domain_agents()
    logger.info(f"[registry] Restored built-in domain: {domain_id}")
    return True
