const ADMIN_TOKEN_KEY = 'lexia_admin_token';

export type AccessLevel = 'PUBLIC' | 'PRO' | 'ADMIN' | 'SUPERADMIN';

export interface AdminSession {
  token: string;
  userId: string | null;
  email: string | null;
  accessLevel: AccessLevel;
}

function parseJwt(token: string): Record<string, any> | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(atob(padded.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

function accessLevelFromRoles(roles: string[]): AccessLevel {
  if (roles.includes('superadmin')) return 'SUPERADMIN';
  if (roles.includes('admin')) return 'ADMIN';
  if (roles.includes('pro')) return 'PRO';
  return 'PUBLIC';
}

export function readAdminSession(): AdminSession | null {
  const token = sessionStorage.getItem(ADMIN_TOKEN_KEY);
  if (!token) return null;

  const parsed = parseJwt(token);
  if (!parsed) return null;

  if (parsed.exp && parsed.exp * 1000 < Date.now()) {
    sessionStorage.removeItem(ADMIN_TOKEN_KEY);
    return null;
  }

  const roles: string[] = parsed.realm_access?.roles || [];
  const accessLevel = accessLevelFromRoles(roles);
  if (accessLevel !== 'ADMIN' && accessLevel !== 'SUPERADMIN') {
    return null;
  }

  return {
    token,
    userId: parsed.sub || null,
    email: parsed.email || parsed.preferred_username || null,
    accessLevel,
  };
}

export function saveAdminSession(token: string): AdminSession | null {
  sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
  return readAdminSession();
}

export function clearAdminSession(): void {
  sessionStorage.removeItem(ADMIN_TOKEN_KEY);
}

export async function loginAdmin(username: string, password: string): Promise<AdminSession> {
  const res = await fetch('/api/admin/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = Array.isArray(data.message) ? data.message[0] : data.message
    throw new Error(msg || 'Échec de connexion')
  }

  const session = saveAdminSession(data.access_token);
  if (!session) {
    throw new Error('Session administrateur invalide');
  }
  return session;
}
