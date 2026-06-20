#!/usr/bin/env node
/**
 * Import PDF judgments from a Google Drive folder into Lexia Legal.
 *
 * Skips files already present in Postgres (by Drive file id, MD5, SHA-256, or
 * filename + non-failed status in a judgments_* collection).
 *
 * Usage (from repo root, with Docker infra running):
 *   node lexia-backend/scripts/import-gdrive-judgments.mjs
 *   node lexia-backend/scripts/import-gdrive-judgments.mjs --dry-run
 *   node lexia-backend/scripts/import-gdrive-judgments.mjs --collection judgments_civil
 *
 * Auth (pick one):
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
 *     Share the Drive folder with the service account email.
 *   GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
 *   GOOGLE_DRIVE_ACCESS_TOKEN=ya29...   (short-lived; for quick tests)
 *
 * Optional:
 *   GOOGLE_DRIVE_FOLDER_ID=15V2YIi6eUwTKTWZ2Xd9A7Aflsl3Zp6Rh
 *   GDRIVE_JUDGMENTS_COLLECTION=judgments_commercial
 */

import { createHash, randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import dotenv from "dotenv";
import { Pool } from "pg";
import Queue from "bull";
import { GoogleAuth } from "google-auth-library";

const require = createRequire(import.meta.url);
const Minio = require("minio");

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");

const DEFAULT_FOLDER_ID = "15V2YIi6eUwTKTWZ2Xd9A7Aflsl3Zp6Rh";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const PROCESSED_STATUSES = ["processing", "pending_review", "published", "ready"];

function loadEnv() {
  for (const candidate of [
    resolve(REPO_ROOT, ".env"),
    resolve(REPO_ROOT, "deploy/.env"),
    resolve(__dirname, "../.env"),
  ]) {
    if (existsSync(candidate)) {
      dotenv.config({ path: candidate });
      return candidate;
    }
  }
  dotenv.config();
  return null;
}

function parseArgs(argv) {
  const args = { dryRun: false, collection: null, folderId: null };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--collection" && argv[i + 1]) {
      args.collection = argv[++i];
    } else if (arg === "--folder-id" && argv[i + 1]) {
      args.folderId = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node import-gdrive-judgments.mjs [--dry-run] [--collection judgments_commercial] [--folder-id ID]`);
      process.exit(0);
    }
  }
  return args;
}

function serviceAccountCredentials() {
  if (process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON);
  }
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (path && existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf8"));
  }
  return undefined;
}

async function getAccessToken() {
  if (process.env.GOOGLE_DRIVE_ACCESS_TOKEN) {
    return process.env.GOOGLE_DRIVE_ACCESS_TOKEN;
  }

  const credentials = serviceAccountCredentials();
  if (!credentials) {
    throw new Error(
      "Google Drive credentials missing. Set GOOGLE_APPLICATION_CREDENTIALS, " +
        "GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON, or GOOGLE_DRIVE_ACCESS_TOKEN. " +
        "The folder must be shared with the service account email, or use an OAuth token.",
    );
  }

  const auth = new GoogleAuth({
    credentials,
    scopes: [DRIVE_SCOPE],
  });
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  if (!tokenResponse.token) {
    throw new Error("Failed to obtain Google Drive access token.");
  }
  return tokenResponse.token;
}

async function driveFetch(accessToken, url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google Drive API ${res.status}: ${body.slice(0, 500)}`);
  }
  return res;
}

