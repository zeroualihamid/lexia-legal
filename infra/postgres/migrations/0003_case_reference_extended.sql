-- ============================================================
-- Migration 0003: Extended court reference (chamber / panel) + cassation
-- ------------------------------------------------------------
-- A Moroccan court file reference can carry more than the appeal-court triple
-- (رقم/رمز/سنة). Cassation (محكمة النقض) and chamber-based references also name
-- a "قسم/غرفة" (chamber/section) and a "هيئة" (panel/bench). We persist those so
-- the lawyer's full reference is captured faithfully even when mahakim.ma's
-- public tracking form cannot look the file up (it only covers first-instance
-- and appeal courts — not the Court of Cassation).
--
-- Apply manually against a running database (idempotent):
--
--   docker compose -f deploy/docker-compose.yml exec -T postgres \
--     psql -U legal_ai -d legal_ai < infra/postgres/migrations/0003_case_reference_extended.sql
-- ============================================================

ALTER TABLE cases
    ADD COLUMN IF NOT EXISTS court_section TEXT,   -- "القسم / الغرفة" (e.g. القسم التجاري عدد 3)
    ADD COLUMN IF NOT EXISTS court_panel   TEXT;   -- "الهيئة" (e.g. الهيئة عدد 3)

-- Allow the 'unsupported' status: a complete reference was saved but the court
-- (e.g. محكمة النقض) is not searchable on the mahakim.ma public portal.
ALTER TABLE cases DROP CONSTRAINT IF EXISTS cases_mahakim_status_check;
ALTER TABLE cases
    ADD CONSTRAINT cases_mahakim_status_check CHECK (mahakim_status IN
        ('idle', 'queued', 'processing', 'ready', 'not_found', 'failed', 'unsupported'));
