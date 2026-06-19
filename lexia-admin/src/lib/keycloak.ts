import Keycloak from 'keycloak-js';

export const keycloakConfig = {
  url: import.meta.env.VITE_KEYCLOAK_URL || 'http://localhost:8080',
  realm: import.meta.env.VITE_KEYCLOAK_REALM || 'legal-ai',
  clientId: import.meta.env.VITE_KEYCLOAK_CLIENT_ID || 'legal-ai-frontend',
};

export const keycloak = new Keycloak(keycloakConfig);

let initPromise: Promise<boolean> | null = null;

export const cleanCurrentUrl = () =>
  `${window.location.origin}${window.location.pathname}${window.location.search}`;

export function ensureKeycloakInit(): Promise<boolean> {
  if (!initPromise) {
    initPromise = keycloak.init({
      onLoad: 'check-sso',
      pkceMethod: 'S256',
      checkLoginIframe: false,
    });
  }
  return initPromise;
}

export function accessLevelFromRoles(roles: string[]): AccessLevel {
  if (roles.includes('superadmin')) return 'SUPERADMIN';
  if (roles.includes('admin')) return 'ADMIN';
  if (roles.includes('pro')) return 'PRO';
  return 'PUBLIC';
}

type AccessLevel = 'PUBLIC' | 'PRO' | 'ADMIN' | 'SUPERADMIN';

export function isKeycloakAuthMode(): boolean {
  if (import.meta.env.VITE_BETTER_AUTH === '1') return false;
  return true;
}
