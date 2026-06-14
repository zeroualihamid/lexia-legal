/**
 * cte_graph_api.ts
 * ────────────────────────────────────────────────────────────────────────
 * Thin TypeScript client for the FastAPI ``/cte-graph/*`` service exposed
 * by qclick-agent. Each function maps 1:1 to a backend endpoint.
 */

const API_URL = (import.meta.env.VITE_API_URL || "").replace(/\/+$/, "");
const API_KEY = import.meta.env.VITE_AUTH_KEY;
const SESSION_STORAGE_KEY = "lumo_session_id";

function getSessionId(): string {
    return localStorage.getItem(SESSION_STORAGE_KEY) || "";
}

function buildHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {
        "x-session-id": getSessionId(),
        "ngrok-skip-browser-warning": "true",
        ...extra,
    };
    if (API_KEY) headers["x-api-key"] = API_KEY;
    return headers;
}

async function parseError(response: Response): Promise<string> {
    try {
        const data = await response.json();
        if (typeof data?.detail === "string") return data.detail;
        if (data?.detail?.message) return data.detail.message;
        return JSON.stringify(data?.detail ?? data);
    } catch {
        return await response.text();
    }
}

// ── Types ────────────────────────────────────────────────────────────────

export interface CTEReactFlowNodeData {
    label: string;
    name: string;
    description: string;
    rawSql: string;
    parents: string[];
    children: string[];
    /** Sub-folder under ``data/reporting/sql/`` the CTE was loaded from. */
    library?: string;
    /** ``$param`` references declared by the catalog. */
    parameters?: string[];
    /** Output columns declared by the catalog. */
    projects?: string[];
}

export interface CTEReactFlowNode {
    id: string;
    type: string;
    position: { x: number; y: number };
    data: CTEReactFlowNodeData;
}

export interface CTEReactFlowEdge {
    id: string;
    source: string;
    target: string;
    label?: string;
}

export interface CTEReactFlowGraph {
    nodes: CTEReactFlowNode[];
    edges: CTEReactFlowEdge[];
}

export interface CTEBuildResponse {
    graph_id: string;
    node_count: number;
    edge_count: number;
    roots: string[];
    leaves: string[];
}

export interface CTEGenerateProfileGraphResponse {
    success: boolean;
    message: string;
    graph_id?: string | null;
    node_count: number;
    edge_count: number;
    roots: string[];
    leaves: string[];
    cte_count: number;
    chain_warning?: string | null;
    plan_reasoning?: string | null;
    error?: string | null;
    duration_ms: number;
}

export interface CTESearchHit {
    node_id: string;
    name: string;
    description: string;
    similarity_score: number;
    parents: string[];
    children: string[];
}

export interface CTEParentPathsResponse {
    selected_node: string;
    all_parent_paths: string[][];
    shortest_path: string[];
    highlight: {
        nodes: string[];
        edges: { source: string; target: string }[];
    };
}

export interface CTEQueryExecutionResponse {
    cte_name: string | null;
    description: string;
    execution_chain: string[];
    columns: string[];
    rows: Record<string, unknown>[];
    row_count: number;
    truncated: boolean;
    sql: string;
    parameters: Record<string, unknown>;
    bound_parameters: Record<string, unknown>;
    missing_parameters: string[];
    resolved_paths: Record<string, string>;
}

export interface CTEQueryResponse {
    selected_node: string;
    matched_nodes: string[];
    search_hits: CTESearchHit[];
    parent_paths: CTEParentPathsResponse;
    execution: CTEQueryExecutionResponse;
}

export interface CTEGraphProfile {
    id: string;
    name: string;
    description: string;
    libraries: string[];
    /** Parquet/DTO stems (`*_dto.py` → stem) for column contracts in prompts. */
    dto_stems: string[];
    query_examples: string[];
    updated_at: string;
    /** Canonical GraphStore id for this profile (`cte-prof-<profile_id>`). */
    graph_id?: string | null;
    /** Number of CTEs in the built graph. */
    cte_count?: number;
    /** SKILL.md this graph is associated with (if any). */
    skill?: string | null;
}

export interface CTEGraphProfileListResponse {
    profiles: CTEGraphProfile[];
    available_libraries: string[];
    available_dto_stems: string[];
    count: number;
}

export interface CTEGraphProfileChatMessage {
    role: "user" | "assistant";
    content: string;
}

