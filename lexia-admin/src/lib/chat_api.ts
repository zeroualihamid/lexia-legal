// API client for Node.js Task Queue Backend
// Maps our backend endpoints to the frontend's expected interface

const stripTrailingSlash = (u: string | undefined) => (u || "").replace(/\/+$/, "");
const API_URL = stripTrailingSlash(import.meta.env.VITE_API_URL);
const CHAT_URL = stripTrailingSlash(import.meta.env.VITE_CHAT_URL) || API_URL;
const CONVERSATION_API_URL = `${CHAT_URL}/conversation`;

// Session management
const SESSION_STORAGE_KEY = "qclick_session_id";
const DEFAULT_SESSION_ID = import.meta.env.VITE_DEFAULT_SESSION_ID || "sess123";
const SAVED_CONVERSATIONS_KEY = "qclick_saved_conversations";

function generateSessionId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
}

function getSessionId(): string {
    const storedSessionId = localStorage.getItem(SESSION_STORAGE_KEY);
    if (storedSessionId) {
        return storedSessionId;
    }
    const newSessionId = DEFAULT_SESSION_ID;
    localStorage.setItem(SESSION_STORAGE_KEY, newSessionId);
    return newSessionId;
}

function setSessionId(sessionId: string): void {
    localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
}

export interface SavedConversationRecord {
    sessionId: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    messageCount: number;
    lastMessage?: string;
}

