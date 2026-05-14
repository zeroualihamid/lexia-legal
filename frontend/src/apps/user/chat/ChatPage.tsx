import React, { useRef, useEffect, useState, useCallback } from 'react'
import { useOutletContext } from 'react-router-dom'
import {
  Button,
  Input,
  Collapse,
  Tag,
  Alert,
  Tooltip,
  Spin,
  Empty,
} from 'antd'
import {
  SendOutlined,
  LinkOutlined,
  ToolOutlined,
  LoadingOutlined,
  LockOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons'
import { useChat } from '../../../shared/hooks/useChat'
import { useAuthStore } from '../../../shared/store/authStore'
import { CollectionTag } from '../../../shared/components/CollectionTag'
import { GOLD, DARK, DARK_CARD, BORDER_COLOR, NAVY } from '../../../shared/constants'

const { TextArea } = Input

interface OutletCtx {
  conversationId: string
}

function WelcomeScreen() {
  const prompts = [
    'ما هي شروط تأسيس شركة ذات مسؤولية محدودة في المغرب؟',
    'ما هو أجل الطعن بالاستئناف في المادة التجارية؟',
    'ما هي حقوق العامل عند الفصل التعسفي؟',
    'ما هي إجراءات نزع ملكية العقار للمنفعة العامة؟',
  ]

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 1,
        padding: '40px 24px',
        gap: 24,
        textAlign: 'center',
        direction: 'rtl',
      }}
    >
      <div style={{ fontSize: 56 }}>⚖️</div>
      <div>
        <h1
          style={{
            fontSize: 28,
            fontWeight: 700,
            color: GOLD,
            fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
            margin: '0 0 8px',
          }}
        >
          مرحباً بك في المنصة القانونية
        </h1>
        <p
          style={{
            fontSize: 15,
            color: 'var(--color-text-secondary)',
            fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
            maxWidth: 500,
            lineHeight: 1.7,
          }}
        >
          اطرح سؤالك القانوني المتعلق بالقانون المغربي وسيساعدك الذكاء الاصطناعي في إيجاد الإجابة المناسبة مع المراجع القانونية
        </p>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 12,
          maxWidth: 640,
          width: '100%',
        }}
      >
        {prompts.map((p, i) => (
          <div
            key={i}
            style={{
              background: DARK_CARD,
              border: `1px solid ${BORDER_COLOR}`,
              borderRadius: 12,
              padding: '12px 16px',
              cursor: 'pointer',
              fontSize: 13,
              color: 'var(--color-text-secondary)',
              fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
              textAlign: 'right',
              lineHeight: 1.5,
              transition: 'all 0.2s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = `rgba(201,168,76,0.5)`
              e.currentTarget.style.color = 'var(--color-text-primary)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = BORDER_COLOR
              e.currentTarget.style.color = 'var(--color-text-secondary)'
            }}
          >
            {p}
          </div>
        ))}
      </div>
    </div>
  )
}

function ToolIndicator({ name, result, status }: { name: string; result?: string; status: string }) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        borderRadius: 8,
        background: 'var(--color-surface-soft)',
        border: '1px solid var(--color-border-subtle)',
        fontSize: 12,
        color: 'var(--color-text-secondary)',
        fontFamily: "'Cairo', sans-serif",
        margin: '2px 0',
      }}
    >
      {status === 'running' ? (
        <Spin indicator={<LoadingOutlined style={{ fontSize: 10, color: GOLD }} />} />
      ) : (
        <ToolOutlined style={{ color: GOLD, fontSize: 11 }} />
      )}
      <span>{name}</span>
      {result && (
        <span style={{ color: 'var(--color-text-tertiary)', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          : {result}
        </span>
      )}
    </div>
  )
}

