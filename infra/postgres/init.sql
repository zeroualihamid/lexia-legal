-- ============================================================
-- Lexia Legal AI Platform — PostgreSQL 16 Schema
-- Moroccan Legal AI Platform Database Initialization
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- Extensions
-- ────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "unaccent";

-- ────────────────────────────────────────────────────────────
-- Enumerations
-- ────────────────────────────────────────────────────────────
CREATE TYPE collection_type AS ENUM (
    'legal_laws',
    'judgments_commercial',
    'judgments_civil',
    'judgments_admin',
    'judgments_criminal',
    'judgments_family',
    'judgments_social',
    'judgments_real_estate',
    'judgments_constitutional',
    'user_documents'
);

CREATE TYPE document_status AS ENUM (
    'processing',
    'pending_review',
    'published',
    'rejected',
    'archived',
    'ready',
    'failed'
);

CREATE TYPE document_visibility AS ENUM (
    'private',
    'pro_only',
    'public'
);

CREATE TYPE owner_type AS ENUM (
    'system',
    'user'
);

CREATE TYPE source_type AS ENUM (
    'pdf_upload',
    'scraping',
    'user_upload'
);

CREATE TYPE job_type AS ENUM (
    'ocr',
    'scraping',
    'embedding',
    'export'
);

CREATE TYPE job_status AS ENUM (
    'pending',
    'processing',
    'done',
    'failed',
    'cancelled'
);

CREATE TYPE subscription_status AS ENUM (
    'trial',
    'active',
    'cancelled',
    'expired',
    'past_due'
);

CREATE TYPE invoice_status AS ENUM (
    'pending',
    'paid',
    'failed',
    'refunded'
);

CREATE TYPE transport_type AS ENUM (
    'sse',
    'stdio',
    'http'
);

CREATE TYPE analysis_status AS ENUM (
    'pending',
    'running',
    'completed',
    'failed'
);

CREATE TYPE auth_type AS ENUM (
    'none',
    'api_key',
    'oauth2',
    'bearer'
);

CREATE TYPE health_status AS ENUM (
    'healthy',
    'degraded',
    'down',
    'unknown'
);

-- ────────────────────────────────────────────────────────────
-- Tables
-- ────────────────────────────────────────────────────────────

