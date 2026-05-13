import { useState, useRef, useCallback, useEffect } from 'react'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  collections?: string[]
  tools?: ToolCall[]
  sources?: Source[]
  timestamp: Date
}

export interface ToolCall {
  name: string
  result?: string
  status: 'running' | 'done' | 'error'
}

export interface Source {
  title: string
  url?: string
  collection: string
  snippet?: string
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
    (conversationId: string, question: string, token: string | null) => {
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
      })

      const url = `/api/chat/stream/${conversationId}?${params.toString()}`
      const es = new EventSource(url)
      eventSourceRef.current = es

      es.addEventListener('chunk', (e) => {
        const data = JSON.parse(e.data)
        accumulated += data.text
        setCurrentMessage(accumulated)
      })

      es.addEventListener('collections', (e) => {
        const data = JSON.parse(e.data)
        setCollections(data.collections || [])
      })

      es.addEventListener('tool_call', (e) => {
        const data = JSON.parse(e.data)
        setTools((prev) => {
          const existing = prev.find((t) => t.name === data.name)
          if (existing) {
            return prev.map((t) =>
              t.name === data.name ? { ...t, result: data.result, status: data.status || 'done' } : t
            )
          }
          return [...prev, { name: data.name, result: data.result, status: data.status || 'running' }]
        })
      })

      es.addEventListener('sources', (e) => {
        const data = JSON.parse(e.data)
        setSources(data.sources || [])
      })

      es.addEventListener('done', (e) => {
        const finalText = accumulated

        setMessages((prev) => [
          ...prev,
          {
            id: `assistant-${Date.now()}`,
            role: 'assistant',
            content: finalText,
            collections,
            tools,
            sources,
            timestamp: new Date(),
          },
        ])
        setCurrentMessage('')
        setIsStreaming(false)
        cleanup()
      })

      es.addEventListener('error', (e) => {
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
      })

      es.onerror = () => {
        if (accumulated) {
          setMessages((prev) => [
            ...prev,
            {
              id: `assistant-${Date.now()}`,
              role: 'assistant',
              content: accumulated,
              collections,
              tools,
              sources,
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
    [cleanup, collections, tools, sources]
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

  return {
    messages,
    isStreaming,
    currentMessage,
    sources,
    collections,
    tools,
    sendMessage,
    clearMessages,
  }
}
