import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { signIn } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { asset } from '@/lib/asset';

/**
 * Minimal credentials login for the internal admin tool.
 *
 * better-auth uses email/password; a bare username like "admin" is mapped to a
 * synthetic email (`admin@qclick.local`) so the operator can sign in with the
 * seeded `admin / admin` account.
 */
function toEmail(username: string): string {
  const u = username.trim();
  return u.includes('@') ? u : `${u || 'admin'}@qclick.local`;
}

export default function AdminLogin() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('admin');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await signIn.email({ email: toEmail(username), password });
      const authError = (res as { error?: { message?: string; code?: string } })?.error;
      if (authError) {
        if (authError.code === 'INVALID_EMAIL_OR_PASSWORD') {
          setError('Identifiant ou mot de passe incorrect (admin / admin par défaut).');
        } else {
          setError(authError.message || 'Échec de connexion');
        }
        return;
      }
      navigate('/', { replace: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Échec de connexion';
      if (/fetch|network|failed/i.test(message)) {
        setError('Impossible de joindre le backend. Vérifiez VITE_BACKEND_URL et que brikz-backend tourne.');
      } else {
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-background p-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm space-y-4 rounded-xl border border-border bg-card p-6 shadow-sm"
      >
        <div className="flex flex-col items-center gap-2">
          <img src={asset('logo.png')} alt="Brikz" className="h-10 w-10 rounded" />
          <h1 className="text-lg font-semibold text-foreground">Brikz · admin</h1>
          <p className="text-xs text-muted-foreground">Cross Tower · agent tooling</p>
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium text-foreground">Identifiant</label>
          <Input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium text-foreground">Mot de passe</label>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <p className="text-sm text-red-500">{error}</p>}
        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? 'Connexion…' : 'Se connecter'}
        </Button>
      </form>
    </div>
  );
}
