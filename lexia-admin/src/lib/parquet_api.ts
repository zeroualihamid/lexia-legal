const API_URL = (import.meta.env.VITE_API_URL || "").replace(/\/+$/, "");
const API_KEY = import.meta.env.VITE_AUTH_KEY;
const SESSION_STORAGE_KEY = "lumo_session_id";

// Session ID management (sync with chat_api.ts)
function getSessionId(): string {
    return localStorage.getItem(SESSION_STORAGE_KEY) || "";
}

function getSessionHeaders(): Record<string, string> {
    const sessionId = getSessionId();
    return {
        "x-session-id": sessionId,
        "ngrok-skip-browser-warning": "true",
    };
}

// Interfaces matching Python Pydantic models
export interface SourceTableInfo {
    table_id: string;
    table_name?: string | null;
    enabled: boolean;
    description?: string | null;
    has_cache: boolean;
}

export interface SourceStatus {
    source_id: string;
    source_type: string;
    description: string;
    refresh_policy: string;
    /** When false, source is kept in YAML but excluded from loaders. */
    enabled?: boolean;
    last_refresh: string | null;
    last_refresh_status: string;
    row_count: number;
    column_count: number;
    cache_size_mb: number | null;
    next_refresh_seconds: number | null;
    tables?: SourceTableInfo[] | null;
}

export interface ParquetFileHead {
    file: string;
    path: string;
    source_id: string | null;
    table_id: string | null;
    enabled: boolean | null;
    cache_type: string | null;
    rows: any[];
    columns: string[];
    row_count: number;
    column_count: number;
    total_rows?: number;
    offset?: number;
    error?: string;
}

export interface ParquetHeadsResponse {
    cache_dir: string;
    limit: number;
    offset?: number;
    include_embeddings: boolean;
    enabled_only?: boolean;
    count: number;
    files: ParquetFileHead[];
}

export interface RefreshResponse {
    success: boolean;
    source_id: string;
    message: string;
    row_count?: number;
    column_count?: number;
}

export interface SchedulerStatus {
    enabled: boolean;
    message?: string;
    running?: boolean;
    scheduled_jobs?: number;
    [key: string]: any;
}

export interface DataHealthResponse {
    status: "healthy" | "degraded" | "unhealthy";
    total_sources: number;
    sources_ok: number;
    sources_error: number;
    sources_with_embeddings: number;
    scheduler_running: boolean;
    scheduled_sources: number;
    error?: string;
}

export interface ColumnSchemaItem {
    column_name: string;
    description: string;
    type: string;
    is_categorical: boolean;
    sample_values?: string[];
}

export interface ColumnSchemaResponse {
    source_id: string;
    table_id: string | null;
    count: number;
    columns: ColumnSchemaItem[];
}

export interface SQLForeignKeyConfig {
    local_column: string;
    ref_table_id: string;
    ref_column: string;
    ref_source_id?: string | null;
    description?: string | null;
    enabled?: boolean;
}

export interface SQLTableConfigItem {
    table_id: string;
    table_name?: string | null;
    query?: string | null;
    columns_class?: string | null;
    incremental_column?: string | null;
    enabled: boolean;
    description?: string;
    cache_file?: string | null;
    embeddings_file?: string | null;
    foreign_keys?: SQLForeignKeyConfig[];
}

export interface SQLSourceConfigResponse {
    source_id: string;
    type: string;
    enabled: boolean;
    description: string;
    tables: SQLTableConfigItem[];
}

export interface SourceConfigResponse {
    source_id: string;
    type: string;
    enabled: boolean;
    description: string;
    path?: string | null;
    columns_class?: string | null;
    incremental_column?: string | null;
    cache_file?: string | null;
    embeddings_file?: string | null;
    foreign_keys?: SQLForeignKeyConfig[];
    tables?: SQLTableConfigItem[];
}

export interface OracleConnectorSettingsValues {
    user: string;
    password: string;
    host: string;
    port: string;
    service_name: string;
}

export interface OracleConnectorSettingsResponse {
    source_id: string;
    env_file: string;
    description: string;
    enabled: boolean;
    source_exists: boolean;
    registered: boolean;
    tables_count: number;
    values: OracleConnectorSettingsValues;
}

export interface OracleConnectorSettingsUpdateRequest {
    user: string;
    password: string;
    host: string;
    port: number;
    service_name: string;
    enabled?: boolean;
    description?: string;
    source_id?: string;
}

export interface ConnectorProviderField {
    key: string;
    label: string;
    secret: boolean;
    default: string;
}

export interface ConnectorProvider {
    id: string;
    label: string;
    source_type: string;
    default_source_id: string;
    fields: ConnectorProviderField[];
}

export interface ConnectorSettingsResponse {
    provider_id: string;
    label: string;
    source_id: string;
    env_file: string;
    enabled: boolean;
    source_exists: boolean;
    registered: boolean;
    configured: boolean;
    tables_count: number;
    values: Record<string, string>;
}

export interface ConnectorSettingsUpdateRequest {
    values: Record<string, string>;
    enabled?: boolean;
    description?: string;
    source_id?: string;
}

export interface MinioObjectItem {
    object_key: string;
    size: number;
    last_modified?: string | null;
    etag?: string | null;
    is_dir?: boolean;
}

export interface MinioObjectsResponse {
    source_id: string;
    bucket: string;
    endpoint: string;
    prefix: string;
    recursive: boolean;
    count: number;
    total_size: number;
    objects: MinioObjectItem[];
}

export interface MinioObjectMutationResponse {
    success: boolean;
    source_id: string;
    bucket: string;
    endpoint: string;
    object_key: string;
    size?: number | null;
    deleted: boolean;
    message: string;
}

export interface SaveColumnSchemaItem {
    column_name: string;
    description: string;
    type: string;
    is_categorical: boolean;
}

export interface ColumnSuggestionInput {
    column_name: string;
    type: string;
    sample_values: string[];
    current_description?: string;
    is_categorical?: boolean;
}

export interface CsvUploadResponse {
    success: boolean;
    source_id: string;
    filename: string;
    delimiter: string;
    refreshed: boolean;
    message: string;
}

export interface QvdUploadResponse {
    success: boolean;
    source_id: string;
    filename: string;
    job_id: string;
    message: string;
}

export type QvdPipelinePhase =
    | "pending"
    | "archiving"
    | "reading"
    | "writing"
    | "finalizing"
    | "completed"
    | "failed";

export interface QvdPipelineProgress {
    phase: QvdPipelinePhase;
    rows_done: number;
    chunks_done: number;
    total_bytes: number | null;
    phase_message: string;
}

export type QvdPipelinePhaseStatus =
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "skipped";

export interface QvdPipelinePhases {
    upload?: {
        status: QvdPipelinePhaseStatus;
        started_at: number | null;
        finished_at: number | null;
        bytes?: number;
    };
    archive_minio?: {
        status: QvdPipelinePhaseStatus;
        started_at: number | null;
        finished_at: number | null;
        bucket?: string;
        key?: string;
    };
    schema_ready?: {
        status: QvdPipelinePhaseStatus;
        started_at: number | null;
        finished_at: number | null;
        columns: string[];
    };
    conversion?: {
        status: QvdPipelinePhaseStatus;
        started_at: number | null;
        finished_at: number | null;
        rows_done: number;
        chunks_done: number;
        parquet_path: string | null;
    };
}

