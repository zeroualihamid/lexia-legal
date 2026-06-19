/**
 * Top-level path prefixes owned by the qclick-agent FastAPI app. Every request
 * whose path falls under one of these is reverse-proxied to LEXIA_AGENT_URL,
 * EXCEPT the exclusions below which are served in-process by NestJS.
 */
export const AGENT_PROXY_PREFIXES = [
  "chat", // /chat/memory/*, /chat/sessions  (/chat/stream is excluded -> ChatController)
  "conversation",
  "domains",
  "cards",
  "parquet",
  "cte-graph",
  "legal-graphs",
  "workflow",
  "graph",
  "agents",
  "data",
  "skills",
  "reporting",
  "playground",
  "stream",
  "admin", // /admin/claude/* — skill enhance-loop (SSE)
  "api/v1",
];

/** Exact paths under an agent prefix that NestJS handles itself. */
const EXCLUDED_EXACT = new Set(["/chat/stream"]);

/** In-process / public prefixes that must never be proxied. */
const IN_PROCESS_PREFIXES = [
  "/api/auth",
  "/api/me",
  "/api/chat",
  "/api/search",
  "/api/documents",
  "/api/cases",
  "/api/billing",
  "/api/admin",
  "/api/dashboard",
  "/api/tenants",
  "/api/badges",
  "/api/parking",
  "/api/tickets",
  "/api/providers",
  "/api/calendar",
  "/api/visitors",
  "/api/boh",
  "/api/users",
  "/health",
  "/docs",
  "/api/docs",
  "/bull-board",
];

/** True when `path` should be reverse-proxied to the agent. */
export function isProxiedPath(path: string): boolean {
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path; // strip trailing slash (keep "/")
  if (EXCLUDED_EXACT.has(p)) return false;
  if (IN_PROCESS_PREFIXES.some((x) => p === x || p.startsWith(x + "/"))) return false;
  return AGENT_PROXY_PREFIXES.some((prefix) => {
    const base = "/" + prefix;
    return p === base || p.startsWith(base + "/");
  });
}
