-- Google Drive connector instances (admin-managed, credentials encrypted at rest).
CREATE TABLE IF NOT EXISTS drive_connectors (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                TEXT NOT NULL,
    folder_id           TEXT NOT NULL,
    auth_type           TEXT NOT NULL DEFAULT 'service_account'
                        CHECK (auth_type IN ('service_account', 'access_token')),
    credentials_enc     TEXT NOT NULL,
    last_test_at        TIMESTAMPTZ,
    last_test_status    TEXT CHECK (last_test_status IN ('success', 'failed')),
    last_test_message   TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_drive_connectors_name ON drive_connectors (name);
