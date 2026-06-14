/**
 * Reporting API — frontend bindings for the report generation system.
 *
 * Endpoints exposed by ``api/routes/reporting.py``:
 *
 *   GET    /reporting/templates                                 — list templates
 *   POST   /reporting/templates                                 — create template directory with starter HTML/CSS
 *   DELETE /reporting/templates/{id}                            — delete one template directory
 *   GET    /reporting/templates/{id}/tokens                     — DSL tokens + tagged blocks
 *   GET    /reporting/templates/{id}/definitions                — read YAML
 *   POST   /reporting/templates/{id}/bootstrap                  — start bootstrap (SSE job)
 *   GET    /reporting/templates/bootstrap/{job_id}/events       — bootstrap SSE
 *   GET    /reporting/templates/bootstrap/{job_id}/status       — bootstrap status
 *   POST   /reporting/templates/{id}/render                     — render (sync or async SSE)
 *   GET    /reporting/templates/render/{job_id}/events          — render SSE
 *   GET    /reporting/templates/render/{job_id}/status          — render status
 *   POST   /reporting/templates/{id}/blocks/{block_id}          — redefine a single block
 *   POST   /reporting/templates/{id}/blocks/{block_id}/preview  — run block CTE & return rows
 *   GET    /reporting/templates/{id}/blocks/{block_id}/sql-source — resolved SQL source for one block
 *   POST   /reporting/templates/{id}/blocks/{block_id}/generate-insurance-production-cte — draft SQL from insurance_production DAG
 *   POST   /reporting/templates/{id}/edit-agent                 — start edit-agent (SSE job)
 *   GET    /reporting/templates/edit-agent/{job_id}/events      — edit-agent SSE
 *   GET    /reporting/templates/edit-agent/{job_id}/status      — edit-agent status
 *   PUT    /reporting/templates/{id}/template-html               — replace report-template.html
 *   PUT    /reporting/templates/{id}/report-css                   — replace report.css
 *
 * The SSE event shape is identical across the three flows (``{step,
 * message, ...extra}``) so a single :class:`streamReportEvents` helper
 * covers every case.
 *
 * Data model
 * ──────────
 * The reporting pipeline is **block-based**.  ``definitions.yaml``
 * carries a ``blocks: ReportBlockDefinition[]`` list (the per-field
 * schema is no longer supported).  Every ``<div data-block="…">``
 * in the template owns one block; the scanner exposes those tagged
 * regions via ``ReportTokens.tokens.blocks`` so the frontend can
 * render each as a clickable "Définir avec l'agent" frame.
 */

const API_URL = (import.meta.env.VITE_API_URL || "").replace(/\/+$/, "");
const API_KEY = import.meta.env.VITE_AUTH_KEY;
const SESSION_STORAGE_KEY = "lumo_session_id";

function getSessionId(): string {
    return localStorage.getItem(SESSION_STORAGE_KEY) || "";
}

function authHeaders(): Record<string, string> {
    return {
        "X-API-Key": API_KEY,
        "x-session-id": getSessionId(),
        "ngrok-skip-browser-warning": "true",
    };
}


/**
 * FastAPI raises ``HTTPException(status, detail)`` which serialises as
 * ``{"detail": "human readable message"}``.  Surfacing that string in
 * the thrown ``Error`` makes toast/banner messages dramatically clearer
 * (e.g. "definitions.yaml missing for model1; run bootstrap first"
 * instead of just "renderReportSync: 409").
 */
async function readError(prefix: string, r: Response): Promise<Error> {
    const body = await r.text();
    let message = body;
    let detail: any = body;
    try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed.detail === "string") {
            message = parsed.detail;
            detail = parsed.detail;
        } else if (parsed && parsed.detail) {
            message = JSON.stringify(parsed.detail);
            detail = parsed.detail;
        }
    } catch {
        /* keep raw body */
    }
    const err = new Error(`${prefix}: ${r.status} ${message}`.trim());
    (err as any).status = r.status;
    (err as any).detail = detail;
    return err;
}


