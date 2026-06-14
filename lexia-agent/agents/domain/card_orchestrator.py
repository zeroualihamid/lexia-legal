"""
Card Orchestrator
==================

Runs all 8 domain subagents in parallel to generate analysis cards.
Each agent loads its domain data, calls the LLM to produce KPI + analysis
cards, then persists results to ``data/subagents/{domain}/cards.json``.

Custom cards (create + regenerate) use the same ``run_agent_flow`` pipeline
as the scheduled refresh — DTO cache, query augmentation, embedding column
resolution, and tool-calling agent loop — to guarantee real SQL against the
correct parquet files.
"""

import importlib
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml
from openai import APIConnectionError as OpenAIConnectionError

from agents.domain.card_models import DomainCard
from agents.domain.card_store import (
    replace_auto_cards,
    save_status,
    load_status,
    add_card,
)
from agents.domain.registry import DOMAIN_AGENTS, _refresh_domain_agents, get_domain_prompts
from llm.prompts.domains.card_generation import (
    CARD_SYSTEM_PROMPT,
    build_card_format_prompt,
)
from skill_registry import load_skill_definitions, build_selected_skills_context
from monitoring.logger import get_logger

logger = get_logger(__name__)

_MAX_WORKERS = 8


class CardOrchestrator:
    """Coordinates card generation across all domain subagents."""

    def __init__(self, config=None, connector_manager=None):
        self._config = config
        self._connector_manager = connector_manager
        self._schemas: Dict[str, Any] = {}
        self._metadata: Dict[str, Any] = {}
        self._is_running = False

    # ── Public API ────────────────────────────────────────────────────────

    def run_all_agents(self) -> Dict[str, bool]:
        """Spawn all domain agents in parallel.  Returns {domain: success}."""
        if self._is_running:
            logger.warning("[orchestrator] Already running, skipping duplicate call")
            return {}

        self._is_running = True
        _refresh_domain_agents()
        self._preload_schemas()
        results: Dict[str, bool] = {}

        try:
            domains_to_run = list(DOMAIN_AGENTS.keys())
            with ThreadPoolExecutor(max_workers=_MAX_WORKERS) as pool:
                futures = {
                    pool.submit(self._run_single, domain_id): domain_id
                    for domain_id in domains_to_run
                }
                for future in as_completed(futures):
                    domain_id = futures[future]
                    try:
                        future.result()
                        results[domain_id] = True
                    except Exception as e:
                        logger.error(
                            f"[orchestrator] {domain_id} failed: {e}\n{traceback.format_exc()}"
                        )
                        results[domain_id] = False
                        save_status(
                            domain_id,
                            is_running=False,
                            error=str(e),
                            last_refresh=datetime.now(timezone.utc).isoformat(),
                        )
        finally:
            self._is_running = False

        successes = sum(1 for v in results.values() if v)
        logger.info(f"[orchestrator] Completed: {successes}/{len(results)} domains succeeded")
        return results

    def run_single_agent(self, domain_id: str) -> bool:
        """Run card generation for a single domain."""
        self._preload_schemas()
        try:
            self._run_single(domain_id)
            return True
        except Exception as e:
            logger.error(f"[orchestrator] {domain_id} failed: {e}", exc_info=True)
            save_status(
                domain_id,
                is_running=False,
                error=str(e),
                last_refresh=datetime.now(timezone.utc).isoformat(),
            )
            return False

    def create_custom_card(
        self,
        domain_id: str,
        user_request: str,
        card_type: str = "analysis",
    ) -> Optional[DomainCard]:
        """Create a single card using two-phase pipeline: code execution then formatting."""
        _refresh_domain_agents()
        self._preload_schemas()
        domain_cfg = DOMAIN_AGENTS.get(domain_id)
        if not domain_cfg:
            return None

        try:
            card = self._single_card_via_agent_flow(
                domain_id, domain_cfg, user_request, card_type
            )
            if card:
                card.prompt = user_request
                add_card(domain_id, card)
            return card
        except Exception as e:
            logger.error(f"[orchestrator] custom card for {domain_id} failed: {e}", exc_info=True)
            return None

    def regenerate_card(
        self,
        domain_id: str,
        card_id: str,
        new_prompt: str,
    ) -> Optional[DomainCard]:
        """Regenerate a single card using two-phase pipeline, replacing the original."""
        from agents.domain.card_store import load_cards, save_cards

        _refresh_domain_agents()
        self._preload_schemas()
        domain_cfg = DOMAIN_AGENTS.get(domain_id)
        if not domain_cfg:
            return None

        cards = load_cards(domain_id)
        old_card = next((c for c in cards if c.card_id == card_id), None)
        if not old_card:
            return None

        try:
            new_card = self._single_card_via_agent_flow(
                domain_id, domain_cfg, new_prompt, old_card.card_type
            )
            if not new_card:
                return None

            new_card.card_id = old_card.card_id
            new_card.order = old_card.order
            new_card.pinned = old_card.pinned
            new_card.created_at = old_card.created_at
            new_card.prompt = new_prompt

            cards = [new_card if c.card_id == card_id else c for c in cards]
            save_cards(domain_id, cards)
            return new_card
        except Exception as e:
            logger.error(f"[orchestrator] regenerate card {card_id} failed: {e}", exc_info=True)
            return None

    # ── Single-card pipeline (uses agent_flow) ─────────────────────────────

    def _single_card_via_agent_flow(
        self,
        domain_id: str,
        domain_cfg: Dict[str, Any],
        user_request: str,
        card_type: str,
    ) -> Optional[DomainCard]:
        """Generate one card using the **exact same pipeline as the /chat endpoint**.

        Two-step approach — guarantees parity with the main chat agent:

        1. ``run_agent_flow(query=user_request)`` — identical to ``/chat``:
           no domain prompt injection, no YAML format wrapper, so query
           augmentation + plan decomposition stay focused on the user's
           real question (avoids spurious filters like ``RAISOCIN = '...'``
           that an overloaded prompt would introduce).
        2. A short LLM formatting pass converts the rich analysis markdown
           returned by the agent into a single-card YAML.

        Falls back to the stats-only pass + a minimal card if both steps fail.
        """
        from flows.agent_flow import run_agent_flow
        from nodes.memory.memory_store import MemoryStore

        domain_name = domain_cfg.get("name", domain_id)
        session_id = f"card-{domain_id}-{uuid.uuid4().hex[:8]}"
        agent_response = ""

        try:
            memory_store = MemoryStore(persist_dir="data/memory")

            logger.info(
                f"[orchestrator] Single-card agent flow for {domain_id} "
                f"(type={card_type}, session={session_id})"
            )

            shared = run_agent_flow(
                query=user_request,
                session_id=session_id,
                max_iterations=10,
                memory_store=memory_store,
                connector_manager=self._connector_manager,
            )

            agent_response = shared.get("final_response", "") or ""
            logger.info(
                f"[orchestrator] Single-card flow for {domain_id} completed: "
                f"{shared.get('agent_iteration', 0)} iterations, "
                f"{len(agent_response)} chars response"
            )
        except Exception as exc:
            logger.error(
                f"[orchestrator] Single-card agent flow failed for {domain_id}: {exc}",
                exc_info=True,
            )

        card: Optional[DomainCard] = None

        # ── Step 2: Convert the chat-style analysis into a single-card YAML ─────
        if agent_response.strip():
            try:
                format_prompt = self._build_analysis_to_card_prompt(
                    domain_name=domain_name,
                    user_request=user_request,
                    card_type=card_type,
                    analysis_markdown=agent_response,
                )
                yaml_raw = self._llm_generate_with_fallback(
                    format_prompt, CARD_SYSTEM_PROMPT, "card_generation"
                )
                card = self._parse_single_card(yaml_raw, domain_id)
                if not card:
                    logger.info(
                        f"[orchestrator] First YAML parse failed — retrying formatting pass"
                    )
                    yaml_raw = self._llm_generate_with_fallback(
                        format_prompt, CARD_SYSTEM_PROMPT, "card_generation"
                    )
                    card = self._parse_single_card(yaml_raw, domain_id)
            except Exception as exc:
                logger.warning(f"[orchestrator] Formatting pass failed: {exc}")

        # Safety net: legacy stats-only pass (no SQL, LLM-only)
        if not card:
            logger.warning(
                f"[orchestrator] Falling back to stats-only card for {domain_id}"
            )
            card = self._fallback_stats_card(domain_id, domain_cfg, user_request, card_type)

        # Minimal card so the user always sees *something* for their prompt.
        # For analysis cards, preserve the full chat-style markdown — this is
        # exactly what the /chat endpoint would show.
        if not card:
            logger.warning(
                f"[orchestrator] All strategies exhausted — creating minimal card from response"
            )
            title = user_request[:60] + ("..." if len(user_request) > 60 else "")
            markdown = (agent_response or "_Aucune donnée disponible._").strip()
            card = DomainCard.new_analysis(
                domain=domain_id,
                title=title,
                markdown=markdown,
                source="user",
                prompt=user_request,
            )

        return card

    def _build_analysis_to_card_prompt(
        self,
        *,
        domain_name: str,
        user_request: str,
        card_type: str,
        analysis_markdown: str,
    ) -> str:
        """Convert an agent-produced analysis (markdown) into a single-card YAML.

        This is a pure formatting step — the LLM does NOT touch data, it only
        re-packages the numbers the agent already computed into the YAML shape
        that :meth:`_parse_single_card` understands.
        """
        card_type = (card_type or "analysis").lower()
        if card_type not in ("kpi", "analysis"):
            card_type = "analysis"

        if card_type == "kpi":
            yaml_shape = (
                "```yaml\n"
                "card_type: \"kpi\"\n"
                "title: \"Titre court de l'indicateur\"\n"
                "value: \"1 234 567,89 MAD\"       # valeur principale\n"
                "delta: \"+12,34 %\"                # variation — avec signe\n"
                "delta_direction: \"up\"            # up | down | neutral\n"
                "color: \"green\"                   # green | red | blue | orange | purple | accent\n"
                "label: \"vs période précédente\"   # légende sous la valeur\n"
                "prompt: \"Description métier de la carte\"\n"
                "```"
            )
            shape_hint = (
                "Extrait les UNE valeur principale et sa variation depuis l'analyse. "
                "Si l'analyse contient plusieurs périodes, prends la dernière et compare "
                "à la précédente."
            )
        else:
            yaml_shape = (
                "```yaml\n"
                "card_type: \"analysis\"\n"
                "title: \"Titre de l'analyse\"\n"
                "tag: \"ASSURANCE\"                 # étiquette métier courte\n"
                "tag_type: \"g\"                    # f | m | g | gr | r | p\n"
                "prompt: \"Description de l'analyse\"\n"
                "markdown: |\n"
                "  Reproduis ICI l'analyse complète, tableaux compris.\n"
                "```"
            )
            shape_hint = (
                "Reproduis l'analyse COMPLÈTE dans le champ `markdown` — tableaux, "
                "listes, commentaires et chiffres inclus, tels quels. Ne raccourcis pas."
            )

        return (
            f"Tu reformattes la réponse produite par l'agent analytique « {domain_name} » "
            f"à la demande utilisateur « {user_request} ».\n\n"
            f"ANALYSE SOURCE (markdown complet) :\n---\n{analysis_markdown}\n---\n\n"
            f"MISSION : produire UNE seule carte de tableau de bord de type « {card_type} » "
            f"qui reprend fidèlement les chiffres de l'analyse ci-dessus.\n\n"
            f"{shape_hint}\n\n"
            "FORMAT DE RÉPONSE OBLIGATOIRE — un seul bloc ```yaml :\n\n"
            f"{yaml_shape}\n\n"
            "RÈGLES :\n"
            "- Utilise UNIQUEMENT les chiffres présents dans l'analyse — NE FABRIQUE RIEN.\n"
            "- N'expose JAMAIS de SQL ni de codes internes seuls (CODEPROD, CODECATE, "
            "  CODEBRAN, …). Pour les dimensions, utilise les libellés : LIBEPROD, LIBECATE, "
            "  LIBEBRAN, ou formulations métier (« produit », « catégorie », « branche »), "
            "  jamais une colonne de code comme titre de ligne dans un tableau.\n"
            "- Devise : MAD. Jamais €, EUR ou autre.\n"
            "- Format numérique français : espace séparateur de milliers, virgule décimale, "
            "  2 décimales. Ex : 1 234 567,89 MAD. Pourcentages : 12,34 %.\n"
            "- Ne retourne RIEN hors du bloc ```yaml."
        )

    def _fallback_stats_card(
        self,
        domain_id: str,
        domain_cfg: Dict[str, Any],
        user_request: str,
        card_type: str,
    ) -> Optional[DomainCard]:
        """Fallback: use the old stats-only approach when code execution fails."""
        from llm.prompts.domains.card_generation import (
            CARD_SYSTEM_PROMPT,
            build_custom_card_prompt,
        )

        prompts = get_domain_prompts(domain_id) or {"system": "", "code": ""}
        schemas_desc = self._build_schemas_description(domain_cfg["primary_sources"])
        data_summary = self._build_data_summary(domain_cfg["primary_sources"])

        prompt = build_custom_card_prompt(
            domain_name=domain_cfg["name"],
            domain_system_prompt=prompts["system"],
            user_request=user_request,
            data_summary=data_summary,
            schemas_description=schemas_desc,
            card_type=card_type,
        )

        raw = self._llm_generate_with_fallback(prompt, CARD_SYSTEM_PROMPT, "card_generation")
        return self._parse_single_card(raw, domain_id)

    @property
    def is_running(self) -> bool:
        return self._is_running

    # ── Internal ──────────────────────────────────────────────────────────

    def _preload_schemas(self) -> None:
        """Load schemas and metadata from datasources.yaml + data_sources (same logic as SchemaLoaderNode)."""
        if self._metadata:
            return
        try:
            config_path = Path(__file__).resolve().parents[2] / "config" / "datasources.yaml"
            if not config_path.exists():
                logger.warning("[orchestrator] datasources.yaml not found")
                return
            with open(config_path, "r", encoding="utf-8") as f:
                cfg = yaml.safe_load(f)

            datasources = list(cfg.get("datasources", []))
            data_sources = cfg.get("data_sources", [])

            # Synthesize from data_sources (tables) not already in datasources — same as SchemaLoaderNode
            mirrored_ids = {ds.get("source_id") for ds in datasources if ds.get("source_id")}
            for source in data_sources:
                for table in source.get("tables", []):
                    if not table.get("enabled", True):
                        continue
                    tid = table.get("table_id") or table.get("table_name")
                    if not tid or tid in mirrored_ids:
                        continue
                    cache_file = table.get("cache_file")
                    if not cache_file:
                        continue
                    path = cache_file if str(cache_file).startswith("data/") else f"data/{cache_file}"
                    embeddings_file = table.get("embeddings_file")
                    embeddings_path = (
                        embeddings_file if embeddings_file and str(embeddings_file).startswith("data/")
                        else (f"data/{embeddings_file}" if embeddings_file else None)
                    )
                    synthesized = {
                        "source_id": tid,
                        "path": path,
                        "description": table.get("description", ""),
                        "business_context": table.get("business_context", ""),
                    }
                    datasources.append({**synthesized, "columns_class": table.get("columns_class"), "enabled": True})
                    mirrored_ids.add(tid)

            for ds in datasources:
                sid = ds.get("source_id")
                if not sid or not ds.get("enabled", True):
                    continue
                self._metadata[sid] = {
                    "path": ds.get("path", ""),
                    "description": ds.get("description", ""),
                    "business_context": ds.get("business_context", ""),
                }
                columns_class_ref = ds.get("columns_class")
                if columns_class_ref and ":" in columns_class_ref:
                    try:
                        mod_path, func_name = columns_class_ref.split(":")
                        mod = importlib.import_module(mod_path)
                        self._schemas[sid] = getattr(mod, func_name)()
                    except Exception as e:
                        logger.debug(f"[orchestrator] Could not load schema for {sid}: {e}")
            logger.info(f"[orchestrator] Preloaded {len(self._metadata)} datasources, {len(self._schemas)} schemas")
        except Exception as e:
            logger.error(f"[orchestrator] Schema preload failed: {e}")

    def _run_single(self, domain_id: str) -> None:
        """Generate cards for one domain using the agent flow pipeline.

        This uses the same infrastructure as the /chat endpoint:
        1. DTO cache warm-up → full parquet schema
        2. Query augmentation → clearer query
        3. Embedding column search → exact categorical values
        4. Agent loop with tools (sql_query, etc.) → real SQL execution
        5. Final response formatted as card YAML → parsed into DomainCard objects
        """
        _refresh_domain_agents()
        domain_cfg = DOMAIN_AGENTS[domain_id]
        logger.info(f"[orchestrator] Generating cards for {domain_id} ({domain_cfg['name']}) via agent flow")

        save_status(domain_id, is_running=True, error=None)

        prompts = get_domain_prompts(domain_id) or {"system": "", "code": ""}
        domain_system_prompt = prompts.get("system", "")

        # Build the query that the agent will execute — instructs it to produce cards
        card_query = self._build_card_generation_query(domain_cfg["name"], domain_system_prompt)

        try:
            from flows.agent_flow import run_agent_flow
            from nodes.memory.memory_store import MemoryStore

            memory_store = MemoryStore(persist_dir="data/memory")

            # Run the full agent flow — it will use sql_query tool to get real data
            shared = run_agent_flow(
                query=card_query,
                session_id=f"cards-{domain_id}",
                max_iterations=10,
                memory_store=memory_store,
                connector_manager=self._connector_manager,
            )

            raw_response = shared.get("final_response", "")
            logger.info(
                f"[orchestrator] Agent flow for {domain_id} completed: "
                f"{shared.get('agent_iteration', 0)} iterations, "
                f"{len(raw_response)} chars response"
            )

            # Try to parse response as card YAML
            cards = self._parse_cards(raw_response, domain_id)

            # If agent didn't produce parseable YAML, do a formatting pass
            if not cards and raw_response.strip():
                logger.info(f"[orchestrator] Agent response not YAML — running formatting pass")
                cards = self._format_response_as_cards(
                    domain_id, domain_cfg["name"], domain_system_prompt, raw_response,
                )

            if not cards:
                logger.warning(f"[orchestrator] No cards produced for {domain_id}, falling back to legacy")
                cards = self._run_single_legacy(domain_id, domain_cfg)

            replace_auto_cards(domain_id, cards)

            save_status(
                domain_id,
                is_running=False,
                error=None,
                last_refresh=datetime.now(timezone.utc).isoformat(),
                card_count=len(cards),
            )
            logger.info(f"[orchestrator] {domain_id}: {len(cards)} cards generated via agent flow")

        except Exception as exc:
            logger.error(f"[orchestrator] Agent flow failed for {domain_id}: {exc}", exc_info=True)
            # Fallback to legacy approach
            logger.info(f"[orchestrator] Falling back to legacy card generation for {domain_id}")
            try:
                cards = self._run_single_legacy(domain_id, domain_cfg)
                replace_auto_cards(domain_id, cards)
                save_status(
                    domain_id,
                    is_running=False,
                    error=None,
                    last_refresh=datetime.now(timezone.utc).isoformat(),
                    card_count=len(cards),
                )
            except Exception as fallback_exc:
                save_status(
                    domain_id,
                    is_running=False,
                    error=str(fallback_exc),
                    last_refresh=datetime.now(timezone.utc).isoformat(),
                )
                raise

    def _build_card_generation_query(self, domain_name: str, domain_system_prompt: str) -> str:
        """Build the user query that instructs the agent to produce dashboard cards."""
        return (
            f"Tu es le sous-agent « {domain_name} ».\n"
            f"{domain_system_prompt}\n\n"
            "MISSION : Analyse les données disponibles en exécutant des requêtes SQL "
            "(utilise l'outil sql_query) pour produire un tableau de bord complet.\n\n"
            "ÉTAPES :\n"
            "1. Utilise `list_tables` pour découvrir les tables disponibles\n"
            "2. Utilise `describe_table` pour comprendre les colonnes\n"
            "3. Exécute des requêtes SQL (sql_query) pour calculer les KPIs et métriques clés\n"
            "4. Produis ta réponse finale au format YAML ci-dessous\n\n"
            "FORMAT DE RÉPONSE OBLIGATOIRE — un seul bloc ```yaml :\n\n"
            "```yaml\n"
            "kpi_cards:\n"
            "  - title: \"Titre du KPI\"\n"
            "    value: \"1 234 567 MAD\"\n"
            "    delta: \"+12.3%\"\n"
            "    delta_direction: \"up\"\n"
            "    color: \"green\"\n"
            "    label: \"vs période précédente\"\n"
            "    prompt: \"Description de ce que la carte affiche\"\n"
            "\n"
            "analysis_cards:\n"
            "  - title: \"Titre de l'analyse\"\n"
            "    tag: \"ASSURANCE\"\n"
            "    tag_type: \"g\"\n"
            "    prompt: \"Description de l'analyse\"\n"
            "    markdown: |\n"
            "      **Constat** : ...\n"
            "      - Point clé 1\n"
            "      - Point clé 2\n"
            "```\n\n"
            "RÈGLES :\n"
            "- Produis 4-6 kpi_cards avec des VRAIES valeurs issues de tes requêtes SQL\n"
            "- Produis 2-3 analysis_cards avec des insights basés sur les données réelles\n"
            "- Montants en MAD avec espace milliers\n"
            "- Textes en français\n"
            "- colors: green, red, blue, orange, purple, accent\n"
            "- delta_direction: up, down, neutral\n"
            "- tag_type: f (bleu), m (orange), g (accent), gr (vert), r (rouge), p (violet)\n"
            "- NE FABRIQUE PAS de chiffres — utilise UNIQUEMENT les résultats SQL"
        )

    def _format_response_as_cards(
        self,
        domain_id: str,
        domain_name: str,
        domain_system_prompt: str,
        agent_response: str,
    ) -> List[DomainCard]:
        """Take the agent's text response and format it as card YAML via a second LLM call."""
        from llm.prompts.domains.card_generation import CARD_SYSTEM_PROMPT

        format_prompt = (
            f"Le sous-agent « {domain_name} » a produit l'analyse suivante basée sur "
            f"des requêtes SQL réelles :\n\n"
            f"---\n{agent_response[:6000]}\n---\n\n"
            "Transforme cette analyse en fiches structurées YAML.\n"
            "Produis EXACTEMENT un bloc ```yaml avec:\n"
            "- 4-6 kpi_cards (extraits des chiffres réels ci-dessus)\n"
            "- 2-3 analysis_cards (insights basés sur les données ci-dessus)\n\n"
            "Format:\n"
            "```yaml\n"
            "kpi_cards:\n"
            "  - title: \"...\"\n    value: \"...\"\n    delta: \"...\"\n"
            "    delta_direction: \"up\"\n    color: \"green\"\n"
            "    label: \"...\"\n    prompt: \"...\"\n"
            "analysis_cards:\n"
            "  - title: \"...\"\n    tag: \"...\"\n    tag_type: \"g\"\n"
            "    prompt: \"...\"\n    markdown: |\n      ...\n"
            "```\n"
            "UTILISE UNIQUEMENT les chiffres de l'analyse ci-dessus. Ne fabrique rien."
        )

        raw = self._llm_generate_with_fallback(format_prompt, CARD_SYSTEM_PROMPT, "card_generation")
        return self._parse_cards(raw, domain_id)

    def _run_single_legacy(self, domain_id: str, domain_cfg: Dict[str, Any]) -> List[DomainCard]:
        """Legacy card generation: LLM-only with data summary (no SQL execution)."""
        prompts = get_domain_prompts(domain_id) or {"system": "", "code": ""}
        schemas_desc = self._build_schemas_description(domain_cfg["primary_sources"])
        data_summary = self._build_data_summary(domain_cfg["primary_sources"])

        from llm.prompts.domains.card_generation import (
            CARD_SYSTEM_PROMPT,
            build_card_generation_prompt,
        )

        prompt = build_card_generation_prompt(
            domain_name=domain_cfg["name"],
            domain_system_prompt=prompts["system"],
            data_summary=data_summary,
            schemas_description=schemas_desc,
        )

        system_prompt = CARD_SYSTEM_PROMPT
        skills = load_skill_definitions()
        if skills:
            skills_ctx = build_selected_skills_context(skills, include_full_content=True)
            system_prompt = f"{system_prompt}\n\n## Expertise métier (skills)\n\n{skills_ctx}"

        raw = self._llm_generate_with_fallback(prompt, system_prompt, "card_generation")
        return self._parse_cards(raw, domain_id)

    # ── LLM helper with connection fallback ──────────────────────────────

    def _llm_generate_with_fallback(
        self,
        prompt: str,
        system: str,
        task_type: str = "card_generation",
    ) -> str:
        """
        Call LLM via create_client_for_task.
        On connection error (unreachable base_url → openai.APIConnectionError),
        fall back to Groq.
        """
        from llm.llm_factory import create_client_for_task, create_llm_client

        client = create_client_for_task(task_type, config=self._config)
        try:
            response = client.generate(prompt, system=system)
            return response.content if hasattr(response, "content") else str(response)
        except (OpenAIConnectionError, Exception) as exc:
            if not isinstance(exc, OpenAIConnectionError) and "onnect" not in str(exc):
                raise
            logger.warning(
                f"[orchestrator] Primary LLM unreachable ({exc}), falling back to Groq"
            )
            fallback = create_llm_client(config=self._config, provider="groq")
            response = fallback.generate(prompt, system=system)
            return response.content if hasattr(response, "content") else str(response)

    # ── Helpers ───────────────────────────────────────────────────────────

    def _build_schemas_description(self, source_ids: List[str]) -> str:
        parts: List[str] = []
        for sid in source_ids:
            info = self._metadata.get(sid, {})
            lines = [f"  {sid}:"]
            if info.get("path"):
                lines.append(f"    path: {info['path']}")
            if info.get("description"):
                lines.append(f"    description: {info['description']}")
            if info.get("business_context"):
                lines.append(f"    context: {info['business_context']}")
            schema_obj = self._schemas.get(sid)
            if schema_obj:
                columns = getattr(schema_obj, "columns", None)
                if columns:
                    lines.append("    columns:")
                    for c in columns:
                        name = getattr(c, "column_name", getattr(c, "name", str(c)))
                        typ = getattr(c, "type", getattr(c, "data_type", "?"))
                        desc = getattr(c, "description", "")
                        if desc:
                            lines.append(f"      - {name} ({typ}): {desc}")
                        else:
                            lines.append(f"      - {name} ({typ})")
            parts.append("\n".join(lines))
        return "\n".join(parts) if parts else "(aucun schéma disponible)"

    def _build_data_summary(self, source_ids: List[str]) -> str:
        """Build a statistical summary by reading cached parquet files."""
        try:
            import pandas as pd
        except ImportError:
            return "(pandas non disponible)"

        summaries: List[str] = []
        for sid in source_ids:
            info = self._metadata.get(sid, {})
            path = info.get("path", "")
            if not path or not Path(path).exists():
                summaries.append(f"{sid}: fichier non trouvé ({path})")
                continue
            try:
                # Compute the summary with DuckDB aggregates rather than loading
                # the whole parquet into pandas — a full read of a large cache
                # (e.g. 8.4M rows × 100+ cols) spikes memory past the container
                # limit. DuckDB streams these aggregates with bounded memory.
                import duckdb
                rel = f"read_parquet('{Path(path).as_posix()}')"
                con = duckdb.connect(database=":memory:")
                try:
                    schema = con.execute(f"DESCRIBE SELECT * FROM {rel}").fetchall()
                    col_names = [r[0] for r in schema]
                    n_rows = con.execute(f"SELECT COUNT(*) FROM {rel}").fetchone()[0]
                    lines = [f"{sid} ({n_rows} lignes, {len(col_names)} colonnes):"]
                    _NUM = ("INT", "DECIMAL", "DOUBLE", "FLOAT", "BIGINT", "HUGEINT", "REAL", "NUMERIC")
                    numeric_cols = [r[0] for r in schema if any(t in str(r[1]).upper() for t in _NUM)]
                    for col in numeric_cols[:6]:
                        mn, mx, avg, cnt = con.execute(
                            f'SELECT min("{col}"), max("{col}"), avg("{col}"), count("{col}") FROM {rel}'
                        ).fetchone()
                        mean_s = round(avg, 2) if avg is not None else "?"
                        lines.append(f"  {col}: min={mn}, max={mx}, mean={mean_s}, count={cnt}")
                    date_cols = [r[0] for r in schema if any(t in str(r[1]).upper() for t in ("DATE", "TIMESTAMP"))]
                    for col in date_cols[:2]:
                        mn, mx = con.execute(f'SELECT min("{col}"), max("{col}") FROM {rel}').fetchone()
                        lines.append(f"  {col}: {mn} → {mx}")
                    summaries.append("\n".join(lines))
                finally:
                    con.close()
            except Exception as e:
                summaries.append(f"{sid}: erreur de lecture ({e})")
        return "\n\n".join(summaries) if summaries else "(aucune donnée disponible)"

    # ── YAML Parsing ──────────────────────────────────────────────────────

    def _parse_cards(self, raw_text: str, domain: str) -> List[DomainCard]:
        yaml_str = self._extract_yaml(raw_text)
        if not yaml_str:
            logger.warning(f"[orchestrator] No YAML block found for {domain}")
            return []
        try:
            data = yaml.safe_load(yaml_str)
        except yaml.YAMLError as e:
            logger.error(f"[orchestrator] YAML parse error for {domain}: {e}")
            return []

        cards: List[DomainCard] = []

        for i, kpi in enumerate(data.get("kpi_cards") or []):
            cards.append(
                DomainCard.new_kpi(
                    domain=domain,
                    title=kpi.get("title", "KPI"),
                    value=str(kpi.get("value", "")),
                    delta=str(kpi.get("delta", "")),
                    delta_direction=kpi.get("delta_direction", "neutral"),
                    color=kpi.get("color", "accent"),
                    label=kpi.get("label", ""),
                    order=i,
                    prompt=kpi.get("prompt", ""),
                )
            )

        kpi_count = len(cards)
        for i, analysis in enumerate(data.get("analysis_cards") or []):
            cards.append(
                DomainCard.new_analysis(
                    domain=domain,
                    title=analysis.get("title", "Analyse"),
                    markdown=analysis.get("markdown", ""),
                    tag=analysis.get("tag", ""),
                    tag_type=analysis.get("tag_type", "g"),
                    order=kpi_count + i,
                    prompt=analysis.get("prompt", ""),
                )
            )

        return cards

    def _parse_single_card(self, raw_text: str, domain: str) -> Optional[DomainCard]:
        yaml_str = self._extract_yaml(raw_text)
        if not yaml_str:
            return None
        try:
            data = yaml.safe_load(yaml_str)
        except yaml.YAMLError:
            return None
        if not isinstance(data, dict):
            return None

        card_type = data.get("card_type", "kpi")
        card_prompt = data.get("prompt", "")
        if card_type == "kpi":
            return DomainCard.new_kpi(
                domain=domain,
                title=data.get("title", "KPI"),
                value=str(data.get("value", "")),
                delta=str(data.get("delta", "")),
                delta_direction=data.get("delta_direction", "neutral"),
                color=data.get("color", "accent"),
                label=data.get("label", ""),
                source="user",
                prompt=card_prompt,
            )
        else:
            return DomainCard.new_analysis(
                domain=domain,
                title=data.get("title", "Analyse"),
                markdown=data.get("markdown", ""),
                tag=data.get("tag", ""),
                tag_type=data.get("tag_type", "g"),
                source="user",
                prompt=card_prompt,
            )

    @staticmethod
    def _extract_yaml(text: str) -> str:
        import re

        m = re.search(r"```yaml\s*(.*?)```", text, re.DOTALL)
        if m:
            return m.group(1).strip()
        m = re.search(r"```\s*(.*?)```", text, re.DOTALL)
        if m:
            return m.group(1).strip()
        return ""
