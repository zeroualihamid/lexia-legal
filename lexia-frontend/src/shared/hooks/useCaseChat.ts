import { useCallback, useEffect, useRef, useState } from 'react'

export interface CaseChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  sources?: CaseChatSource[]
  timestamp: Date
}

export interface CaseChatSource {
  title: string
  collection: string
  docType?: string | null
}

export interface CaseReferenceEvent {
  caseRef: string | null
  mahakimStatus: string
  mahakimSupported: boolean
  parsed: {
    courtType: string | null
    courtName: string | null
    fileNumber: string | null
    fileCode: string | null
    fileYear: string | null
    courtSection: string | null
    courtPanel: string | null
  }
}

/**
 * SSE chat hook for a single case. Streams from
 * GET /api/cases/:caseId/chat/stream and parses the backend's unnamed,
 * typed messages (chunk | collections | sources | done | error).
 */
export function useCaseChat(
  caseId: string | null,
  opts?: { onReference?: (ev: CaseReferenceEvent) => void },
) {
  const onReferenceRef = useRef(opts?.onReference)
  onReferenceRef.current = opts?.onReference
  const [messages, setMessages] = useState<CaseChatMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [currentMessage, setCurrentMessage] = useState('')
  const esRef = useRef<EventSource | null>(null)

  const cleanup = useCallback(() => {
    if (esRef.current) {
      esRef.current.close()
      esRef.current = null
    }
  }, [])

  useEffect(() => () => cleanup(), [cleanup])

  // Reset the conversation when switching cases.
  useEffect(() => {
    cleanup()
    setMessages([])
    setCurrentMessage('')
    setIsStreaming(false)
  }, [caseId, cleanup])

  const sendMessage = useCallback(
    (question: string, token: string | null) => {
      if (!caseId) return
      cleanup()

      setMessages((prev) => [
        ...prev,
        { id: `user-${Date.now()}`, role: 'user', content: question, timestamp: new Date() },
      ])
      setIsStreaming(true)
      setCurrentMessage('')

      let accumulated = ''
      let collectedSources: CaseChatSource[] = []
      let done = false

      const params = new URLSearchParams({ q: question, ...(token ? { token } : {}) })
      const es = new EventSource(`/api/cases/${caseId}/chat/stream?${params.toString()}`)
      esRef.current = es

      const finalize = (content: string, isError = false) => {
        setMessages((prev) => [
          ...prev,
          {
            id: `assistant-${Date.now()}`,
            role: 'assistant',
            content: isError
              ? 'حدث خطأ أثناء معالجة طلبك. يرجى المحاولة مرة أخرى.'
              : content,
            sources: collectedSources,
            timestamp: new Date(),
          },
        ])
        setCurrentMessage('')
        setIsStreaming(false)
        cleanup()
      }

      es.onmessage = (e) => {
        if (!e.data) return
        let data: any
        try {
          data = JSON.parse(e.data)
        } catch {
          return
        }
        switch (data.type) {
          case 'case_reference':
            onReferenceRef.current?.({
              caseRef: data.caseRef ?? null,
              mahakimStatus: data.mahakimStatus,
              mahakimSupported: !!data.mahakimSupported,
              parsed: data.parsed || {},
            })
            break
          case 'chunk':
            accumulated += data.content || ''
            setCurrentMessage(accumulated)
            break
          case 'sources':
            collectedSources = (data.sources || []).map((s: any) => ({
              title: s.titleAr || s.titleFr || s.title || s.articleRef || '',
              collection: s.collection || 'user_documents',
              docType: s.docType,
            }))
            break
          case 'done':
            done = true
            finalize(accumulated)
            break
          case 'error':
            done = true
            finalize('', true)
            break
        }
      }

      es.onerror = () => {
        if (done) {
          cleanup()
          return
        }
        finalize(accumulated, !accumulated)
      }
    },
    [caseId, cleanup],
  )

  return { messages, isStreaming, currentMessage, sendMessage }
}
