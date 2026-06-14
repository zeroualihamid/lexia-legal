import { type FormEvent, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { signIn, signUp, useSession } from "../../lib/auth-client";

type AuthMode = "signin" | "signup";
type AuthStatus = {
  kind: "info" | "error";
  text: string;
};

export default function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const redirectTo = params.get("redirectTo") || "/agent";
  const { data: session, refetch } = useSession();
  const [mode, setMode] = useState<AuthMode>(params.get("mode") === "signup" ? "signup" : "signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (session) navigate(redirectTo, { replace: true });
  }, [navigate, redirectTo, session]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setStatus(null);
    setSubmitting(true);
    try {
      if (mode === "signup") {
        const { error } = await signUp.email({ email, password, name });
        if (error) throw new Error(error.message || "Signup failed");
        setStatus({ kind: "info", text: "Account created. Check your inbox to verify your email." });
      } else {
        const { error } = await signIn.email({ email, password });
        if (error) {
          if (error.code === "EMAIL_NOT_VERIFIED" || /verif/i.test(error.message || "")) {
            setStatus({ kind: "info", text: "We sent you a new verification link. Please confirm before signing in." });
            return;
          }
          throw new Error(error.message || "Sign-in failed");
        }
        localStorage.removeItem("isAuthenticated");
        await refetch();
        navigate(redirectTo, { replace: true });
      }
    } catch (err) {
      setStatus({
        kind: "error",
        text: err instanceof Error ? err.message : "Authentication failed",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm space-y-4 rounded-2xl border bg-card p-6 shadow-sm"
      >
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">
            {mode === "signup" ? "Create an account" : "Sign in"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {mode === "signup"
              ? "We'll email you a verification link."
              : "Welcome back to Brikz."}
          </p>
        </div>

        {mode === "signup" && (
          <input
            type="text"
            required
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        )}
        <input
          type="email"
          required
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        />
        <input
          type="password"
          required
          minLength={8}
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        />

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          {submitting ? "Working…" : mode === "signup" ? "Create account" : "Sign in"}
        </button>

        {status && (
          <p
            className={
              status.kind === "error"
                ? "text-sm text-red-600"
                : "text-sm text-muted-foreground"
            }
          >
            {status.text}
          </p>
        )}

        <button
          type="button"
          onClick={() => setMode(mode === "signup" ? "signin" : "signup")}
          className="w-full text-sm text-muted-foreground hover:text-foreground"
        >
          {mode === "signup" ? "Already have an account? Sign in" : "Need an account? Sign up"}
        </button>
      </form>
    </div>
  );
}
