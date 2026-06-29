const API_URL = (import.meta.env.VITE_API_URL || "/api").replace(/\/+$/, "");
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
    if (typeof data?.message === "string") return data.message;
    if (data?.detail?.message) return String(data.detail.message);
    return JSON.stringify(data?.detail ?? data);
  } catch {
    return await response.text();
  }
}

export interface LegalGraphDocument {
  collection?: string;
  document_id?: string;
  title?: string;
  qdrant_chunks?: number;
  chunks?: number;
  minio_path?: string;
  minio_size?: number;
  document_type?: string;
}

export interface LegalGraphSummary {
  [key: string]: unknown;
  source_collections?: string[];
  selected_collection?: string;
  selected_documents?: LegalGraphDocument[];
  documents?: LegalGraphDocument[];
  excluded_documents?: LegalGraphDocument[];
  document_count?: number;
  chunk_count?: number;
  graph_nodes?: number;
  graph_edges?: number;
  edge_counts?: Record<string, number>;
  layer_counts?: Record<string, number>;
  reasoning_edge_count?: number;
  graph_search_status?: string;
  graph_search_method?: string;
  graph_search_message?: string;
  reasoning_path?: string[];
}

export interface LegalGraphStats {
  document_count?: number | null;
  chunk_count?: number | null;
  graph_nodes?: number | null;
  graph_edges?: number | null;
  reasoning_edge_count?: number | null;
  edge_counts: Record<string, number>;
  layer_counts: Record<string, number>;
  graph_search_status?: string | null;
  graph_search_method?: string | null;
  graph_search_message?: string | null;
}

export interface LegalGraphImage {
  filename: string;
  kind: string;
  label: string;
  url: string;
  size_bytes: number;
  updated_at: string;
}

export interface LegalGraphFile {
  filename: string;
  kind: string;
  url: string;
  size_bytes: number;
  updated_at: string;
}

export interface LegalGraphArtifact {
  id: string;
  name: string;
  directory: string;
  updated_at: string;
  images: LegalGraphImage[];
  files: LegalGraphFile[];
  stats: LegalGraphStats;
  summary: LegalGraphSummary;
}

export interface LegalGraphListResponse {
  graphs: LegalGraphArtifact[];
  count: number;
  data_root: string;
}

export interface LegalGraphExplorePreset {
  id: string;
  label: string;
  question: string;
  intent: string;
  section_types: string[];
}

export interface LegalGraphExplorePresetsResponse {
  presets: LegalGraphExplorePreset[];
}

export interface LegalGraphReactFlowNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: {
    label: string;
    section_type: string;
    section_title?: string;
    paragraph_index?: number | null;
    text_preview: string;
    judgment_id?: string;
    document_id?: string;
    color: string;
    isSeed?: boolean;
    isOnPath?: boolean;
  };
}

export interface LegalGraphReactFlowEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  data?: {
    relation_type?: string;
    isOnPath?: boolean;
  };
}

export interface LegalGraphReactFlowGraph {
  nodes: LegalGraphReactFlowNode[];
  edges: LegalGraphReactFlowEdge[];
}

export interface LegalGraphExploreQueryResponse {
  preset_id?: string | null;
  query: string;
  seeds: string[];
  node_ids: string[];
  edge_ids: string[];
  graph: LegalGraphReactFlowGraph;
  stats: Record<string, unknown>;
  truncated: boolean;
  message: string;
}

export interface LegalGraphPathStep {
  node_id: string;
  chunk_id?: string;
  section_type?: string;
  section_title?: string;
  text_preview?: string;
  relation_to_next?: string | null;
  edge_explanation?: string | null;
}

export interface LegalGraphExplorePathResponse {
  node_id: string;
  goal_node_id?: string | null;
  path_node_ids: string[];
  path_steps: LegalGraphPathStep[];
  highlighted_edge_ids: string[];
  graph: LegalGraphReactFlowGraph;
  search_method: string;
  status: string;
  summary: string;
  key_steps: string[];
  confidence_score: number;
  message: string;
  suggested_action: string;
}

export function legalGraphAssetUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const adminPath = normalized.replace(/^\/legal-graphs\//, "/admin/legal-graphs/");
  return `${API_URL}${adminPath}`;
}

export async function listLegalGraphs(): Promise<LegalGraphListResponse> {
  const response = await fetch(`${API_URL}/admin/legal-graphs`, {
    method: "GET",
    headers: buildHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Legal graph fetch failed (${response.status}): ${await parseError(response)}`);
  }
  return response.json();
}

export async function listLegalGraphPresets(): Promise<LegalGraphExplorePresetsResponse> {
  const response = await fetch(`${API_URL}/admin/legal-graphs/explore/presets`, {
    method: "GET",
    headers: buildHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Legal graph presets failed (${response.status}): ${await parseError(response)}`);
  }
  return response.json();
}

export async function exploreLegalGraphQuery(
  graphId: string,
  body: { preset_id?: string; query?: string; depth?: number },
): Promise<LegalGraphExploreQueryResponse> {
  const response = await fetch(`${API_URL}/admin/legal-graphs/${encodeURIComponent(graphId)}/explore/query`, {
    method: "POST",
    headers: buildHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Legal graph query failed (${response.status}): ${await parseError(response)}`);
  }
  return response.json();
}

export async function exploreLegalGraphPath(
  graphId: string,
  body: { node_id: string; query?: string; goal_node_id?: string },
): Promise<LegalGraphExplorePathResponse> {
  const response = await fetch(`${API_URL}/admin/legal-graphs/${encodeURIComponent(graphId)}/explore/path`, {
    method: "POST",
    headers: buildHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Legal graph path failed (${response.status}): ${await parseError(response)}`);
  }
  return response.json();
}
