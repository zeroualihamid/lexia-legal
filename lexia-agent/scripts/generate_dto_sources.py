#!/usr/bin/env python3
"""CLI: write one ``dto_<stem>.sql`` per DTO/parquet pair under sql/fragment_library/.

Usage:
    python brikz-agent/scripts/generate_dto_sources.py
    python brikz-agent/scripts/generate_dto_sources.py --overwrite

The script (re)builds ``data/reporting/sql/fragment_library/dto_<stem>.sql`` files
and refreshes their entries in ``index.yaml`` so the reporting bootstrap
flow and the edit-agent resolve them via ``cte_ref`` and ``fragment_library/index.yaml``
(reference ``FROM dto_<stem>`` in block SQL).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--parquet-dir",
        default=str(_ROOT / "data" / "parquet"),
        help="Directory containing <stem>.parquet files (default: data/parquet)",
    )
    parser.add_argument(
        "--block-library-dir",
        default=str(_ROOT / "data" / "reporting" / "sql" / "fragment_library"),
        help="Fragment / DTO CTE directory (default: data/reporting/sql/fragment_library)",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Rewrite existing dto_<stem>.sql files (default: leave them alone)",
    )
    args = parser.parse_args()

    from nodes.reporting.dto_source_generator import generate_all_dto_sources

    written = generate_all_dto_sources(
        parquet_dir=Path(args.parquet_dir),
        block_library_dir=Path(args.block_library_dir),
        overwrite=args.overwrite,
    )
    if written:
        print(f"Wrote {len(written)} dto source CTE(s):")
        for n in written:
            print(f"  - {n}.sql")
    else:
        print("No new dto source CTEs written (use --overwrite to refresh).")


if __name__ == "__main__":
    main()