export interface QvdPipelineStatus {
    job_id: string;
    status: "pending" | "running" | "completed" | "failed";
    source_id: string;
    filename: string;
    elapsed_seconds: number | null;
    error: string | null;
    results: Record<string, any> | null;
    progress?: QvdPipelineProgress | null;
    phases?: QvdPipelinePhases | null;
}

export interface XlsxUploadResponse {
    success: boolean;
    job_id: string;
    file_count: number;
    source_ids: string[];
    filenames: string[];
    message: string;
}

export type XlsxFileStatus = "pending" | "running" | "completed" | "failed";

export interface XlsxFileEntry {
    filename: string;
    source_id: string;
    status: XlsxFileStatus;
    error: string | null;
    results: {
        parquet_path?: string;
        row_count?: number;
        column_count?: number;
        sheet_names?: string[];
        next_steps?: string[];
    } | null;
}

export interface XlsxPipelineStatus {
    job_id: string;
    status: "pending" | "running" | "completed" | "partial" | "failed";
    elapsed_seconds: number | null;
    error: string | null;
    total_files: number;
    completed_files: number;
    failed_files: number;
    files: XlsxFileEntry[];
}

export interface SupabaseSourceCreateRequest {
    source_id: string;
    host: string;
    port?: number;
    database: string;
    username: string;
    password: string;
    db_schema?: string;
    description?: string;
    enabled?: boolean;
    refresh_policy?: string;
}

/**
 * List all registered data sources
 */
export async function listSources(): Promise<SourceStatus[]> {
    const response = await fetch(`${API_URL}/parquet/sources`, {
        method: "GET",
        headers: {
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
    });

    if (!response.ok) {
        throw new Error(`Data API error: ${response.status} - ${await response.text()}`);
    }

    return response.json();
}

/**
 * Get head rows for parquet files whose datasource is enabled in datasources.yaml.
 */
export async function getParquetHeads(
    limit: number = 5,
    includeEmbeddings: boolean = false,
    offset: number = 0
): Promise<ParquetHeadsResponse> {
    const url = new URL(`${API_URL}/parquet/heads`);
    url.searchParams.append("limit", limit.toString());
    url.searchParams.append("include_embeddings", includeEmbeddings.toString());
    url.searchParams.append("offset", offset.toString());

    const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
    });

    if (!response.ok) {
        throw new Error(`Data API error: ${response.status}`);
    }

    return response.json();
}

/**
 * Response returned when existing parquet files would be overwritten and
 * the caller hasn't confirmed yet (HTTP 409).
 */
export interface RefreshConfirmationNeeded {
    needs_confirmation: true;
    source_id: string;
    table_id?: string;
    existing_files: string[];
    message: string;
}

/**
 * Trigger manual refresh for a source.
 *
 * If `confirmOverwrite` is false (default) and parquet files already exist,
 * the backend returns a 409 with details about which files would be overwritten.
 * The caller should inspect the result for `needs_confirmation` and re-call
 * with `confirmOverwrite=true` after user approval.
 */
export async function refreshSource(
    sourceId: string,
    incremental: boolean = false,
    force: boolean = true,
    tableId?: string,
    confirmOverwrite: boolean = false,
): Promise<RefreshResponse | RefreshConfirmationNeeded> {
    const url = new URL(`${API_URL}/parquet/refresh/${sourceId}`);
    url.searchParams.append("incremental", incremental.toString());
    url.searchParams.append("force", force.toString());
    if (tableId) url.searchParams.append("table_id", tableId);
    url.searchParams.append("confirm_overwrite", confirmOverwrite.toString());

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
        const response = await fetch(url.toString(), {
            method: "POST",
            signal: controller.signal,
            headers: {
                "X-API-Key": API_KEY,
                ...getSessionHeaders(),
            },
        });
        clearTimeout(timeout);

        if (response.status === 409) {
            return response.json();
        }

        if (!response.ok) {
            throw new Error(`Refresh API error: ${response.status}`);
        }

        return response.json();
    } catch (err: any) {
        clearTimeout(timeout);
        if (err.name === "AbortError") {
            return { success: false, source_id: sourceId, message: "Refresh timed out after 30s" } as RefreshResponse;
        }
        throw err;
    }
}

export async function getDownloadStatus(jobId: string): Promise<{
    job_id: string; status: string; source_id: string; table_id: string;
    row_count: number | null; error: string | null; elapsed_seconds: number | null;
}> {
    const response = await fetch(`${API_URL}/parquet/download/${jobId}`, {
        headers: { "X-API-Key": API_KEY, ...getSessionHeaders() },
    });
    if (!response.ok) throw new Error(`Download status error: ${response.status}`);
    return response.json();
}

// ── Download Agent (reasoning-capable download with SSE) ──────────────

export interface DownloadEvent {
    ts: string;
    step: string;
    message: string;
    rows_downloaded?: number;
    total_rows?: number;
    batch?: number;
    elapsed?: number;
    rate?: number;
    pct?: number | null;
    error?: string;
    status?: string;
    row_count?: number | null;
    integrity?: Record<string, any>;
    retry?: number;
}

export interface DownloadAgentLookup {
    job_id: string | null;
    status?: string;
    source_id?: string;
    table_id?: string;
    row_count?: number | null;
    total_rows?: number | null;
    error?: string | null;
    elapsed_seconds?: number | null;
    events?: DownloadEvent[];
    last_event?: DownloadEvent | null;
}

export async function lookupDownloadAgent(
    sourceId: string,
    tableId: string,
): Promise<DownloadAgentLookup> {
    const response = await fetch(
        `${API_URL}/parquet/download-agent/lookup/${sourceId}/${tableId}`,
        { headers: { "X-API-Key": API_KEY, ...getSessionHeaders() } },
    );
    if (!response.ok) throw new Error(`Lookup error: ${response.status}`);
    return response.json();
}

export async function startDownloadAgent(
    sourceId: string,
    tableId: string,
    incremental: boolean = false,
    resume: boolean = true,
): Promise<{ job_id: string; source_id: string; table_id: string; message: string; reconnected?: boolean }> {
    const url = new URL(`${API_URL}/parquet/download-agent/${sourceId}/${tableId}`);
    url.searchParams.append("incremental", incremental.toString());
    url.searchParams.append("resume", resume.toString());

    const response = await fetch(url.toString(), {
        method: "POST",
        headers: { "X-API-Key": API_KEY, ...getSessionHeaders() },
    });
    if (!response.ok) throw new Error(`Download agent error: ${response.status}`);
    return response.json();
}

