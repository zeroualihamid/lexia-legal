import { type ReactNode, useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useSession } from './lib/auth-client';
import AdminLogin from './components/auth/AdminLogin';
import AdminLayout from './components/layout/AdminLayout';
import { AuthProvider, useAuthStore } from './store/authStore';
import {
  accessLevelFromRoles,
  cleanCurrentUrl,
  ensureKeycloakInit,
  keycloak,
  isKeycloakAuthMode,
} from './lib/keycloak';

function AuthLoadingScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="h-8 w-8 rounded-full border-2 border-primary/25 border-t-primary animate-spin" />
    </div>
  );
}

function BetterAuthProtectedRoute({ children }: { children: ReactNode }) {
  const { data: session, isPending } = useSession();
  if (isPending) return <AuthLoadingScreen />;
  if (!session) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function KeycloakProtectedRoute({ children }: { children: ReactNode }) {
  const { token, accessLevel, keycloak: kc, setAuth } = useAuthStore();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const authenticated = await ensureKeycloakInit();
        if (cancelled) return;

        if (authenticated && keycloak.token) {
          const parsed = JSON.parse(atob(keycloak.token.split('.')[1]));
          const roles: string[] = parsed?.realm_access?.roles || [];
          setAuth({
            token: keycloak.token,
            userId: keycloak.subject || null,
            email: keycloak.tokenParsed?.email || keycloak.tokenParsed?.preferred_username || null,
            accessLevel: accessLevelFromRoles(roles),
            keycloak,
          });
          keycloak.onTokenExpired = () => {
            void keycloak.updateToken(30).then((refreshed) => {
              if (refreshed && keycloak.token) {
                setAuth({ token: keycloak.token });
              }
            });
          };
        } else {
          setAuth({ keycloak });
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setAuth]);

  useEffect(() => {
    if (!ready) return;
    if (!token && kc) {
      kc.login({ redirectUri: cleanCurrentUrl() });
    }
  }, [ready, token, kc]);

  if (!ready) return <AuthLoadingScreen />;
  if (!token) return <AuthLoadingScreen />;

  if (accessLevel !== 'ADMIN' && accessLevel !== 'SUPERADMIN') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-background p-6 text-center">
        <p className="text-lg font-semibold text-foreground">Accès refusé</p>
        <p className="max-w-md text-sm text-muted-foreground">
          Ce panneau d&apos;administration nécessite un compte administrateur Lexia Legal.
        </p>
        <button
          type="button"
          className="text-sm text-primary underline"
          onClick={() => kc?.logout({ redirectUri: window.location.origin })}
        >
          Se déconnecter
        </button>
      </div>
    );
  }

  return <>{children}</>;
}

function ProtectedRoute({ children }: { children: ReactNode }) {
  if (isKeycloakAuthMode()) {
    return <KeycloakProtectedRoute>{children}</KeycloakProtectedRoute>;
  }
  return <BetterAuthProtectedRoute>{children}</BetterAuthProtectedRoute>;
}

export default function App() {
  const [isDarkMode, setIsDarkMode] = useState(() => {
    const stored = localStorage.getItem('admin-theme');
    return stored ? stored === 'dark' : true;
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDarkMode);
    document.documentElement.lang = 'fr';
    localStorage.setItem('admin-theme', isDarkMode ? 'dark' : 'light');
  }, [isDarkMode]);

  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<AdminLogin />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <AdminLayout isDarkMode={isDarkMode} toggleTheme={() => setIsDarkMode((v) => !v)} />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
