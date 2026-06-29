import axios from 'axios'
import { resolveAdminApiToken } from '../auth/adminSession'
import { useAuthStore } from '../store/authStore'

const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  headers: {
    'Content-Type': 'application/json',
  },
})

const cleanCurrentUrl = () => `${window.location.origin}${window.location.pathname}${window.location.search}`

apiClient.interceptors.request.use(
  (config) => {
    const token = resolveAdminApiToken(useAuthStore.getState().token)
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  (error) => Promise.reject(error)
)

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      const { token, keycloak } = useAuthStore.getState()
      // Only redirect to Keycloak when we had a session that expired.
      // Background 401s while logged out should not trigger a login loop.
      if (token && keycloak) {
        keycloak.login({ redirectUri: cleanCurrentUrl() })
      }
    }
    return Promise.reject(error)
  }
)

export default apiClient
