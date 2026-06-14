"""In-memory + on-disk store for CTE dependency graphs.

MVP design
──────────
Each call to ``store.put(graph)`` mints a fresh ``graph_id`` (UUID4),
keeps the :class:`networkx.DiGraph` in a process-local dict, and pickles
it to ``<base_dir>/<graph_id>.pkl``.  Re-opening the same store on the
next process boot re-hydrates from disk lazily on ``get(graph_id)``.

The pickle format is intentional: ``networkx.DiGraph`` round-trips
through pickle losslessly, including custom node attributes (numpy
embeddings, plain Python lists, …).  A JSON / YAML representation
would either lose the numpy dtype or pay the cost of base64 every read.

Production-shaped swap
──────────────────────
This class is deliberately tiny so a Postgres / S3-backed implementation
can replace it without touching the API or the builder.  The four
methods :meth:`put`, :meth:`get`, :meth:`exists` and :meth:`delete`
form the entire contract that the rest of the package depends on.
"""

from __future__ import annotations

import logging
import os
import pickle
import threading
import uuid
from pathlib import Path
from typing import Dict, Optional

import networkx as nx


logger = logging.getLogger(__name__)


class GraphStore:
    """Process-local cache + pickle persistence."""

    def __init__(self, base_dir: Path | str) -> None:
        self.base_dir = Path(base_dir)
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self._cache: Dict[str, nx.DiGraph] = {}
        # mtime of the pkl when we cached it, so get() can detect when a DIFFERENT
        # process (e.g. the enhance-loop MCP server) rewrote the graph on disk and
        # reload it instead of serving a stale in-memory copy.
        self._mtimes: Dict[str, Optional[float]] = {}
        self._lock = threading.Lock()

    # ── Public API ─────────────────────────────────────────────────────

    def new_id(self) -> str:
        """Return a fresh, unique graph identifier."""
        return uuid.uuid4().hex

    def put(self, graph: nx.DiGraph, *, graph_id: Optional[str] = None) -> str:
        """Persist *graph* under a fresh (or supplied) id; return the id."""
        gid = graph_id or self.new_id()
        with self._lock:
            self._cache[gid] = graph
            self._write(gid, graph)
            self._mtimes[gid] = self._disk_mtime(gid)
        logger.info(
            "GraphStore: persisted graph %s (%d nodes, %d edges)",
            gid, graph.number_of_nodes(), graph.number_of_edges(),
        )
        return gid

    def get(self, graph_id: str) -> Optional[nx.DiGraph]:
        """Return the graph or ``None`` if unknown.

        Re-reads from disk when the pkl changed since it was cached, so a graph
        written by another process (the enhance MCP server runs in its own
        process) is reflected here instead of a stale cached copy.
        """
        with self._lock:
            disk_mtime = self._disk_mtime(graph_id)
            cached = self._cache.get(graph_id)
            if cached is not None and (
                disk_mtime is None or disk_mtime == self._mtimes.get(graph_id)
            ):
                return cached
            graph = self._read(graph_id)
            if graph is not None:
                self._cache[graph_id] = graph
                self._mtimes[graph_id] = disk_mtime
            return graph

    def exists(self, graph_id: str) -> bool:
        with self._lock:
            return graph_id in self._cache or self._path_for(graph_id).is_file()

    def delete(self, graph_id: str) -> bool:
        with self._lock:
            removed = False
            if graph_id in self._cache:
                del self._cache[graph_id]
                removed = True
            self._mtimes.pop(graph_id, None)
            p = self._path_for(graph_id)
            if p.is_file():
                try:
                    p.unlink()
                    removed = True
                except OSError as e:
                    logger.warning("GraphStore: cannot delete %s: %s", p, e)
            return removed

    # ── Disk helpers ───────────────────────────────────────────────────

    def _path_for(self, graph_id: str) -> Path:
        return self.base_dir / f"{graph_id}.pkl"

    def _disk_mtime(self, graph_id: str) -> Optional[float]:
        """Modification time of the graph's pkl, or ``None`` when absent."""
        try:
            return self._path_for(graph_id).stat().st_mtime
        except OSError:
            return None

    def _write(self, graph_id: str, graph: nx.DiGraph) -> None:
        path = self._path_for(graph_id)
        tmp = path.with_suffix(".pkl.tmp")
        try:
            with tmp.open("wb") as f:
                pickle.dump(graph, f, protocol=pickle.HIGHEST_PROTOCOL)
            os.replace(tmp, path)
        except Exception as e:
            logger.warning("GraphStore: pickle write failed for %s: %s", graph_id, e)
            try:
                tmp.unlink(missing_ok=True)
            except Exception:
                pass

    def _read(self, graph_id: str) -> Optional[nx.DiGraph]:
        path = self._path_for(graph_id)
        if not path.is_file():
            return None
        try:
            with path.open("rb") as f:
                graph = pickle.load(f)
            if not isinstance(graph, nx.DiGraph):
                logger.warning("GraphStore: %s is not a DiGraph; ignoring", path)
                return None
            return graph
        except Exception as e:
            logger.warning("GraphStore: pickle read failed for %s: %s", graph_id, e)
            return None
