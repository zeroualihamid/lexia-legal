import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import apiClient from '../api/client'
import { useAuthStore } from '../store/authStore'

export type ChatUploadStatus = 'processing' | 'ready' | 'published' | 'failed'

export interface ChatUploadItem {
  id: string
  filename: string
  status: ChatUploadStatus
  isJudgment: boolean
  documentType: string | null
  collection: string | null
  caseId: string | null
  analysisId: string | null
  analysisStatus: string | null
  summaryReady: boolean
  errorMessage: string | null
}

const TERMINAL_DOC: ChatUploadStatus[] = ['ready', 'published', 'failed']

function isSettled(item: ChatUploadItem): boolean {
  const docDone = TERMINAL_DOC.includes(item.status)
  if (!docDone) return false
  if (item.isJudgment) {
    return item.analysisStatus === 'completed' || item.analysisStatus === 'failed'
  }
  return true
}

/**
 * Tracks files uploaded directly in the main chat: upload, poll for the
 * parsing/classification result and (for judgments) the bilingual summary,
 * and link the result to a case.
 */
export function useChatUpload() {
  const queryClient = useQueryClient()
  const [items, setItems] = useState<ChatUploadItem[]>([])
  const [uploading, setUploading] = useState(false)
  const pollRef = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    const current = items
    const pending = current.filter((it) => !isSettled(it))
    if (pending.length === 0) return
    const updates = await Promise.all(
      pending.map(async (it) => {
        try {
          const res = await apiClient.get(`/chat/uploads/${it.id}`)
          return res.data as Partial<ChatUploadItem> & { id: string }
        } catch {
          return null
        }
      }),
    )
    setItems((prev) =>
      prev.map((it) => {
        const u = updates.find((x) => x && x.id === it.id)
        return u ? { ...it, ...u } : it
      }),
    )
  }, [items])

  // Poll while anything is still being processed/summarised.
  useEffect(() => {
    const hasPending = items.some((it) => !isSettled(it))
    if (!hasPending) {
      if (pollRef.current) {
        window.clearInterval(pollRef.current)
        pollRef.current = null
      }
      return
    }
    if (pollRef.current) return
    pollRef.current = window.setInterval(() => {
      refresh()
    }, 3000)
    return () => {
      if (pollRef.current) {
        window.clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [items, refresh])

  const uploadFile = useCallback(async (file: File) => {
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await apiClient.post('/chat/uploads', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      const id: string = res.data.documentId
      setItems((prev) => [
        ...prev,
        {
          id,
          filename: file.name,
          status: 'processing',
          isJudgment: false,
          documentType: null,
          collection: null,
          caseId: null,
          analysisId: null,
          analysisStatus: null,
          summaryReady: false,
          errorMessage: null,
        },
      ])
      queryClient.invalidateQueries({ queryKey: ['upload-tasks'] })
      return id
    } finally {
      setUploading(false)
    }
  }, [queryClient])

  const linkToCase = useCallback(
    async (
      id: string,
      payload: { caseId?: string; newCase?: { title: string; clientName?: string } },
    ) => {
      const res = await apiClient.post(`/chat/uploads/${id}/link`, payload)
      const caseId: string = res.data.caseId
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, caseId } : it)))
      return res.data as { caseId: string; caseTitle: string }
    },
    [],
  )

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id))
  }, [])

  return { items, uploading, uploadFile, linkToCase, dismiss }
}

/** Build a browser-openable URL for the original uploaded PDF (token in query). */
export function chatUploadPdfUrl(id: string): string {
  const token = useAuthStore.getState().token
  const p = new URLSearchParams(token ? { token } : {})
  const qs = p.toString()
  return `/api/chat/uploads/${id}/pdf${qs ? `?${qs}` : ''}`
}

function judgmentsPending(data: ChatUploadItem[] | undefined): boolean {
  if (!data) return false
  return data.some(
    (d) =>
      d.status === 'processing' ||
      (d.isJudgment &&
        d.analysisStatus !== 'completed' &&
        d.analysisStatus !== 'failed'),
  )
}

/** Every judgment the current user has uploaded via the main chat. */
export function useMyJudgments(enabled: boolean) {
  return useQuery<ChatUploadItem[]>({
    queryKey: ['my-judgments'],
    enabled,
    queryFn: async () => (await apiClient.get('/chat/uploads')).data,
    refetchInterval: (q) =>
      judgmentsPending(q.state.data as ChatUploadItem[] | undefined) ? 4000 : false,
  })
}

export interface SummaryStreamState {
  markdown: string
  status: 'idle' | 'pending' | 'running' | 'completed' | 'failed'
  error: string | null
}

/** Live SSE stream of a judgment upload's bilingual summary. */
export function useChatUploadSummaryStream(id: string | null): SummaryStreamState {
  const token = useAuthStore((s) => s.token)
  const [state, setState] = useState<SummaryStreamState>({
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
    const url = `/api/chat/uploads/${id}/summary/stream${
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
        setState((s) =>
          s.status === 'completed'
            ? s
            : { ...s, status: 'failed', error: 'connexion perdue' },
        )
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