export interface CTEGraphProfileAssistantResponse {
    assistant_message: string;
    operation: "none" | "create" | "update" | "delete";
    target_profile_id?: string | null;
    draft_profile?: CTEGraphProfile | null;
    ready_to_generate?: boolean;
    follow_up_questions?: string[];
}

// ── Endpoints ────────────────────────────────────────────────────────────

export async function buildCteGraph(
    sql: string,
    cte_descriptions: Record<string, string> = {},
    dialect: string = "duckdb",
): Promise<CTEBuildResponse> {
    const response = await fetch(`${API_URL}/cte-graph/build`, {
        method: "POST",
        headers: buildHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ sql, cte_descriptions, dialect }),
    });
    if (!response.ok) {
        throw new Error(`Build failed (${response.status}): ${await parseError(response)}`);
    }
    return response.json();
}

/**
 * Build the dependency graph from the on-disk reporting CTE library at
 * ``qclick-agent/data/reporting/sql/<library>/index.yaml``.
 *
 * Pass ``profileId`` to build from that profile's libraries and persist under
 * the canonical id ``cte-prof-<profile_id>`` (one graph per catalogue card).
 * Pass ``libraries`` only for anonymous builds (no profile card).
 */
export async function buildCteLibraryGraph(options?: {
    libraries?: string[];
    profileId?: string;
    forceRebuild?: boolean;
}): Promise<CTEBuildResponse> {
    const profileId = options?.profileId?.trim();
    const body: Record<string, unknown> = {};
    if (profileId) {
        body.profile_id = profileId;
        body.force_rebuild = Boolean(options?.forceRebuild);
    } else if (options?.libraries && options.libraries.length > 0) {
        body.libraries = options.libraries;
    }
    const response = await fetch(`${API_URL}/cte-graph/build-library`, {
        method: "POST",
        headers: buildHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        throw new Error(`Library build failed (${response.status}): ${await parseError(response)}`);
    }
    return response.json();
}

/**
 * Génère une chaîne CTE linéaire (agent : plan → SQL) pour le dossier du profil,
 * puis reconstruit le graphe stocké sous l’id canonique du catalogue.
 */
export async function generateCteProfileGraph(
    profileId: string,
    options?: { additionalInstructions?: string },
): Promise<CTEGenerateProfileGraphResponse> {
    const body: Record<string, unknown> = {};
    const extra = options?.additionalInstructions?.trim();
    if (extra) body.additional_instructions = extra;
    const response = await fetch(
        `${API_URL}/cte-graph/profiles/${encodeURIComponent(profileId)}/generate-graph`,
        {
            method: "POST",
            headers: buildHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify(body),
        },
    );
    if (!response.ok) {
        throw new Error(`Génération graphe (${response.status}): ${await parseError(response)}`);
    }
    return response.json();
}

export async function listCteGraphProfiles(): Promise<CTEGraphProfileListResponse> {
    const response = await fetch(`${API_URL}/cte-graph/profiles`, {
        method: "GET",
        headers: buildHeaders(),
    });
    if (!response.ok) {
        throw new Error(`Profiles fetch failed (${response.status}): ${await parseError(response)}`);
    }
    return response.json();
}

export async function createCteGraphProfile(args: {
    id?: string;
    name: string;
    /** Required: the SKILL.md (its name or directory) this graph is associated with. */
    skill: string;
    description?: string;
    libraries?: string[];
    dtoStems?: string[];
    queryExamples?: string[];
}): Promise<CTEGraphProfile> {
    const response = await fetch(`${API_URL}/cte-graph/profiles`, {
        method: "POST",
        headers: buildHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
            id: args.id || null,
            name: args.name,
            skill: args.skill,
            description: args.description || "",
            libraries: args.libraries || [],
            dto_stems: args.dtoStems || [],
            query_examples: args.queryExamples || [],
        }),
    });
    if (!response.ok) {
        throw new Error(`Profile create failed (${response.status}): ${await parseError(response)}`);
    }
    return response.json();
}

/** Delete all CTE graph profiles whose built graph has no CTEs. */
export async function pruneEmptyCteGraphProfiles(): Promise<{ deleted: string[]; count: number }> {
    const response = await fetch(`${API_URL}/cte-graph/profiles/prune-empty`, {
        method: "POST",
        headers: buildHeaders({ "Content-Type": "application/json" }),
    });
    if (!response.ok) {
        throw new Error(`Prune failed (${response.status}): ${await parseError(response)}`);
    }
    return response.json();
}

