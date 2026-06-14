#!/bin/sh
# Seed /app/data from image when a named Docker volume masks packaged files.
# Without this, docker-compose's app_data:/app/data hides data/reporting from the image.

set -e
SEED=/opt/brikz-seed

if [ -d "$SEED/data/reporting" ]; then
    mkdir -p /app/data/reporting
    cp -a "$SEED/data/reporting"/. /app/data/reporting/
fi

if [ -f "$SEED/data/cte_graph_profiles.json" ] && [ ! -f /app/data/cte_graph_profiles.json ]; then
    mkdir -p /app/data
    cp -a "$SEED/data/cte_graph_profiles.json" /app/data/
fi

exec "$@"
