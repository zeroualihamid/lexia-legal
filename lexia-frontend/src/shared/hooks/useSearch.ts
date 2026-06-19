import { useState, useRef, useCallback, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
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
  legalFamily?: string
  legalClass?: string
}

export interface MinioFile {
  id: string
  title_ar: string
  title_fr?: string | null
  collection: string
  document_type?: string | null
  status: string
  visibility: string
  minio_bucket: string
  minio_key: string
  file_name: string
  file_size_bytes?: number | string | null
  content_type?: string | null
  page_count?: number | null
  created_at: string
  url?: string | null
  can_rename?: boolean
  is_judgment?: boolean
  analysis_id?: string | null
  analysis_status?: string | null
  summary_ready?: boolean
  legal_family?: string | null
  legal_class?: string | null
  classification_manual?: boolean
}

export function isJudgmentFile(file: MinioFile): boolean {
  return (
    !!file.is_judgment ||
    file.document_type === 'judgment' ||
    (typeof file.collection === 'string' && file.collection.startsWith('judgments_'))
  )
}

export interface MinioFilesResponse {
  files: MinioFile[]
  total: number
  page: number
  limit: number
}

export function useMinioFiles(
  collection: string,
  page: number,
  limit = 24,
  legalFamily?: string,
  legalClass?: string,
) {
  return useQuery<MinioFilesResponse>({
    queryKey: ['search-files', collection, page, limit, legalFamily, legalClass],
    queryFn: async () =>
      (
        await apiClient.get('/search/files', {
          params: {
            collection: collection || undefined,
            page,
            limit,
            legalFamily: legalFamily || undefined,
            legalClass: legalClass || undefined,
          },
        })
      ).data,
    refetchInterval: (q) => {
      const data = q.state.data?.files
      if (!data) return false
      return data.some(
        (f) =>
          f.analysis_status === 'pending' || f.analysis_status === 'running',
      )
        ? 4000
        : false
    },
  })
}

export function useRenameSearchFile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      documentId,
      titleAr,
    }: {
      documentId: string
      titleAr: string
    }) =>
      (
        await apiClient.patch(`/documents/${documentId}/title`, {
          titleAr,
        })
      ).data as { id: string; title_ar: string },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['search-files'] })
    },
  })
}

export function useUpdateDocumentClassification() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      documentId,
      legalFamily,
      legalClass,
    }: {
      documentId: string
      legalFamily: string
      legalClass: string
    }) =>
      (
        await apiClient.patch(`/documents/${documentId}/legal-classification`, {
          legalFamily,
          legalClass,
        })
      ).data as {
        id: string
        legal_family: string
        legal_class: string
        classification_manual: boolean
      },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['search-files'] })
    },
  })
}

export function useResetDocumentClassification() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (documentId: string) =>
      (
        await apiClient.patch(`/documents/${documentId}/legal-classification`, {
          reset: true,
        })
      ).data as {
        id: string
        legal_family: string
        legal_class: string
        classification_manual: boolean
      },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['search-files'] })
    },
  })
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
              mode: params.mode === 'text' ? 'fulltext' : params.mode || 'hybrid',
              page: params.page || 1,
              limit: params.limit || 20,
              legalFamily: params.legalFamily || undefined,
              legalClass: params.legalClass || undefined,
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