export async function updateCteGraphProfile(
    profileId: string,
    args: {
        name?: string;
        description?: string;
        libraries?: string[];
        dtoStems?: string[];
        queryExamples?: string[];
    },
): Promise<CTEGraphProfile> {
    const response = await fetch(`${API_URL}/cte-graph/profiles/${encodeURIComponent(profileId)}`, {
        method: "PUT",
        headers: buildHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
            ...(args.name !== undefined ? { name: args.name } : {}),
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.libraries !== undefined ? { libraries: args.libraries } : {}),
            ...(args.dtoStems !== undefined ? { dto_stems: args.dtoStems } : {}),
            ...(args.queryExamples !== undefined ? { query_examples: args.queryExamples } : {}),
        }),
    });
    if (!response.ok) {
        throw new Error(`Profile update failed (${response.status}): ${await parseError(response)}`);
    }
    return response.json();
}

export async function deleteCteGraphProfile(profileId: string): Promise<{ success: boolean; profile_id: string }> {
    const response = await fetch(`${API_URL}/cte-graph/profiles/${encodeURIComponent(profileId)}`, {
        method: "DELETE",
        headers: buildHeaders(),
    });
    if (!response.ok) {
        throw new Error(`Profile delete failed (${response.status}): ${await parseError(response)}`);
    }
    return response.json();
}

export async function assistCteGraphProfiles(args: {
    messages: CTEGraphProfileChatMessage[];
    currentProfileId?: string | null;
    /** DTO stems currently selected in the form — schema text is sent to the model. */
    dtoStems?: string[];
}): Promise<CTEGraphProfileAssistantResponse> {
    const response = await fetch(`${API_URL}/cte-graph/profiles/ai-assist`, {
        method: "POST",
        headers: buildHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
            messages: args.messages,
            current_profile_id: args.currentProfileId || null,
            dto_stems: args.dtoStems?.length ? args.dtoStems : null,
        }),
    });
    if (!response.ok) {
        throw new Error(`Profile assistant failed (${response.status}): ${await parseError(response)}`);
    }
    return response.json();
}

export async function getCteGraph(graphId: string): Promise<CTEReactFlowGraph> {
    const response = await fetch(`${API_URL}/cte-graph/${encodeURIComponent(graphId)}`, {
        method: "GET",
        headers: buildHeaders(),
    });
    if (!response.ok) {
        throw new Error(`Fetch failed (${response.status}): ${await parseError(response)}`);
    }
    return response.json();
}

export async function searchCteGraph(
    graphId: string,
    query: string,
    topK: number = 5,
): Promise<CTESearchHit[]> {
    const response = await fetch(`${API_URL}/cte-graph/search`, {
        method: "POST",
        headers: buildHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ graph_id: graphId, query, top_k: topK }),
    });
    if (!response.ok) {
        throw new Error(`Search failed (${response.status}): ${await parseError(response)}`);
    }
    return response.json();
}

export async function getCteParentPaths(
    graphId: string,
    nodeId: string,
): Promise<CTEParentPathsResponse> {
    const response = await fetch(
        `${API_URL}/cte-graph/${encodeURIComponent(graphId)}/node/${encodeURIComponent(nodeId)}/parent-paths`,
        { method: "GET", headers: buildHeaders() },
    );
    if (!response.ok) {
        throw new Error(`Parent paths failed (${response.status}): ${await parseError(response)}`);
    }
    return response.json();
}

export async function runCteGraphQuery(args: {
    graphId: string;
    query: string;
    parquetPaths?: Record<string, string>;
    parameters?: Record<string, unknown>;
    topK?: number;
    maxRows?: number;
    cteName?: string;
}): Promise<CTEQueryResponse> {
    const response = await fetch(`${API_URL}/cte-graph/query`, {
        method: "POST",
        headers: buildHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
            graph_id: args.graphId,
            query: args.query,
            parquet_paths: args.parquetPaths || {},
            parameters: args.parameters || {},
            top_k: args.topK ?? 5,
            max_rows: args.maxRows ?? 50,
            cte_name: args.cteName || null,
        }),
    });
    if (!response.ok) {
        throw new Error(`CTE query failed (${response.status}): ${await parseError(response)}`);
    }
    return response.json();
}
