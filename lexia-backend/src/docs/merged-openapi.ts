import type { Express, Request, Response } from "express";
import type { OpenAPIObject } from "@nestjs/swagger";

/**
 * Serves a *merged* OpenAPI document at the Swagger JSON path so that
 * http://<backend>/docs lists not only the in-process routes (Chat, Health)
 * but also EVERY endpoint of the qclick-agent FastAPI service that this
 * backend reverse-proxies.
 *
 * The agent's spec is fetched live from `${LEXIA_AGENT_URL}/openapi.json`
 * (FastAPI generates it automatically), merged into the NestJS-generated base
 * document, and cached briefly. If the agent is unreachable (e.g. still booting)
 * we serve the base document so /docs never breaks.
 *
 * Because the agent is reached through this backend at the SAME paths it
 * exposes (the proxy forwards `req.path` unchanged), the agent's spec paths map
 * 1:1 onto the backend's public surface — no path rewriting needed.
 */

const AGENT_URL = process.env.LEXIA_AGENT_URL ?? "http://localhost:8000";
const CACHE_TTL_MS = 30_000;

let cached: { at: number; doc: OpenAPIObject } | null = null;

async function fetchAgentSpec(): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(new URL("/openapi.json", AGENT_URL), {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null; // agent down / still booting -> fall back to base doc
  } finally {
    clearTimeout(timer);
  }
}

function mergeAgentSpec(base: OpenAPIObject, agent: Record<string, any>): OpenAPIObject {
  const merged: OpenAPIObject = JSON.parse(JSON.stringify(base));
  merged.paths = { ...(merged.paths ?? {}) };

  const agentPaths: Record<string, any> = agent.paths ?? {};
  for (const [path, item] of Object.entries(agentPaths)) {
    // Skip the agent's own doc plumbing.
    if (path === "/openapi.json" || path === "/docs" || path === "/redoc" || path.startsWith("/docs/")) {
      continue;
    }
    // Don't clobber a path the backend already documents itself (e.g. /chat/stream).
    if (merged.paths[path]) continue;
    merged.paths[path] = item;
  }

  // Merge component schemas referenced by the agent's $refs (base wins on clash).
  const agentSchemas: Record<string, any> = agent.components?.schemas ?? {};
  merged.components = merged.components ?? {};
  merged.components.schemas = { ...agentSchemas, ...(merged.components.schemas ?? {}) };

  return merged;
}

/**
 * Registers `GET <jsonPath>` on the underlying Express app, returning the merged
 * spec. Must be registered BEFORE SwaggerModule.setup so this handler (rather
 * than Swagger's static one) answers the UI's request for the document.
 */
export function mountMergedOpenApi(expressApp: Express, baseDoc: OpenAPIObject, jsonPath = "/docs-json"): void {
  expressApp.get(jsonPath, async (_req: Request, res: Response) => {
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      res.json(cached.doc);
      return;
    }
    const agentSpec = await fetchAgentSpec();
    const doc = agentSpec ? mergeAgentSpec(baseDoc, agentSpec) : baseDoc;
    cached = { at: Date.now(), doc };
    res.json(doc);
  });
}
