"""Génère une chaîne CTE linéaire (chaque CTE dépend de la précédente) pour un profil catalogue.

Pipeline en deux phases LLM :
1. Plan structuré (noms snake_case, objectif de chaque étape, raisonnement court).
2. Un seul bloc SQL ``WITH`` respectant le plan et la contrainte de chaîne immédiate.

Le profil ``insurance_audit`` délègue à :func:`run_contrats_audit_cte_generation`.
"""

from __future__ import annotations

import json
import logging
import re
import time
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from flows.dto_cache_flow import format_selected_dto_schemas_for_prompt
from flows.report_cte_save_flow import (
    _extract_sql_fence,
    _validate_immediate_predecessor_chain,
    write_linear_cte_catalog,
)
from services.cte_graph.library_graph_cache import invalidate_cte_library_graph_caches
from services.cte_graph.library_loader import LibraryError, load_library

logger = logging.getLogger(__name__)

_PHASE1_SYSTEM = """\
Tu es un architecte analytique pour des pipelines SQL en CTE.

Réponds **exclusivement** avec un objet JSON (sans markdown, sans texte avant ou après).
Schéma attendu :
{
  "reasoning": "string — synthèse courte du périmètre et des sources",
  "ctes": [
    {"name": "nom_snake_case", "purpose": "rôle de cette étape dans la chaîne"}
  ]
}

Règles :
- ``ctes`` est une liste ordonnée : la première étape lit les données sources (tables, vues, read_parquet, etc.) ;
  chaque étape suivante affine ou transforme la précédente (conceptuellement une chaîne linéaire).
- Les ``name`` sont des identifiants SQL valides en snake_case, uniques.
"""

_PHASE2_SYSTEM_TEMPLATE = """\
Tu es un expert SQL ({dialect}). Tu génères **un seul** script avec une clause WITH.

Réponds avec **un unique** bloc markdown ```sql ... ``` et rien d'autre.

Contraintes obligatoires :
- Les CTE sont **exactement** celles du plan fourni, **dans le même ordre**, avec les **mêmes noms**.
- La **première** CTE accède aux sources décrites (tables / vues / fichiers parquet selon le dialecte).
- Chaque CTE suivante doit référencer **explicitement** dans son corps SQL la CTE **immédiatement précédente**
  (FROM ou JOIN sur son nom). Aucune saut dans la chaîne.
- Terminer par une CTE ou un SELECT final plausible (ex. ``SELECT 1 AS ok`` si aucune agrégation finale n'est requise).

Dialecte : {dialect}. Commentaires SQL en français (-- ...).
"""


def _strip_json_fence(text: str) -> str:
    raw = (text or "").strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.IGNORECASE)
        raw = re.sub(r"\s*```$", "", raw)
    return raw.strip()


def _parse_phase1(text: str) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    try:
        doc = json.loads(_strip_json_fence(text))
    except json.JSONDecodeError as e:
        return None, f"JSON phase 1 invalide : {e}"
    if not isinstance(doc, dict):
        return None, "phase 1 : document JSON attendu (objet)"
    ctes = doc.get("ctes")
    if not isinstance(ctes, list) or not ctes:
        return None, "phase 1 : clé 'ctes' requise (liste non vide)"
    for i, item in enumerate(ctes):
        if not isinstance(item, dict):
            return None, f"phase 1 : entrée ctes[{i}] invalide"
        name = (item.get("name") or "").strip()
        if not name or not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", name):
            return None, f"phase 1 : nom CTE invalide {name!r}"
    return doc, None


def _dialect_for_profile_folder(profile_id: str) -> str:
    if profile_id == "insurance_audit":
        return "postgres"
    return "duckdb"


def run_insurance_audit_branch() -> Dict[str, Any]:
    """Délègue à la génération contrats existante (table ``contrats``)."""
    from flows.report_cte_save_flow import run_contrats_audit_cte_generation

    t0 = time.perf_counter()
    r = run_contrats_audit_cte_generation()
    r["duration_ms"] = r.get("duration_ms") or round((time.perf_counter() - t0) * 1000.0, 1)
    r["phase1"] = None
    r["mode"] = "insurance_audit_contrats"
    lib_err = r.get("insurance_audit_library_error")
    cat_err = r.get("insurance_audit_catalog_validate_error")
    base_ok = bool(r.get("success"))
    r["success"] = base_ok and not lib_err and not cat_err
    if not r["success"]:
        r["error"] = (
            r.get("error")
            or lib_err
            or cat_err
            or "génération assurance incomplète"
        )
    r["chain_warning"] = r.get("insurance_audit_chain_warning")
    r["library"] = {
        "ok": bool(not lib_err),
        "cte_count": int(r.get("insurance_audit_cte_count") or 0),
        "error": lib_err,
    }
    return r


