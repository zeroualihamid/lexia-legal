#!/usr/bin/env python3
"""Build or consolidate the canonical unified legal graph (.pkl)."""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.legal_graph.unified_builder import (  # noqa: E402
    build_unified_judgments_graph,
    consolidate_legal_graphs,
    unified_pkl_path,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("build_unified_judgments_graph")


def main() -> int:
    parser = argparse.ArgumentParser(description="Build unified legal graph pickle")
    parser.add_argument(
        "--consolidate",
        action="store_true",
        help="Merge all existing legal graph pkls into one and delete legacy copies",
    )
    parser.add_argument(
        "--no-qdrant",
        action="store_true",
        help="Skip Qdrant scroll during build/consolidation",
    )
    parser.add_argument(
        "--max-points",
        type=int,
        default=None,
        help="Cap total Qdrant points scrolled (default: unlimited)",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default=None,
        help="Override output directory (default: data/legal_graph_unified)",
    )
    args = parser.parse_args()

    if args.consolidate:
        summary = consolidate_legal_graphs(
            use_qdrant=not args.no_qdrant,
            delete_legacy_pkls=True,
        )
    else:
        summary = build_unified_judgments_graph(
            use_qdrant=not args.no_qdrant,
            max_points=args.max_points,
            output_dir=Path(args.output_dir) if args.output_dir else None,
            delete_legacy_pkls=False,
        )
    logger.info("Unified graph written to %s", unified_pkl_path())
    logger.info(
        "Nodes=%s edges=%s reasoning_edges=%s documents=%s",
        summary["graph_nodes"],
        summary["graph_edges"],
        summary["reasoning_edge_count"],
        summary["document_count"],
    )
    if summary.get("deleted_pkls"):
        logger.info("Deleted %s legacy pickle(s)", len(summary["deleted_pkls"]))
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
