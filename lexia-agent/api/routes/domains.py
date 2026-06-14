"""
Domain (Subagent) Management API
==================================

CRUD endpoints for creating, listing, updating, and deleting
custom domain subagents. Each domain gets its own LLM persona,
prompt, and card pipeline.
"""

import threading
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from agents.domain.registry import (
    clear_prompt_override,
    create_domain,
    delete_domain,
    get_all_domain_details,
    get_domain_config,
    get_domain_prompts,
    get_hidden_builtin_details,
    list_domains,
    restore_domain,
    update_domain,
)
from monitoring.logger import get_logger

logger = get_logger(__name__)

router = APIRouter()


class CreateDomainRequest(BaseModel):
    name: str = Field(..., min_length=2, max_length=80, description="Display name")
    system_prompt: str = Field(..., min_length=10, max_length=8000, description="LLM persona / system prompt")
    code_prompt: str = Field("", max_length=8000, description="Extra context for code generation")
    primary_sources: List[str] = Field(default_factory=list, description="Data source IDs to use")
    description: str = Field("", max_length=500)
    welcome_message: str = Field("", max_length=500)
    sample_questions: List[str] = Field(default_factory=list, max_length=5)
    icon: str = Field("Bot", max_length=40, description="Lucide icon name")


class UpdateDomainRequest(BaseModel):
    name: Optional[str] = Field(None, min_length=2, max_length=80)
    system_prompt: Optional[str] = Field(None, min_length=10, max_length=8000)
    code_prompt: Optional[str] = Field(None, max_length=8000)
    primary_sources: Optional[List[str]] = None
    description: Optional[str] = Field(None, max_length=500)
    welcome_message: Optional[str] = Field(None, max_length=500)
    sample_questions: Optional[List[str]] = None
    icon: Optional[str] = Field(None, max_length=40)
    regenerate_cards: bool = Field(False, description="Trigger card regeneration after update")


@router.get("", summary="List all domains")
async def list_all_domains():
    """Return all active domains (built-in + custom) with metadata for the frontend."""
    domains = get_all_domain_details()
    return {"domains": domains, "count": len(domains)}


@router.get("/hidden/list", summary="List hidden built-in domains")
async def list_hidden():
    """Return built-in domains that the user has hidden."""
    hidden = get_hidden_builtin_details()
    return {"domains": hidden, "count": len(hidden)}


@router.get("/{domain_id}", summary="Get domain details")
async def get_domain(domain_id: str):
    """Return full config for a single domain, including system_prompt and code_prompt."""
    cfg = get_domain_config(domain_id)
    if not cfg:
        raise HTTPException(404, f"Unknown domain: {domain_id}")
    prompts = get_domain_prompts(domain_id)
    result = {"domain_id": domain_id, **cfg}
    if prompts:
        result["system_prompt"] = prompts["system"]
        result["code_prompt"] = prompts["code"]
    return result


@router.post("", summary="Create a custom subagent")
async def create_custom_domain(body: CreateDomainRequest, request: Request):
    """
    Create a new domain subagent with a custom prompt and persona.

    The domain ID is auto-generated from the name as a slug.
    Initial analysis cards are generated in the background automatically.
    """
    try:
        result = create_domain(
            name=body.name,
            system_prompt=body.system_prompt,
            code_prompt=body.code_prompt,
            primary_sources=body.primary_sources,
            description=body.description,
            welcome_message=body.welcome_message,
            sample_questions=body.sample_questions,
            icon=body.icon,
        )

        domain_id = result["domain_id"]

        orchestrator = getattr(request.app.state, "card_orchestrator", None)
        if orchestrator:
            def _generate_initial_cards():
                try:
                    logger.info(f"[domains] Generating initial cards for new domain '{domain_id}'...")
                    orchestrator.run_single_agent(domain_id)
                    logger.info(f"[domains] Initial cards ready for '{domain_id}'")
                except Exception as exc:
                    logger.error(f"[domains] Initial card generation failed for '{domain_id}': {exc}")

            t = threading.Thread(
                target=_generate_initial_cards,
                daemon=True,
                name=f"card-init-{domain_id}",
            )
            t.start()

        return {"status": "created", **result}
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.post("/{domain_id}/reset-prompts", summary="Reset built-in domain prompts to module default")
async def reset_domain_prompts(domain_id: str):
    """Clear prompt override for a built-in domain. Next prompts come from llm.prompts.domains.*."""
    try:
        clear_prompt_override(domain_id)
        prompts = get_domain_prompts(domain_id)
        return {"status": "reset", "domain_id": domain_id, "system_prompt": prompts.get("system", ""), "code_prompt": prompts.get("code", "")}
    except ValueError as e:
        raise HTTPException(404, str(e))


