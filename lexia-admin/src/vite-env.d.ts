/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BACKEND_URL?: string;
  readonly VITE_API_URL?: string;
  readonly VITE_ANALYST_URL?: string;
  readonly VITE_BASE?: string;
  readonly VITE_AUTH_KEY?: string;
  readonly VITE_CHAT_URL?: string;
  readonly VITE_DEFAULT_SESSION_ID?: string;
  readonly VITE_OPENCODE_URL?: string;
  readonly VITE_OFFICIAL_OPENCODE_APP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
