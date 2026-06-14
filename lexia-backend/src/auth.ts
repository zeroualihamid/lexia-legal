import { betterAuth } from "better-auth";
import { Pool } from "pg";
import { sendVerificationEmail } from "./email";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function parseOrigins(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const localDevOrigins = [
  "http://localhost:5100",
  "http://127.0.0.1:5100",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
  "http://localhost:5175",
  "http://127.0.0.1:5175",
  "http://localhost:5176",
  "http://127.0.0.1:5176",
];

const appEnv = process.env.LEXIA_ENV ?? process.env.NODE_ENV;
const isAppProduction = appEnv === "production";
const authURL = process.env.BETTER_AUTH_URL ?? "";
const isLocalAuthURL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(authURL);
const isHttpsAuthURL = /^https:\/\//.test(authURL);
// Whether Secure cookies are usable. True for HTTPS, and also for
// localhost/127.0.0.1 (a browser "secure context" where Secure cookies work
// even over http — preserves cross-port local dev :5173↔:6003). FALSE only for
// a real plain-HTTP host (on-prem behind nginx, e.g. http://172.16.8.111),
// where browsers drop Secure cookies and reject SameSite=None without Secure.
const allowSecureCookies = isHttpsAuthURL || isLocalAuthURL;

// Trusted browser origins for credentialed requests (CORS + better-auth CSRF):
//   LEXIA_CHAT_ORIGIN  — the lexia chat frontend (comma-separated allowed)
//   LEXIA_ADMIN_ORIGIN — the lexia-admin internal tool (comma-separated)
// plus the built-in local dev origins in non-production. Configure each app's
// origin explicitly via its env var so the exact port is handled clearly.
export const trustedOrigins = Array.from(
  new Set([
    ...parseOrigins(process.env.LEXIA_CHAT_ORIGIN),
    ...parseOrigins(process.env.LEXIA_ADMIN_ORIGIN),
    ...(!isAppProduction || isLocalAuthURL ? localDevOrigins : []),
  ]),
);

export const pool = new Pool({
  connectionString: required("DATABASE_URL"),
});

export const auth = betterAuth({
  database: pool,
  baseURL: required("BETTER_AUTH_URL"),
  secret: required("BETTER_AUTH_SECRET"),
  trustedOrigins,
  // Session-cookie attributes adapt to the PUBLIC scheme (BETTER_AUTH_URL):
  //  • HTTPS (e.g. Netlify frontend + Railway backend, different registrable
  //    domains): cross-site delivery needs SameSite=None + Secure, plus
  //    Partitioned (CHIPS) for the modern third-party-cookie standard.
  //  • Plain HTTP on-prem behind nginx (frontend + API on the same host, e.g.
  //    http://172.16.8.111): browsers DROP Secure cookies on HTTP and reject
  //    SameSite=None without Secure — so use SameSite=Lax + non-Secure (the
  //    request is first-party/same-origin, so Lax is sent on navigation).
  // NOTE (HTTPS cross-site): Safari/strict browsers still block third-party
  // cookies — the robust fix is to proxy the API through the frontend domain.
  advanced: {
    defaultCookieAttributes: allowSecureCookies
      ? { sameSite: "none", secure: true, partitioned: true }
      : { sameSite: "lax", secure: false },
    // Only emit the __Secure- cookie-name prefix for true HTTPS — on plain HTTP
    // (incl. localhost) a __Secure- cookie would be rejected by the browser.
    useSecureCookies: isHttpsAuthURL,
  },
  emailAndPassword: {
    enabled: true,
    // Email verification temporarily disabled so accounts can sign in without
    // clicking a Resend link (the sandbox sender can't deliver to arbitrary
    // addresses). Re-enable + restore emailVerification once a verified Resend
    // domain/sender is configured.
    requireEmailVerification: false,
    // Allow the seeded internal admin account (admin / admin). Default is 8.
    minPasswordLength: 1,
  },
  emailVerification: {
    sendOnSignIn: false,
    sendVerificationEmail: async ({ user, url }) => {
      await sendVerificationEmail(user.email, url);
    },
  },
});
