-- ============================================================
-- Migration 0002: Court reference + mahakim.ma tracking
-- ------------------------------------------------------------
-- Adds the structured court-file reference used to look a case up on the
-- Moroccan justice portal (https://mahakim.ma) plus the columns that hold
-- the background scrape result.
--
-- Apply manually against a running database (idempotent):
--
--   docker compose -f deploy/docker-compose.yml exec -T postgres \
--     psql -U legal_ai -d legal_ai < infra/postgres/migrations/0002_case_court_tracking.sql
-- ============================================================

ALTER TABLE cases
    -- Structured reference that drives the mahakim.ma lookup form.
    ADD COLUMN IF NOT EXISTS court_type     TEXT,            -- 'appeal' | 'first_instance'
    ADD COLUMN IF NOT EXISTS court_name     TEXT,            -- e.g. "محكمة الاستئناف بالرباط"
    ADD COLUMN IF NOT EXISTS file_number    TEXT,            -- "رقم الملف" (numero)
    ADD COLUMN IF NOT EXISTS file_code      TEXT,            -- "رمز الملف" (mark)
    ADD COLUMN IF NOT EXISTS file_year      TEXT,            -- "السنة" (annee)
    ADD COLUMN IF NOT EXISTS case_category  TEXT DEFAULT 'file', -- mahakim tab: 'file' | 'hearings'
    -- Background fetch bookkeeping.
    ADD COLUMN IF NOT EXISTS mahakim_status TEXT NOT NULL DEFAULT 'idle'
                              CHECK (mahakim_status IN
                                ('idle', 'queued', 'processing', 'ready', 'not_found', 'failed')),
    ADD COLUMN IF NOT EXISTS mahakim_data       JSONB,
    ADD COLUMN IF NOT EXISTS mahakim_fetched_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS mahakim_error      TEXT;

-- A case reference is unique per owner (a lawyer cannot register the same
-- court file twice). Case-insensitive, ignores blank refs.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cases_owner_ref
    ON cases (owner_id, lower(case_ref))
    WHERE case_ref IS NOT NULL AND btrim(case_ref) <> '';
