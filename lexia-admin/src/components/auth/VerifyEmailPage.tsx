import { Link } from "react-router-dom";

export default function VerifyEmailPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-4 rounded-2xl border bg-card p-6 shadow-sm text-center">
        <h1 className="text-2xl font-semibold">Check your email</h1>
        <p className="text-sm text-muted-foreground">
          We sent you a verification link. Click it to activate your account,
          then return here to sign in.
        </p>
        <Link
          to="/login"
          className="inline-block rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
        >
          Back to sign in
        </Link>
      </div>
    </div>
  );
}