def run_generic_linear_chain(
    profile: Dict[str, Any],
    library_dir: Path,
    *,
    additional_instructions: str = "",
) -> Dict[str, Any]:
    """Deux appels LLM + écriture du catalogue sous *library_dir*."""
    from config import get_settings
    from llm.llm_factory import get_llm

    t0 = time.perf_counter()
    profile_id = str(profile.get("id") or "")
    dialect = _dialect_for_profile_folder(profile_id)
    settings = get_settings()
    client, _ = get_llm()
    cfg_mt = int(getattr(settings, "llm_max_tokens", 4096))
    mt = max(cfg_mt, 8192)

    stems = [s for s in (profile.get("dto_stems") or []) if isinstance(s, str) and s.strip()]
    dto_block = ""
    if stems:
        try:
            dto_block = format_selected_dto_schemas_for_prompt(stems)
        except Exception as e:  # noqa: BLE001
            logger.warning("DTO schema for profile %s: %s", profile_id, e)
            dto_block = ""

    lib_name = ""
    libs = profile.get("libraries") or []
    if isinstance(libs, list) and libs:
        lib_name = str(libs[0])

    user_phase1 = json.dumps(
        {
            "profile_id": profile_id,
            "library_folder": lib_name,
            "name": profile.get("name"),
            "description": profile.get("description"),
            "query_examples": profile.get("query_examples") or [],
            "additional_instructions": (additional_instructions or "").strip(),
            "dto_schema_excerpt": dto_block[:12000] if dto_block else "",
        },
        ensure_ascii=False,
    )

    out: Dict[str, Any] = {
        "success": False,
        "mode": "generic_linear_chain",
        "phase1": None,
        "phase1_error": None,
        "sql_phase2_error": None,
        "library": None,
        "chain_warning": None,
        "duration_ms": 0.0,
        "error": None,
    }

    try:
        r1 = client.chat.completions.create(
            model=settings.llm.model,
            messages=[
                {"role": "system", "content": _PHASE1_SYSTEM},
                {"role": "user", "content": user_phase1},
            ],
            temperature=0.2,
            max_tokens=min(2000, mt),
        )
        raw1 = (r1.choices[0].message.content or "").strip()
    except Exception as e:  # noqa: BLE001
        logger.exception("CTE chain phase 1 failed")
        out["error"] = str(e)
        out["duration_ms"] = round((time.perf_counter() - t0) * 1000.0, 1)
        return out

    plan, err = _parse_phase1(raw1)
    if err:
        out["phase1_error"] = err
        out["error"] = err
        out["duration_ms"] = round((time.perf_counter() - t0) * 1000.0, 1)
        return out

    out["phase1"] = plan

    phase2_user = (
        "Plan validé (respecter l'ordre et les noms) :\n"
        + json.dumps(plan, ensure_ascii=False, indent=2)
        + "\n\n"
        + (f"Instructions additionnelles :\n{additional_instructions.strip()}\n\n" if additional_instructions.strip() else "")
    )

    phase2_system = _PHASE2_SYSTEM_TEMPLATE.format(dialect=dialect)

    try:
        r2 = client.chat.completions.create(
            model=settings.llm.model,
            messages=[
                {"role": "system", "content": phase2_system},
                {"role": "user", "content": phase2_user},
            ],
            temperature=0.15,
            max_tokens=mt,
        )
        raw2 = (r2.choices[0].message.content or "").strip()
    except Exception as e:  # noqa: BLE001
        logger.exception("CTE chain phase 2 failed")
        out["error"] = str(e)
        out["duration_ms"] = round((time.perf_counter() - t0) * 1000.0, 1)
        return out

    sql_text = _extract_sql_fence(raw2)
    if not sql_text.strip():
        msg = "Réponse LLM phase 2 vide ou sans bloc SQL"
        out["sql_phase2_error"] = msg
        out["error"] = msg
        out["duration_ms"] = round((time.perf_counter() - t0) * 1000.0, 1)
        return out

    purposes: Dict[str, str] = {}
    for item in (plan.get("ctes") or []):
        if isinstance(item, dict) and item.get("name"):
            k = str(item["name"]).strip()
            purposes[k] = str(item.get("purpose") or "").strip() or f"Étape « {k} »."

    lib_result = write_linear_cte_catalog(
        sql_text,
        library_dir,
        dialect=dialect,
        descriptions=purposes if purposes else None,
    )

    out["library"] = lib_result

    if not lib_result.get("ok"):
        msg = lib_result.get("error") or "Échec écriture catalogue CTE"
        out["error"] = msg
        out["duration_ms"] = round((time.perf_counter() - t0) * 1000.0, 1)
        return out

    names = lib_result.get("cte_names") or []
    deps = lib_result.get("deps") or {}
    out["chain_warning"] = _validate_immediate_predecessor_chain(names, deps)
    if out["chain_warning"]:
        logger.warning("%s", out["chain_warning"])

    try:
        load_library(library_dir.parent, libraries=[profile_id])
    except LibraryError as e:
        out["error"] = f"Catalogue invalide après écriture : {e}"
        out["duration_ms"] = round((time.perf_counter() - t0) * 1000.0, 1)
        return out

    invalidate_cte_library_graph_caches()
    out["success"] = True
    out["duration_ms"] = round((time.perf_counter() - t0) * 1000.0, 1)
    return out


def run_profile_cte_chain_generation(
    profile: Dict[str, Any],
    library_dir: Path,
    *,
    additional_instructions: str = "",
) -> Dict[str, Any]:
    """Point d'entrée : branche assurance ou généricité."""
    pid = str(profile.get("id") or "")
    if pid == "insurance_audit":
        return run_insurance_audit_branch()
    return run_generic_linear_chain(
        profile,
        library_dir,
        additional_instructions=additional_instructions,
    )
