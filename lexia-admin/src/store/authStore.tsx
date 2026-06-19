import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type Keycloak from 'keycloak-js';

export type AccessLevel = 'PUBLIC' | 'PRO' | 'ADMIN' | 'SUPERADMIN';

interface AuthState {
  token: string | null;
  email: string | null;
  userId: string | null;
  accessLevel: AccessLevel;
  keycloak: Keycloak | null;
}

interface AuthContextValue extends AuthState {
  setAuth: (partial: Partial<AuthState>) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const emptyAuth: AuthState = {
  token: null,
  email: null,
  userId: null,
  accessLevel: 'PUBLIC',
  keycloak: null,
};

/** Module-level token for non-React API helpers (lexia-api). */
let tokenRef: string | null = null;

export function getLexiaToken(): string | null {
  return tokenRef;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuthState] = useState<AuthState>(emptyAuth);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...auth,
      setAuth: (partial) => {
        setAuthState((prev) => {
          const next = { ...prev, ...partial };
          tokenRef = next.token;
          return next;
        });
      },
      logout: () => {
        tokenRef = null;
        setAuthState(emptyAuth);
      },
    }),
    [auth],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuthStore(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuthStore must be used within AuthProvider');
  return ctx;
}
