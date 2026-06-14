#!/bin/sh
# Wait for MinIO to be live, configure mc alias, create the default bucket.
set -eu

BUCKET="${MINIO_BUCKET:-qclick}"
ENDPOINT="http://127.0.0.1:9000"

echo "[minio-bucket] waiting for MinIO at ${ENDPOINT} ..."
i=0
until curl -fsS "${ENDPOINT}/minio/health/live" >/dev/null 2>&1; do
  i=$((i+1))
  if [ "$i" -gt 60 ]; then
    echo "[minio-bucket] MinIO did not become healthy in time" >&2
    exit 1
  fi
  sleep 1
done

echo "[minio-bucket] configuring mc alias"
mc alias set local "${ENDPOINT}" "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}" >/dev/null

echo "[minio-bucket] ensuring bucket '${BUCKET}'"
mc mb --ignore-existing "local/${BUCKET}"

echo "[minio-bucket] done"