export function streamDownloadEvents(
    jobId: string,
    onEvent: (event: DownloadEvent) => void,
    onDone?: () => void,
    onError?: (error: Error) => void,
): () => void {
    const url = `${API_URL}/parquet/download-agent/${jobId}/events`;
    const controller = new AbortController();

    (async () => {
        try {
            const response = await fetch(url, {
                headers: { "X-API-Key": API_KEY, ...getSessionHeaders() },
                signal: controller.signal,
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
                            const evt: DownloadEvent = JSON.parse(line.slice(6));
                            onEvent(evt);
                        } catch { /* skip malformed */ }
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

export async function getDownloadAgentStatus(jobId: string): Promise<{
    job_id: string; status: string; source_id: string; table_id: string;
    row_count: number | null; total_rows: number | null;
    error: string | null; elapsed_seconds: number | null;
    events: DownloadEvent[]; last_event: DownloadEvent | null;
}> {
    const response = await fetch(`${API_URL}/parquet/download-agent/${jobId}/status`, {
        headers: { "X-API-Key": API_KEY, ...getSessionHeaders() },
    });
    if (!response.ok) throw new Error(`Download agent status error: ${response.status}`);
    return response.json();
}

// ── Embedding Agent (reasoning-capable embedding pipeline with SSE) ──

export interface EmbeddingEvent {
    ts: string;
    step: string;
    message: string;
    column?: string;
    col_index?: number;
    total_columns?: number;
    distinct_count?: number;
    batch?: number;
    total_batches?: number;
    total_texts?: number;
    elapsed?: number;
    error?: string;
    status?: string;
    summary?: Record<string, number>;
}

export interface EmbeddingAgentLookup {
    job_id: string | null;
    status?: string;
    source_id?: string;
    table_id?: string;
    error?: string | null;
    elapsed_seconds?: number | null;
    events?: EmbeddingEvent[];
    last_event?: EmbeddingEvent | null;
    summary?: Record<string, number> | null;
}

export async function lookupEmbeddingAgent(
    sourceId: string,
    tableId?: string,
): Promise<EmbeddingAgentLookup> {
    const url = new URL(`${API_URL}/parquet/embedding-agent/lookup/${sourceId}`);
    if (tableId) url.searchParams.append("table_id", tableId);
    const response = await fetch(url.toString(), {
        headers: { "X-API-Key": API_KEY, ...getSessionHeaders() },
    });
    if (!response.ok) throw new Error(`Embedding lookup error: ${response.status}`);
    return response.json();
}

export async function startEmbeddingAgent(
    sourceId: string,
    categoricalColumns: string[],
    tableId?: string,
): Promise<{ job_id: string; source_id: string; table_id?: string; message: string; reconnected?: boolean }> {
    const response = await fetch(`${API_URL}/parquet/embedding-agent/${sourceId}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
        body: JSON.stringify({
            source_id: sourceId,
            categorical_columns: categoricalColumns,
            table_id: tableId || null,
        }),
    });
    if (!response.ok) throw new Error(`Embedding agent error: ${response.status}`);
    return response.json();
}

export function streamEmbeddingEvents(
    jobId: string,
    onEvent: (event: EmbeddingEvent) => void,
    onDone?: () => void,
    onError?: (error: Error) => void,
): () => void {
    const url = `${API_URL}/parquet/embedding-agent/${jobId}/events`;
    const controller = new AbortController();

    (async () => {
        try {
            const response = await fetch(url, {
                headers: { "X-API-Key": API_KEY, ...getSessionHeaders() },
                signal: controller.signal,
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
                            const evt: EmbeddingEvent = JSON.parse(line.slice(6));
                            onEvent(evt);
                        } catch { /* skip malformed */ }
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

/**
 * Invalidate cache for a source
 */
export async function invalidateCache(sourceId: string, cacheType?: 'data' | 'embeddings'): Promise<{ success: boolean; message: string }> {
    const url = new URL(`${API_URL}/parquet/cache/${sourceId}`);
    if (cacheType) {
        url.searchParams.append("cache_type", cacheType);
    }

    const response = await fetch(url.toString(), {
        method: "DELETE",
        headers: {
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
    });

    if (!response.ok) {
        throw new Error(`Cache API error: ${response.status}`);
    }

    return response.json();
}

/**
 * Get scheduler status
 */
export async function getSchedulerStatus(): Promise<SchedulerStatus> {
    const response = await fetch(`${API_URL}/parquet/scheduler/status`, {
        method: "GET",
        headers: {
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
    });

    if (!response.ok) {
        throw new Error(`Scheduler API error: ${response.status}`);
    }

    return response.json();
}

/**
 * Get detailed status for a specific source
 */
export async function getSourceStatus(sourceId: string): Promise<any> {
    const response = await fetch(`${API_URL}/parquet/status/${sourceId}`, {
        method: "GET",
        headers: {
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
    });

    if (!response.ok) {
        throw new Error(`Status API error: ${response.status}`);
    }

    return response.json();
}

/**
 * Get data health status
 */
export async function getDataHealth(): Promise<DataHealthResponse> {
    const response = await fetch(`${API_URL}/parquet/health`, {
        method: "GET",
        headers: {
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
    });

    if (!response.ok) {
        throw new Error(`Health API error: ${response.status}`);
    }

    return response.json();
}

/**
 * Get embedding statistics for sources
 */
export async function getEmbeddingsStats(sourceId?: string): Promise<any> {
    const url = new URL(`${API_URL}/parquet/embeddings/stats`);
    if (sourceId) url.searchParams.append("source_id", sourceId);

    const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
    });

    if (!response.ok) {
        throw new Error(`Embedding stats API error: ${response.status}`);
    }

    return response.json();
}

/**
 * Search embeddings
 */
export async function searchEmbeddings(params: {
    query: string;
    source_ids?: string[];
    column_name?: string;
    threshold?: number;
    top_k?: number;
}): Promise<any> {
    const url = new URL(`${API_URL}/parquet/embeddings/search`);
    url.searchParams.append("query", params.query);
    if (params.source_ids) params.source_ids.forEach(id => url.searchParams.append("source_ids", id));
    if (params.column_name) url.searchParams.append("column_name", params.column_name);
    if (params.threshold) url.searchParams.append("threshold", params.threshold.toString());
    if (params.top_k) url.searchParams.append("top_k", params.top_k.toString());

    const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
    });

    if (!response.ok) {
        throw new Error(`Search API error: ${response.status}`);
    }

    return response.json();
}

/**
 * Search column embeddings by cosine similarity against a user query.
 */
export async function columnEmbeddingSearch(params: {
    query: string;
    source_id: string;
    column_name: string;
    table_id?: string;
    threshold?: number;
    top_k?: number;
}): Promise<{
    query: string;
    column_name: string;
    threshold: number;
    total_results: number;
    results: Array<{
        distinct_value: string;
        column_name: string;
        similarity: number;
        name_similarity: number;
        definition_similarity: number;
        definitions: string[];
        source_id: string;
    }>;
}> {
    const url = new URL(`${API_URL}/parquet/embeddings/column-search`);
    url.searchParams.append("query", params.query);
    url.searchParams.append("source_id", params.source_id);
    url.searchParams.append("column_name", params.column_name);
    if (params.table_id) url.searchParams.append("table_id", params.table_id);
    if (params.threshold != null) url.searchParams.append("threshold", params.threshold.toString());
    if (params.top_k != null) url.searchParams.append("top_k", params.top_k.toString());

    const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
    });

    if (!response.ok) {
        throw new Error(`Column search API error: ${response.status}`);
    }

    return response.json();
}

/**
 * Re-embed all rows for specified columns (or all columns) so that
 * embedded_values matches the current definition_values.
 */
export async function reembedColumnDefinitions(params: {
    source_id: string;
    table_id?: string;
    column_names?: string[];
}): Promise<{
    success: boolean;
    source_id: string;
    table_id: string | null;
    columns: string[];
    reembedded_count: number;
}> {
    const response = await fetch(`${API_URL}/parquet/columns/embeddings/reembed`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
        body: JSON.stringify(params),
    });

    if (!response.ok) {
        throw new Error(`Reembed API error: ${response.status}`);
    }

    return response.json();
}

/**
 * Get head rows for a single parquet file
 */
export async function getParquetHead(params: {
    file?: string;
    source_id?: string;
    table_id?: string;
    cache_type?: 'data' | 'embeddings';
    limit?: number;
    offset?: number;
    column_name?: string;
}): Promise<ParquetFileHead> {
    const url = new URL(`${API_URL}/parquet/head`);
    if (params.file) url.searchParams.append("file", params.file);
    if (params.source_id) url.searchParams.append("source_id", params.source_id);
    if (params.table_id) url.searchParams.append("table_id", params.table_id);
    if (params.column_name) url.searchParams.append("column_name", params.column_name);

    const cacheType = params.cache_type || "data";
    const limit = params.limit || 5;
    const offset = params.offset ?? 0;
    url.searchParams.append("cache_type", cacheType);
    url.searchParams.append("limit", limit.toString());
    url.searchParams.append("offset", offset.toString());

    const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
    });

    if (!response.ok) {
        throw new Error(`Parquet head API error: ${response.status}`);
    }

    return response.json();
}

/**
 * Get column embeddings for a source
 */
export async function getColumnEmbeddings(source_id: string, table_id?: string, limit_values: number = 50): Promise<any> {
    const url = new URL(`${API_URL}/parquet/columns/embeddings`);
    url.searchParams.append("source_id", source_id);
    if (table_id) url.searchParams.append("table_id", table_id);
    url.searchParams.append("limit_values", limit_values.toString());

    const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
    });

    if (!response.ok) {
        throw new Error(`Embeddings API error: ${response.status}`);
    }

    return response.json();
}

/**
 * Get DTO-backed column schema metadata for a source/table
 */
export async function getColumnSchema(source_id: string, table_id?: string): Promise<ColumnSchemaResponse> {
    const url = new URL(`${API_URL}/parquet/columns/schema`);
    url.searchParams.append("source_id", source_id);
    if (table_id) url.searchParams.append("table_id", table_id);

    const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
    });

    if (!response.ok) {
        throw new Error(`Column schema API error: ${response.status}`);
    }

    return response.json();
}

export async function getSqlSourceConfig(source_id: string): Promise<SQLSourceConfigResponse> {
    const response = await fetch(`${API_URL}/parquet/sql/source-config/${encodeURIComponent(source_id)}`, {
        method: "GET",
        headers: {
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
    });

    if (!response.ok) {
        throw new Error(`SQL source config API error: ${response.status}`);
    }

    return response.json();
}

export async function getSourceConfig(source_id: string): Promise<SourceConfigResponse> {
    const response = await fetch(`${API_URL}/parquet/source-config/${encodeURIComponent(source_id)}`, {
        method: "GET",
        headers: {
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
    });

    if (!response.ok) {
        throw new Error(`Source config API error: ${response.status}`);
    }

    return response.json();
}

export async function listMinioObjects(source_id: string, prefix: string = ""): Promise<MinioObjectsResponse> {
    const url = new URL(`${API_URL}/parquet/minio/${encodeURIComponent(source_id)}/objects`);
    if (prefix) url.searchParams.append("prefix", prefix);

    const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
    });

    if (!response.ok) {
        throw new Error(`MinIO objects API error: ${response.status} - ${await response.text()}`);
    }

    return response.json();
}

export async function uploadMinioObject(source_id: string, file: File, object_key?: string): Promise<MinioObjectMutationResponse> {
    const formData = new FormData();
    formData.append("file", file);
    if (object_key) formData.append("object_key", object_key);

    const response = await fetch(`${API_URL}/parquet/minio/${encodeURIComponent(source_id)}/objects`, {
        method: "POST",
        headers: {
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
        body: formData,
    });

    if (!response.ok) {
        throw new Error(`MinIO upload API error: ${response.status} - ${await response.text()}`);
    }

    return response.json();
}

export async function deleteMinioObject(source_id: string, object_key: string): Promise<MinioObjectMutationResponse> {
    const url = new URL(`${API_URL}/parquet/minio/${encodeURIComponent(source_id)}/objects`);
    url.searchParams.append("object_key", object_key);

    const response = await fetch(url.toString(), {
        method: "DELETE",
        headers: {
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
    });

    if (!response.ok) {
        throw new Error(`MinIO delete API error: ${response.status} - ${await response.text()}`);
    }

    return response.json();
}

export async function getOracleSettings(): Promise<OracleConnectorSettingsResponse> {
    const response = await fetch(`${API_URL}/parquet/oracle/settings`, {
        method: "GET",
        headers: {
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
    });

    if (!response.ok) {
        throw new Error(`Oracle settings API error: ${response.status} - ${await response.text()}`);
    }

    return response.json();
}

export async function saveOracleSettings(payload: OracleConnectorSettingsUpdateRequest): Promise<any> {
    const response = await fetch(`${API_URL}/parquet/oracle/settings`, {
        method: "PUT",
        headers: {
            "Content-Type": "application/json",
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        throw new Error(`Oracle settings save API error: ${response.status} - ${await response.text()}`);
    }

    return response.json();
}

export async function listConnectorProviders(): Promise<ConnectorProvider[]> {
    const response = await fetch(`${API_URL}/parquet/connectors/providers`, {
        method: "GET",
        headers: { "X-API-Key": API_KEY, ...getSessionHeaders() },
    });
    if (!response.ok) throw new Error(`Connector providers API error: ${response.status}`);
    return response.json();
}

export async function getConnectorSettings(providerId: string): Promise<ConnectorSettingsResponse> {
    const response = await fetch(`${API_URL}/parquet/connectors/${providerId}/settings`, {
        method: "GET",
        headers: { "X-API-Key": API_KEY, ...getSessionHeaders() },
    });
    if (!response.ok) throw new Error(`Connector settings API error: ${response.status}`);
    return response.json();
}

export async function saveConnectorSettings(providerId: string, payload: ConnectorSettingsUpdateRequest): Promise<any> {
    const response = await fetch(`${API_URL}/parquet/connectors/${providerId}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-API-Key": API_KEY, ...getSessionHeaders() },
        body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`Connector settings save API error: ${response.status}`);
    return response.json();
}

export async function uploadCsvSource(file: File, source_id?: string, description?: string): Promise<CsvUploadResponse> {
    const formData = new FormData();
    formData.append("file", file);
    if (source_id) formData.append("source_id", source_id);
    if (description) formData.append("description", description);

    const response = await fetch(`${API_URL}/parquet/csv/upload`, {
        method: "POST",
        headers: {
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
        body: formData,
    });

    if (!response.ok) {
        throw new Error(`CSV upload API error: ${response.status} - ${await response.text()}`);
    }

    return response.json();
}

export async function uploadQvdSource(file: File, source_id?: string, description?: string): Promise<QvdUploadResponse> {
    // Gzip in the browser before posting. Railway's HTTP edge proxy enforces a
    // ~5 min request timeout; a raw 568 MB QVD over a typical home upload
    // exceeds that and gets cut off as "Failed to fetch". Empirically QVD
    // compresses ~6× (568 MB → 88 MB), which fits comfortably under the limit.
    // The backend already handles `.qvd.gz` (strips `.gz` server-side, so the
    // derived source_id and parquet stem are identical to the raw path).
    const payload = await gzipFileIfPossible(file);

    const formData = new FormData();
    formData.append("file", payload.blob, payload.filename);
    if (source_id) formData.append("source_id", source_id);
    if (description) formData.append("description", description);

    const response = await fetch(`${API_URL}/parquet/qvd/upload`, {
        method: "POST",
        headers: {
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
        body: formData,
    });

    if (!response.ok) {
        throw new Error(`QVD upload API error: ${response.status} - ${await response.text()}`);
    }

    return response.json();
}

async function gzipFileIfPossible(file: File): Promise<{ blob: Blob; filename: string }> {
    const name = file.name;
    if (name.toLowerCase().endsWith(".gz")) {
        return { blob: file, filename: name };
    }
    if (typeof CompressionStream === "undefined") {
        return { blob: file, filename: name };
    }
    const compressed = file.stream().pipeThrough(new CompressionStream("gzip"));
    const blob = await new Response(compressed).blob();
    return { blob, filename: `${name}.gz` };
}

export async function getQvdPipelineStatus(job_id: string): Promise<QvdPipelineStatus> {
    const response = await fetch(`${API_URL}/parquet/qvd/pipeline/${encodeURIComponent(job_id)}`, {
        method: "GET",
        headers: {
            "X-API-Key": API_KEY,
            "Content-Type": "application/json",
            ...getSessionHeaders(),
        },
    });

    if (!response.ok) {
        throw new Error(`QVD pipeline status API error: ${response.status} - ${await response.text()}`);
    }

    return response.json();
}

/**
 * Upload one or more Excel workbooks and launch the XLSX → Parquet pipeline
 * (`flows/xlsx_pipeline_flow.run_xlsx_pipeline`) in the background.
 * Returns a single batch job_id whose progress can be polled via
 * `getXlsxPipelineStatus`.
 */
export async function uploadXlsxSources(
    files: File[],
    description?: string,
): Promise<XlsxUploadResponse> {
    if (!files.length) {
        throw new Error("uploadXlsxSources requires at least one file");
    }

    const formData = new FormData();
    for (const f of files) formData.append("files", f, f.name);
    if (description) formData.append("description", description);

    const response = await fetch(`${API_URL}/parquet/xlsx/upload`, {
        method: "POST",
        headers: {
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
        body: formData,
    });

    if (!response.ok) {
        throw new Error(`XLSX upload API error: ${response.status} - ${await response.text()}`);
    }

    return response.json();
}

export async function getXlsxPipelineStatus(job_id: string): Promise<XlsxPipelineStatus> {
    const response = await fetch(`${API_URL}/parquet/xlsx/pipeline/${encodeURIComponent(job_id)}`, {
        method: "GET",
        headers: {
            "X-API-Key": API_KEY,
            "Content-Type": "application/json",
            ...getSessionHeaders(),
        },
    });

    if (!response.ok) {
        throw new Error(`XLSX pipeline status API error: ${response.status} - ${await response.text()}`);
    }

    return response.json();
}

export async function deleteSourceConfig(source_id: string, delete_files: boolean = false): Promise<any> {
    const url = new URL(`${API_URL}/parquet/sources/${encodeURIComponent(source_id)}`);
    url.searchParams.append("delete_files", delete_files.toString());

    const response = await fetch(url.toString(), {
        method: "DELETE",
        headers: {
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
    });

    if (!response.ok) {
        throw new Error(`Source delete API error: ${response.status} - ${await response.text()}`);
    }

    return response.json();
}

export async function patchSourceEnabled(source_id: string, enabled: boolean): Promise<{ success: boolean; source_id: string; enabled: boolean }> {
    const response = await fetch(`${API_URL}/parquet/sources/${encodeURIComponent(source_id)}`, {
        method: "PATCH",
        headers: {
            "Content-Type": "application/json",
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
        body: JSON.stringify({ enabled }),
    });

    if (!response.ok) {
        throw new Error(`Source patch API error: ${response.status} - ${await response.text()}`);
    }

    return response.json();
}

export interface DefinitionItem {
    distinct_value: string;
    definitions: string[];
}

export async function saveColumnDefinitions(
    source_id: string,
    column_name: string,
    items: DefinitionItem[],
    table_id?: string,
): Promise<{ success: boolean; updated_count: number }> {
    const response = await fetch(`${API_URL}/parquet/columns/definitions`, {
        method: "PUT",
        headers: {
            "Content-Type": "application/json",
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
        body: JSON.stringify({ source_id, table_id: table_id ?? null, column_name, items }),
    });

    if (!response.ok) {
        throw new Error(`Definitions save API error: ${response.status} - ${await response.text()}`);
    }

    return response.json();
}

export interface RefineDefinitionChange {
    distinct_value: string;
    action: 'add' | 'update' | 'delete';
    old_definitions: string[];
    new_definitions: string[];
}

export async function refineColumnDefinitions(
    source_id: string,
    column_name: string,
    reference_text: string,
    items: DefinitionItem[],
    table_id?: string,
): Promise<{ changes: RefineDefinitionChange[]; count: number }> {
    const response = await fetch(`${API_URL}/parquet/columns/definitions/refine`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
        body: JSON.stringify({ source_id, table_id: table_id ?? null, column_name, reference_text, items }),
    });

    if (!response.ok) {
        throw new Error(`Definitions refine API error: ${response.status} - ${await response.text()}`);
    }

    return response.json();
}

export async function createSupabaseSource(payload: SupabaseSourceCreateRequest): Promise<any> {
    const response = await fetch(`${API_URL}/parquet/supabase/sources`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        throw new Error(`Supabase source API error: ${response.status} - ${await response.text()}`);
    }

    return response.json();
}

export async function upsertSqlTableConfig(source_id: string, table: SQLTableConfigItem): Promise<any> {
    const response = await fetch(`${API_URL}/parquet/sql/tables`, {
        method: "PUT",
        headers: {
            "Content-Type": "application/json",
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
        body: JSON.stringify({ source_id, table }),
    });

    if (!response.ok) {
        throw new Error(`SQL table save API error: ${response.status} - ${await response.text()}`);
    }

    return response.json();
}

export async function deleteSqlTableConfig(source_id: string, table_id: string, delete_files: boolean = false): Promise<any> {
    const url = new URL(`${API_URL}/parquet/sql/tables`);
    url.searchParams.append("source_id", source_id);
    url.searchParams.append("table_id", table_id);
    url.searchParams.append("delete_files", delete_files.toString());

    const response = await fetch(url.toString(), {
        method: "DELETE",
        headers: {
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
    });

    if (!response.ok) {
        throw new Error(`SQL table delete API error: ${response.status} - ${await response.text()}`);
    }

    return response.json();
}

export async function saveColumnSchema(source_id: string, table_id: string | null | undefined, columns: SaveColumnSchemaItem[]): Promise<any> {
    const response = await fetch(`${API_URL}/parquet/columns/schema`, {
        method: "PUT",
        headers: {
            "Content-Type": "application/json",
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
        body: JSON.stringify({ source_id, table_id, columns }),
    });

    if (!response.ok) {
        throw new Error(`Save column schema API error: ${response.status} - ${await response.text()}`);
    }

    return response.json();
}

export async function suggestColumnSchema(
    source_id: string,
    table_id: string | null | undefined,
    source_description: string | null | undefined,
    columns: ColumnSuggestionInput[]
): Promise<ColumnSchemaResponse> {
    const response = await fetch(`${API_URL}/parquet/columns/suggest`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
        body: JSON.stringify({
            source_id,
            table_id,
            source_description,
            columns,
        }),
    });

    if (!response.ok) {
        throw new Error(`Column suggestion API error: ${response.status} - ${await response.text()}`);
    }

    return response.json();
}


// ── Categorical Distinct (background job) ────────────────────────────────────

export interface CategoricalDistinctJobResponse {
    job_id: string;
    source_id: string;
    status: "queued" | "running" | "success" | "failed";
    categorical_columns?: string[];
    success?: boolean | null;
    error?: string | null;
    distinct_parquet_path?: string | null;
    summary?: Record<string, number> | null;
    duration_ms?: number | null;
}

export async function launchCategoricalDistinct(
    source_id: string,
    categorical_columns: string[],
    table_id?: string,
): Promise<{ job_id: string; status: string }> {
    const payload: Record<string, unknown> = { source_id, categorical_columns };
    if (table_id) payload.table_id = table_id;
    const response = await fetch(`${API_URL}/parquet/columns/generate-distinct`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        throw new Error(`Generate distinct API error: ${response.status} - ${await response.text()}`);
    }

    return response.json();
}

export async function getCategoricalDistinctStatus(
    job_id: string,
): Promise<CategoricalDistinctJobResponse> {
    const response = await fetch(`${API_URL}/parquet/columns/generate-distinct/${encodeURIComponent(job_id)}`, {
        method: "GET",
        headers: {
            "X-API-Key": API_KEY,
            ...getSessionHeaders(),
        },
    });

    if (!response.ok) {
        throw new Error(`Generate distinct status API error: ${response.status}`);
    }

    return response.json();
}


// ── Skills API ──────────────────────────────────────────────────────────────

export interface SkillSummary {
    name: string;
    description: string;
    directory_name: string;
    aliases: string[];
}

export interface SkillDetail extends SkillSummary {
    content_body: string;
    /** DTO directory_name (e.g. "ca_view_dto") this skill is bound to. */
    dto?: string;
    source_view?: string;
    parquet_source?: string;
}

export async function listSkills(): Promise<{ skills: SkillSummary[]; count: number }> {
    const response = await fetch(`${API_URL}/skills`, {
        headers: { "X-API-Key": API_KEY, ...getSessionHeaders() },
    });
    if (!response.ok) throw new Error(`Skills list error: ${response.status}`);
    return response.json();
}

export async function getSkill(directoryName: string): Promise<SkillDetail> {
    const response = await fetch(`${API_URL}/skills/${encodeURIComponent(directoryName)}`, {
        headers: { "X-API-Key": API_KEY, ...getSessionHeaders() },
    });
    if (!response.ok) throw new Error(`Get skill error: ${response.status}`);
    return response.json();
}

export async function updateSkill(
    directoryName: string,
    data: { name?: string; description?: string; content_body?: string; aliases?: string[]; dto?: string },
): Promise<{ success: boolean }> {
    const response = await fetch(`${API_URL}/skills/${encodeURIComponent(directoryName)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-API-Key": API_KEY, ...getSessionHeaders() },
        body: JSON.stringify(data),
    });
    if (!response.ok) throw new Error(`Update skill error: ${response.status}`);
    return response.json();
}

export async function createSkill(data: {
    directory_name: string;
    name: string;
    description?: string;
    content_body?: string;
    aliases?: string[];
    dto?: string;
}): Promise<{ success: boolean; directory_name: string }> {
    const response = await fetch(`${API_URL}/skills`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": API_KEY, ...getSessionHeaders() },
        body: JSON.stringify(data),
    });
    if (!response.ok) throw new Error(`Create skill error: ${response.status}`);
    return response.json();
}

export async function deleteSkill(directoryName: string): Promise<{ success: boolean }> {
    const response = await fetch(`${API_URL}/skills/${encodeURIComponent(directoryName)}`, {
        method: "DELETE",
        headers: { "X-API-Key": API_KEY, ...getSessionHeaders() },
    });
    if (!response.ok) throw new Error(`Delete skill error: ${response.status}`);
    return response.json();
}

// ── DTOs (for skill scoping) ────────────────────────────────────────────────

export interface SkillDto {
    /** Filename stem, e.g. ``Analytics_Final_dto``. Stored as the skill alias. */
    directory_name: string;
    /** Human-friendly slug without the trailing ``_dto`` suffix. */
    slug: string;
    /** Python module path, e.g. ``classes.dtos.Analytics_Final_dto``. */
    module_path: string;
    /** From ``get_file_description()`` if defined, else the module docstring. */
    file_description: string;
}

export async function listSkillDtos(): Promise<{ dtos: SkillDto[]; count: number }> {
    const response = await fetch(`${API_URL}/skills/dtos`, {
        headers: { "X-API-Key": API_KEY, ...getSessionHeaders() },
    });
    if (!response.ok) throw new Error(`List DTOs error: ${response.status}`);
    return response.json();
}


// ── AI Skill Generation ─────────────────────────────────────────────────────

export interface SkillChatMessage {
    role: "user" | "assistant";
    content: string;
}

export interface SkillDraft {
    name: string;
    description: string;
    aliases: string[];
    content_body: string;
    directory_name: string;
}

export interface SkillChatResponse {
    message: string;
    skill_draft: SkillDraft | null;
}

/**
 * Snapshot of a skill the user is editing, passed through to the LLM so it
 * can propose targeted modifications instead of generating a brand new skill.
 * Pass it only when the chat is opened from the *edit* view.
 */
export interface SkillContext {
    directory_name: string;
    name: string;
    description?: string;
    aliases?: string[];
    content_body?: string;
}

/**
 * Multi-turn skill chat endpoint.
 *
 * - ``currentSkill`` is set only when the chat is opened from the *edit*
 *   view; presence flips the backend into edit mode.
 * - ``selectedDtos`` is set only in CREATE mode and contains the DTO
 *   ``directory_name`` values the user ticked in the multi-select. The
 *   backend uses those to statically extract the column schemas and
 *   inject them as a "Données ciblées" section in the system prompt, so
 *   the LLM grounds its generated skill in real column names instead of
 *   guessing. The DTOs also become the skill's aliases by default.
 * - ``finalize`` forces the LLM to STOP asking clarifying questions and
 *   emit the final ```skill block immediately. Fired by the "Créer le
 *   skill" button when the user wants to lock in the current state
 *   without another chat round-trip.
 */
export async function aiGenerateSkill(
    messages: SkillChatMessage[],
    currentSkill?: SkillContext | null,
    selectedDtos?: string[],
    finalize?: boolean,
): Promise<SkillChatResponse> {
    const payload: Record<string, unknown> = { messages };
    if (currentSkill) payload.current_skill = currentSkill;
    if (selectedDtos && selectedDtos.length > 0) payload.selected_dtos = selectedDtos;
    if (finalize) payload.finalize = true;
    const response = await fetch(`${API_URL}/skills/ai-generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": API_KEY, ...getSessionHeaders() },
        body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`AI skill generation error: ${response.status}`);
    return response.json();
}


// ── Claude Code enhance loop (SSE) ──────────────────────────────────────────

export interface EnhanceRequest {
    skill_directory_name: string;
    instructions?: string;
    dto?: string;
    max_questions?: number;
}

export interface EnhanceEvent {
    event: string;            // run_started | claude_system | thinking | assistant_delta | tool_start | tool_result | result | error | done | heartbeat
    data: Record<string, unknown>;
}

/**
 * Stream a Claude Code "enhance this skill" run. POSTs to /admin/claude/stream
 * and parses the SSE (`event:`/`data:` lines) into typed events. Returns an
 * abort function (aborting drops the connection → the server kills the run).
 */
export function enhanceSkillStream(
    req: EnhanceRequest,
    onEvent: (e: EnhanceEvent) => void,
    onError?: (err: Error) => void,
    onDone?: () => void,
): () => void {
    const controller = new AbortController();
    (async () => {
        try {
            const resp = await fetch(`${API_URL}/admin/claude/stream`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-API-Key": API_KEY,
                    Accept: "text/event-stream",
                    ...getSessionHeaders(),
                },
                body: JSON.stringify(req),
                signal: controller.signal,
            });
            if (!resp.ok) throw new Error(`Enhance error: ${resp.status} - ${await resp.text()}`);
            const reader = resp.body?.getReader();
            if (!reader) throw new Error("No response body");
            const decoder = new TextDecoder();
            let buffer = "";
            let curEvent = "message";
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const rawLine of lines) {
                    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
                    if (line.startsWith("event:")) {
                        curEvent = line.slice(6).trim();
                    } else if (line.startsWith("data:")) {
                        const payload = line.slice(5).trim();
                        let data: Record<string, unknown> = {};
                        try { data = JSON.parse(payload); } catch { data = { raw: payload }; }
                        onEvent({ event: curEvent, data });
                        curEvent = "message";
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


// ── Conversations + CTE-pertinence judge ────────────────────────────────────

export interface ConversationSummary {
    session_id: string;
    turns: number;
    cte_turns: number;
    last_query: string;
    updated_at: number;
    /** reused (existing CTE / fast-path) | generated (new CTE) | ran (ad-hoc) | none */
    cte_mode?: 'reused' | 'generated' | 'ran' | 'none';
    cte_names?: string[];
}

export interface ConversationCte { label: string; sql: string }
export interface ConversationResult {
    label: string;
    columns: string[];
    row_count: number | null;
    rows: Record<string, unknown>[];
    error?: string | null;
}
export interface ConversationTurn {
    query: string;
    response: string;
    /** reused (existing CTE / fast-path) | generated (new CTE) | ran (ad-hoc) | none */
    cte_mode?: 'reused' | 'generated' | 'ran' | 'none';
    cte_names?: string[];
    ctes: ConversationCte[];
    results: ConversationResult[];
}
export interface ConversationDetail {
    session_id: string;
    turn_count: number;
    turns: ConversationTurn[];
}

export async function listConversations(limit = 100): Promise<{ conversations: ConversationSummary[]; count: number }> {
    const response = await fetch(`${API_URL}/admin/conversations?limit=${limit}`, {
        headers: { "X-API-Key": API_KEY, ...getSessionHeaders() },
    });
    if (!response.ok) throw new Error(`List conversations error: ${response.status}`);
    return response.json();
}

export async function getConversation(sessionId: string): Promise<ConversationDetail> {
    const response = await fetch(`${API_URL}/admin/conversations/${encodeURIComponent(sessionId)}`, {
        headers: { "X-API-Key": API_KEY, ...getSessionHeaders() },
    });
    if (!response.ok) throw new Error(`Get conversation error: ${response.status}`);
    return response.json();
}

export async function deleteConversation(sessionId: string): Promise<{ success: boolean }> {
    const response = await fetch(`${API_URL}/admin/conversations/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
        headers: { "X-API-Key": API_KEY, ...getSessionHeaders() },
    });
    if (!response.ok) throw new Error(`Delete conversation error: ${response.status}`);
    return response.json();
}

export async function deleteAllConversations(): Promise<{ success: boolean; deleted: number }> {
    const response = await fetch(`${API_URL}/admin/conversations`, {
        method: "DELETE",
        headers: { "X-API-Key": API_KEY, ...getSessionHeaders() },
    });
    if (!response.ok) throw new Error(`Delete all conversations error: ${response.status}`);
    return response.json();
}

export interface ApplyCteRequest {
    name: string;
    sql: string;
    description?: string;
    parameters?: string[];
    depends_on?: string[];
    graph_id?: string;
}

/** Apply an approved CTE proposal (manual-approval upsert into the graph). */
export async function applyCte(
    req: ApplyCteRequest,
): Promise<{ success: boolean; name: string; graph_id: string; replaced: boolean }> {
    const response = await fetch(`${API_URL}/admin/claude/apply-cte`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": API_KEY, ...getSessionHeaders() },
        body: JSON.stringify(req),
    });
    if (!response.ok) throw new Error(`Apply CTE error: ${response.status} - ${await response.text()}`);
    return response.json();
}

/** Stream a Claude Code "analyse + improve the CTEs of a conversation" run. */
export function judgeConversationStream(
    req: { session_id?: string; instructions?: string; approval_mode?: 'auto' | 'manual'; graph_id?: string },
    onEvent: (e: EnhanceEvent) => void,
    onError?: (err: Error) => void,
    onDone?: () => void,
): () => void {
    const controller = new AbortController();
    (async () => {
        try {
            const resp = await fetch(`${API_URL}/admin/claude/judge/stream`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-API-Key": API_KEY,
                    Accept: "text/event-stream",
                    ...getSessionHeaders(),
                },
                body: JSON.stringify(req),
                signal: controller.signal,
            });
            if (!resp.ok) throw new Error(`Judge error: ${resp.status} - ${await resp.text()}`);
            const reader = resp.body?.getReader();
            if (!reader) throw new Error("No response body");
            const decoder = new TextDecoder();
            let buffer = "";
            let curEvent = "message";
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const rawLine of lines) {
                    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
                    if (line.startsWith("event:")) {
                        curEvent = line.slice(6).trim();
                    } else if (line.startsWith("data:")) {
                        const payload = line.slice(5).trim();
                        let data: Record<string, unknown> = {};
                        try { data = JSON.parse(payload); } catch { data = { raw: payload }; }
                        onEvent({ event: curEvent, data });
                        curEvent = "message";
                    }
                }
            }
            onDone?.();
        } catch (err) {
            if (!controller.signal.aborted) onError?.(err instanceof Error ? err : new Error(String(err)));
        }
    })();
    return () => controller.abort();
}


// ── Generic section assistant chat (one panel per admin section) ────────────

export interface ChatAgentRequest {
    message: string;
    /** data | connectors | prompts | cte | general — steers the system prompt + focus. */
    scope?: string;
    /** Optional section context (selected source/template/etc.) injected into the prompt. */
    context?: string;
    /** CTE graph id the user is viewing — binds the agent to that graph + its source. */
    graph_id?: string;
}

/**
 * Stream a Claude Code section-assistant chat. POSTs to /admin/claude/chat/stream
 * and parses the SSE into typed {@link EnhanceEvent}s. Returns an abort function
 * (aborting drops the connection → the server kills the run).
 */
export function chatAgentStream(
    req: ChatAgentRequest,
    onEvent: (e: EnhanceEvent) => void,
    onError?: (err: Error) => void,
    onDone?: () => void,
): () => void {
    const controller = new AbortController();
    (async () => {
        try {
            const resp = await fetch(`${API_URL}/admin/claude/chat/stream`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-API-Key": API_KEY,
                    Accept: "text/event-stream",
                    ...getSessionHeaders(),
                },
                body: JSON.stringify({ scope: "general", ...req }),
                signal: controller.signal,
            });
            if (!resp.ok) throw new Error(`Chat error: ${resp.status} - ${await resp.text()}`);
            const reader = resp.body?.getReader();
            if (!reader) throw new Error("No response body");
            const decoder = new TextDecoder();
            let buffer = "";
            let curEvent = "message";
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const rawLine of lines) {
                    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
                    if (line.startsWith("event:")) {
                        curEvent = line.slice(6).trim();
                    } else if (line.startsWith("data:")) {
                        const payload = line.slice(5).trim();
                        let data: Record<string, unknown> = {};
                        try { data = JSON.parse(payload); } catch { data = { raw: payload }; }
                        onEvent({ event: curEvent, data });
                        curEvent = "message";
                    }
                }
            }
            onDone?.();
        } catch (err) {
            if (!controller.signal.aborted) onError?.(err instanceof Error ? err : new Error(String(err)));
        }
    })();
    return () => controller.abort();
}


// ── Prompt Templates API ────────────────────────────────────────────────────

export interface PromptTemplate {
    category: string;
    name: string;
    path: string;
}

export interface PromptTemplateDetail {
    category: string;
    name: string;
    content: string;
}

export async function listPromptTemplates(category?: string): Promise<{
    templates: PromptTemplate[];
    categories: string[];
    count: number;
}> {
    const url = new URL(`${API_URL}/skills/templates/list`);
    if (category) url.searchParams.append("category", category);
    const response = await fetch(url.toString(), {
        headers: { "X-API-Key": API_KEY, ...getSessionHeaders() },
    });
    if (!response.ok) throw new Error(`List templates error: ${response.status}`);
    return response.json();
}

export async function getPromptTemplate(category: string, name: string): Promise<PromptTemplateDetail> {
    const response = await fetch(
        `${API_URL}/skills/templates/${encodeURIComponent(category)}/${encodeURIComponent(name)}`,
        { headers: { "X-API-Key": API_KEY, ...getSessionHeaders() } },
    );
    if (!response.ok) throw new Error(`Get template error: ${response.status}`);
    return response.json();
}

export async function updatePromptTemplate(
    category: string,
    name: string,
    content: string,
): Promise<{ success: boolean }> {
    const response = await fetch(
        `${API_URL}/skills/templates/${encodeURIComponent(category)}/${encodeURIComponent(name)}`,
        {
            method: "PUT",
            headers: { "Content-Type": "application/json", "X-API-Key": API_KEY, ...getSessionHeaders() },
            body: JSON.stringify({ content }),
        },
    );
    if (!response.ok) throw new Error(`Update template error: ${response.status}`);
    return response.json();
}

export async function improvePromptTemplate(
    content: string,
    instruction: string = "",
): Promise<{ improved: string }> {
    const response = await fetch(
        `${API_URL}/skills/templates/improve`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-API-Key": API_KEY, ...getSessionHeaders() },
            body: JSON.stringify({ content, instruction }),
        },
    );
    if (!response.ok) throw new Error(`Improve template error: ${response.status}`);
    return response.json();
}


// ── SQL Head / Cache Window / Cache Metadata ─────────────────────────────

export async function getSqlTableHead(
    sourceId: string,
    tableId: string,
    limit: number = 100,
): Promise<ParquetFileHead> {
    const url = new URL(`${API_URL}/parquet/sql/head`);
    url.searchParams.append("source_id", sourceId);
    url.searchParams.append("table_id", tableId);
    url.searchParams.append("limit", String(limit));
    const response = await fetch(url.toString(), {
        headers: { "X-API-Key": API_KEY, ...getSessionHeaders() },
    });
    if (!response.ok) throw new Error(`SQL head error: ${response.status}`);
    return response.json();
}

export interface CacheWindowConfig {
    date_column: string;
    months: number;
}

export async function setCacheWindow(
    sourceId: string,
    tableId: string,
    config: CacheWindowConfig,
): Promise<{ status: string }> {
    const response = await fetch(
        `${API_URL}/parquet/sources/${encodeURIComponent(sourceId)}/tables/${encodeURIComponent(tableId)}/cache-window`,
        {
            method: "PUT",
            headers: { "Content-Type": "application/json", "X-API-Key": API_KEY, ...getSessionHeaders() },
            body: JSON.stringify(config),
        },
    );
    if (!response.ok) throw new Error(`Set cache window error: ${response.status}`);
    return response.json();
}

export interface CacheMetadata {
    source_id: string;
    table_id: string;
    row_count: number;
    column_count: number;
    generated_at: string;
    cache_window_months?: number;
    date_column?: string;
    min_date?: string;
    max_date?: string;
    db_table_ref?: string;
}

export async function getCacheMetadata(
    sourceId: string,
    tableId: string,
): Promise<CacheMetadata> {
    const response = await fetch(
        `${API_URL}/parquet/sources/${encodeURIComponent(sourceId)}/tables/${encodeURIComponent(tableId)}/cache-metadata`,
        { headers: { "X-API-Key": API_KEY, ...getSessionHeaders() } },
    );
    if (!response.ok) throw new Error(`Cache metadata error: ${response.status}`);
    return response.json();
}