function readSavedConversations(): SavedConversationRecord[] {
    try {
        const raw = localStorage.getItem(SAVED_CONVERSATIONS_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writeSavedConversations(records: SavedConversationRecord[]): void {
    localStorage.setItem(SAVED_CONVERSATIONS_KEY, JSON.stringify(records));
}

export function createSessionId(): string {
    const sessionId = generateSessionId();
    setSessionId(sessionId);
    return sessionId;
}

export function getSavedConversationsMeta(): SavedConversationRecord[] {
    return readSavedConversations().sort((a, b) => (
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    ));
}

export function upsertSavedConversationMeta(record: SavedConversationRecord): SavedConversationRecord[] {
    const existing = readSavedConversations();
    const next = existing.filter(item => item.sessionId !== record.sessionId);
    next.push(record);
    const sorted = next.sort((a, b) => (
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    ));
    writeSavedConversations(sorted);
    return sorted;
}

export function removeSavedConversationMeta(sessionId: string): SavedConversationRecord[] {
    const next = readSavedConversations().filter(item => item.sessionId !== sessionId);
    writeSavedConversations(next);
    return next;
}

// Types matching the frontend expectations
export interface ChatRequest {
    query: string;
}

export interface ChatResponse {
    success: boolean;
    query?: string;
    response?: string;
    agent_used?: string;
    used_tools?: string[];
    conversation_id?: string | null;
    error?: string | null;
    taskId?: string;
}

// SSE Event types for streaming (mapped from our backend)
export interface SSEStartEvent {
    type: "start";
    timestamp: string;
}

export interface SSEStatusEvent {
    type: "status";
    status: string;
    progress: number;
    message?: string;
    timestamp: string;
}

export interface SSEChunkEvent {
    type: "chunk";
    content: string;
    timestamp: string;
}

export interface SSECompleteEvent {
    type: "complete";
    timestamp: string;
    result?: any;
    used_tools?: string[];
    final_markdown?: string;
    steps?: any[];
}

export interface SSEErrorEvent {
    type: "error";
    content: string;
    timestamp: string;
}

export interface SSEChartDataEvent {
    type: "chart_data";
    chartId: string;
    query: string;
    chart: {
        chartType: string;
        option: Record<string, any>;
    };
    timestamp: string;
}

export type SSEEvent =
    | SSEStartEvent
    | SSEStatusEvent
    | SSEChunkEvent
    | SSECompleteEvent
    | SSEErrorEvent
    | SSEChartDataEvent;

export type StreamCallback = (event: SSEEvent) => void;

// Session event types (for compatibility)
export interface SSESessionStatusEvent {
    type: "session_status";
    status: "connected";
}

export interface SSEAuthCloseWarningEvent {
    type: "auth_close_warning";
    grace_seconds: number;
}

export interface SSESessionExpiredEvent {
    type: "session_expired";
    reason: string;
}

export type SSESessionEvent =
    | SSESessionStatusEvent
    | SSEAuthCloseWarningEvent
    | SSESessionExpiredEvent;

export type SessionEventCallback = (event: SSESessionEvent) => void;

function _formatNumber(n: number): string {
    if (Number.isInteger(n)) {
        return n.toLocaleString("fr-FR");
    }
    return n.toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
}

function _buildSqlThinkingMarkdown(data: any): string {
    const parts: string[] = [];
    const results: any[] = data?.sql_results || [];

    for (const r of results) {
        if (r?.error) continue;
        const rows: any[][] = r?.rows || [];
        const cols: string[] = r?.columns || [];
        if (cols.length === 0 || rows.length === 0) continue;

        if (rows.length === 1 && cols.length === 1) {
            const val = rows[0]?.[0] ?? rows[0];
            const num = typeof val === "number" ? val : parseFloat(String(val));
            const label = (r.label || cols[0] || "").replace(/_/g, " ");
            if (!isNaN(num)) {
                parts.push(`**${label}** : **${_formatNumber(num)}**`);
            } else {
                parts.push(`**${label}** : ${val}`);
            }
            continue;
        }

        if (r.label) {
            parts.push(`**${r.label}**`);
        }
        parts.push("");
        parts.push("| " + cols.map(c => c.replace(/_/g, " ")).join(" | ") + " |");
        parts.push("| " + cols.map(() => "---").join(" | ") + " |");
        for (const row of rows.slice(0, 50)) {
            const cells = Array.isArray(row)
                ? row.map((v: any) => {
                    if (v == null) return "";
                    if (typeof v === "number") return _formatNumber(v);
                    return String(v);
                })
                : cols.map((c: string) => String((row as any)?.[c] ?? ""));
            parts.push("| " + cells.join(" | ") + " |");
        }
        if (rows.length > 50) {
            parts.push(`\n*… et ${rows.length - 50} lignes supplémentaires*`);
        }
    }

    if (parts.length === 0) {
        const ev = data?.evaluation;
        if (ev?.justification) return ev.justification;
        return "Aucun résultat trouvé.";
    }

    return parts.join("\n");
}

function mapWorkflowEventToSSE(eventName: string, data: any): SSEEvent | null {
    const timestamp = data?.timestamp || new Date().toISOString();

    switch (eventName) {
        case "session_created":
            return {
                type: "status",
                status: "session_created",
                progress: 1,
                message: data?.message || `Session : ${data?.session_id || "créée"}`,
                timestamp,
            };
        case "workflow_start":
            return {
                type: "status",
                status: "workflow_start",
                progress: 10,
                message: "Analyse de votre demande en cours...",
                timestamp,
            };

        // --- Agent flow events ---
        case "thinking":
            return {
                type: "status",
                status: "thinking",
                progress: 30,
                message: data?.message || "Réflexion en cours...",
                timestamp,
            };
        case "tool_start":
            return {
                type: "status",
                status: "tool_start",
                progress: 50,
                message: data?.message || `Exécution de l'outil ${data?.tool || ""}...`,
                timestamp,
            };
        case "tool_result":
            return {
                type: "status",
                status: "tool_result",
                progress: 65,
                message: data?.message || "Résultat obtenu.",
                timestamp,
            };
        case "iteration":
            return {
                type: "status",
                status: "iteration",
                progress: 40,
                message: data?.message || "Affinement de la réponse...",
                timestamp,
            };
        case "response":
            return {
                type: "status",
                status: "response",
                progress: 90,
                message: data?.message || "Préparation de la réponse finale...",
                timestamp,
            };

        case "workflow_complete": {
            const strategicResponse = data?.strategic_response;
            const hasSqlResults = Array.isArray(data?.sql_results) && data.sql_results.length > 0;

            let markdown: string;
            if (strategicResponse) {
                markdown = strategicResponse;
            } else {
                markdown = hasSqlResults
                    ? _buildSqlThinkingMarkdown(data)
                    : (data?.final_markdown || data?.response || data?.result?.response || "");
            }
            return {
                type: "complete",
                timestamp,
                result: data?.result ?? data,
                final_markdown: markdown,
                steps: [],
            };
        }
        case "error":
            return {
                type: "error",
                content: data?.error || data?.message || "Erreur du traitement",
                timestamp,
            };
        case "cancelled":
            return {
                type: "error",
                content: "Traitement annulé",
                timestamp,
            };
        case "chart_data":
            return {
                type: "chart_data",
                chartId: data?.chartId,
                query: data?.query,
                chart: data?.chart,
                timestamp,
            };
        case "llm_token":
            return {
                type: "chunk",
                content: data?.token ?? "",
                timestamp,
            };
        case "heartbeat":
            return null;
        default:
            console.warn("Unmapped SSE event:", eventName, data);
            return null;
    }
}

// Conversation types (for compatibility)
export interface ConversationMessage {
    role: "user" | "assistant";
    content: string;
}

export interface ConversationItem {
    conversation_id: string;
    topic: string;
    last_message?: string;
    created_at: string;
    updated_at: string;
}

export interface ConversationListResponse {
    success: boolean;
    conversations: ConversationItem[];
    count: number;
    error?: string | null;
}

export interface ConversationHistoryResponse {
    success: boolean;
    messages: ConversationMessage[];
    error?: string | null;
}

export interface DeleteConversationResponse {
    success: boolean;
    message: string;
    error?: string | null;
}

export interface UploadDossierResponse {
    success: boolean;
    message?: string;
    dossier_id?: string;
    error?: string | null;
}

export { getSessionId, setSessionId };

/**
 * Submit a chat query and get task ID
 */
export async function submitChatQuery(request: ChatRequest): Promise<ChatResponse> {
    const sessionId = getSessionId();

    const response = await fetch(`${API_URL}/api/v1/chat`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            message: request.query,
            sessionId: sessionId,
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Chat API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();

    // Map backend response to frontend interface
    return {
        success: true,
        query: request.query,
        taskId: data.taskId,
        conversation_id: data.sessionId,
    };
}

/**
 * Poll for task completion (fallback when SSE fails or for quick tasks)
 */
async function pollTaskResult(
    taskId: string,
    onEvent: StreamCallback,
): Promise<void> {
    const maxAttempts = 60;
    const delayMs = 1000;

    for (let attempts = 0; attempts < maxAttempts; attempts++) {
        try {
            const response = await fetch(`${API_URL}/api/v1/tasks/${taskId}`);
            const data = await response.json();

            // Send status event
            onEvent({
                type: "status",
                status: data.status,
                progress: data.progress || (attempts / maxAttempts) * 100,
                timestamp: new Date().toISOString(),
            });

            if (data.status === "completed") {
                // Extract content from result
                let content = "";
                let usedTools: string[] = [];

                if (data.result) {
                    if (typeof data.result.response === "string") {
                        content = data.result.response;
                    }
                    if (data.result.toolUsed) {
                        usedTools = [data.result.toolUsed];
                    }
                }

                // Send content as chunk
                if (content) {
                    onEvent({
                        type: "chunk",
                        content: content,
                        timestamp: new Date().toISOString(),
                    });
                }

                // Send complete event
                onEvent({
                    type: "complete",
                    timestamp: new Date().toISOString(),
                    result: data.result,
                    used_tools: usedTools,
                });

                return;
            } else if (data.status === "failed") {
                onEvent({
                    type: "error",
                    content: data.error || "Task failed",
                    timestamp: new Date().toISOString(),
                });
                return;
            }

            // Wait before next poll
            await new Promise(resolve => setTimeout(resolve, delayMs));
        } catch (error) {
            console.error("Poll error:", error);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }

    // Timeout
    onEvent({
        type: "error",
        content: "Timeout waiting for response",
        timestamp: new Date().toISOString(),
    });
}

/**
 * Stream chat results using SSE
 * Connects to our backend's stream endpoint
 */
export function streamChatResults(
    taskId: string,
    onEvent: StreamCallback,
    onError?: (error: Error) => void,
): AbortController {
    const abortController = new AbortController();
    let sseFailed = false;

    // Send start event
    onEvent({
        type: "start",
        timestamp: new Date().toISOString(),
    });

    fetch(`${API_URL}/api/v1/stream/${taskId}`, {
        method: "GET",
        headers: {
            "Accept": "text/event-stream",
            "Cache-Control": "no-cache",
        },
        signal: abortController.signal,
    })
        .then(async (response) => {
            if (!response.ok) {
                throw new Error(`Stream API error: ${response.status} - ${response.statusText}`);
            }

            if (!response.body) {
                throw new Error("Response body is null");
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let receivedAnyData = false;

            while (true) {
                const { done, value } = await reader.read();

                if (done) {
                    break;
                }

                receivedAnyData = true;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                    const trimmedLine = line.trim();
                    if (trimmedLine.startsWith("data: ")) {
                        try {
                            const data = JSON.parse(trimmedLine.slice(6).trim());

                            // Skip connection events
                            if (data.type === "connected") {
                                continue;
                            }

                            // Map backend events to frontend events
                            if (data.status === "processing") {
                                onEvent({
                                    type: "status",
                                    status: data.type || data.status,
                                    progress: data.progress || 0,
                                    timestamp: data.timestamp || new Date().toISOString(),
                                });
                            } else if (data.status === "completed") {
                                // Extract content from result
                                let content = "";
                                let usedTools: string[] = [];

                                if (data.result) {
                                    if (typeof data.result.response === "string") {
                                        content = data.result.response;
                                    }
                                    if (data.result.toolUsed) {
                                        usedTools = [data.result.toolUsed];
                                    }
                                }

                                // Send content as chunk
                                if (content) {
                                    onEvent({
                                        type: "chunk",
                                        content: content,
                                        timestamp: new Date().toISOString(),
                                    });
                                }

                                // Send complete event
                                onEvent({
                                    type: "complete",
                                    timestamp: new Date().toISOString(),
                                    result: data.result,
                                    used_tools: usedTools,
                                });
                            } else if (data.status === "failed") {
                                onEvent({
                                    type: "error",
                                    content: data.error || "Task failed",
                                    timestamp: new Date().toISOString(),
                                });
                            }
                        } catch (error) {
                            console.error("Failed to parse SSE event:", error, line);
                        }
                    }
                }
            }

            // If we didn't receive any data, fallback to polling
            if (!receivedAnyData) {
                console.log("No SSE data received, falling back to polling");
                await pollTaskResult(taskId, onEvent);
            }
        })
        .catch(async (error) => {
            if (error.name === "AbortError") {
                return;
            }

            console.error("SSE error, falling back to polling:", error);
            sseFailed = true;

            // Fallback to polling
            try {
                await pollTaskResult(taskId, onEvent);
            } catch (pollError) {
                if (onError) {
                    onError(pollError instanceof Error ? pollError : new Error(String(pollError)));
                } else {
                    console.error("Poll error:", pollError);
                }
            }
        });

    return abortController;
}

/**
 * Legacy interface: Stream a chat query (combines submit + stream)
 * This maintains compatibility with the existing useChat hook
 */
export function streamChatQuery(
    request: ChatRequest,
    onEvent: StreamCallback,
    onError?: (error: Error) => void,
): AbortController {
    const abortController = new AbortController();
    const sessionId = getSessionId();
    const startTimestamp = new Date().toISOString();

    onEvent({ type: "start", timestamp: startTimestamp });

    fetch(`${CHAT_URL}/chat/stream`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Cache-Control": "no-cache",
            "X-Session-ID": sessionId,
        },
        body: JSON.stringify({
            query: request.query,
        }),
        signal: abortController.signal,
    })
        .then(async (response) => {
            if (!response.ok) {
                throw new Error(`Chat API error: ${response.status} - ${response.statusText}`);
            }
            const returnedSessionId = response.headers.get("X-Session-ID");
            if (returnedSessionId) {
                setSessionId(returnedSessionId);
            }

            if (!response.body) {
                throw new Error("Response body is null");
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                buffer = buffer.replace(/\r\n/g, "\n");

                let separatorIndex = buffer.indexOf("\n\n");
                while (separatorIndex !== -1) {
                    const rawEvent = buffer.slice(0, separatorIndex).trim();
                    buffer = buffer.slice(separatorIndex + 2);

                    if (rawEvent) {
                        const eventLines = rawEvent.split("\n");
                        const nameLine = eventLines.find(line => line.startsWith("event:"));
                        const eventName = nameLine ? nameLine.slice(6).trim() : "message";
                        const dataLines = eventLines
                            .filter(line => line.startsWith("data:"))
                            .map(line => line.slice(5).trim());

                        if (dataLines.length > 0) {
                            const dataStr = dataLines.join("\n").trim();
                            try {
                                const payload = JSON.parse(dataStr);
                                const mapped = mapWorkflowEventToSSE(eventName, payload);
                                if (!mapped) {
                                    separatorIndex = buffer.indexOf("\n\n");
                                    continue;
                                }

                                if (mapped.type === "complete") {
                                    const markdown = mapped.final_markdown || "";
                                    if (markdown) {
                                        onEvent({
                                            type: "chunk",
                                            content: markdown,
                                            timestamp: mapped.timestamp,
                                        });
                                    }
                                }
                                onEvent(mapped);
                            } catch (err) {
                                console.error("Failed to parse /chat SSE event:", err, rawEvent);
                            }
                        }
                    }

                    separatorIndex = buffer.indexOf("\n\n");
                }
            }

            // trailing partial frames are ignored intentionally
        })
        .catch((error) => {
            if (error?.name === "AbortError") return;
            if (onError) {
                onError(error instanceof Error ? error : new Error(String(error)));
            } else {
                console.error("Chat SSE error:", error);
            }
        });

    return abortController;
}

/**
 * Non-streaming chat query
 */
export async function sendChatQuery(request: ChatRequest): Promise<ChatResponse> {
    const response = await submitChatQuery(request);

    if (!response.taskId) {
        return {
            success: false,
            error: "No task ID returned",
        };
    }

    // Poll for result
    let attempts = 0;
    const maxAttempts = 30;

    while (attempts < maxAttempts) {
        const taskResponse = await fetch(`${API_URL}/api/v1/tasks/${response.taskId}`);
        const taskData = await taskResponse.json();

        if (taskData.status === "completed") {
            return {
                success: true,
                query: request.query,
                response: taskData.result?.response || "",
                used_tools: taskData.result?.toolUsed ? [taskData.result.toolUsed] : [],
            };
        } else if (taskData.status === "failed") {
            return {
                success: false,
                error: taskData.error || "Task failed",
            };
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
        attempts++;
    }

    return {
        success: false,
        error: "Timeout waiting for response",
    };
}

// Legacy exports for compatibility
export const uploadDossier = async (files: File[]): Promise<any> => {
    return {
        success: true,
        message: "Upload not yet implemented",
    };
};

export const getConversations = async (): Promise<any> => {
    const response = await fetch(`${CONVERSATION_API_URL}/`, {
        method: "GET",
        headers: {
            Accept: "application/json",
        },
    });

    if (!response.ok) {
        throw new Error(`Conversation API error: ${response.status} - ${response.statusText}`);
    }

    const data = await response.json();
    return {
        success: true,
        conversations: data.sessions || [],
        count: data.total || 0,
    };
};

export const getConversationHistory = async (sessionId: string): Promise<any> => {
    const response = await fetch(`${CONVERSATION_API_URL}/${encodeURIComponent(sessionId)}`, {
        method: "GET",
        headers: {
            Accept: "application/json",
        },
    });

    if (!response.ok) {
        throw new Error(`Conversation history API error: ${response.status} - ${response.statusText}`);
    }

    const data = await response.json();
    return {
        success: true,
        messages: data.messages || [],
        session_id: data.session_id || sessionId,
    };
};

export const deleteConversation = async (sessionId: string): Promise<any> => {
    const response = await fetch(`${CONVERSATION_API_URL}/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
    });

    if (!response.ok && response.status !== 204) {
        throw new Error(`Delete conversation API error: ${response.status} - ${response.statusText}`);
    }

    removeSavedConversationMeta(sessionId);

    return {
        success: true,
        message: "Deleted",
    };
};

export const deleteConversations = async (): Promise<any> => {
    return {
        success: true,
        message: "All deleted",
    };
};

export const resetSessionMemory = async (sessionId: string): Promise<{ success: boolean; message: string }> => {
    const response = await fetch(`${CHAT_URL}/chat/memory/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
    });
    if (!response.ok) {
        throw new Error(`Reset memory API error: ${response.status} - ${response.statusText}`);
    }
    return response.json();
};

export const subscribeToSessionEvents = (): AbortController => {
    return new AbortController();
};
