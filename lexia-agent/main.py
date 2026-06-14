# api/main.py

"""
FastAPI Application
===================

Main FastAPI app with all routes, middleware, and lifecycle hooks.

Run:
    uvicorn api.main:app --reload --host 0.0.0.0 --port 8000

Production:
    gunicorn api.main:app -w 4 -k uvicorn.workers.UvicornWorker
"""

import os
import sys

try:
    from _cython_pydantic_shim import patch_pydantic as _patch_pydantic

    _patch_pydantic()
except Exception:
    pass

import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

# Ensure project root is on sys.path (needed by uvicorn reload / multiprocessing spawn)
_project_root = str(Path(__file__).resolve().parent)
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

# data/ contains the classes package referenced by columns_class configs
_data_dir = str(Path(__file__).resolve().parent / "data")
if _data_dir not in sys.path:
    sys.path.insert(0, _data_dir)

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse

from monitoring.logger import get_logger

logger = get_logger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Lifespan events (startup / shutdown)
# ─────────────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Startup and shutdown hooks.
    
    Startup:
        - Initialize global singletons (graph, LLM factory, embeddings)
        - Load graph from disk if present
        - Rebuild similarity search index
        - Log system configuration
    
    Shutdown:
        - Persist graph to disk
        - Close LLM client connections
        - Flush logs
    """
    # ── Startup ───────────────────────────────────────────────────────────────
    logger.info("🚀 PocketFlow API starting...")

    try:
        from config.settings import settings
        from graph.reasoning_graph import ReasoningGraph
        from graph.graph_builder import GraphBuilder

        # Initialize graph
        graph = ReasoningGraph(settings)
        logger.info(
            f"Graph loaded: {graph.backend.node_count} nodes, "
            f"{graph.backend.edge_count} edges"
        )

        # Rebuild similarity index from stored nodes
        if graph.backend.node_count > 0:
            builder = GraphBuilder(graph, settings)
            indexed = builder.rebuild_similarity_index()
            logger.info(f"Similarity index rebuilt: {indexed} nodes")

        # Store globals for dependency injection
        app.state.graph = graph
        app.state.settings = settings

        # ── Data Loader: ConnectorManager + Scheduler ─────────────────────
        import yaml
        from config import get_settings
        from services.connector_manager import ConnectorManager
        from services.refresh_scheduler import RefreshScheduler
        from flows.dataloader_flow import run_dataloader_flow

        cfg_settings = get_settings()

        # Create ConnectorManager (shared across routes and scheduler)
        parquet_dir = str(settings.parquet_cache_dir)
        connector_manager = ConnectorManager(cache_base_dir=parquet_dir)
        app.state.connector_manager = connector_manager

        # Register connectors for all enabled sources so /parquet/sources works
        # even when cache files already exist and the dataloader flow is skipped.
        from nodes.dataloader.connector_factory_node import _create_connector

        for src in cfg_settings.data_sources:
            if not src.enabled:
                continue
            try:
                connector = _create_connector(src)
                if connector_manager.get_connector(connector.source_id) is None:
                    connector_manager.register_connector(connector)
                    cm = connector_manager.cache_manager
                    total_rows, total_cols = 0, 0

                    if getattr(src, "tables", None):
                        import pyarrow.parquet as pq
                        for tbl in src.tables:
                            if not tbl.enabled:
                                continue
                            if tbl.cache_file:
                                tcp = Path(tbl.cache_file)
                                if not tcp.is_absolute():
                                    tcp = Path(cm.base_dir) / tcp.name
                            else:
                                tcp = cm.get_cache_path(f"{src.source_id}_{tbl.table_id}")
                            if tcp.exists():
                                try:
                                    pf = pq.ParquetFile(tcp)
                                    total_rows += pf.metadata.num_rows
                                    total_cols = max(total_cols, pf.metadata.num_columns)
                                except Exception:
                                    pass
                    else:
                        cache_file = getattr(src, "cache_file", None)
                        if cache_file:
                            cp = Path(cache_file)
                            if not cp.is_absolute():
                                cp = Path(cm.base_dir) / cp.name
                        else:
                            cp = cm.get_cache_path(src.source_id)
                        if cp.exists():
                            import pyarrow.parquet as pq
                            try:
                                pf = pq.ParquetFile(cp)
                                total_rows = pf.metadata.num_rows
                                total_cols = pf.metadata.num_columns
                            except Exception:
                                total_rows, total_cols = 0, 0

                    if total_rows > 0:
                        connector.metadata.row_count = total_rows
                        connector.metadata.column_count = total_cols
                        connector.metadata.last_refresh_status = "success"
                        connector.metadata.cache_path = str(cm.base_dir)
            except Exception as exc:
                logger.warning(f"[startup] Could not register connector for '{src.source_id}': {exc}")

        logger.info(f"[startup] Registered {len(connector_manager.connectors)} connectors")

        # Pre-load DTO KV cache & compact schema
        from flows.dto_cache_flow import run_dto_cache_flow
        run_dto_cache_flow(parquet_cache_dir=str(settings.parquet_cache_dir))
        logger.info("[startup] DTO KV cache populated")

        # Initialize semantic query cache (reuse EmbeddingManager's model)
        from services.query_cache import init_query_cache
        _emb_model = connector_manager.embedding_manager._ensure_model()
        init_query_cache(
            cache_dir=str(Path(parquet_dir).parent / "query_cache"),
            model=_emb_model,
        )
        logger.info("[startup] Semantic query cache initialized")

        # Load loader_config.yaml
        loader_cfg_path = Path("config/loader_config.yaml")
        loader_config: dict = {}
        if loader_cfg_path.exists():
            with open(loader_cfg_path, "r", encoding="utf-8") as f:
                loader_config = yaml.safe_load(f) or {}

        refresh_cfg = loader_config.get("refresh", {})
        scheduler_enabled = refresh_cfg.get("enabled", False)
        interval_seconds = refresh_cfg.get("interval_seconds", 1800)
        run_on_startup = refresh_cfg.get("run_on_startup", True)
        # Env override: DATALOADER_RUN_ON_STARTUP=false disables the boot-time
        # cache build. This prevents the startup loader from re-reading a large
        # QVD source CONCURRENTLY with an in-flight upload conversion of the same
        # file — two simultaneous QVD->Parquet conversions exceeded the 24GB
        # container limit and OOM-crashed the agent. The upload pipeline builds
        # the cache (memory-safe, streamed) and it persists on the volume, so a
        # boot-time pre-load is unnecessary; sources load on demand otherwise.
        _env_startup = os.getenv("DATALOADER_RUN_ON_STARTUP")
        if _env_startup is not None:
            run_on_startup = _env_startup.strip().lower() not in ("0", "false", "no", "off")
        incremental_by_default = refresh_cfg.get("incremental_by_default", True)

        # Create and start RefreshScheduler
        refresh_scheduler = RefreshScheduler(connector_manager)
        app.state.refresh_scheduler = refresh_scheduler

        def _resolve_cache_file(cm, cache_file: str) -> Path:
            """Resolve a configured ``cache_file`` to its on-disk path.

            Mirrors ``CacheManager.get_cache_path``'s custom-path handling: a
            ``cache_file`` that is absolute, or already rooted under ``base_dir``
            (e.g. ``data/parquet/oracle_env_ca_view.parquet``), is used verbatim —
            NOT blindly joined onto ``base_dir`` again. The previous naive
            ``base_dir / cache_file`` produced a doubled path
            (``data/parquet/data/parquet/…``) that never existed, so the
            scheduler thought every uploaded source's cache was missing and
            re-read the full QVD every interval → OOM crash loop.
            """
            p = Path(cache_file)
            if p.is_absolute():
                return p
            if p.parts[: len(cm.base_dir.parts)] == cm.base_dir.parts:
                return p
            return cm.base_dir / p

        def _needs_refresh(src) -> bool:
            """Return True only if cached parquet files are missing."""
            cm = connector_manager.cache_manager
            if getattr(src, "tables", None):
                for tbl in src.tables:
                    if not tbl.enabled:
                        continue
                    p = _resolve_cache_file(cm, tbl.cache_file) if tbl.cache_file else cm.get_cache_path(f"{src.source_id}_{tbl.table_id}")
                    if not p.exists():
                        return True
                return False
            p = _resolve_cache_file(cm, src.cache_file) if getattr(src, "cache_file", None) else cm.get_cache_path(src.source_id)
            return not p.exists()

        if scheduler_enabled:
            # Register a single job that refreshes only sources whose
            # parquet caches are missing — never silently overwrite existing data.
            def _scheduled_refresh():
                try:
                    stale = [
                        s for s in cfg_settings.data_sources
                        if s.enabled and _needs_refresh(s)
                    ]
                    if not stale:
                        logger.debug("[dataloader] Scheduled refresh: all caches present, nothing to do")
                        return
                    for src in stale:
                        logger.info(f"[dataloader] Scheduled refresh for missing cache: {src.source_id}")
                        run_dataloader_flow(
                            connector_manager=connector_manager,
                            settings=cfg_settings,
                            source_id=src.source_id,
                            incremental=incremental_by_default,
                        )
                except Exception as exc:
                    logger.error(f"[dataloader] Scheduled refresh failed: {exc}", exc_info=True)

            refresh_scheduler.scheduler.every(interval_seconds).seconds.do(_scheduled_refresh)
            refresh_scheduler.start()
            logger.info(
                f"[dataloader] Scheduler started: refresh every {interval_seconds}s"
            )

        # Run startup load in background thread (non-blocking)
        if run_on_startup:
            stale_sources = [s for s in cfg_settings.data_sources if s.enabled and _needs_refresh(s)]

            if stale_sources:
                def _startup_load():
                    try:
                        ids = [s.source_id for s in stale_sources]
                        logger.info(f"[dataloader] Startup load for sources missing cache: {ids}")
                        for src in stale_sources:
                            run_dataloader_flow(
                                connector_manager=connector_manager,
                                settings=cfg_settings,
                                source_id=src.source_id,
                                incremental=False,
                            )
                        logger.info("[dataloader] Startup load complete")
                    except Exception as exc:
                        logger.error(f"[dataloader] Startup load failed: {exc}", exc_info=True)

                t = threading.Thread(target=_startup_load, daemon=True, name="dataloader-startup")
                t.start()
            else:
                logger.info("[dataloader] All caches present, skipping startup load")

        # ── Card Orchestrator: auto-analysis for all 8 domains ──────────
        from agents.domain.card_orchestrator import CardOrchestrator

        card_orchestrator = CardOrchestrator(
            config=cfg_settings,
            connector_manager=connector_manager,
        )
        app.state.card_orchestrator = card_orchestrator

        # Run initial card generation in background (non-blocking). Gated by env:
        # CARDS_RUN_ON_STARTUP=false skips it. The boot-time card run launches
        # agent flows that query the data sources; for a large source whose
        # parquet cache isn't built yet this forces a full QVD read via the
        # connector and, combined with the concurrent card LLM/embedding work,
        # OOM-crashed the container — which on restart regenerated cards and
        # re-read the QVD, a crash loop. Disable on Railway until the cache is
        # built (by the upload pipeline); cards still build on demand afterwards.
        _cards_on_startup = os.getenv("CARDS_RUN_ON_STARTUP", "true").strip().lower() not in ("0", "false", "no", "off")

        def _startup_cards():
            try:
                logger.info("[cards] Starting initial card generation for all domains...")
                card_orchestrator.run_all_agents()
                logger.info("[cards] Initial card generation complete")
            except Exception as exc:
                logger.error(f"[cards] Startup card generation failed: {exc}", exc_info=True)

        if _cards_on_startup:
            t_cards = threading.Thread(target=_startup_cards, daemon=True, name="card-orchestrator-startup")
            t_cards.start()
        else:
            logger.info("[cards] Startup card generation disabled (CARDS_RUN_ON_STARTUP=false)")

        # Schedule hourly card refresh (3600 seconds)
        if scheduler_enabled:
            def _scheduled_card_refresh():
                try:
                    card_orchestrator.run_all_agents()
                except Exception as exc:
                    logger.error(f"[cards] Scheduled card refresh failed: {exc}", exc_info=True)

            refresh_scheduler.scheduler.every(3600).seconds.do(_scheduled_card_refresh)
            logger.info("[cards] Hourly card refresh scheduled")

        # ── Pre-load SentenceTransformer model (avoids 15s cold start on first query) ──
        def _preload_embedding_model():
            try:
                from services.embedding_model_provider import (
                    DEFAULT_EMBEDDING_MODEL,
                    get_embedding_model,
                    register_model,
                )
                logger.info("[startup] Pre-loading SentenceTransformer: %s", DEFAULT_EMBEDDING_MODEL)
                model = get_embedding_model(DEFAULT_EMBEDDING_MODEL)
                register_model(DEFAULT_EMBEDDING_MODEL, model)
                app.state.embedding_model = model
                logger.info("[startup] SentenceTransformer ready")
            except Exception as exc:
                logger.warning("[startup] SentenceTransformer pre-load failed (non-fatal): %s", exc)

        t_emb = threading.Thread(target=_preload_embedding_model, daemon=True, name="embedding-preload")
        t_emb.start()

        logger.info("✓ PocketFlow API ready")

    except Exception as e:
        logger.error(f"Startup failed: {e}")
        raise

    yield

    # ── Shutdown ──────────────────────────────────────────────────────────────
    logger.info("🛑 PocketFlow API shutting down...")

    try:
        # Stop refresh scheduler
        if hasattr(app.state, "refresh_scheduler"):
            app.state.refresh_scheduler.stop()
            logger.info("Refresh scheduler stopped")

        # Persist graph
        if hasattr(app.state, "graph"):
            app.state.graph.backend.save()
            logger.info("Graph saved to disk")

    except Exception as e:
        logger.warning(f"Shutdown cleanup error: {e}")

    logger.info("✓ PocketFlow API stopped")


# ─────────────────────────────────────────────────────────────────────────────
# FastAPI app
# ─────────────────────────────────────────────────────────────────────────────

_PROD = os.getenv("LEXIA_ENV", "").lower() == "production"

app = FastAPI(
    title="PocketFlow API",
    description=(
        "AI-powered code generation with graph reasoning, adversarial validation, "
        "and sandboxed execution."
    ),
    version="1.0.0",
    lifespan=lifespan,
    docs_url=None if _PROD else "/docs",
    redoc_url=None if _PROD else "/redoc",
    openapi_url=None if _PROD else "/openapi.json",
)


# ─────────────────────────────────────────────────────────────────────────────
# Middleware
# ─────────────────────────────────────────────────────────────────────────────

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # In production: restrict to specific origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Request-ID"],
)

# GZip compression
app.add_middleware(GZipMiddleware, minimum_size=1000)


# Request timing middleware
@app.middleware("http")
async def add_request_timing(request: Request, call_next):
    """Add X-Request-Time header to all responses."""
    start_time = time.perf_counter()
    response = await call_next(request)
    duration_ms = (time.perf_counter() - start_time) * 1000
    response.headers["X-Request-Time"] = f"{duration_ms:.2f}ms"
    return response


# Request ID middleware
@app.middleware("http")
async def add_request_id(request: Request, call_next):
    """Add unique X-Request-ID to every request for tracing."""
    import uuid
    request_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    return response


# Logging middleware
@app.middleware("http")
async def log_requests(request: Request, call_next):
    """Log all requests with method, path, status, duration."""
    start = time.perf_counter()
    response = await call_next(request)
    duration = (time.perf_counter() - start) * 1000
    
    logger.info(
        f"{request.method} {request.url.path} → {response.status_code} "
        f"({duration:.1f}ms)"
    )
    return response


# ─────────────────────────────────────────────────────────────────────────────
# Global exception handlers
# ─────────────────────────────────────────────────────────────────────────────

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Catch-all for unhandled exceptions."""
    logger.error(f"Unhandled exception on {request.url.path}: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={
            "error": "Internal server error",
            "detail": str(exc),
            "path": str(request.url.path),
        },
    )


