import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const adminRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(adminRoot, "..");

function read(path) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function stringArray(source, name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
  if (!match) throw new Error(`Could not find ${name}`);
  return [...match[1].matchAll(/["']([^"']+)["']/g)].map((item) => item[1]);
}

function topLevel(path) {
  return path.replace(/^\/+/, "").split("/")[0];
}

const backendSource = read("lexia-backend/src/proxy/proxy.constants.ts");
const viteSource = read("lexia-admin/vite.config.js");
const nginxSource = read("lexia-admin/nginx.conf");

const backendPrefixes = [
  ...stringArray(backendSource, "AGENT_PROXY_PREFIXES"),
  ...stringArray(backendSource, "IN_PROCESS_PREFIXES"),
].map(topLevel);

// Swagger fetches the merged document from this sibling route.
backendPrefixes.push("docs-json");

const required = new Set(backendPrefixes);
const vitePrefixes = new Set(stringArray(viteSource, "BACKEND_PROXY_PREFIXES"));

const nginxMatch = nginxSource.match(/location\s+~\s+\^\/\(([^)]+)\)/);
if (!nginxMatch) throw new Error("Could not find the backend nginx location");
const nginxPrefixes = new Set(nginxMatch[1].split("|"));

const missingFromVite = [...required].filter((prefix) => !vitePrefixes.has(prefix));
const missingFromNginx = [...required].filter((prefix) => !nginxPrefixes.has(prefix));

if (!nginxSource.includes("proxy_pass http://lexia-backend:4000;")) {
  throw new Error("nginx must proxy to lexia-backend:4000 without a URI suffix");
}
if (missingFromVite.length || missingFromNginx.length) {
  throw new Error(
    [
      missingFromVite.length && `Missing Vite prefixes: ${missingFromVite.join(", ")}`,
      missingFromNginx.length && `Missing nginx prefixes: ${missingFromNginx.join(", ")}`,
    ].filter(Boolean).join("\n"),
  );
}

console.log(`Backend contract OK (${required.size} top-level routes)`);
