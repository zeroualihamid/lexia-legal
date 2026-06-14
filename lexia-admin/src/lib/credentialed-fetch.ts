// Single-port migration: brikz-backend (NestJS) enforces a better-auth
// session on all proxied agent routes. The session lives in an http-only cookie,
// so every request to the backend must be sent with credentials.
//
// Rather than touch ~120 fetch() call sites, we install a one-time global fetch
// interceptor that adds `credentials: "include"` to requests targeting our
// backend base URLs (VITE_API_URL / VITE_ANALYST_URL / VITE_CHAT_URL) or
// same-origin relative URLs. Cross-origin calls (e.g. the OpenCode server on
// VITE_OPENCODE_URL) are left untouched so we don't break their CORS.

const stripTrailingSlash = (u: string | undefined): string => (u || "").replace(/\/+$/, "");

const BACKEND_BASES: string[] = [
  import.meta.env.VITE_API_URL,
  import.meta.env.VITE_ANALYST_URL,
  import.meta.env.VITE_CHAT_URL,
]
  .map(stripTrailingSlash)
  .filter(Boolean);

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function targetsBackend(url: string): boolean {
  // Relative URL -> same origin as the app (also our backend when co-served).
  if (!/^https?:\/\//i.test(url)) return true;
  return BACKEND_BASES.some((base) => url === base || url.startsWith(base + "/"));
}

let installed = false;

export function installCredentialedFetch(): void {
  if (installed || typeof window === "undefined" || !window.fetch) return;
  installed = true;

  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (targetsBackend(urlOf(input)) && (!init || init.credentials === undefined)) {
      init = { ...(init ?? {}), credentials: "include" };
    }
    return original(input, init);
  };
}
