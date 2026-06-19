import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import apiClient from '../api/client'
import { useAuthStore } from '../store/authStore'

export interface SummaryStreamState {
  markdown: string
  status: 'idle' | 'pending' | 'running' | 'completed' | 'failed'
  error: string | null
}

interface SavedSummary {
  status: string
  markdown: string
  error: string | null
}

type SummaryPaths = {
  fetchPath: (id: string) => string
  streamPath: (id: string) => string
}

async function fetchSavedSummary(
  documentId: string,
  fetchPath: (id: string) => string,
): Promise<SavedSummary | null> {
  try {
    const res = await apiClient.get(fetchPath(documentId))
    return res.data as SavedSummary
  } catch (err: any) {
    if (err?.response?.status === 404) return null
    throw err
  }
}

function attachSummaryEventSource(
  documentId: string,
  streamPath: (id: string) => string,
  token: string | null,
  setState: Dispatch<SetStateAction<SummaryStreamState>>,
): () => void {
  const params = new URLSearchParams(token ? { token } : {})
  const url = `${streamPath(documentId)}${
    params.toString() ? `?${params.toString()}` : ''
  }`
  const es = new EventSource(url)

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
      setState((s) => ({
        ...s,
        markdown: s.markdown + (data.content || ''),
        status: s.status === 'idle' ? 'running' : s.status,
      }))
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
        error: null,
      }))
    } catch {
      setState((s) => ({ ...s, status: 'completed' }))
    }
    es.close()
  })
  es.addEventListener('error', (e) => {
    try {
      const data = JSON.parse((e as MessageEvent).data)
      setState((s) => ({ ...s, status: 'failed', error: data.message || 'erreur' }))
    } catch {
      setState((s) =>
        s.status === 'completed'
          ? s
          : { ...s, status: 'failed', error: 'connexion perdue' },
      )
    }
    es.close()
  })

  return () => es.close()
}

/** Load saved summary from DB first; stream only while pending/running. */
export function useJudgmentSummary(
  documentId: string | null,
  paths: SummaryPaths,
  reloadToken = 0,
): SummaryStreamState {
  const token = useAuthStore((s) => s.token)
  const [state, setState] = useState<SummaryStreamState>({
    markdown: '',
    status: 'idle',
    error: null,
  })
  const closeStreamRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    closeStreamRef.current?.()
    closeStreamRef.current = null

    if (!documentId) {
      setState({ markdown: '', status: 'idle', error: null })
      return
    }

    let cancelled = false
    setState({ markdown: '', status: 'pending', error: null })

    ;(async () => {
      try {
        const saved = await fetchSavedSummary(documentId, paths.fetchPath)
        if (cancelled) return

        if (!saved) {
          setState({ markdown: '', status: 'idle', error: null })
          return
        }

        if (saved.status === 'completed') {
          setState({
            markdown: saved.markdown || '',
            status: 'completed',
            error: null,
          })
          return
        }

        if (saved.status === 'failed') {
          setState({
            markdown: saved.markdown || '',
            status: 'failed',
            error: saved.error || 'failed',
          })
          return
        }

        setState({
          markdown: saved.markdown || '',
          status: saved.status === 'running' ? 'running' : 'pending',
          error: null,
        })

        closeStreamRef.current = attachSummaryEventSource(
          documentId,
          paths.streamPath,
          token,
          (patch) => {
            if (!cancelled) setState(patch)
          },
        )
      } catch (err: any) {
        if (cancelled) return
        setState({
          markdown: '',
          status: 'failed',
          error: err?.response?.data?.message || 'تعذّر تحميل الملخص',
        })
      }
    })()

    return () => {
      cancelled = true
      closeStreamRef.current?.()
      closeStreamRef.current = null
    }
  }, [documentId, token, paths.fetchPath, paths.streamPath, reloadToken])

  return state
}

const SEARCH_SUMMARY_PATHS: SummaryPaths = {
  fetchPath: (id) => `/search/documents/${id}/judgment-summary`,
  streamPath: (id) => `/api/search/documents/${id}/judgment-summary/stream`,
}

const DOCUMENT_SUMMARY_PATHS: SummaryPaths = {
  fetchPath: (id) => `/documents/${id}/judgment-summary`,
  streamPath: (id) => `/api/search/documents/${id}/judgment-summary/stream`,
}

export function useSearchJudgmentSummary(
  documentId: string | null,
  reloadToken = 0,
) {
  return useJudgmentSummary(documentId, SEARCH_SUMMARY_PATHS, reloadToken)
}

export function useDocumentJudgmentSummary(
  documentId: string | null,
  reloadToken = 0,
) {
  return useJudgmentSummary(documentId, DOCUMENT_SUMMARY_PATHS, reloadToken)
}

export function useChatJudgmentSummaryStream(
  documentId: string | null,
  reloadToken = 0,
) {
  return useDocumentJudgmentSummary(documentId, reloadToken)
}

export function useSearchJudgmentSummaryStream(
  documentId: string | null,
  reloadToken = 0,
) {
  return useSearchJudgmentSummary(documentId, reloadToken)
}

export function useSummarizeSearchJudgment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (documentId: string) =>
      (
        await apiClient.post(`/search/documents/${documentId}/summarize-judgment`)
      ).data as {
        analysisId: string
        analysisStatus: string
        jobId: string | number
      },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['search-files'] })
    },
  })
}
