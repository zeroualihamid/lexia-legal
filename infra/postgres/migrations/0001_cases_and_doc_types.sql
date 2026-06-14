-- ============================================================
-- Migration 0001: Case-centric documents
-- ------------------------------------------------------------
-- There is no migration framework in this project. init.sql is only
-- applied on FIRST boot of an empty postgres volume. Apply this file
-- manually against a running database when you do NOT want to wipe data:
--
--   docker compose -f deploy/docker-compose.yml exec -T postgres \
--     psql -U legal_ai -d legal_ai < infra/postgres/migrations/0001_cases_and_doc_types.sql
--
-- It is idempotent (safe to run more than once).
-- ============================================================

-- Cases (matters): a lawyer groups uploaded documents by client case.
CREATE TABLE IF NOT EXISTS cases (
    id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id      UUID        NOT NULL,
    title         TEXT        NOT NULL,
    client_name   TEXT,
    case_ref      TEXT,
    description   TEXT,
    status        TEXT        NOT NULL DEFAULT 'open'
                              CHECK (status IN ('open', 'closed', 'archived')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cases_owner_id ON cases (owner_id);
CREATE INDEX IF NOT EXISTS idx_cases_updated_at ON cases (updated_at DESC);

-- Documents: link to a case + carry the legal document taxonomy.
ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS case_id       UUID REFERENCES cases(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS document_type TEXT,
    ADD COLUMN IF NOT EXISTS ocr_text      TEXT,
    ADD COLUMN IF NOT EXISTS word_count    INTEGER;

CREATE INDEX IF NOT EXISTS idx_documents_case_id ON documents (case_id);

-- New document_status values used by the user-upload pipeline.
ALTER TYPE document_status ADD VALUE IF NOT EXISTS 'ready';
ALTER TYPE document_status ADD VALUE IF NOT EXISTS 'failed';

-- updated_at trigger for cases (re-uses the shared trigger function).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_cases_updated_at'
    ) THEN
        CREATE TRIGGER trg_cases_updated_at
            BEFORE UPDATE ON cases
            FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
    END IF;
END $$;