// ── Shared types ───────────────────────────────────────────────────────────

export interface ReportEvent {
    step: string;
    message: string;
    /** Bootstrap/render-only — populated on the final summary line. */
    status?: "completed" | "failed" | "running";
    /** Bootstrap/render-only — final ``run_*`` result on the summary line. */
    result?: any;
    /** Wall-clock seconds (summary line only). */
    elapsed?: number;
    /** Anything extra emitted by the backend node. */
    [extra: string]: any;
}

export type SubmitJobPhase = "idle" | "running" | "completed" | "failed";

export type ReportBlockKind =
    | "scalar"
    | "section"
    | "condition"
    | "narrative"
    | "chart_array"
    | "mixed"
    | "empty";

export type ReportBlockStatus =
    | "draft"
    | "validated"
    | "live"
    | "invalid"
    | "deprecated"
    | "skeleton";


// ── Templates ──────────────────────────────────────────────────────────────

export interface ReportTemplateInfo {
    template_id: string;
    has_template_html: boolean;
    has_definitions: boolean;
    /** Number of non-deprecated blocks in ``definitions.yaml``. */
    blocks_count: number;
    version: number;
}

export interface ReportTemplateParameter {
    id: string;
    type?: string;
    default?: any;
    description?: string;
}

export interface CreateReportTemplateRequest {
    template_id: string;
    report_title?: string;
}

export interface CreateReportTemplateResponse {
    template_id: string;
    template_dir: string;
    has_template_html: boolean;
    has_report_css: boolean;
}

export interface DeleteReportTemplateResponse {
    template_id: string;
    deleted: boolean;
}

export async function listReportTemplates(): Promise<ReportTemplateInfo[]> {
    const r = await fetch(`${API_URL}/reporting/templates`, {
        headers: authHeaders(),
    });
    if (!r.ok) throw await readError("listReportTemplates", r);
    return r.json();
}

export async function createReportTemplate(
    body: CreateReportTemplateRequest,
): Promise<CreateReportTemplateResponse> {
    const r = await fetch(`${API_URL}/reporting/templates`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...authHeaders(),
        },
        body: JSON.stringify(body),
    });
    if (!r.ok) throw await readError("createReportTemplate", r);
    return r.json();
}

export async function deleteReportTemplate(
    templateId: string,
): Promise<DeleteReportTemplateResponse> {
    const r = await fetch(`${API_URL}/reporting/templates/${encodeURIComponent(templateId)}`, {
        method: "DELETE",
        headers: authHeaders(),
    });
    if (!r.ok) throw await readError("deleteReportTemplate", r);
    return r.json();
}

/** Result of ``POST .../seed-definitions`` (skeleton YAML, no LLM). */
export interface SeedDefinitionsResult {
    template_id: string;
    version: number;
    blocks_count: number;
    definitions_path: string;
}

/**
 * Create ``definitions.yaml`` with one skeleton block per ``data-block`` in the HTML.
 * Does not run LLM bootstrap — the user fills SQL per block (or uses « Amorcer » for full draft).
 */
export async function seedReportDefinitionsSkeleton(
    templateId: string,
): Promise<SeedDefinitionsResult> {
    const r = await fetch(
        `${API_URL}/reporting/templates/${encodeURIComponent(templateId)}/seed-definitions`,
        {
            method: "POST",
            headers: authHeaders(),
        },
    );
    if (!r.ok) throw await readError("seedReportDefinitionsSkeleton", r);
    return r.json();
}


// ── Tokens (scanner output) ────────────────────────────────────────────────

export interface ReportTokenScalar {
    name: string;
    occurrences: number;
    in_chart_scalar_comment?: boolean;
    lines?: number[];
}

export interface ReportTokenSection {
    name: string;
    parent?: string | null;
    children?: string[];
    inner_tokens?: string[];
    line: number;
}

export interface ReportTokenCondition {
    name: string;
    line: number;
}