-- Cases (matters): a lawyer groups uploaded documents by client case.
-- Each case is owned by a single user (owner_id = Keycloak subject UUID).
CREATE TABLE cases (
    id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id      UUID        NOT NULL,
    title         TEXT        NOT NULL,
    client_name   TEXT,
    case_ref      TEXT,
    description   TEXT,
    status        TEXT        NOT NULL DEFAULT 'open'
                              CHECK (status IN ('open', 'closed', 'archived')),
    -- Structured court-file reference for the mahakim.ma lookup.
    court_type    TEXT,                                  -- 'appeal' | 'first_instance' | 'cassation'
    court_name    TEXT,
    file_number   TEXT,                                  -- "رقم الملف"
    file_code     TEXT,                                  -- "رمز الملف"
    file_year     TEXT,                                  -- "السنة"
    court_section TEXT,                                  -- "القسم / الغرفة" (e.g. القسم التجاري عدد 3)
    court_panel   TEXT,                                  -- "الهيئة" (e.g. الهيئة عدد 3)
    case_category TEXT        DEFAULT 'file',            -- mahakim tab: 'file' | 'hearings'
    -- Background fetch result from https://mahakim.ma.
    mahakim_status     TEXT   NOT NULL DEFAULT 'idle'
                              CHECK (mahakim_status IN
                                ('idle', 'queued', 'processing', 'ready', 'not_found', 'failed', 'unsupported')),
    mahakim_data       JSONB,
    mahakim_fetched_at TIMESTAMPTZ,
    mahakim_error      TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cases_owner_id ON cases (owner_id);
CREATE INDEX idx_cases_updated_at ON cases (updated_at DESC);
-- A case reference is unique per owner (case-insensitive, ignoring blanks).
CREATE UNIQUE INDEX uq_cases_owner_ref
    ON cases (owner_id, lower(case_ref))
    WHERE case_ref IS NOT NULL AND btrim(case_ref) <> '';

-- Documents: core legal documents (laws, judgments, user uploads)
CREATE TABLE documents (
    id                  UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
    title_ar            TEXT            NOT NULL,
    title_fr            TEXT,
    collection          collection_type NOT NULL,
    source_type         source_type     NOT NULL,
    owner_type          owner_type      NOT NULL DEFAULT 'system',
    owner_id            UUID,
    -- For user uploads: the client case this document belongs to.
    case_id             UUID            REFERENCES cases(id) ON DELETE CASCADE,
    -- Legal document taxonomy (contract, pleading, judgment, ...). NULL for system docs.
    document_type       TEXT,
    visibility          document_visibility NOT NULL DEFAULT 'public',
    status              document_status NOT NULL DEFAULT 'processing',
    minio_bucket        TEXT            NOT NULL,
    minio_key           TEXT            NOT NULL,
    file_size_bytes     BIGINT,
    content_type        TEXT,
    page_count          INTEGER,
    pages_status        analysis_status DEFAULT 'pending',
    ocr_text            TEXT,
    word_count          INTEGER,
    jurisdiction        JSONB           DEFAULT '{}',
    reviewed_by         UUID,
    reviewed_at         TIMESTAMPTZ,
    rejection_reason    TEXT,
    error_message       TEXT,
    metadata            JSONB           DEFAULT '{}',
    created_at          TIMESTAMPTZ     DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     DEFAULT NOW()
);

-- Per-document rendered page images (one row per PDF page).
-- The bucket name equals the document UUID (per design choice).
CREATE TABLE document_pages (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page_number     INTEGER NOT NULL,
    minio_bucket    TEXT NOT NULL,
    minio_key       TEXT NOT NULL,
    width           INTEGER,
    height          INTEGER,
    file_size_bytes BIGINT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (document_id, page_number)
);

CREATE INDEX idx_document_pages_document_id ON document_pages (document_id);

-- Chunks: text segments extracted from documents, linked to Qdrant vectors
CREATE TABLE chunks (
    id              UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id     UUID            NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    collection      collection_type NOT NULL,
    content_ar      TEXT            NOT NULL,
    chunk_index     INTEGER         NOT NULL,
    page_number     INTEGER,
    article_ref     TEXT,
    token_count     INTEGER,
    qdrant_id       TEXT,
    created_at      TIMESTAMPTZ     DEFAULT NOW()
);

-- Conversations: chat sessions per user
CREATE TABLE conversations (
    id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID        NOT NULL,
    title_ar    TEXT        NOT NULL DEFAULT 'محادثة جديدة',
    is_archived BOOLEAN     DEFAULT FALSE,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Messages: individual messages within conversations
CREATE TABLE messages (
    id                  UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id     UUID        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role                TEXT        NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content             TEXT        NOT NULL,
    sources             JSONB       DEFAULT '[]',
    tokens_input        INTEGER     DEFAULT 0,
    tokens_output       INTEGER     DEFAULT 0,
    collections_used    TEXT[]      DEFAULT '{}',
    tools_used          JSONB       DEFAULT '[]',
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Sources: scraping/feed source definitions
CREATE TABLE sources (
    id              UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
    name_ar         TEXT            NOT NULL,
    name_fr         TEXT,
    url             TEXT            NOT NULL,
    scraper_type    TEXT            NOT NULL,
    collection      collection_type NOT NULL,
    is_active       BOOLEAN         DEFAULT TRUE,
    last_scraped_at TIMESTAMPTZ,
    config          JSONB           DEFAULT '{}',
    created_at      TIMESTAMPTZ     DEFAULT NOW()
);

-- Jobs: background processing tasks (OCR, scraping, embedding, export)
CREATE TABLE jobs (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    type            job_type    NOT NULL,
    status          job_status  NOT NULL DEFAULT 'pending',
    document_id     UUID        REFERENCES documents(id) ON DELETE SET NULL,
    source_id       UUID        REFERENCES sources(id) ON DELETE SET NULL,
    progress        INTEGER     DEFAULT 0,
    total_pages     INTEGER,
    processed_pages INTEGER     DEFAULT 0,
    error_log       TEXT,
    metadata        JSONB       DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Subscription plans: tiered pricing for Moroccan market
CREATE TABLE subscription_plans (
    id                      UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
    name_ar                 TEXT            NOT NULL,
    name_fr                 TEXT            NOT NULL,
    price_monthly_mad       DECIMAL(10,2)   NOT NULL,
    price_yearly_mad        DECIMAL(10,2)   NOT NULL,
    max_messages_per_day    INTEGER         NOT NULL,
    max_searches_per_day    INTEGER         NOT NULL,
    max_uploads_per_month   INTEGER         NOT NULL,
    max_storage_gb          DECIMAL(5,2)    NOT NULL,
    has_sources             BOOLEAN         DEFAULT FALSE,
    has_references          BOOLEAN         DEFAULT FALSE,
    has_history             BOOLEAN         DEFAULT FALSE,
    has_export              BOOLEAN         DEFAULT FALSE,
    has_upload              BOOLEAN         DEFAULT FALSE,
    is_active               BOOLEAN         DEFAULT TRUE,
    created_at              TIMESTAMPTZ     DEFAULT NOW()
);

-- Subscriptions: user ↔ plan mapping
CREATE TABLE subscriptions (
    id              UUID                    PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID                    NOT NULL UNIQUE,
    plan_id         UUID                    REFERENCES subscription_plans(id) ON DELETE SET NULL,
    status          subscription_status     NOT NULL DEFAULT 'trial',
    started_at      TIMESTAMPTZ             DEFAULT NOW(),
    expires_at      TIMESTAMPTZ,
    auto_renew      BOOLEAN                 DEFAULT TRUE,
    payment_method  JSONB                   DEFAULT '{}',
    created_at      TIMESTAMPTZ             DEFAULT NOW(),
    updated_at      TIMESTAMPTZ             DEFAULT NOW()
);

-- Usage records: aggregated per-user monthly usage for billing
CREATE TABLE usage_records (
    user_id             UUID            NOT NULL,
    month               CHAR(7)         NOT NULL,  -- format: YYYY-MM
    messages_count      INTEGER         DEFAULT 0,
    searches_count      INTEGER         DEFAULT 0,
    tokens_input        BIGINT          DEFAULT 0,
    tokens_output       BIGINT          DEFAULT 0,
    ocr_pages           INTEGER         DEFAULT 0,
    openai_cost_usd     DECIMAL(10,6)   DEFAULT 0,
    mistral_cost_usd    DECIMAL(10,6)   DEFAULT 0,
    total_cost_usd      DECIMAL(10,6)   DEFAULT 0,
    PRIMARY KEY (user_id, month)
);

-- Invoices: billing records
CREATE TABLE invoices (
    id                  UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id             UUID            NOT NULL,
    subscription_id     UUID            REFERENCES subscriptions(id) ON DELETE SET NULL,
    invoice_number      TEXT            NOT NULL UNIQUE,
    amount_mad          DECIMAL(10,2)   NOT NULL,
    status              invoice_status  NOT NULL DEFAULT 'pending',
    pdf_minio_key       TEXT,
    payment_gateway     TEXT,
    issued_at           TIMESTAMPTZ     DEFAULT NOW(),
    paid_at             TIMESTAMPTZ
);

-- User upload quotas: track monthly upload limits per user
CREATE TABLE user_upload_quotas (
    user_id             UUID    NOT NULL,
    month               CHAR(7) NOT NULL,  -- format: YYYY-MM
    documents_uploaded  INTEGER DEFAULT 0,
    pages_processed     INTEGER DEFAULT 0,
    storage_used_bytes  BIGINT  DEFAULT 0,
    PRIMARY KEY (user_id, month)
);

-- Skills: system prompt presets for domain-specific AI behaviour
CREATE TABLE skills (
    id                      UUID                PRIMARY KEY DEFAULT uuid_generate_v4(),
    name_ar                 TEXT                NOT NULL,
    name_fr                 TEXT                NOT NULL,
    system_prompt           TEXT                NOT NULL,
    icon                    TEXT,
    is_active               BOOLEAN             DEFAULT TRUE,
    is_default              BOOLEAN             DEFAULT FALSE,
    applicable_collections  collection_type[]   DEFAULT '{}',
    created_at              TIMESTAMPTZ         DEFAULT NOW()
);

-- Tools: callable functions exposed to the AI agent
CREATE TABLE tools (
    id                      UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                    TEXT        NOT NULL UNIQUE,
    name_ar                 TEXT        NOT NULL,
    name_fr                 TEXT        NOT NULL,
    function_schema         JSONB       NOT NULL,
    implementation_code     TEXT        NOT NULL,
    is_active               BOOLEAN     DEFAULT TRUE,
    requires_subscription   BOOLEAN     DEFAULT FALSE,
    timeout_ms              INTEGER     DEFAULT 5000,
    created_at              TIMESTAMPTZ DEFAULT NOW()
);

-- MCP servers: Model Context Protocol server registrations
CREATE TABLE mcp_servers (
    id                  UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
    name_ar             TEXT            NOT NULL,
    name_fr             TEXT            NOT NULL,
    endpoint_url        TEXT            NOT NULL,
    transport_type      transport_type  NOT NULL DEFAULT 'sse',
    auth_type           auth_type       NOT NULL DEFAULT 'none',
    auth_config         JSONB           DEFAULT '{}',
    available_tools     JSONB           DEFAULT '[]',
    is_active           BOOLEAN         DEFAULT TRUE,
    health_status       health_status   NOT NULL DEFAULT 'unknown',
    last_health_check   TIMESTAMPTZ,
    created_at          TIMESTAMPTZ     DEFAULT NOW()
);

-- Agent configurations: named AI agent profiles combining skills, tools, and MCP servers
CREATE TABLE agent_configurations (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    name_ar         TEXT        NOT NULL,
    name_fr         TEXT        NOT NULL,
    skill_ids       UUID[]      DEFAULT '{}',
    tool_ids        UUID[]      DEFAULT '{}',
    mcp_server_ids  UUID[]      DEFAULT '{}',
    model           TEXT        NOT NULL DEFAULT 'gpt-4o',
    temperature     DECIMAL(3,2) DEFAULT 0.7,
    max_tokens      INTEGER     DEFAULT 4096,
    is_active       BOOLEAN     DEFAULT TRUE,
    is_default      BOOLEAN     DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Rate limits: sliding-window rate limiting store
CREATE TABLE rate_limits (
    identifier      TEXT        NOT NULL,
    action          TEXT        NOT NULL,
    count           INTEGER     DEFAULT 0,
    window_start    TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (identifier, action)
);

-- ────────────────────────────────────────────────────────────
-- Indexes
-- ────────────────────────────────────────────────────────────

-- Full-text trigram indexes for Arabic content search
CREATE INDEX idx_chunks_content_ar_trgm
    ON chunks USING GIN (content_ar gin_trgm_ops);

CREATE INDEX idx_documents_title_ar_trgm
    ON documents USING GIN (title_ar gin_trgm_ops);

-- Collection-based filtering
CREATE INDEX idx_documents_collection
    ON documents (collection);

CREATE INDEX idx_documents_status
    ON documents (status);

CREATE INDEX idx_documents_visibility
    ON documents (visibility);

CREATE INDEX idx_documents_owner
    ON documents (owner_type, owner_id);

CREATE INDEX idx_documents_case_id
    ON documents (case_id);

CREATE INDEX idx_chunks_document_id
    ON chunks (document_id);

CREATE INDEX idx_chunks_collection
    ON chunks (collection);

CREATE INDEX idx_chunks_qdrant_id
    ON chunks (qdrant_id);

-- Conversation and message indexes
CREATE INDEX idx_conversations_user_id
    ON conversations (user_id);

CREATE INDEX idx_conversations_updated_at
    ON conversations (updated_at DESC);

CREATE INDEX idx_messages_conversation_id
    ON messages (conversation_id);

CREATE INDEX idx_messages_created_at
    ON messages (created_at DESC);

-- Job queue indexes
CREATE INDEX idx_jobs_status
    ON jobs (status);

CREATE INDEX idx_jobs_type_status
    ON jobs (type, status);

CREATE INDEX idx_jobs_document_id
    ON jobs (document_id);

-- Subscription & billing indexes
CREATE INDEX idx_subscriptions_user_id
    ON subscriptions (user_id);

CREATE INDEX idx_subscriptions_status
    ON subscriptions (status);

CREATE INDEX idx_invoices_user_id
    ON invoices (user_id);

CREATE INDEX idx_invoices_status
    ON invoices (status);

-- Rate limiting index
CREATE INDEX idx_rate_limits_window_start
    ON rate_limits (window_start);

-- ────────────────────────────────────────────────────────────
-- Trigger: auto-update updated_at columns
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_documents_updated_at
    BEFORE UPDATE ON documents
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TRIGGER trg_cases_updated_at
    BEFORE UPDATE ON cases
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TRIGGER trg_conversations_updated_at
    BEFORE UPDATE ON conversations
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TRIGGER trg_jobs_updated_at
    BEFORE UPDATE ON jobs
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TRIGGER trg_subscriptions_updated_at
    BEFORE UPDATE ON subscriptions
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ────────────────────────────────────────────────────────────
-- Seed Data: Subscription Plans
-- ────────────────────────────────────────────────────────────

INSERT INTO subscription_plans (
    id,
    name_ar,
    name_fr,
    price_monthly_mad,
    price_yearly_mad,
    max_messages_per_day,
    max_searches_per_day,
    max_uploads_per_month,
    max_storage_gb,
    has_sources,
    has_references,
    has_history,
    has_export,
    has_upload,
    is_active
) VALUES
(
    uuid_generate_v4(),
    'مجاني',
    'Gratuit',
    0.00,
    0.00,
    10,
    20,
    0,
    0.00,
    FALSE,
    FALSE,
    FALSE,
    FALSE,
    FALSE,
    TRUE
),
(
    uuid_generate_v4(),
    'محترف',
    'Professionnel',
    199.00,
    1990.00,
    100,
    200,
    20,
    5.00,
    TRUE,
    TRUE,
    TRUE,
    TRUE,
    TRUE,
    TRUE
),
(
    uuid_generate_v4(),
    'مؤسسي',
    'Entreprise',
    799.00,
    7990.00,
    1000,
    2000,
    200,
    50.00,
    TRUE,
    TRUE,
    TRUE,
    TRUE,
    TRUE,
    TRUE
);

-- ────────────────────────────────────────────────────────────
-- Seed Data: Default Skill
-- ────────────────────────────────────────────────────────────

INSERT INTO skills (
    id,
    name_ar,
    name_fr,
    system_prompt,
    icon,
    is_active,
    is_default,
    applicable_collections
) VALUES (
    uuid_generate_v4(),
    'المساعد القانوني العام',
    'Assistant Juridique Général',
    'أنت مساعد قانوني متخصص في القانون المغربي. مهمتك مساعدة المستخدمين في فهم النصوص القانونية والأحكام القضائية المغربية. تجيب دائماً باللغة العربية ما لم يطلب المستخدم غير ذلك. تستند إجاباتك إلى النصوص القانونية المغربية الرسمية والأحكام القضائية الصادرة عن المحاكم المغربية. تُشير دائماً إلى المصادر والمراجع القانونية ذات الصلة. لا تقدم استشارات قانونية شخصية وتحيل المستخدم إلى محامٍ مختص عند الحاجة.',
    'scale',
    TRUE,
    TRUE,
    ARRAY[
        'legal_laws',
        'judgments_commercial',
        'judgments_civil',
        'judgments_admin',
        'judgments_criminal',
        'judgments_family',
        'judgments_social',
        'judgments_real_estate',
        'judgments_constitutional',
        'user_documents'
    ]::collection_type[]
);

-- ────────────────────────────────────────────────────────────
-- Seed Data: Default Agent Configuration
-- ────────────────────────────────────────────────────────────

INSERT INTO agent_configurations (
    id,
    name_ar,
    name_fr,
    model,
    temperature,
    max_tokens,
    is_active,
    is_default
) VALUES (
    uuid_generate_v4(),
    'الوكيل القانوني الافتراضي',
    'Agent Juridique par Défaut',
    'gpt-4o',
    0.7,
    4096,
    TRUE,
    TRUE
);

-- ────────────────────────────────────────────────────────────
-- Judgment Analyses (Claude Code CLI — admin)
-- One row per uploaded judgment PDF + its structured French analysis.
-- ────────────────────────────────────────────────────────────
CREATE TABLE judgment_analyses (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    filename        TEXT NOT NULL,
    pdf_bucket      TEXT NOT NULL,
    pdf_key         TEXT NOT NULL,
    status          analysis_status NOT NULL DEFAULT 'pending',
    markdown_result TEXT,
    error_message   TEXT,
    model           TEXT,
    prompt_version  TEXT NOT NULL DEFAULT 'v1',
    created_by      UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_judgment_analyses_status     ON judgment_analyses (status);
CREATE INDEX idx_judgment_analyses_created_by ON judgment_analyses (created_by);
CREATE INDEX idx_judgment_analyses_created_at ON judgment_analyses (created_at DESC);
