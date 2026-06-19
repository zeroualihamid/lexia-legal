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

export function legalGraphAssetUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${API_URL}${normalized}`;
}

export async function listLegalGraphs(): Promise<LegalGraphListResponse> {
  const response = await fetch(`${API_URL}/legal-graphs`, {
    method: "GET",
    headers: buildHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Legal graph fetch failed (${response.status}): ${await parseError(response)}`);
  }
  return response.json();
}
