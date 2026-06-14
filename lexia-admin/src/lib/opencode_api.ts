// API client for OpenCode server (http://127.0.0.1:4096)
// Connects via SSE for real-time streaming and REST for session/message management

const OPENCODE_BASE_URL =
  import.meta.env.VITE_OPENCODE_URL || "http://127.0.0.1:4096";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OpenCodeSession {
  id: string;
  slug: string;
  projectID: string;
  directory: string;
  title: string;
  version: string;
  summary?: {
    additions: number;
    deletions: number;
    files: number;
  };
  time: {
    created: number;
    updated: number;
  };
}

export interface OpenCodeMessageInfo {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  parentID?: string;
  modelID?: string;
  providerID?: string;
  agent?: string;
  cost?: number;
  tokens?: {
    total: number;
    input: number;
    output: number;
    reasoning: number;
    cache?: { read: number; write: number };
  };
  finish?: string;
  time: {
    created: number;
    completed?: number;
  };
}

export interface OpenCodeTextPart {
  type: "text";
  text: string;
  id: string;
  sessionID: string;
  messageID: string;
}

export interface OpenCodeToolPart {
  type: "tool";
  callID: string;
  tool: string;
  state: {
    status: "pending" | "running" | "completed" | "error";
    input?: Record<string, unknown>;
    output?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    time?: { start: number; end: number };
  };
  id: string;
  sessionID: string;
  messageID: string;
}

export interface OpenCodeReasoningPart {
  type: "reasoning";
  text: string;
  time?: { start: number; end: number };
  id: string;
  sessionID: string;
  messageID: string;
}

export interface OpenCodeStepStartPart {
  type: "step-start";
  snapshot?: string;
  id: string;
  sessionID: string;
  messageID: string;
}

export interface OpenCodeStepFinishPart {
  type: "step-finish";
  id: string;
  sessionID: string;
  messageID: string;
}

export type OpenCodePart =
  | OpenCodeTextPart
  | OpenCodeToolPart
  | OpenCodeReasoningPart
  | OpenCodeStepStartPart
  | OpenCodeStepFinishPart;

export interface OpenCodeMessage {
  info: OpenCodeMessageInfo;
  parts: OpenCodePart[];
}

// SSE event types emitted by /event
export interface OpenCodeEvent {
  type: string;
  properties: Record<string, unknown>;
}

// Callbacks for streaming chat
export interface OpenCodeStreamCallbacks {
  onTextDelta?: (delta: string, fullText: string) => void;
  onToolUpdate?: (part: OpenCodeToolPart) => void;
  onReasoningDelta?: (text: string) => void;
  onError?: (error: string) => void;
  onDone?: (sessionId: string) => void;
  onEvent?: (event: OpenCodeEvent) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function opencodeFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const url = `${OPENCODE_BASE_URL}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `OpenCode API ${response.status}: ${response.statusText} – ${text}`,
    );
  }
  return response.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export async function getHealth(): Promise<{
  healthy: boolean;
  version: string;
}> {
  return opencodeFetch("/global/health");
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

export async function listSessions(): Promise<OpenCodeSession[]> {
  return opencodeFetch<OpenCodeSession[]>("/session");
}

export async function getSession(
  sessionId: string,
): Promise<OpenCodeSession> {
  return opencodeFetch<OpenCodeSession>(`/session/${encodeURIComponent(sessionId)}`);
}

export async function createSession(
  title?: string,
): Promise<OpenCodeSession> {
  return opencodeFetch<OpenCodeSession>("/session", {
    method: "POST",
    body: JSON.stringify({ title: title ?? undefined }),
  });
}

export async function deleteSession(sessionId: string): Promise<boolean> {
  return opencodeFetch<boolean>(
    `/session/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" },
  );
}

export async function abortSession(sessionId: string): Promise<boolean> {
  return opencodeFetch<boolean>(
    `/session/${encodeURIComponent(sessionId)}/abort`,
    { method: "POST" },
  );
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export async function getMessages(
  sessionId: string,
  limit?: number,
): Promise<OpenCodeMessage[]> {
  const qs = limit ? `?limit=${limit}` : "";
  return opencodeFetch<OpenCodeMessage[]>(
    `/session/${encodeURIComponent(sessionId)}/message${qs}`,
  );
}

export async function getMessage(
  sessionId: string,
  messageId: string,
): Promise<OpenCodeMessage> {
  return opencodeFetch<OpenCodeMessage>(
    `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`,
  );
}

/**
 * Send a prompt and wait for the full assistant response (blocking).
 */
export async function sendPrompt(
  sessionId: string,
  text: string,
  options?: {
    model?: { providerID: string; modelID: string };
    agent?: string;
  },
): Promise<OpenCodeMessage> {
  return opencodeFetch<OpenCodeMessage>(
    `/session/${encodeURIComponent(sessionId)}/message`,
    {
      method: "POST",
      body: JSON.stringify({
        parts: [{ type: "text", text }],
        ...(options?.model ? { model: options.model } : {}),
        ...(options?.agent ? { agent: options.agent } : {}),
      }),
    },
  );
}

/**
 * Send a prompt asynchronously (returns immediately, stream via SSE).
 */
export async function sendPromptAsync(
  sessionId: string,
  text: string,
  options?: {
    model?: { providerID: string; modelID: string };
    agent?: string;
  },
): Promise<void> {
  const url = `${OPENCODE_BASE_URL}/session/${encodeURIComponent(sessionId)}/prompt_async`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      parts: [{ type: "text", text }],
      ...(options?.model ? { model: options.model } : {}),
      ...(options?.agent ? { agent: options.agent } : {}),
    }),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`prompt_async failed: ${response.status} – ${errText}`);
  }
}

