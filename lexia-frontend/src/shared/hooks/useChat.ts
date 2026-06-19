import { useState, useRef, useCallback, useEffect } from 'react'

export interface MatchedCase {
  id: string
  title: string
  caseRef?: string | null
  clientName?: string | null
  status?: string | null
  documentCount?: number
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  collections?: string[]
  tools?: ToolCall[]
  sources?: Source[]
  cases?: MatchedCase[]
  timestamp: Date
}

export interface ToolCall {
  name: string
  result?: string
  status: 'running' | 'done' | 'error'
}

export interface Source {
  id?: string
  title: string
  url?: string
  fileName?: string
  filePath?: string
  docType?: string
  hasSummary?: boolean
  collection: string
  snippet?: string
}

export interface SourceCatalogEntry {
  id: string
  title: string
  url?: string
  fileName?: string
  filePath?: string
  docType?: string
  hasSummary?: boolean
  collection: string
}

export function buildSourceCatalog(
  sources: Source[] | undefined,
): Record<string, SourceCatalogEntry> {
  const map: Record<string, SourceCatalogEntry> = {}
  if (!sources) return map
  for (const s of sources) {
    if (!s.id) continue
    map[s.id] = {
      id: s.id,
      title: s.title,
      url: s.url,
      fileName: s.fileName,
      filePath: s.filePath,
      docType: s.docType,
      hasSummary: s.hasSummary,
      collection: s.collection,
    }
  }
  return map
}

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [currentMessage, setCurrentMessage] = useState('')
  const [sources, setSources] = useState<Source[]>([])
  const [collections, setCollections] = useState<string[]>([])
  const [tools, setTools] = useState<ToolCall[]>([])
  const eventSourceRef = useRef<EventSource | null>(null)

  const cleanup = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => cleanup()
  }, [cleanup])

  const sendMessage = useCallback(
    (conversationId: string, question: string, token: string | null, caseId?: string) => {
      cleanup()

      const userMessage: ChatMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: question,
        timestamp: new Date(),
      }

      setMessages((prev) => [...prev, userMessage])
      setIsStreaming(true)
      setCurrentMessage('')
      setSources([])
      setCollections([])
      setTools([])

      let accumulated = ''

      const params = new URLSearchParams({
        q: question,
        ...(token ? { token } : {}),
        ...(caseId ? { caseId } : {}),
      })

      const url = `/api/chat/stream/${conversationId}?${params.toString()}`
      const es = new EventSource(url)
      eventSourceRef.current = es

      // Local accumulators so the final assistant message captures the latest
      // values without depending on React state timing.
      let collectedCollections: string[] = []
      let collectedSources: Source[] = []
      let collectedTools: ToolCall[] = []
      let collectedCases: MatchedCase[] = []
      let done = false

      // The backend emits unnamed SSE messages whose JSON carries a `type`
      // discriminator: chunk | collections | sources | tool_result | done | error.
      es.onmessage = (e) => {
        if (!e.data) return
        let data: any
        try {
          data = JSON.parse(e.data)
        } catch {
          return
        }

        switch (data.type) {
          case 'chunk': {
            accumulated += data.content || ''
            setCurrentMessage(accumulated)
            break
          }
          case 'collections': {
            collectedCollections = (data.collections || []).map((c: any) =>
              typeof c === 'string' ? c : c.collection,
            )
            setCollections(collectedCollections)
            break
          }
          case 'sources': {
            collectedSources = (data.sources || []).map((s: any) => ({
              id: s.id,
              title: s.titleAr || s.titleFr || s.title || s.articleRef || s.fileName || '',
              url: s.url,
              fileName: s.fileName,
              filePath: s.filePath,
              docType: s.docType,
              hasSummary: s.hasSummary,
              collection: s.collection || 'user_documents',
              snippet: s.snippet,
            }))
            setSources(collectedSources)
            break
          }
          case 'cases': {
            collectedCases = (data.cases || []) as MatchedCase[]
            break
          }
          case 'tool_result': {
            const name = data.tool || data.name
            setTools((prev) => {
              const next = prev.find((t) => t.name === name)
                ? prev.map((t) =>
                    t.name === name ? { ...t, result: JSON.stringify(data.result), status: 'done' as const } : t,
                  )
                : [...prev, { name, result: JSON.stringify(data.result), status: 'done' as const }]
              collectedTools = next
              return next
            })
            break
          }
          case 'done': {
            done = true
            setMessages((prev) => [
              ...prev,
              {
                id: `assistant-${Date.now()}`,
                role: 'assistant',
                content: accumulated,
                collections: collectedCollections,
                tools: collectedTools,
                sources: collectedSources,
                cases: collectedCases,
                timestamp: new Date(),
              },
            ])
            setCurrentMessage('')
            setIsStreaming(false)
            cleanup()
            break
          }
          case 'error': {
            done = true
            setMessages((prev) => [
              ...prev,
              {
                id: `assistant-error-${Date.now()}`,
                role: 'assistant',
                content: 'حدث خطأ أثناء معالجة طلبك. يرجى المحاولة مرة أخرى.',
                timestamp: new Date(),
              },
            ])
            setIsStreaming(false)
            cleanup()
            break
          }
        }
      }

      es.onerror = () => {
        // A normal stream close after `done` also triggers onerror — ignore it.
        if (done) {
          cleanup()
          return
        }
        if (accumulated) {
          setMessages((prev) => [
            ...prev,
            {
              id: `assistant-${Date.now()}`,
              role: 'assistant',
              content: accumulated,
              collections: collectedCollections,
              tools: collectedTools,
              sources: collectedSources,
              cases: collectedCases,
              timestamp: new Date(),
            },
          ])
        } else {
          setMessages((prev) => [
            ...prev,
            {
              id: `assistant-error-${Date.now()}`,
              role: 'assistant',
              content: 'حدث خطأ في الاتصال. يرجى المحاولة مرة أخرى.',
              timestamp: new Date(),
            },
          ])
        }
        setCurrentMessage('')
        setIsStreaming(false)
        cleanup()
      }
    },
    [cleanup]
  )

  const clearMessages = useCallback(() => {
    cleanup()
    setMessages([])
    setCurrentMessage('')
    setSources([])
    setCollections([])
    setTools([])
    setIsStreaming(false)
  }, [cleanup])

  /** Replace the transcript with a previously persisted conversation history. */
  const loadMessages = useCallback(
    (history: ChatMessage[]) => {
      cleanup()
      setMessages(history)
      setCurrentMessage('')
      setSources([])
      setCollections([])
      setTools([])
      setIsStreaming(false)
    },
    [cleanup],
  )

  return {
    messages,
    isStreaming,
    currentMessage,
    sources,
    collections,
    tools,
    sendMessage,
    clearMessages,
    loadMessages,
  }
}
