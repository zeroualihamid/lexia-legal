import axios from 'axios'
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
    const token = useAuthStore.getState().token
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
      const keycloak = useAuthStore.getState().keycloak
      if (keycloak) {
        keycloak.login({ redirectUri: cleanCurrentUrl() })
      }
    }
    return Promise.reject(error)
  }
)

export default apiClient