// ---------------------------------------------------------------------------
// SSE event stream
// ---------------------------------------------------------------------------

/**
 * Subscribe to the global SSE event stream from the opencode server.
 * Returns an AbortController to tear down the connection.
 *
 * The first event is always `{ type: "server.connected" }`.
 *
 * Key event types to watch for during a chat:
 *  - `message.part.updated` – text deltas and tool call updates
 *  - `message.updated`      – full message info updates
 *  - `session.idle`         – session finished processing
 *  - `session.error`        – error during processing
 */
export function subscribeToEvents(
  onEvent: (event: OpenCodeEvent) => void,
  onError?: (error: Error) => void,
): AbortController {
  const controller = new AbortController();

  fetch(`${OPENCODE_BASE_URL}/event`, {
    headers: { Accept: "text/event-stream", "Cache-Control": "no-cache" },
    signal: controller.signal,
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`SSE connect failed: ${response.status}`);
      }
      if (!response.body) {
        throw new Error("SSE response body is null");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data: ")) {
            try {
              const data = JSON.parse(trimmed.slice(6));
              onEvent(data as OpenCodeEvent);
            } catch {
              // ignore malformed SSE frames
            }
          }
        }
      }
    })
    .catch((err) => {
      if ((err as Error).name === "AbortError") return;
      onError?.(err instanceof Error ? err : new Error(String(err)));
    });

  return controller;
}

// ---------------------------------------------------------------------------
// Streaming chat  (high-level convenience)
// ---------------------------------------------------------------------------

/**
 * Send a chat message and stream the response in real-time via SSE.
 *
 * Flow:
 *  1. Subscribe to the global event stream.
 *  2. Fire `prompt_async` so the assistant starts generating.
 *  3. Filter SSE events for the target session and forward deltas/tool
 *     updates/errors to the provided callbacks.
 *  4. When `session.idle` is received the stream is considered complete.
 *
 * Returns an AbortController that tears down both the SSE connection and
 * (optionally) aborts the running session.
 */
export function streamChat(
  sessionId: string,
  text: string,
  callbacks: OpenCodeStreamCallbacks,
  options?: {
    model?: { providerID: string; modelID: string };
    agent?: string;
  },
): AbortController {
  const controller = new AbortController();

  const textAccumulator: Record<string, string> = {};

  const sseController = subscribeToEvents(
    (event) => {
      callbacks.onEvent?.(event);

      const props = event.properties ?? {};
      if (
        "sessionID" in props &&
        (props as { sessionID: string }).sessionID !== sessionId
      ) {
        return;
      }

      switch (event.type) {
        case "message.part.updated": {
          const part = props.part as OpenCodePart | undefined;
          if (!part) break;

          if (part.type === "text") {
            const delta = (props.delta as string) ?? "";
            const partId = part.id;
            textAccumulator[partId] =
              (textAccumulator[partId] ?? "") + delta;
            callbacks.onTextDelta?.(delta, part.text ?? textAccumulator[partId]);
          } else if (part.type === "tool") {
            callbacks.onToolUpdate?.(part as OpenCodeToolPart);
          } else if (part.type === "reasoning") {
            callbacks.onReasoningDelta?.((part as OpenCodeReasoningPart).text);
          }
          break;
        }

        case "session.error": {
          const error =
            (props.error as string) ??
            (props.message as string) ??
            "Unknown session error";
          callbacks.onError?.(error);
          break;
        }

        case "session.idle": {
          callbacks.onDone?.(sessionId);
          sseController.abort();
          break;
        }
      }
    },
    (err) => {
      callbacks.onError?.(err.message);
    },
  );

  controller.signal.addEventListener("abort", () => {
    sseController.abort();
    abortSession(sessionId).catch(() => {});
  });

  sendPromptAsync(sessionId, text, options).catch((err) => {
    callbacks.onError?.(
      err instanceof Error ? err.message : String(err),
    );
  });

  return controller;
}

// ---------------------------------------------------------------------------
// Create session + stream in one call
// ---------------------------------------------------------------------------

/**
 * Convenience wrapper: creates a new session (or reuses an existing one),
 * sends a message, and streams the response.
 */
export async function chatStream(
  text: string,
  callbacks: OpenCodeStreamCallbacks,
  options?: {
    sessionId?: string;
    title?: string;
    model?: { providerID: string; modelID: string };
    agent?: string;
  },
): Promise<{ sessionId: string; abort: AbortController }> {
  let sessionId = options?.sessionId;

  if (!sessionId) {
    const session = await createSession(options?.title ?? text.slice(0, 60));
    sessionId = session.id;
  }

  const abort = streamChat(sessionId, text, callbacks, {
    model: options?.model,
    agent: options?.agent,
  });

  return { sessionId, abort };
}
