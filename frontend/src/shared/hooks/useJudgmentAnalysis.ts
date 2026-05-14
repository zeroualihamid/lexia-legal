import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import apiClient from '../api/client'
import { useAuthStore } from '../store/authStore'

export type AnalysisStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface JudgmentAnalysis {
  id: string
  filename: string
  pdf_bucket: string
  pdf_key: string
  status: AnalysisStatus
  markdown_result: string | null
  error_message: string | null
  model: string | null
  prompt_version: string
  created_by: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

export function useJudgmentAnalysisList() {
  return useQuery<JudgmentAnalysis[]>({
    queryKey: ['judgment-analyses'],
    queryFn: async () => {
      const res = await apiClient.get('/admin/judgment-analysis')
      return res.data
    },
    refetchInterval: (q) => {
      const data = q.state.data as JudgmentAnalysis[] | undefined
      if (!data) return false
      const hasActive = data.some(
        (a) => a.status === 'pending' || a.status === 'running',
      )
      return hasActive ? 4000 : false
    },
  })
}

export function useJudgmentAnalysisOne(id: string | null) {
  return useQuery<JudgmentAnalysis>({
    queryKey: ['judgment-analysis', id],
    enabled: !!id,
    queryFn: async () => {
      const res = await apiClient.get(`/admin/judgment-analysis/${id}`)
      return res.data
    },
  })
}

export function useCreateJudgmentAnalysis() {
  const qc = useQueryClient()
  return useMutation<{ analysisId: string; jobId: string | number }, Error, File>({
    mutationFn: async (file) => {
      const fd = new FormData()
      fd.append('file', file)
      const res = await apiClient.post('/admin/judgment-analysis', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      return res.data
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['judgment-analyses'] }),
  })
}

export function useRerunJudgmentAnalysis() {
  const qc = useQueryClient()
  return useMutation<{ analysisId: string; jobId: string | number }, Error, string>({
    mutationFn: async (id) => {
      const res = await apiClient.post(`/admin/judgment-analysis/${id}/rerun`)
      return res.data
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['judgment-analyses'] }),
  })
}

export interface AnalysisStreamState {
  markdown: string
  status: AnalysisStatus | 'idle'
  error: string | null
}

/**
 * Subscribe to the SSE stream for a single analysis. Replay events
 * pre-populate `markdown` from the DB (handles tab refresh mid-run).
 */
export function useJudgmentAnalysisStream(id: string | null): AnalysisStreamState {
  const token = useAuthStore((s) => s.token)
  const [state, setState] = useState<AnalysisStreamState>({
    markdown: '',
    status: 'idle',
    error: null,
  })
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    if (esRef.current) {
      esRef.current.close()
      esRef.current = null
    }
    if (!id) {
      setState({ markdown: '', status: 'idle', error: null })
      return
    }

    setState({ markdown: '', status: 'pending', error: null })

    const params = new URLSearchParams(token ? { token } : {})
    const url = `/api/admin/judgment-analysis/${id}/stream${
      params.toString() ? `?${params.toString()}` : ''
    }`

    const es = new EventSource(url)
    esRef.current = es

    es.addEventListener('replay', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data)
        setState((s) => ({ ...s, markdown: data.content || '' }))
      } catch {
        /* ignore */
      }
    })

    es.addEventListener('status', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data)
        setState((s) => ({ ...s, status: data.status }))
      } catch {
        /* ignore */
      }
    })

    es.addEventListener('chunk', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data)
        setState((s) => ({ ...s, markdown: s.markdown + (data.content || '') }))
      } catch {
        /* ignore */
      }
    })

    es.addEventListener('done', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data)
        setState((s) => ({
          ...s,
          markdown: data.markdown || s.markdown,
          status: 'completed',
        }))
      } catch {
        setState((s) => ({ ...s, status: 'completed' }))
      }
      es.close()
      esRef.current = null
    })

    es.addEventListener('error', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data)
        setState((s) => ({ ...s, status: 'failed', error: data.message || 'erreur' }))
      } catch {
        // Native EventSource error events have no .data; only treat as
        // failure if we haven't already received a terminal event.
        setState((s) => (s.status === 'completed' ? s : { ...s, status: 'failed', error: 'connexion perdue' }))
      }
      es.close()
      esRef.current = null
    })

    return () => {
      es.close()
      esRef.current = null
    }
  }, [id, token])

  return state
}
