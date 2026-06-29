export default () => ({
  port: parseInt(process.env.PORT, 10) || 4000,
  database: {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT, 10) || 5432,
    database: process.env.POSTGRES_DB || 'legal_ai',
    user: process.env.POSTGRES_USER || 'legal_ai',
    password: process.env.POSTGRES_PASSWORD,
  },
  keycloak: {
    url: process.env.KEYCLOAK_URL || 'http://localhost:8080',
    realm: process.env.KEYCLOAK_REALM || 'legal-ai',
    clientId: process.env.KEYCLOAK_CLIENT_ID || 'legal-ai-backend',
    clientSecret: process.env.KEYCLOAK_CLIENT_SECRET,
    adminPassword: process.env.KEYCLOAK_ADMIN_PASSWORD || 'lexia_dev_admin_password',
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD,
  },
  qdrant: {
    host: process.env.QDRANT_HOST || 'localhost',
    port: parseInt(process.env.QDRANT_PORT, 10) || 6333,
    apiKey: process.env.QDRANT_API_KEY,
    https: process.env.QDRANT_USE_SSL === 'true',
  },
  minio: {
    endPoint: process.env.MINIO_ENDPOINT || 'localhost',
    port: parseInt(process.env.MINIO_PORT, 10) || 9000,
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY,
    secretKey: process.env.MINIO_SECRET_KEY,
    // Browser-reachable endpoint used only when signing presigned URLs.
    // The internal endPoint (e.g. "minio") is not resolvable from the user's
    // browser, so presigned object URLs must be signed for a public host.
    // Defaults to the internal endpoint to preserve previous behaviour.
    publicEndpoint: process.env.MINIO_PUBLIC_ENDPOINT || process.env.MINIO_ENDPOINT || 'localhost',
    publicPort: parseInt(process.env.MINIO_PUBLIC_PORT, 10) || parseInt(process.env.MINIO_PORT, 10) || 9000,
    publicUseSSL: process.env.MINIO_PUBLIC_USE_SSL
      ? process.env.MINIO_PUBLIC_USE_SSL === 'true'
      : process.env.MINIO_USE_SSL === 'true',
  },
  openai: {
    // The OpenAI SDK throws during construction when apiKey is empty.
    // Keep the app bootable for local/API-only development; AI calls still
    // require a real OPENAI_API_KEY to succeed.
    apiKey: process.env.OPENAI_API_KEY || 'local-dev-openai-api-key-not-configured',
  },
  // Chat LLM (routing + answer generation). OpenAI-compatible: point at any
  // provider via LLM_BASE_URL (e.g. DeepSeek). Embeddings stay on OpenAI
  // (`openai` above) since DeepSeek has no embeddings API; corpus retrieval
  // degrades gracefully if embeddings are unavailable.
  llm: {
    apiKey:
      process.env.LLM_API_KEY ||
      process.env.DEEPSEEK_API_KEY ||
      process.env.OPENAI_API_KEY ||
      'local-dev-llm-api-key-not-configured',
    baseURL:
      process.env.LLM_BASE_URL ||
      (process.env.DEEPSEEK_API_KEY ? 'https://api.deepseek.com' : undefined),
    chatModel:
      process.env.LLM_CHAT_MODEL ||
      (process.env.DEEPSEEK_API_KEY || process.env.LLM_BASE_URL
        ? 'deepseek-chat'
        : 'gpt-4o'),
  },
  mistral: { apiKey: process.env.MISTRAL_API_KEY },
  // Claude Code (bilingual judgment analysis). Headless auth uses a long-lived
  // OAuth token from `claude setup-token` (CLAUDE_CODE_OAUTH_TOKEN) instead of
  // the interactive CLI login, which can't be carried into the container.
  claude: {
    oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN || '',
    analysisTimeoutMs:
      parseInt(process.env.CLAUDE_ANALYSIS_TIMEOUT_MS, 10) || 10 * 60 * 1000,
    classificationTimeoutMs:
      parseInt(process.env.CLAUDE_CLASSIFICATION_TIMEOUT_MS, 10) || 90 * 1000,
    killGraceMs:
      parseInt(process.env.CLAUDE_KILL_GRACE_MS, 10) || 5 * 1000,
  },
  agent: {
    url: process.env.LEXIA_AGENT_URL || 'http://localhost:8000',
    internalSecret: process.env.LEXIA_AGENT_INTERNAL_SECRET || '',
    userDocsCollection: process.env.LEXIA_USER_DOCS_COLLECTION || 'lexia_user_docs',
  },
  uploads: {
    // Monthly upload cap for authenticated users without an active paid plan.
    defaultMonthlyQuota: parseInt(process.env.LEXIA_DEFAULT_UPLOAD_QUOTA, 10) || 100,
    maxFileSizeBytes:
      parseInt(process.env.LEXIA_MAX_UPLOAD_BYTES, 10) || 50 * 1024 * 1024,
  },
  encryptionKey: process.env.ENCRYPTION_KEY || '12345678901234567890123456789012',
  cors: { origin: process.env.CORS_ORIGIN || 'http://localhost' },
});
