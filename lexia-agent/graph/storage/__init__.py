# graph/storage/__init__.py

"""
Graph Storage Package
=====================

Pluggable persistence backends for the reasoning graph.

Currently implemented:
    NetworkXBackend   – JSON + .npy on local disk (default, no extra services)

Planned / drop-in replacements:
    Neo4jBackend      – native graph DB for large-scale deployments
    SQLiteBackend     – single-file relational storage

Usage:
    from graph.storage import NetworkXBackend

    backend = NetworkXBackend(config)
    backend.add_node("n1", code="df = pd.read_parquet('f.parquet')", ...)
    node = backend.get_node("n1")
"""

from graph.storage.networkx_backend import NetworkXBackend

__all__ = ["NetworkXBackend"]
