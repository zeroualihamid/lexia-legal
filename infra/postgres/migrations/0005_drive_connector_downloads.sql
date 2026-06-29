-- Track Google Drive files fetched via admin connectors.
CREATE TABLE IF NOT EXISTS drive_connector_file_downloads (
    connector_id      UUID NOT NULL REFERENCES drive_connectors(id) ON DELETE CASCADE,
    drive_file_id     TEXT NOT NULL,
    file_name         TEXT NOT NULL,
    mime_type         TEXT,
    file_size_bytes   BIGINT,
    minio_bucket      TEXT,
    minio_key         TEXT,
    downloaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    downloaded_by     UUID,
    PRIMARY KEY (connector_id, drive_file_id)
);

CREATE INDEX IF NOT EXISTS idx_drive_connector_downloads_connector
    ON drive_connector_file_downloads (connector_id);
CREATE INDEX IF NOT EXISTS idx_drive_connector_downloads_at
    ON drive_connector_file_downloads (downloaded_at DESC);
