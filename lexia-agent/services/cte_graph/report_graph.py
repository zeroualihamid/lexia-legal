"""Report CTE graphs — reports run their SQL off a pickled NetworkX graph.

Each HTML report template owns:

* an ``index.yaml`` (next to ``definitions.yaml`` / ``report-template.html``)
  that names its **ledger** parquet, the DuckDB **source view**, and the
  **pickle graph** id, and
* a pickle graph ``data/cte_graphs/cte-report-<id>.pkl`` whose nodes are the
  report's SQL fragments (``rawSql`` = the fragment body) connected by
  ``{{include: …}}`` edges.

At render time the pipeline loads the graph and resolves every block's
``cte_ref`` (and any ``{{include: name}}``) from graph nodes instead of from
``data/reporting/sql/`` files — so the ``sql/`` tree can be retired entirely.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import networkx as nx

from .graph_store import GraphStore

logger = logging.getLogger(__name__)

_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_GRAPH_DIR = _PROJECT_ROOT / "data" / "cte_graphs"

_INCLUDE_RE = re.compile(r"\{\{\s*include:\s*([A-Za-z0-9_]+)\s*\}\}", re.IGNORECASE)

FragmentLookup = Callable[[str], Optional[str]]


def report_graph_id(report_id: str) -> str:
    """Pickle graph id for a report template (``cte-report-<slug>``)."""
    slug = re.sub(r"[^a-z0-9]+", "-", (report_id or "").strip().lower()).strip("-")
    return f"cte-report-{slug or 'default'}"


def load_report_index(template_dir: Path) -> Optional[Dict[str, Any]]:
    """Read a report's ``index.yaml`` (ledger parquet + source view + graph id)."""
    path = Path(template_dir) / "index.yaml"
    if not path.is_file():
        return None
    try:
        import yaml

        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        return data if isinstance(data, dict) else None
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("report index.yaml read failed (%s): %s", path, exc)
        return None


def load_report_graph(graph_id: str, *, graph_dir: Optional[Path] = None) -> Optional[nx.DiGraph]:
    """Load a report's pickle graph by id, or None if absent."""
    store = GraphStore(graph_dir or _GRAPH_DIR)
    return store.get(graph_id)


def make_fragment_lookup(graph: Optional[nx.DiGraph]) -> FragmentLookup:
    """Return a ``name -> rawSql`` resolver backed by *graph* node attributes."""
    if graph is None:
        return lambda _name: None

    def lookup(name: str) -> Optional[str]:
        if name in graph:
            return str(graph.nodes[name].get("rawSql") or "") or None
        return None

    return lookup


def resolve_report_parquet(index: Dict[str, Any]) -> Optional[Path]:
    """Absolute path to the report's ledger parquet from its index.yaml."""
    raw = index.get("parquet") or index.get("ledger")
    if not raw:
        return None
    p = Path(str(raw))
    return p if p.is_absolute() else (_PROJECT_ROOT / p)


# ── Builder (migration: fragment .sql files → pickle graph) ──────────────────


def build_report_graph_from_fragments(
    report_id: str,
    fragment_dir: Path,
    *,
    parquet_source: str,
    source_view: str,
    fragment_prefix: Optional[str] = None,
    graph_dir: Optional[Path] = None,
) -> nx.DiGraph:
    """Ingest ``<fragment_dir>/<prefix>*.sql`` into a report pickle graph.

    Each ``.sql`` file becomes a node (``rawSql`` = file text, verbatim);
    ``{{include: name}}`` references become ``name -> node`` edges. Graph
    metadata records the ledger parquet + source view. Persists and returns
    the graph.
    """
    fragment_dir = Path(fragment_dir)
    prefix = fragment_prefix if fragment_prefix is not None else f"{report_id}__"
    files = sorted(p for p in fragment_dir.glob("*.sql") if p.name.startswith(prefix))
    if not files:
        files = sorted(fragment_dir.glob("*.sql"))

    graph = nx.DiGraph()
    graph.graph.update(
        {
            "report": report_id,
            "parquet_source": parquet_source,
            "source_view": source_view,
            "schema_version": 1,
            "kind": "report",
        }
    )

    bodies: Dict[str, str] = {}
    for f in files:
        name = f.stem
        text = f.read_text(encoding="utf-8")
        bodies[name] = text
        includes = sorted({m.group(1) for m in _INCLUDE_RE.finditer(text)})
        graph.add_node(
            name,
            id=name,
            name=name,
            description=f"Report fragment {name}",
            rawSql=text,
            parents=list(includes),
            children=[],
        )

    for name, text in bodies.items():
        for dep in {m.group(1) for m in _INCLUDE_RE.finditer(text)}:
            if dep in graph:
                graph.add_edge(dep, name)
                kids = graph.nodes[dep].get("children") or []
                if name not in kids:
                    kids.append(name)
                    graph.nodes[dep]["children"] = kids

    gid = report_graph_id(report_id)
    GraphStore(graph_dir or _GRAPH_DIR).put(graph, graph_id=gid)
    logger.info(
        "report graph %r built: %d nodes, %d edges (parquet=%s view=%s)",
        gid, graph.number_of_nodes(), graph.number_of_edges(), parquet_source, source_view,
    )
    return graph
