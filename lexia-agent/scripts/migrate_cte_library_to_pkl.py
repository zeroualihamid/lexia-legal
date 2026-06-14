"""One-time migration: build the canonical CTE pickle graph from the on-disk
``analyse_bancaire`` catalogue (``index.yaml`` + ``.sql``) and stamp the graph
with its parquet "ledger" pointer + source view.

After this runs, ``data/cte_graphs/cte-prof-analyse-bancaire.pkl`` is the single
source of truth and the on-disk ``index.yaml`` / ``.sql`` files can be deleted.

Usage:
    .venv/bin/python scripts/migrate_cte_library_to_pkl.py [--library analyse_bancaire]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))


def _datasource_parquet(dataset: str, default: str) -> str:
    """Resolve the parquet ``cache_file`` for *dataset* from datasources.yaml."""
    import yaml

    cfg_path = _PROJECT_ROOT / "config" / "datasources.yaml"
    try:
        doc = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
    except Exception:
        return default
    sources = doc if isinstance(doc, list) else doc.get("sources") or doc.get("datasources") or []
    for s in sources if isinstance(sources, list) else []:
        if not isinstance(s, dict):
            continue
        cache = s.get("cache_file")
        if cache and dataset.lower() in str(cache).lower():
            return str(cache)
    return default


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library", default="analyse_bancaire")
    parser.add_argument("--source-view", default="oracle_env_ca_view")
    parser.add_argument("--dataset", default="oracle_env_ca_view")
    args = parser.parse_args()

    from services.cte_graph.graph_builder import GraphBuilder
    from services.cte_graph.graph_store import GraphStore
    from services.cte_graph.library_graph_cache import (
        get_agent_cte_embedding_service,
        graph_id_for_library,
    )
    from services.cte_graph.library_loader import load_library
    from services.cte_graph.repository import _normalize_cte_def

    reporting_sql = _PROJECT_ROOT / "data" / "reporting" / "sql"
    graph_dir = _PROJECT_ROOT / "data" / "cte_graphs"

    records = load_library(reporting_sql, libraries=[args.library])
    print(f"Loaded {len(records)} CTE records from {args.library}")
    if not records:
        print("Nothing to migrate (no records).")
        return 1

    parquet_source = _datasource_parquet(args.dataset, f"data/parquet/{args.dataset}.parquet")
    graph_meta = {
        "library": args.library,
        "parquet_source": parquet_source,
        "source_view": args.source_view,
        "schema_version": 1,
    }

    builder = GraphBuilder(embeddings=get_agent_cte_embedding_service())
    graph = builder.build_from_library(records, graph_meta=graph_meta)

    # Normalise each node's rawSql to a clean ``name AS ( … )`` definition.
    for nid, attrs in graph.nodes(data=True):
        attrs["rawSql"] = _normalize_cte_def(attrs.get("name", nid), attrs.get("rawSql", ""))

    gid = graph_id_for_library(args.library)
    store = GraphStore(graph_dir)
    store.put(graph, graph_id=gid)

    print(f"Persisted graph {gid!r}: {graph.number_of_nodes()} nodes, "
          f"{graph.number_of_edges()} edges")
    print(f"  parquet_source = {parquet_source}")
    print(f"  source_view    = {args.source_view}")
    print("Nodes:", sorted(graph.nodes()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
