import axios, { type InternalAxiosRequestConfig } from 'axios'
import { useAuthStore } from '@/stores/useAuthStore'

/**
 * Axios instance for app API calls. Adds Authorization: Bearer <token> when auth store has a token.
 */
export const api = axios.create({
  baseURL: typeof window !== 'undefined' ? '' : undefined,
})

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = useAuthStore.getState().token
  if (token) {
    config.headers.set('Authorization', `Bearer ${token}`)
  }
  return config
})
