#!/usr/bin/env python3
"""Migrate rapport_v1 definitions.yaml: promote inline ``sql`` to sql/fragment_library/*.sql."""

from __future__ import annotations

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

import yaml  # noqa: E402

from nodes.reporting.block_materialize import materialize_all_blocks  # noqa: E402


def main() -> None:
    defs_path = _ROOT / "data/reporting/templates/rapport_v1/definitions.yaml"
    lib_dir = _ROOT / "data" / "reporting" / "sql" / "fragment_library"
    raw = yaml.safe_load(defs_path.read_text(encoding="utf-8"))
    blocks = list(raw.get("blocks") or [])
    raw["blocks"] = materialize_all_blocks(
        blocks,
        block_library_dir=lib_dir,
        template_id="rapport_v1",
        overwrite=True,
    )
    raw["version"] = int(raw.get("version") or 0) + 1
    defs_path.write_text(
        yaml.safe_dump(raw, allow_unicode=True, sort_keys=False, width=100),
        encoding="utf-8",
    )
    print(f"OK {defs_path} version={raw['version']} blocks={len(raw['blocks'])}")


if __name__ == "__main__":
    main()
