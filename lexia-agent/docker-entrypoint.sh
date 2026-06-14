#!/bin/sh
# Seed baked /app/data content into the (Railway) volume mounted at /app/data
# before starting the app.
#
# Why: Railway mounts an EMPTY volume, which masks the image's baked /app/data
# — including the `data/classes` Python package (import target), the CTE profile
# graphs in `data/cte_graphs/*.pkl`, `data/reporting`, etc. Without seeding, the
# app crashes (ModuleNotFoundError: data.classes) and CTE graphs/parquet caches
# never persist. At build time the baked tree is copied to /opt/brikz-seed-data;
# here we copy it into /app/data with `-n` (no-clobber) so the volume is
# populated on first boot while runtime edits (new DTOs, appended CTEs, parquet
# caches) are preserved across restarts.
set -e

SEED="/opt/brikz-seed-data"
DATA="/app/data"

if [ -d "$SEED" ]; then
  mkdir -p "$DATA"
  cp -rn "$SEED/." "$DATA/" 2>/dev/null || true
fi

exec uvicorn main:app --host 0.0.0.0 --port 8000
