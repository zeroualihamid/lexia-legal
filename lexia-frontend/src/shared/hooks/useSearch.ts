import { useState, useRef, useCallback, useEffect } from 'react'
import apiClient from '../api/client'

export interface SearchResult {
  id: string
  title_ar: string
  title_fr?: string
  collection: string
  snippet: string
  highlights?: string[]
  jurisdiction?: string
  date?: string
  url?: string
  score?: number
}

export interface SearchParams {
  q: string
  collection?: string
  mode?: 'hybrid' | 'semantic' | 'text'
  page?: number
  limit?: number
}

export function useSearch() {
  const [results, setResults] = useState<SearchResult[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [total, setTotal] = useState(0)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const abortControllerRef = useRef<AbortController | null>(null)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelPending = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => cancelPending()
  }, [cancelPending])

  const search = useCallback(
    (params: SearchParams) => {
      cancelPending()

      if (!params.q.trim()) {
        setResults([])
        setTotal(0)
        return
      }

      debounceTimerRef.current = setTimeout(async () => {
        const controller = new AbortController()
        abortControllerRef.current = controller

        setIsLoading(true)
        try {
          const response = await apiClient.get('/search', {
            params: {
              q: params.q,
              collection: params.collection,
              mode: params.mode || 'hybrid',
              page: params.page || 1,
              limit: params.limit || 20,
            },
            signal: controller.signal,
          })
          setResults(response.data.results || [])
          setTotal(response.data.total || 0)
        } catch (err: any) {
          if (err.name !== 'AbortError' && err.code !== 'ERR_CANCELED') {
            setResults([])
            setTotal(0)
          }
        } finally {
          setIsLoading(false)
        }
      }, 300)
    },
    [cancelPending]
  )

  const suggest = useCallback(async (query: string) => {
    if (!query.trim() || query.length < 2) {
      setSuggestions([])
      return
    }
    try {
      const response = await apiClient.get('/search/suggest', { params: { q: query } })
      setSuggestions(response.data.suggestions || [])
    } catch {
      setSuggestions([])
    }
  }, [])

  const clearResults = useCallback(() => {
    cancelPending()
    setResults([])
    setTotal(0)
    setSuggestions([])
  }, [cancelPending])

  return {
    results,
    isLoading,
    total,
    suggestions,
    search,
    suggest,
    clearResults,
  }
}