export function ChatPage() {
  const ctx = useOutletContext<OutletCtx>()
  const conversationId = ctx?.conversationId || 'default'
  const { token, accessLevel } = useAuthStore()
  const isPro = accessLevel === 'PRO' || accessLevel === 'ADMIN' || accessLevel === 'SUPERADMIN'

  const { messages, isStreaming, currentMessage, sources, collections, tools, sendMessage } = useChat()
  const [inputValue, setInputValue] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<any>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, currentMessage])

  const handleSend = useCallback(() => {
    const q = inputValue.trim()
    if (!q || isStreaming) return
    setInputValue('')
    sendMessage(conversationId, q, token)
  }, [inputValue, isStreaming, sendMessage, conversationId, token])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const showMessages = messages.length > 0 || isStreaming

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        direction: 'rtl',
      }}
    >
      {/* Rate limit warning for PUBLIC */}
      {!token && (
        <Alert
          message={
            <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>
              10 رسائل مجانية يومياً — سجّل الدخول للحصول على تجربة كاملة
            </span>
          }
          type="warning"
          showIcon
          icon={<InfoCircleOutlined />}
          banner
          style={{
            background: 'rgba(201,168,76,0.1)',
            border: 'none',
            borderBottom: `1px solid rgba(201,168,76,0.2)`,
            fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
          }}
        />
      )}

      {/* Messages */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '24px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        {!showMessages ? (
          <WelcomeScreen />
        ) : (
          <>
            {messages.map((msg) => (
              <div
                key={msg.id}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start',
                  gap: 6,
                }}
              >
                {/* Bubble */}
                <div
                  className={msg.role === 'user' ? 'message-user' : 'message-assistant'}
                  style={{
                    maxWidth: msg.role === 'user' ? '65%' : '80%',
                    fontSize: 14,
                    lineHeight: 1.75,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
                  }}
                >
                  {msg.content}
                </div>

                {/* Collections used */}
                {msg.role === 'assistant' && msg.collections && msg.collections.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', paddingRight: 8 }}>
                    {msg.collections.map((c) => (
                      <CollectionTag key={c} collection={c} size="small" />
                    ))}
                  </div>
                )}

                {/* Tool calls */}
                {msg.role === 'assistant' && msg.tools && msg.tools.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', paddingRight: 8 }}>
                    {msg.tools.map((t, i) => (
                      <ToolIndicator key={i} name={t.name} result={t.result} status={t.status} />
                    ))}
                  </div>
                )}

                {/* Sources (PRO only) */}
                {msg.role === 'assistant' && msg.sources && msg.sources.length > 0 && (
                  isPro ? (
                    <Collapse
                      size="small"
                      ghost
                      style={{ maxWidth: '80%', paddingRight: 8 }}
                      items={[
                        {
                          key: 'sources',
                          label: (
                            <span style={{
                              fontSize: 12,
                              color: 'var(--color-text-secondary)',
                              fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
                            }}>
                              المصادر ({msg.sources.length})
                            </span>
                          ),
                          children: (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                              {msg.sources.map((src, i) => (
                                <div
                                  key={i}
                                  style={{
                                    background: 'var(--color-surface-faint)',
                                    border: '1px solid var(--color-border-subtle)',
                                    borderRadius: 8,
                                    padding: '8px 12px',
                                    direction: 'rtl',
                                  }}
                                >
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                                    <CollectionTag collection={src.collection} size="small" />
                                    {src.url && (
                                      <a href={src.url} target="_blank" rel="noopener noreferrer">
                                        <LinkOutlined style={{ color: GOLD, fontSize: 12 }} />
                                      </a>
                                    )}
                                  </div>
                                  <div style={{
                                    fontSize: 13,
                                    fontWeight: 600,
                                    color: 'var(--color-text-primary)',
                                    fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
                                    marginBottom: 4,
                                  }}>
                                    {src.title}
                                  </div>
                                  {src.snippet && (
                                    <div style={{
                                      fontSize: 12,
                                      color: 'var(--color-text-tertiary)',
                                      fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
                                      lineHeight: 1.6,
                                    }}>
                                      {src.snippet}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          ),
                        },
                      ]}
                    />
                  ) : (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 12px',
                        borderRadius: 8,
                        background: 'rgba(201,168,76,0.08)',
                        border: `1px solid rgba(201,168,76,0.2)`,
                        fontSize: 12,
                        color: 'var(--color-text-secondary)',
                        fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
                        cursor: 'pointer',
                        maxWidth: '80%',
                        marginRight: 8,
                      }}
                    >
                      <LockOutlined style={{ color: GOLD }} />
                      اشترك في الخطة المدفوعة لرؤية المصادر والوثائق المرجعية
                    </div>
                  )
                )}
              </div>
            ))}

            {/* Streaming message */}
            {isStreaming && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
                {/* Active tools */}
                {tools.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', paddingRight: 8 }}>
                    {tools.map((t, i) => (
                      <ToolIndicator key={i} name={t.name} result={t.result} status={t.status} />
                    ))}
                  </div>
                )}

                <div
                  className="message-assistant"
                  style={{
                    maxWidth: '80%',
                    fontSize: 14,
                    lineHeight: 1.75,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
                    minWidth: 60,
                    minHeight: 24,
                  }}
                >
                  {currentMessage || (
                    <span style={{ color: 'var(--color-text-tertiary)', fontStyle: 'italic' }}>
                      جاري التفكير...
                    </span>
                  )}
                  <span className="streaming-cursor" />
                </div>

                {/* Active collections */}
                {collections.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', paddingRight: 8 }}>
                    {collections.map((c) => (
                      <CollectionTag key={c} collection={c} size="small" />
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div
        style={{
          position: 'sticky',
          bottom: 0,
          background: 'rgba(6,13,24,0.9)',
          backdropFilter: 'blur(20px)',
          borderTop: `1px solid ${BORDER_COLOR}`,
          padding: '12px 16px 16px',
          direction: 'rtl',
        }}
      >
        <div
          style={{
            maxWidth: 800,
            margin: '0 auto',
            display: 'flex',
            gap: 10,
            alignItems: 'flex-end',
          }}
        >
          <TextArea
            ref={inputRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="اكتب سؤالك القانوني هنا..."
            autoSize={{ minRows: 1, maxRows: 6 }}
            disabled={isStreaming}
            style={{
              background: DARK_CARD,
              border: `1px solid ${inputValue ? 'rgba(201,168,76,0.4)' : 'var(--color-border-subtle)'}`,
              color: 'var(--color-text-primary)',
              borderRadius: 12,
              padding: '10px 14px',
              fontSize: 14,
              fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
              direction: 'rtl',
              resize: 'none',
              transition: 'border-color 0.2s',
            }}
          />
          <Button
            type="primary"
            icon={isStreaming ? <LoadingOutlined /> : <SendOutlined />}
            onClick={handleSend}
            disabled={!inputValue.trim() || isStreaming}
            style={{
              background: inputValue.trim() && !isStreaming ? GOLD : 'rgba(201,168,76,0.3)',
              borderColor: 'transparent',
              color: inputValue.trim() && !isStreaming ? '#000' : 'var(--color-text-quaternary)',
              height: 42,
              width: 42,
              borderRadius: 10,
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.2s',
            }}
          />
        </div>
        {!token && (
          <div
            style={{
              textAlign: 'center',
              fontSize: 11,
              color: 'var(--color-text-quaternary)',
              marginTop: 8,
              fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
            }}
          >
            سجّل الدخول للوصول إلى سجل محادثاتك وإمكانيات متقدمة
          </div>
        )}
      </div>
    </div>
  )
}