export interface ReportTokenNarrative {
    name: string;
    line: number;
    /** Frontend-only: kept for backwards compatibility with the badge tooltip. */
    marker?: string;
}

export interface ReportTokenChartArray {
    name: string;
    line: number;
}

/**
 * One ``<element data-block="<name>">…</element>`` region exposed by
 * :class:`TemplateScanNode`.  Drives the visual preview's clickable
 * frames and the definition list's "skeleton" entries.
 */
export interface ReportTokenBlock {
    /** ``data-block`` attribute value (snake_case, unique per template). */
    name: string;
    /** HTML element name, e.g. ``"div"``, ``"section"``. */
    element: string;
    kind: ReportBlockKind;
    line: number;
    inner_scalars: string[];
    inner_sections: string[];
    inner_conditions: string[];
    inner_narratives: string[];
    inner_chart_arrays: string[];
    /**
     * Outer HTML of the tagged element from its opening tag through the
     * matching close tag (scanner excerpt; may be truncated server-side).
     */
    html_excerpt: string;
}

/** A DSL marker that has no ``data-block`` ancestor — should be fixed in the HTML. */
export interface ReportTokenOrphan {
    kind: "scalar" | "section" | "condition" | "narrative" | "chart_array";
    name: string;
    line: number;
}

export interface ReportTokens {
    template_id: string;
    tokens: {
        scalars:      ReportTokenScalar[];
        sections:     ReportTokenSection[];
        conditions:   ReportTokenCondition[];
        narratives:   ReportTokenNarrative[];
        chart_arrays: ReportTokenChartArray[];
        blocks:       ReportTokenBlock[];
        orphans:      ReportTokenOrphan[];
    };
    /** Flat list of every distinct DSL token name. */
    all_field_ids: string[];
    /**
     * Raw HTML source of the template — re-tokenised by ``TemplatePreview``
     * so each tagged block becomes a clickable frame that opens the
     * edit-agent prompt for that block.
     */
    template_html: string;
    /**
     * Sibling assets shipped with the template (currently ``*.css``)
     * keyed by filename.  ``TemplatePreview`` inlines any
     * ``<link rel="stylesheet" href="<filename>">`` whose href matches
     * a key here so the visual preview iframe renders with real
     * corporate styling instead of unstyled HTML.
     */
    template_assets?: Record<string, string>;
}

export async function getReportTokens(templateId: string): Promise<ReportTokens> {
    const r = await fetch(
        `${API_URL}/reporting/templates/${encodeURIComponent(templateId)}/tokens`,
        { headers: authHeaders() },
    );
    if (!r.ok) throw await readError("getReportTokens", r);
    return r.json();
}


// ── Definitions (raw YAML payload) ─────────────────────────────────────────

/**
 * One sub-CTE inside a ``kind=mixed`` block.  Mirrors the validator
 * schema in :mod:`nodes.reporting.sql_helpers`.
 */
export interface ReportBlockSubCte {
    id:               string;
    kind:             ReportBlockKind;
    tokens?:          string[];
    mapping?:         Record<string, string>;
    grounding_fields?: string[];
    sql?:             string;
    cte_ref?:         string | null;
    style?:           string;
    fallback_text?:   string;
}

/**
 * One block in ``definitions.yaml`` — the unit owning a CTE plus the
 * prompt that justifies its formula.  Inferred ``kind`` matches the
 * structural marker found inside the tagged ``<div>`` (or ``mixed`` when
 * scalars co-exist with one structural marker).
 */