async function listPdfFiles(accessToken, folderId) {
  const files = [];
  let pageToken;

  do {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set(
      "q",
      `'${folderId}' in parents and mimeType='application/pdf' and trashed=false`,
    );
    url.searchParams.set(
      "fields",
      "nextPageToken,files(id,name,mimeType,size,md5Checksum,modifiedTime)",
    );
    url.searchParams.set("pageSize", "200");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await driveFetch(accessToken, url);
    const data = await res.json();
    files.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return files;
}

async function downloadPdf(accessToken, fileId) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  const res = await driveFetch(accessToken, url);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function loadDedupIndex(pool) {
  const { rows } = await pool.query(`
    SELECT
      metadata->>'google_drive_file_id' AS drive_id,
      metadata->>'md5_checksum' AS md5_checksum,
      metadata->>'sha256' AS sha256,
      split_part(minio_key, '/', 2) AS filename,
      status::text AS status,
      collection::text AS collection
    FROM documents
    WHERE metadata ? 'google_drive_file_id'
       OR collection::text LIKE 'judgments_%'
  `);

  const driveIds = new Set();
  const md5s = new Set();
  const sha256s = new Set();
  const filenames = new Set();

  for (const row of rows) {
    if (row.drive_id) driveIds.add(row.drive_id);
    if (row.md5_checksum) md5s.add(row.md5_checksum);
    if (row.sha256) sha256s.add(row.sha256);
    if (
      row.filename &&
      row.collection?.startsWith("judgments_") &&
      PROCESSED_STATUSES.includes(row.status)
    ) {
      filenames.add(row.filename);
    }
  }

  return { driveIds, md5s, sha256s, filenames };
}

function skipReason(file, dedup, sha256) {
  if (dedup.driveIds.has(file.id)) return "google_drive_file_id";
  if (file.md5Checksum && dedup.md5s.has(file.md5Checksum)) return "md5_checksum";
  if (sha256 && dedup.sha256s.has(sha256)) return "sha256";
  if (dedup.filenames.has(file.name)) return "filename";
  return null;
}

function dockerHostToLocal(host) {
  if (process.env.GDRIVE_IMPORT_USE_DOCKER_HOSTS === "true") return host;
  if (
    typeof host === "string" &&
    ["postgres", "redis", "minio", "qdrant", "keycloak"].includes(host) &&
    !existsSync("/.dockerenv")
  ) {
    return "localhost";
  }
  return host;
}

function createClients() {
  const pool = new Pool({
    host: dockerHostToLocal(process.env.POSTGRES_HOST || "localhost"),
    port: parseInt(process.env.POSTGRES_PORT || "5432", 10),
    database: process.env.POSTGRES_DB || "legal_ai",
    user: process.env.POSTGRES_USER || "legal_ai",
    password: process.env.POSTGRES_PASSWORD,
  });

  const minio = new Minio.Client({
    endPoint: dockerHostToLocal(process.env.MINIO_ENDPOINT || "localhost"),
    port: parseInt(process.env.MINIO_PORT || "9000", 10),
    useSSL: process.env.MINIO_USE_SSL === "true",
    accessKey: process.env.MINIO_ACCESS_KEY || "minioadmin",
    secretKey: process.env.MINIO_SECRET_KEY,
  });

  const redis = {
    host: dockerHostToLocal(process.env.REDIS_HOST || "localhost"),
    port: parseInt(process.env.REDIS_PORT || "6379", 10),
  };
  if (process.env.REDIS_PASSWORD) {
    redis.password = process.env.REDIS_PASSWORD;
  }

  const docQueue = new Queue("document-processing", { redis });
  return { pool, minio, docQueue };
}

async function ingestPdf({
  pool,
  minio,
  docQueue,
  file,
  buffer,
  collection,
  folderId,
  dryRun,
}) {
  const docId = randomUUID();
  const bucket = "raw-pdfs";
  const key = `${docId}/${file.name}`;
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const metadata = {
    google_drive_file_id: file.id,
    google_drive_folder_id: folderId,
    md5_checksum: file.md5Checksum || null,
    sha256,
    source: "google_drive",
    drive_modified_time: file.modifiedTime || null,
  };

  if (dryRun) {
    return { docId, action: "would_import", sha256 };
  }

  await minio.putObject(bucket, key, buffer, buffer.length, {
    "Content-Type": "application/pdf",
  });

  await pool.query(
    `INSERT INTO documents
       (id, title_ar, title_fr, collection, source_type, owner_type, owner_id,
        case_id, document_type, status, visibility, minio_bucket, minio_key,
        file_size_bytes, content_type, metadata)
     VALUES ($1, $2, NULL, $3, 'pdf_upload', 'system', NULL,
             NULL, NULL, 'processing', 'public', $4, $5, $6, 'application/pdf', $7::jsonb)`,
    [
      docId,
      file.name,
      collection,
      bucket,
      key,
      buffer.length,
      JSON.stringify(metadata),
    ],
  );

  const job = await docQueue.add(
    "process-document",
    {
      documentId: docId,
      bucket,
      key,
      ownerType: "system",
      ownerId: null,
      caseId: null,
      documentType: null,
    },
    {
      jobId: `document-upload-${docId}`,
      removeOnComplete: false,
      removeOnFail: false,
    },
  );

  await pool.query(
    `UPDATE documents
     SET metadata = metadata || jsonb_build_object(
           'processingJobId', $1::text,
           'taskStartedAt', NOW()::text
         ),
         updated_at = NOW()
     WHERE id = $2`,
    [String(job.id), docId],
  );

  return { docId, action: "imported", jobId: job.id, sha256 };
}

async function main() {
  const envFile = loadEnv();
  const args = parseArgs(process.argv);
  const folderId =
    args.folderId ||
    process.env.GOOGLE_DRIVE_FOLDER_ID ||
    DEFAULT_FOLDER_ID;
  const collection =
    args.collection ||
    process.env.GDRIVE_JUDGMENTS_COLLECTION ||
    "judgments_commercial";

  console.log(`[gdrive-import] env: ${envFile || "(process env)"}`);
  console.log(`[gdrive-import] folder: ${folderId}`);
  console.log(`[gdrive-import] collection: ${collection}`);
  if (args.dryRun) console.log("[gdrive-import] dry-run mode — no writes");

  const accessToken = await getAccessToken();
  const { pool, minio, docQueue } = createClients();

  try {
    const dedup = await loadDedupIndex(pool);
    console.log(
      `[gdrive-import] dedup index: ${dedup.driveIds.size} drive ids, ` +
        `${dedup.md5s.size} md5, ${dedup.sha256s.size} sha256, ` +
        `${dedup.filenames.size} filenames`,
    );

    const files = await listPdfFiles(accessToken, folderId);
    console.log(`[gdrive-import] found ${files.length} PDF(s) in Drive folder`);

    const stats = { skipped: 0, imported: 0, would_import: 0, failed: 0 };

    for (const file of files) {
      const preSkip = skipReason(file, dedup, null);
      if (preSkip) {
        console.log(`  skip  ${file.name} (${preSkip})`);
        stats.skipped += 1;
        continue;
      }

      try {
        console.log(`  fetch ${file.name} (${file.size || "?"} bytes)`);
        const buffer = await downloadPdf(accessToken, file.id);
        const sha256 = createHash("sha256").update(buffer).digest("hex");
        const postSkip = skipReason(file, dedup, sha256);
        if (postSkip) {
          console.log(`  skip  ${file.name} (${postSkip} after download)`);
          stats.skipped += 1;
          continue;
        }

        const result = await ingestPdf({
          pool,
          minio,
          docQueue,
          file,
          buffer,
          collection,
          folderId,
          dryRun: args.dryRun,
        });

        dedup.driveIds.add(file.id);
        if (file.md5Checksum) dedup.md5s.add(file.md5Checksum);
        dedup.sha256s.add(sha256);
        dedup.filenames.add(file.name);

        if (result.action === "would_import") {
          console.log(`  plan  ${file.name}`);
          stats.would_import += 1;
        } else {
          console.log(`  ok    ${file.name} → ${result.docId} (job ${result.jobId})`);
          stats.imported += 1;
        }
      } catch (err) {
        console.error(`  fail  ${file.name}: ${err.message}`);
        stats.failed += 1;
      }
    }

    console.log(
      `[gdrive-import] done: imported=${stats.imported} skipped=${stats.skipped} ` +
        `would_import=${stats.would_import} failed=${stats.failed}`,
    );
  } finally {
    await docQueue.close();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`[gdrive-import] fatal: ${err.message}`);
  process.exit(1);
});