@app.exception_handler(404)
async def not_found_handler(request: Request, exc):
    """Custom 404 response.

    Preserves the original ``HTTPException.detail`` when an endpoint raises
    a domain-level 404 (e.g. "Source not found: oracle_env"), so clients can
    distinguish "route missing" from "resource missing" without having to
    inspect server logs.
    """
    detail = getattr(exc, "detail", None)
    return JSONResponse(
        status_code=404,
        content={
            "error": "Not found",
            "path": str(request.url.path),
            "message": detail if detail else "The requested resource does not exist",
        },
    )


# ─────────────────────────────────────────────────────────────────────────────
# Root endpoint
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/", tags=["Root"])
async def root():
    """API root — returns service metadata."""
    return {
        "service": "PocketFlow API",
        "version": "1.0.0",
        "status": "operational",
        "docs": "/docs",
        "health": "/health",
    }


# ─────────────────────────────────────────────────────────────────────────────
# Register all route modules
# ─────────────────────────────────────────────────────────────────────────────

from api import register_all_routers
from api.routes.streaming import router as streaming_router

register_all_routers(app)
app.include_router(streaming_router, prefix="/stream", tags=["Streaming"])


# ─────────────────────────────────────────────────────────────────────────────
# Development server
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8000")),
        reload=True,
        reload_dirs=["agent", "api", "config", "flows", "graph", "llm", "nodes", "monitoring", "services", "conversation", "tools"],
        log_level="info",
    )
