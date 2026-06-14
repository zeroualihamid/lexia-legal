import { createAuthClient } from "better-auth/react";

// The unified brikz-backend owns both auth and agent APIs. Same-origin is the
// preferred mode; VITE_ANALYST_URL remains as a compatibility fallback.
const envURL = (
  import.meta.env.VITE_API_URL ||
  import.meta.env.VITE_ANALYST_URL ||
  ""
).replace(/\/+$/, "");
const baseURL = envURL || (typeof window !== "undefined" ? window.location.origin : "");

export const authClient = createAuthClient({ baseURL });

export const { signIn, signUp, signOut, useSession, sendVerificationEmail } = authClient;