export interface ReportBlockDefinition {
    /** ``data-block`` name on the corresponding ``<div>``. */
    id:               string;
    kind:             ReportBlockKind;
    /** Free-form goal / prompt — fed to the LLM when (re)drafting. */
    goal?:            string;
    /** DSL token names produced by this block (scalars + structural marker). */
    tokens?:          string[];
    /** Optional ``TOKEN -> sql_alias`` map.  Defaults to lowercased token name. */
    mapping?:         Record<string, string>;
    /** For narrative blocks: SQL columns that ground the LLM prose. */
    grounding_fields?: string[];
    /** Inline CTE; either ``sql`` or ``cte_ref`` must be set (not both). */
    sql?:             string;
    /** Reference to a reusable block in ``data/reporting/sql/fragment_library/``. */
    cte_ref?:         string | null;
    /** For ``kind=mixed`` blocks: list of sub-CTEs (one per inner marker). */
    ctes?:            ReportBlockSubCte[];
    depends_on?:      string[];
    style?:           string;
    fallback_text?:   string;
    status?:          ReportBlockStatus;
    deprecated?:      boolean;
    draft_errors?:    string[];
}

export interface ReportDefinitions {
    template_id: string;
    version:     number;
    parameters?: ReportTemplateParameter[];
    sources?:    Array<{ name: string; source_id?: string; description?: string }>;
    blocks:      ReportBlockDefinition[];
    metadata?:   Record<string, any>;
}

export async function getReportDefinitions(
    templateId: string,
): Promise<ReportDefinitions> {
    const r = await fetch(
        `${API_URL}/reporting/templates/${encodeURIComponent(templateId)}/definitions`,
        { headers: authHeaders() },
    );
    if (!r.ok) throw await readError("getReportDefinitions", r);
    return r.json();
}

export interface TemplateParametersSaved {
    template_id: string;
    version: number;
    parameters: ReportTemplateParameter[];
}

