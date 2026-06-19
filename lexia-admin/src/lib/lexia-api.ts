import { getLexiaToken } from '@/store/authStore';

const API_BASE = (import.meta.env.VITE_API_URL || '/api').replace(/\/+$/, '');

export async function lexiaFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = getLexiaToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (!headers.has('Content-Type') && init.body && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(`${API_BASE}${path.startsWith('/') ? path : `/${path}`}`, {
    ...init,
    headers,
    credentials: 'include',
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Erreur HTTP ${res.status}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
