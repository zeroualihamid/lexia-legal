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
    url: process.env.KEYCLOAK_URL || 'http://keycloak:8080',
    realm: process.env.KEYCLOAK_REALM || 'legal-ai',
    clientId: process.env.KEYCLOAK_CLIENT_ID || 'legal-ai-backend',
    clientSecret: process.env.KEYCLOAK_CLIENT_SECRET,
    adminPassword: process.env.KEYCLOAK_ADMIN_PASSWORD,
  },
  redis: {
    host: process.env.REDIS_HOST || 'redis',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD,
  },
  qdrant: {
    host: process.env.QDRANT_HOST || 'qdrant',
    port: parseInt(process.env.QDRANT_PORT, 10) || 6333,
    apiKey: process.env.QDRANT_API_KEY,
  },
  minio: {
    endPoint: process.env.MINIO_ENDPOINT || 'minio',
    port: parseInt(process.env.MINIO_PORT, 10) || 9000,
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY,
    secretKey: process.env.MINIO_SECRET_KEY,
  },
  openai: { apiKey: process.env.OPENAI_API_KEY },
  mistral: { apiKey: process.env.MISTRAL_API_KEY },
  encryptionKey: process.env.ENCRYPTION_KEY || '12345678901234567890123456789012',
  cors: { origin: process.env.CORS_ORIGIN || 'http://localhost' },
});