export async function updateReportTemplateParameters(
    templateId: string,
    parameters: ReportTemplateParameter[],
): Promise<TemplateParametersSaved> {
    const r = await fetch(
        `${API_URL}/reporting/templates/${encodeURIComponent(templateId)}/parameters`,
        {
            method: "PUT",
            headers: { ...authHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify({ parameters }),
        },
    );
    if (!r.ok) throw await readError("updateReportTemplateParameters", r);
    return r.json();
}


/** Response from ``PUT /reporting/templates/{id}/template-html``. */
export interface TemplateHtmlSaved {
    ok:             boolean;
    template_id:    string;
    bytes_written?: number;
}

/** Persist the full contents of ``report-template.html`` (atomic write on the server). */
export async function saveReportTemplateHtml(
    templateId: string,
    html: string,
): Promise<TemplateHtmlSaved> {
    const r = await fetch(
        `${API_URL}/reporting/templates/${encodeURIComponent(templateId)}/template-html`,
        {
            method:  "PUT",
            headers: { ...authHeaders(), "Content-Type": "application/json" },
            body:    JSON.stringify({ html }),
        },
    );
    if (!r.ok) throw await readError("saveReportTemplateHtml", r);
    return r.json();
}


/** Response from ``PUT /reporting/templates/{id}/report-css``. */
export interface ReportCssSaved {
    ok:             boolean;
    template_id:    string;
    bytes_written?: number;
}

/** Persist ``report.css`` alongside ``report-template.html`` (atomic write on the server). */
export async function saveReportCss(
    templateId: string,
    css: string,
): Promise<ReportCssSaved> {
    const r = await fetch(
        `${API_URL}/reporting/templates/${encodeURIComponent(templateId)}/report-css`,
        {
            method:  "PUT",
            headers: { ...authHeaders(), "Content-Type": "application/json" },
            body:    JSON.stringify({ css }),
        },
    );
    if (!r.ok) throw await readError("saveReportCss", r);
    return r.json();
}


// ── Single-block redefinition (no LLM) ─────────────────────────────────────

/**
 * Mirrors ``BlockUpsertRequest`` on the backend — used by the inline
 * edit UX to save a block without driving the agent.  Only fields you
 * want to change need to be provided; existing values are merged.
 */
export interface BlockUpsertRequest {
    kind:             ReportBlockKind;
    goal?:            string;
    tokens?:          string[];
    mapping?:         Record<string, string>;
    grounding_fields?: string[];
    sql?:             string;
    cte_ref?:         string | null;
    ctes?:            ReportBlockSubCte[];
    depends_on?:      string[];
    style?:           string;
    fallback_text?:   string;
}

export interface BlockUpsertResponse {
    template_id:      string;
    block_id:         string;
    /** ``"created"`` if the block was new in the YAML, ``"updated"`` otherwise. */
    action:           "created" | "updated";
    version:          number;
    final_aliases:    string[];
    referenced_params: string[];
    warnings:         string[];
}

export interface SaveCteRequest {
    goal: string;
    max_retries?: number;
}

export interface SaveCteResponse {
    template_id: string;
    block_id: string;
    action: string;
    version: number;
    duration_ms: number;
    block: ReportBlockDefinition;
    validation_summary: Record<string, any>;
}

export async function upsertReportBlock(
    templateId: string,
    blockId: string,
    body: BlockUpsertRequest,
): Promise<BlockUpsertResponse> {
    const r = await fetch(
        `${API_URL}/reporting/templates/` +
        `${encodeURIComponent(templateId)}/blocks/${encodeURIComponent(blockId)}`,
        {
            method:  "POST",
            headers: { ...authHeaders(), "Content-Type": "application/json" },
            body:    JSON.stringify(body),
        },
    );
    if (!r.ok) throw await readError("upsertReportBlock", r);
    return r.json();
}

export async function saveReportBlockCte(
    templateId: string,
    blockId: string,
    body: SaveCteRequest,
): Promise<SaveCteResponse> {
    const r = await fetch(
        `${API_URL}/reporting/templates/` +
        `${encodeURIComponent(templateId)}/blocks/${encodeURIComponent(blockId)}/save-cte`,
        {
            method: "POST",
            headers: { ...authHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify(body),
        },
    );
    if (!r.ok) throw await readError("saveReportBlockCte", r);
    return r.json();
}


// ── Single-block preview (execute CTE and return rows) ────────────────────

/**
 * POST body of ``/reporting/templates/{id}/blocks/{block_id}/preview``.
 * Mirrors :class:`BlockPreviewRequest` on the backend.  All fields are
 * optional — a CTE that needs no ``$param`` and no parquet view can be
 * previewed with ``previewReportBlock(t, b)``.
 */
export interface BlockPreviewRequest {
    /** Values bound to ``$param`` placeholders in the SQL. */
    parameters?:    Record<string, any>;
    /** ``{source_name -> filesystem path}`` registered as DuckDB views. */
    parquet_paths?: Record<string, string>;
    /** Max rows to return (capped to 200 backend-side). */
    limit?:         number;
    /**
     * For ``kind=mixed`` blocks: ``id`` of one entry in ``ctes[]`` whose
     * SQL is executed (same DuckDB setup as a leaf block).
     */
    sub_block_id?:   string;
}

export interface BlockPreviewResult {
    template_id:        string;
    block_id:           string;
    /** Set when a ``kind=mixed`` parent was previewed via ``sub_block_id``. */
    sub_block_id?:      string | null;
    kind:               string;
    /** Original (un-expanded) CTE source — exactly what's in ``definitions.yaml``. */
    sql:                string;
    /** SQL after ``{{include: …}}`` expansion (what DuckDB actually ran). */
    expanded_sql:       string;
    columns:            string[];
    /** Each row is a list of cell values, JSON-coerced (dates → ISO strings, etc.). */
    rows:               any[][];
    row_count:          number;
    truncated:          boolean;
    referenced_params:  string[];
    bound_params:       Record<string, any>;
    duration_ms:        number;
    warnings:           string[];
    /**
     * ``{source_name -> filesystem path}`` map of which parquet file
     * was *actually* used per declared source.  Surfaces the backend's
     * auto-resolution so the UI can confirm what ran (helpful when
     * ``parquet_paths`` was omitted from the request).
     */
    resolved_parquet_paths?: Record<string, string>;
}

export interface BlockSqlSourceResult {
    template_id: string;
    block_id: string;
    sub_block_id?: string | null;
    kind: string;
    source_mode: string;
    cte_ref?: string | null;
    source_path?: string | null;
    sql: string;
    expanded_sql: string;
}

export async function getReportBlockSqlSource(
    templateId: string,
    blockId: string,
    subBlockId?: string | null,
): Promise<BlockSqlSourceResult> {
    const query = subBlockId
        ? `?sub_block_id=${encodeURIComponent(subBlockId)}`
        : "";
    const r = await fetch(
        `${API_URL}/reporting/templates/` +
        `${encodeURIComponent(templateId)}/blocks/` +
        `${encodeURIComponent(blockId)}/sql-source${query}`,
        {
            headers: authHeaders(),
        },
    );
    if (!r.ok) throw await readError("getReportBlockSqlSource", r);
    return r.json();
}

export interface GenerateInsuranceCteRequest {
    leaf_cte?: string | null;
}

export interface GenerateInsuranceCteResponse {
    template_id: string;
    block_id: string;
    leaf_cte: string;
    depends_ordered: string[];
    generated_sql: string;
    expanded_sql: string;
    validation_ok: boolean;
    validation_errors: string[];
}

export async function generateInsuranceProductionCte(
    templateId: string,
    blockId: string,
    body: GenerateInsuranceCteRequest = {},
): Promise<GenerateInsuranceCteResponse> {
    const r = await fetch(
        `${API_URL}/reporting/templates/` +
        `${encodeURIComponent(templateId)}/blocks/` +
        `${encodeURIComponent(blockId)}/generate-insurance-production-cte`,
        {
            method: "POST",
            headers: { ...authHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify(body),
        },
    );
    if (!r.ok) throw await readError("generateInsuranceProductionCte", r);
    return r.json();
}

/**
 * Execute a single block's CTE on the backend and return its rows.
 *
 * Errors are surfaced as ``HTTPException(422)`` so the UI can render
 * the SQL execution error inline.  Pass ``parquet_paths`` (mapped on
 * ``definitions.yaml.sources[*].name``) when the CTE references a
 * source view; otherwise pure-SELECT CTEs work without any binding.
 */
export async function previewReportBlock(
    templateId: string,
    blockId: string,
    body: BlockPreviewRequest = {},
): Promise<BlockPreviewResult> {
    const r = await fetch(
        `${API_URL}/reporting/templates/` +
        `${encodeURIComponent(templateId)}/blocks/` +
        `${encodeURIComponent(blockId)}/preview`,
        {
            method:  "POST",
            headers: { ...authHeaders(), "Content-Type": "application/json" },
            body:    JSON.stringify(body),
        },
    );
    if (!r.ok) throw await readError("previewReportBlock", r);
    return r.json();
}


// ── Parquet source discovery ──────────────────────────────────────────────

/**
 * One parquet file discovered under ``data/parquet/`` on the backend.
 * Mirrors :class:`ParquetFileEntry` in ``api/routes/reporting.py``.
 */
export interface ParquetFileEntry {
    /** Bare filename, e.g. ``grand_livre_2025_…_xlsx.parquet``. */
    filename:        string;
    /** Absolute path on the backend's filesystem. */
    path:            string;
    size_bytes:      number;
    /** Column names exposed by the parquet (post-introspection). */
    columns:         string[];
    /** ``true`` for embedding indexes (read-only — cannot back a CTE source). */
    is_embeddings:   boolean;
    /** Coarse classification: ``"ledger"`` / ``"balance"`` / ``"unknown"``. */
    kind:            string;
    /** Names of ``definitions.sources[*]`` entries this file can fulfil. */
    matches_sources: string[];
    /** Human-friendly label (e.g. ``"Grand livre · 2025-01-01 → 2025-12-31"``). */
    label:           string;
}

export interface ParquetFileListResult {
    parquet_dir:    string;
    files:          ParquetFileEntry[];
    /**
     * Suggested ``{source_name -> path}`` map for the requested
     * ``template_id``.  Empty when the caller didn't pass a template
     * id — discovery alone doesn't know which sources to map.
     */
    default_paths:  Record<string, string>;
}

/**
 * List parquet files available on the backend (``data/parquet/``).
 *
 * Pass ``templateId`` to get a ``default_paths`` suggestion that maps
 * each ``definitions.sources[*]`` entry to the latest matching file —
 * the UI can use it as the initial selection.  ``includeEmbeddings``
 * defaults to ``false`` because ``*_embeddings.parquet`` files cannot
 * back a CTE source.
 */
export async function listParquetFiles(
    templateId?: string,
    includeEmbeddings = false,
): Promise<ParquetFileListResult> {
    const params = new URLSearchParams();
    if (templateId) params.set("template_id", templateId);
    if (includeEmbeddings) params.set("include_embeddings", "true");
    const qs = params.toString();
    const r = await fetch(
        `${API_URL}/reporting/parquet-files${qs ? `?${qs}` : ""}`,
        { headers: authHeaders() },
    );
    if (!r.ok) throw await readError("listParquetFiles", r);
    return r.json();
}


// ── Bootstrap ──────────────────────────────────────────────────────────────

export interface BootstrapStarted {
    job_id:      string;
    template_id: string;
    message:     string;
}

export async function startReportBootstrap(
    templateId: string,
    parquetCacheDir?: string,
): Promise<BootstrapStarted> {
    const r = await fetch(
        `${API_URL}/reporting/templates/${encodeURIComponent(templateId)}/bootstrap`,
        {
            method:  "POST",
            headers: { ...authHeaders(), "Content-Type": "application/json" },
            body:    JSON.stringify({ parquet_cache_dir: parquetCacheDir ?? null }),
        },
    );
    if (!r.ok) throw await readError("startReportBootstrap", r);
    return r.json();
}

export interface ReportJobStatus {
    job_id:        string;
    status:        SubmitJobPhase;
    started_at?:   number | null;
    finished_at?:  number | null;
    error?:        string | null;
    result?:       any;
    last_event?:   ReportEvent | null;
}

export async function getReportBootstrapStatus(
    jobId: string,
): Promise<ReportJobStatus> {
    const r = await fetch(
        `${API_URL}/reporting/templates/bootstrap/${encodeURIComponent(jobId)}/status`,
        { headers: authHeaders() },
    );
    if (!r.ok) throw await readError("getReportBootstrapStatus", r);
    return r.json();
}


// ── Render ─────────────────────────────────────────────────────────────────

export interface RenderRequestBody {
    parameters?:              Record<string, any>;
    parquet_paths?:           Record<string, string>;
    pre_supplied_narratives?: Record<string, string>;
    async_mode?:              boolean;
}

/** Per-block error surfaced by ``ReportSqlBatchNode`` when a CTE failed. */
export interface RenderSqlError {
    block_id?: string;
    kind?:     ReportBlockKind;
    target?:   string;
    error?:    string;
}

export interface RenderResult {
    template_id:        string;
    success:            boolean;
    html?:              string;
    missing?:           string[];
    sql_errors?:        RenderSqlError[];
    sql_summary?:       Record<string, any>;
    narrative_summary?: Record<string, any>;
    render_flags?:      Record<string, boolean>;
    duration_ms?:       number;
    error?:             string | null;
}

export interface RenderJobStarted {
    job_id:      string;
    template_id: string;
    message:     string;
}

/** Synchronous render — returns the HTML inline. */
export async function renderReportSync(
    templateId: string,
    body: RenderRequestBody = {},
): Promise<RenderResult> {
    const r = await fetch(
        `${API_URL}/reporting/templates/${encodeURIComponent(templateId)}/render`,
        {
            method:  "POST",
            headers: { ...authHeaders(), "Content-Type": "application/json" },
            body:    JSON.stringify({ ...body, async_mode: false }),
        },
    );
    if (!r.ok) throw await readError("renderReportSync", r);
    return r.json();
}

/** Async render — fire-and-forget; subscribe via :func:`streamReportEvents`. */
export async function startReportRender(
    templateId: string,
    body: RenderRequestBody = {},
): Promise<RenderJobStarted> {
    const r = await fetch(
        `${API_URL}/reporting/templates/${encodeURIComponent(templateId)}/render`,
        {
            method:  "POST",
            headers: { ...authHeaders(), "Content-Type": "application/json" },
            body:    JSON.stringify({ ...body, async_mode: true }),
        },
    );
    if (!r.ok) throw await readError("startReportRender", r);
    return r.json();
}

export async function getReportRenderStatus(jobId: string): Promise<ReportJobStatus> {
    const r = await fetch(
        `${API_URL}/reporting/templates/render/${encodeURIComponent(jobId)}/status`,
        { headers: authHeaders() },
    );
    if (!r.ok) throw await readError("getReportRenderStatus", r);
    return r.json();
}


// ── Edit-agent (chat session) ──────────────────────────────────────────────

export interface EditAgentRequestBody {
    query:                  string;
    session_id?:            string;
    max_iterations?:        number;
    parquet_paths?:         Record<string, string>;
    parquet_cache_dir?:     string;
    initial_messages?:      Array<{ role: string; content: string }>;
}

export interface EditAgentJobStarted {
    job_id:      string;
    template_id: string;
    message:     string;
}

export interface EditAgentResult {
    response:         string;
    iterations:       number;
    definitions_path: string;
    session_id:       string;
}

export async function startReportEditAgent(
    templateId: string,
    body: EditAgentRequestBody,
): Promise<EditAgentJobStarted> {
    const r = await fetch(
        `${API_URL}/reporting/templates/${encodeURIComponent(templateId)}/edit-agent`,
        {
            method:  "POST",
            headers: { ...authHeaders(), "Content-Type": "application/json" },
            body:    JSON.stringify(body),
        },
    );
    if (!r.ok) throw await readError("startReportEditAgent", r);
    return r.json();
}

export async function getReportEditAgentStatus(
    jobId: string,
): Promise<ReportJobStatus> {
    const r = await fetch(
        `${API_URL}/reporting/templates/edit-agent/${encodeURIComponent(jobId)}/status`,
        { headers: authHeaders() },
    );
    if (!r.ok) throw await readError("getReportEditAgentStatus", r);
    return r.json();
}


// ── Generic SSE consumer ───────────────────────────────────────────────────

/**
 * Stream events from a long-running reporting job (bootstrap / render /
 * edit-agent).  Returns an unsubscribe function.  The connection auto-
 * closes once the backend emits the final ``summary`` event.
 *
 * @param kind  Which job kind to subscribe to.
 * @param jobId The job id returned by the corresponding ``start*`` call.
 * @param onEvent Called for every parsed SSE payload.
 * @param onDone  Called when the stream closes cleanly (after summary).
 * @param onError Called on network / parse errors (only when not aborted).
 */
export function streamReportEvents(
    kind: "bootstrap" | "render" | "edit-agent",
    jobId: string,
    onEvent: (evt: ReportEvent) => void,
    onDone?: () => void,
    onError?: (err: Error) => void,
): () => void {
    const url = `${API_URL}/reporting/templates/${kind}/${encodeURIComponent(jobId)}/events`;
    const controller = new AbortController();

    (async () => {
        try {
            const response = await fetch(url, {
                headers: authHeaders(),
                signal:  controller.signal,
            });
            if (!response.ok) throw new Error(`SSE error: ${response.status}`);
            const reader = response.body?.getReader();
            if (!reader) throw new Error("No response body");

            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                    if (line.startsWith("data: ")) {
                        try {
                            const evt: ReportEvent = JSON.parse(line.slice(6));
                            onEvent(evt);
                        } catch {
                            /* skip malformed payloads */
                        }
                    }
                }
            }
            onDone?.();
        } catch (err) {
            if (!controller.signal.aborted) {
                onError?.(err instanceof Error ? err : new Error(String(err)));
            }
        }
    })();

    return () => controller.abort();
}
