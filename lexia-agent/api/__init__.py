# routes/__init__.py

"""
API Routes Package
==================

FastAPI routers organised by domain.

    health.py        – liveness / readiness probes
    workflow.py      – run, status, cancel workflow executions
    conversation.py  – session history and message management
    graph.py         – query the code knowledge graph
    agents.py        – agent configuration and debate management

Registration (in api/main.py):
    from routes import register_all_routers
    register_all_routers(app)
"""

from fastapi import FastAPI

from .routes.health       import router as health_router
from .routes.workflow     import router as workflow_router
from .routes.conversation import router as conversation_router
from .routes.graph        import router as graph_router
from .routes.agents       import router as agents_router
from .routes.chat         import router as chat_router
from .routes.data_routes  import router as data_router
from .routes.parquet      import parquet_router
from .routes.cards        import router as cards_router
from .routes.domains      import router as domains_router
from .routes.skills       import router as skills_router
from .routes.playground   import router as playground_router
from .routes.reporting    import reporting_router
from .routes.cte_graph    import router as cte_graph_router
from .routes.legal_graph  import router as legal_graph_router
from .routes.admin_claude import router as admin_claude_router
from .routes.admin_conversations import router as admin_conversations_router
from .routes.user_documents import router as user_documents_router
from .routes.user_documents import cases_router as user_cases_router



def register_all_routers(app: FastAPI) -> None:
    """Attach all domain routers to the FastAPI application."""
    app.include_router(health_router,       prefix="/health",       tags=["Health"])
    app.include_router(workflow_router,     prefix="/workflow",     tags=["Workflow"])
    app.include_router(conversation_router, prefix="/conversation", tags=["Conversation"])
    app.include_router(graph_router,        prefix="/graph",        tags=["Graph"])
    app.include_router(agents_router,       prefix="/agents",       tags=["Agents"])
    app.include_router(chat_router,         prefix="/chat",         tags=["Chat"])
    app.include_router(data_router,         prefix="/data",         tags=["Data"])
    app.include_router(parquet_router)
    app.include_router(cards_router,        prefix="/cards",        tags=["Cards"])
    app.include_router(domains_router,      prefix="/domains",      tags=["Domains"])
    app.include_router(skills_router,       prefix="/skills",       tags=["Skills"])
    app.include_router(playground_router,   prefix="/playground",   tags=["Playground"])
    app.include_router(reporting_router)
    app.include_router(cte_graph_router,    prefix="/cte-graph",    tags=["CTE Graph"])
    app.include_router(legal_graph_router,  prefix="/legal-graphs", tags=["Legal Graphs"])
    app.include_router(admin_claude_router, prefix="/admin/claude", tags=["Admin Claude"])
    app.include_router(admin_conversations_router, prefix="/admin/conversations", tags=["Admin Conversations"])
    app.include_router(user_documents_router, prefix="/documents", tags=["User Documents"])
    app.include_router(user_cases_router, prefix="/cases", tags=["User Documents"])

__all__ = [
    "health_router",
    "workflow_router",
    "conversation_router",
    "graph_router",
    "agents_router",
    "chat_router",
    "data_router",
    "parquet_router",
    "cards_router",
    "domains_router",
    "skills_router",
    "reporting_router",
    "cte_graph_router",
    "legal_graph_router",
    "register_all_routers",
]
