/**
 * Ensure the internal brikz-admin account exists:
 *   login: admin  →  email admin@qclick.local
 *   password: admin
 *
 * Idempotent: safe to run on every boot after `auth migrate`.
 */
import { hashPassword } from "better-auth/crypto";
import { Pool } from "pg";
import { randomBytes } from "node:crypto";

const ADMIN_EMAIL = "admin@qclick.local";
const ADMIN_NAME = "admin";
const ADMIN_PASSWORD = "admin";

function id() {
  return randomBytes(16).toString("base64url");
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.log("[seed-admin] DATABASE_URL not set — skipping");
    return;
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const passwordHash = await hashPassword(ADMIN_PASSWORD);

    const existing = await pool.query(
      `SELECT id FROM "user" WHERE email = $1 LIMIT 1`,
      [ADMIN_EMAIL],
    );

    let userId = existing.rows[0]?.id;
    if (!userId) {
      userId = id();
      await pool.query(
        `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, true, NOW(), NOW())`,
        [userId, ADMIN_NAME, ADMIN_EMAIL],
      );
      console.log(`[seed-admin] created user ${ADMIN_EMAIL}`);
    } else {
      await pool.query(
        `UPDATE "user"
         SET name = $2, "emailVerified" = true, "updatedAt" = NOW()
         WHERE id = $1`,
        [userId, ADMIN_NAME],
      );
      console.log(`[seed-admin] updated user ${ADMIN_EMAIL}`);
    }

    const acct = await pool.query(
      `SELECT id FROM account WHERE "userId" = $1 AND "providerId" = 'credential' LIMIT 1`,
      [userId],
    );

    if (!acct.rows[0]?.id) {
      await pool.query(
        `INSERT INTO account (
           id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt"
         ) VALUES ($1, $2, 'credential', $3, $4, NOW(), NOW())`,
        [id(), userId, userId, passwordHash],
      );
      console.log("[seed-admin] created credential account");
    } else {
      await pool.query(
        `UPDATE account
         SET password = $2, "updatedAt" = NOW()
         WHERE id = $1`,
        [acct.rows[0].id, passwordHash],
      );
      console.log("[seed-admin] reset password to default (admin)");
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[seed-admin] failed:", err);
  process.exit(1);
});
