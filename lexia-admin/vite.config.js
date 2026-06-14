import path from "path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

/** Path prefixes served by brikz-backend (auth, Cross Tower API, agent proxy). */
const BACKEND_PROXY_PREFIXES = [
  "api",
  "chat",
  "conversation",
  "domains",
  "cards",
  "parquet",
  "cte-graph",
  "workflow",
  "graph",
  "agents",
  "data",
  "skills",
  "reporting",
  "playground",
  "stream",
  "admin",
  "health",
  "docs",
  "docs-json",
];

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backendTarget = (
    env.VITE_BACKEND_URL ||
    env.VITE_API_URL ||
    "http://localhost:3020"
  ).replace(/\/$/, "");

  const proxy = Object.fromEntries(
    BACKEND_PROXY_PREFIXES.map((prefix) => [
      `/${prefix}`,
      { target: backendTarget, changeOrigin: true },
    ]),
  );

  return {
    // Support serving under a sub-path (e.g., /brikz/) via VITE_BASE.
    base: env.VITE_BASE || "/",
    plugins: [react()],
    server: {
      port: 5175,
      strictPort: false,
      proxy,
      // Allow importing report.css from the sibling agent tree (``?raw``).
      fs: {
        allow: [path.resolve(__dirname, "."), path.resolve(__dirname, "..")],
      },
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  };
});