@router.post("/{domain_id}/restore", summary="Restore a hidden built-in domain")
async def restore_hidden_domain(domain_id: str):
    """Restore a previously hidden built-in domain."""
    try:
        restore_domain(domain_id)
        return {"status": "restored", "domain_id": domain_id}
    except ValueError as e:
        raise HTTPException(404, str(e))


@router.patch("/{domain_id}", summary="Update a custom subagent")
async def update_custom_domain(domain_id: str, body: UpdateDomainRequest, request: Request):
    """Update fields on a domain. Built-in domains: prompt overrides only.
    Set regenerate_cards=true to trigger card regeneration after the update."""
    regen = body.regenerate_cards
    updates = body.model_dump(exclude_none=True)
    updates.pop("regenerate_cards", None)
    if not updates:
        raise HTTPException(400, "No fields to update")
    try:
        result = update_domain(domain_id, **updates)

        if regen:
            orchestrator = getattr(request.app.state, "card_orchestrator", None)
            if orchestrator:
                def _regen():
                    try:
                        logger.info(f"[domains] Regenerating cards for '{domain_id}' after prompt update...")
                        orchestrator.run_single_agent(domain_id)
                        logger.info(f"[domains] Cards regenerated for '{domain_id}'")
                    except Exception as exc:
                        logger.error(f"[domains] Card regeneration failed for '{domain_id}': {exc}")

                t = threading.Thread(target=_regen, daemon=True, name=f"card-regen-{domain_id}")
                t.start()

        return {"status": "updated", "cards_regenerating": regen, **result}
    except ValueError as e:
        raise HTTPException(404, str(e))


class RefinePromptRequest(BaseModel):
    current_prompt: str = Field("", max_length=8000, description="Current system prompt (can be empty for new)")
    user_instruction: str = Field(..., min_length=2, max_length=2000, description="What the user wants the agent to do")
    domain_id: Optional[str] = Field(None, description="Domain ID for context (optional)")


@router.post("/refine-prompt", summary="AI-assisted prompt refinement")
async def refine_prompt(body: RefinePromptRequest):
    """Use an LLM to generate or refine a system prompt based on user instructions.

    If current_prompt is empty, generates a new prompt from scratch.
    If provided, refines the existing prompt according to user_instruction.
    """
    from llm.llm_factory import create_client_for_task

    try:
        llm = create_client_for_task("agent")
    except Exception:
        from llm.llm_factory import create_llm_client
        llm = create_llm_client(provider="groq")

    # Build context about available data
    schema_hint = ""
    try:
        from flows.agent_flow import _ensure_dto_cache, _list_parquet_files
        from pathlib import Path
        from config import get_settings
        settings = get_settings()
        parquet_dir = Path(getattr(settings, "parquet_cache_dir", None) or "data/parquet")
        schema = _ensure_dto_cache(parquet_dir)
        stems = _list_parquet_files(parquet_dir)
        schema_hint = f"\n\nDonnées disponibles (tables parquet):\n{', '.join(stems[:30])}\n\nSchéma (extrait):\n{schema[:3000]}"
    except Exception:
        pass

    system = f"""Tu es un expert en ingénierie de prompts pour des sous-agents analytiques.
Ton rôle est de générer ou améliorer un system prompt pour un sous-agent de dashboard.

Le sous-agent sera utilisé pour:
- Générer des KPIs (indicateurs clés) sous forme de cartes
- Créer des analyses avec graphiques (ECharts)
- Répondre à des questions métier sur les données

Le prompt doit être en français, précis, et inclure:
1. Le rôle et l'expertise du sous-agent
2. Les types d'analyses et KPIs à produire
3. Les sources de données à utiliser
4. Le format de sortie attendu (KPI cards, analyses markdown, graphiques)
5. Les règles métier spécifiques si mentionnées

Génère UNIQUEMENT le system prompt, sans explication ni commentaire.{schema_hint}"""

    if body.current_prompt.strip():
        user_msg = f"""Voici le prompt actuel du sous-agent:

---
{body.current_prompt}
---

L'utilisateur demande la modification suivante:
{body.user_instruction}

Génère le prompt amélioré complet (pas juste la modification)."""
    else:
        user_msg = f"""L'utilisateur veut créer un sous-agent avec les instructions suivantes:

{body.user_instruction}

Génère un system prompt complet et professionnel pour ce sous-agent."""

    try:
        resp = llm.generate(prompt=user_msg, system=system)
        return {"prompt": resp.content.strip(), "model": resp.model}
    except Exception as exc:
        raise HTTPException(500, f"LLM error: {exc}")


@router.delete("/{domain_id}", summary="Delete / hide a subagent")
async def delete_or_hide_domain(domain_id: str):
    """Remove a custom domain or hide a built-in one (except Dashboard)."""
    try:
        delete_domain(domain_id)
        return {"status": "deleted", "domain_id": domain_id}
    except ValueError as e:
        raise HTTPException(404, str(e))
