import { create } from 'zustand'

interface AuthState {
  token: string | null
  userId: string | null
  email: string | null
  accessLevel: 'PUBLIC' | 'PRO' | 'ADMIN' | 'SUPERADMIN'
  keycloak: any | null
  setAuth: (auth: Partial<AuthState>) => void
  logout: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  token: null,
  userId: null,
  email: null,
  accessLevel: 'PUBLIC',
  keycloak: null,
  setAuth: (auth) => set((state) => ({ ...state, ...auth })),
  logout: () => set({ token: null, userId: null, email: null, accessLevel: 'PUBLIC', keycloak: null }),
}))
