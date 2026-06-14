import React, { useRef, useEffect, useState, useCallback } from 'react'
import { useOutletContext, useNavigate } from 'react-router-dom'
import {
  Button,
  Input,
  Collapse,
  Tag,
  Alert,
  Tooltip,
  Spin,
  Empty,
  Dropdown,
  App as AntApp,
} from 'antd'
import {
  SendOutlined,
  LinkOutlined,
  ToolOutlined,
  LoadingOutlined,
  LockOutlined,
  InfoCircleOutlined,
  FolderOpenOutlined,
  PaperClipOutlined,
  BankOutlined,
  AppstoreOutlined,
  ControlOutlined,
  AudioOutlined,
  GlobalOutlined,
  DownOutlined,
  ArrowUpOutlined,
  PlusOutlined,
  ProfileOutlined,
} from '@ant-design/icons'
import { useChat, ChatMessage } from '../../../shared/hooks/useChat'
import { useChatUpload, ChatUploadItem } from '../../../shared/hooks/useChatUpload'
import { ChatUploadCards, JudgmentsManagerDrawer } from './ChatUploadPanel'
import { useAuthStore } from '../../../shared/store/authStore'
import {
  useCreateConversation,
  fetchConversationMessages,
} from '../../../shared/hooks/useConversations'
import { useCases } from '../../../shared/hooks/useCases'
import { CollectionTag } from '../../../shared/components/CollectionTag'
import { GOLD, DARK, DARK_CARD, BORDER_COLOR, NAVY } from '../../../shared/constants'

const { TextArea } = Input

const EXAMPLE_PROMPTS = [
  'ما هي شروط تأسيس شركة ذات مسؤولية محدودة في المغرب؟',
  'ما هو أجل الطعن بالاستئناف في المادة التجارية؟',
  'ما هي حقوق العامل عند الفصل التعسفي؟',
  'ما هي إجراءات نزع ملكية العقار للمنفعة العامة؟',
]

interface OutletCtx {
  conversationId: string | null
  setConversationId: (id: string | null) => void
  refetchConversations: () => void
}

const ARABIC_FONT = "'Noto Naskh Arabic', 'Cairo', sans-serif"

function ComposerPill({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 14px',
        borderRadius: 999,
        background: 'var(--color-bg-card)',
        border: '1px solid var(--color-border)',
        color: 'var(--color-text-secondary)',
        fontSize: 13,
        fontFamily: ARABIC_FONT,
        cursor: 'pointer',
        transition: 'all 0.18s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--color-gold-border)'
        e.currentTarget.style.color = 'var(--color-text-primary)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--color-border)'
        e.currentTarget.style.color = 'var(--color-text-secondary)'
      }}
    >
      {icon}
      <span>{label}</span>
      <PlusOutlined style={{ fontSize: 11, opacity: 0.6 }} />
    </button>
  )
}

function IconButton({
  icon,
  title,
  onClick,
  active,
}: {
  icon: React.ReactNode
  title: string
  onClick?: () => void
  active?: boolean
}) {
  return (
    <Tooltip title={title}>
      <button
        type="button"
        onClick={onClick}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 32,
          height: 32,
          borderRadius: 8,
          background: active ? 'var(--color-gold-tint)' : 'transparent',
          border: 'none',
          color: active ? GOLD : 'var(--color-text-tertiary)',
          cursor: 'pointer',
          fontSize: 16,
          transition: 'all 0.18s',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--color-surface-soft)'
          e.currentTarget.style.color = 'var(--color-text-primary)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = active ? 'var(--color-gold-tint)' : 'transparent'
          e.currentTarget.style.color = active ? GOLD : 'var(--color-text-tertiary)'
        }}
      >
        {icon}
      </button>
    </Tooltip>
  )
}

/** The LEXIA landing composer shown when a conversation has no messages yet. */
function StartComposer({
  value,
  onChange,
  onSubmit,
  onKeyDown,
  isStreaming,
  inputRef,
  onAttach,
  onOpenJudgments,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
  isStreaming: boolean
  inputRef: React.RefObject<any>
  onAttach: () => void
  onOpenJudgments: () => void
}) {
  const navigate = useNavigate()
  const { token } = useAuthStore()
  const { data: cases } = useCases(!!token)
  const [matter, setMatter] = useState<{ id: string; title: string } | null>(null)
  const [focused, setFocused] = useState(false)

  const matterMenu = {
    items: [
      { key: 'general', label: <span style={{ fontFamily: ARABIC_FONT }}>بحث عام (دون قضية)</span> },
      ...(cases && cases.length > 0
        ? [{ type: 'divider' as const }, ...cases.map((c) => ({
            key: c.id,
            label: <span style={{ fontFamily: ARABIC_FONT }}>{c.title}</span>,
          }))]
        : []),
      ...(token
        ? [
            { type: 'divider' as const },
            {
              key: '__manage',
              label: (
                <span style={{ fontFamily: ARABIC_FONT, color: GOLD }}>
                  <FolderOpenOutlined /> إدارة القضايا
                </span>
              ),
            },
          ]
        : []),
    ],
    onClick: ({ key }: { key: string }) => {
      if (key === 'general') setMatter(null)
      else if (key === '__manage') navigate('/cases')
      else {
        const c = cases?.find((x) => x.id === key)
        if (c) navigate(`/cases/${c.id}`)
      }
    },
  }

  const promptMenu = {
    items: EXAMPLE_PROMPTS.map((p, i) => ({
      key: String(i),
      label: <span style={{ fontFamily: ARABIC_FONT, whiteSpace: 'normal', maxWidth: 360, display: 'inline-block' }}>{p}</span>,
    })),
    onClick: ({ key }: { key: string }) => onChange(EXAMPLE_PROMPTS[Number(key)]),
  }

  const canSend = !!value.trim() && !isStreaming

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px 16px 80px',
        direction: 'rtl',
      }}
    >
      <h1
        style={{
          fontSize: 'clamp(36px, 6vw, 56px)',
          fontWeight: 700,
          letterSpacing: 6,
          color: 'var(--color-text-primary)',
          fontFamily: "'Georgia', 'Times New Roman', serif",
          margin: '0 0 36px',
        }}
      >
        LEXIA
      </h1>

      {/* Composer card */}
      <div
        style={{
          width: '100%',
          maxWidth: 760,
          background: 'var(--color-bg-card)',
          border: `1px solid ${focused ? 'var(--color-gold-border)' : 'var(--color-border)'}`,
          borderRadius: 24,
          padding: '14px 18px 12px',
          boxShadow: focused
            ? '0 8px 28px rgba(0,0,0,0.10)'
            : '0 4px 18px rgba(0,0,0,0.05)',
          transition: 'all 0.2s',
        }}
      >
        {/* Top row: client matter + prompts */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <Dropdown menu={matterMenu} trigger={['click']} placement="bottomRight">
            <button
              type="button"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                background: 'transparent',
                border: 'none',
                color: 'var(--color-text-secondary)',
                fontSize: 13,
                fontFamily: ARABIC_FONT,
                cursor: 'pointer',
                padding: 4,
              }}
            >
              {matter ? matter.title : 'القضية'}
              <DownOutlined style={{ fontSize: 10, opacity: 0.6 }} />
            </button>
          </Dropdown>

          <Dropdown menu={promptMenu} trigger={['click']} placement="bottomLeft">
            <button
              type="button"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                background: 'transparent',
                border: 'none',
                color: 'var(--color-text-secondary)',
                fontSize: 13,
                fontFamily: ARABIC_FONT,
                cursor: 'pointer',
                padding: 4,
              }}
            >
              نماذج الأسئلة
              <DownOutlined style={{ fontSize: 10, opacity: 0.6 }} />
            </button>
          </Dropdown>
        </div>

        {/* Text area */}
        <TextArea
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="اطرح سؤالك القانوني..."
          autoSize={{ minRows: 2, maxRows: 8 }}
          disabled={isStreaming}
          variant="borderless"
          style={{
            background: 'transparent',
            color: 'var(--color-text-primary)',
            fontSize: 15,
            fontFamily: ARABIC_FONT,
            direction: 'rtl',
            resize: 'none',
            padding: '6px 4px 10px',
          }}
        />

        {/* Bottom row: files/sources + actions */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <ComposerActionText
              icon={<PaperClipOutlined />}
              label="إرفاق ملف"
              onClick={onAttach}
            />
            <ComposerActionText
              icon={<BankOutlined />}
              label="المصادر"
              onClick={() => navigate('/search')}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <IconButton icon={<AppstoreOutlined />} title="التكاملات (قريباً)" />
            <IconButton icon={<ControlOutlined />} title="الإعدادات (قريباً)" />
            <span style={{ width: 1, height: 18, background: 'var(--color-border)', margin: '0 4px' }} />
            <IconButton icon={<AudioOutlined />} title="الإدخال الصوتي (قريباً)" />
            <button
              type="button"
              onClick={onSubmit}
              disabled={!canSend}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 34,
                height: 34,
                marginInlineStart: 4,
                borderRadius: 10,
                border: 'none',
                background: canSend ? GOLD : 'var(--color-surface-soft)',
                color: canSend ? '#000' : 'var(--color-text-quaternary)',
                cursor: canSend ? 'pointer' : 'not-allowed',
                transition: 'all 0.18s',
              }}
            >
              {isStreaming ? <LoadingOutlined /> : <ArrowUpOutlined />}
            </button>
          </div>
        </div>
      </div>

      {/* Pills below the composer */}
      <div style={{ display: 'flex', gap: 12, marginTop: 16, flexWrap: 'wrap', justifyContent: 'center' }}>
        <ComposerPill
          icon={<FolderOpenOutlined />}
          label="الخزنة"
          onClick={() => navigate('/cases')}
        />
        <ComposerPill
          icon={<ProfileOutlined />}
          label="أحكامي"
          onClick={onOpenJudgments}
        />
        <ComposerPill
          icon={<GlobalOutlined />}
          label="بحث الويب"
          onClick={() => {}}
        />
      </div>
    </div>
  )
}

function ComposerActionText({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        background: 'transparent',
        border: 'none',
        color: 'var(--color-text-tertiary)',
        fontSize: 13,
        fontFamily: ARABIC_FONT,
        cursor: 'pointer',
        padding: '4px 6px',
        borderRadius: 8,
        transition: 'all 0.18s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--color-surface-soft)'
        e.currentTarget.style.color = 'var(--color-text-primary)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
        e.currentTarget.style.color = 'var(--color-text-tertiary)'
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
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
  const navigate = useNavigate()
  const conversationId = ctx?.conversationId ?? null
  const setConversationId = ctx?.setConversationId
  const refetchConversations = ctx?.refetchConversations
  const { token, accessLevel } = useAuthStore()
  const isPro = accessLevel === 'PRO' || accessLevel === 'ADMIN' || accessLevel === 'SUPERADMIN'

  const { message } = AntApp.useApp()
  const { messages, isStreaming, currentMessage, sources, collections, tools, sendMessage, loadMessages } = useChat()
  const { mutateAsync: createConversation } = useCreateConversation()
  const upload = useChatUpload()
  const [inputValue, setInputValue] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<any>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [showJudgments, setShowJudgments] = useState(false)

  const openJudgments = useCallback(() => {
    if (!token) {
      message.info('سجّل الدخول لعرض أحكامك')
      return
    }
    setShowJudgments(true)
  }, [token, message])

  const askAboutUpload = useCallback((item: ChatUploadItem) => {
    setInputValue(`بخصوص الحكم «${item.filename}»: `)
    setTimeout(() => inputRef.current?.focus?.(), 50)
  }, [])

  const triggerAttach = useCallback(() => {
    if (!token) {
      message.info('سجّل الدخول لرفع وتحليل الملفات')
      return
    }
    fileInputRef.current?.click()
  }, [token, message])

  const handleFilePicked = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = ''
      if (!file) return
      if (file.type !== 'application/pdf') {
        message.error('يُقبل ملف PDF فقط')
        return
      }
      try {
        await upload.uploadFile(file)
        message.success('تم رفع الملف، جارٍ التحليل والتصنيف...')
      } catch (err: any) {
        message.error(err?.response?.data?.message || 'تعذّر رفع الملف')
      }
    },
    [upload, message],
  )
  // Tracks which conversation's transcript is currently shown, so we don't
  // re-fetch (and wipe) the one we just created locally while streaming.
  const loadedConvRef = useRef<string | null>(null)

  // Load (or clear) the transcript whenever the active conversation changes.
  useEffect(() => {
    if (conversationId === loadedConvRef.current) return
    loadedConvRef.current = conversationId

    if (!conversationId) {
      loadMessages([])
      return
    }

    let cancelled = false
    ;(async () => {
      try {
        const history = await fetchConversationMessages(conversationId)
        if (cancelled) return
        loadMessages(
          history.map<ChatMessage>((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            timestamp: new Date(m.created_at),
          })),
        )
      } catch {
        if (!cancelled) loadMessages([])
      }
    })()

    return () => {
      cancelled = true
    }
  }, [conversationId, loadMessages])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, currentMessage])

  // After a stream completes, refresh the sidebar so the (possibly newly titled)
  // conversation moves to the top with its updated timestamp.
  const wasStreamingRef = useRef(false)
  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming && conversationId) {
      refetchConversations?.()
    }
    wasStreamingRef.current = isStreaming
  }, [isStreaming, conversationId, refetchConversations])

  const handleSend = useCallback(async () => {
    const q = inputValue.trim()
    if (!q || isStreaming) return
    setInputValue('')

    let convId = conversationId
    // PRO+ chats are persisted: lazily create a real conversation on the first
    // message so history can be saved and re-opened later.
    if (isPro && !convId) {
      try {
        const created = await createConversation()
        convId = created.id
        loadedConvRef.current = convId
        setConversationId?.(convId)
        refetchConversations?.()
      } catch {
        // Fall back to an in-memory chat if creation fails.
      }
    }

    sendMessage(convId || 'default', q, token)
  }, [
    inputValue,
    isStreaming,
    sendMessage,
    conversationId,
    token,
    isPro,
    createConversation,
    setConversationId,
    refetchConversations,
  ])

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
          <StartComposer
            value={inputValue}
            onChange={setInputValue}
            onSubmit={handleSend}
            onKeyDown={handleKeyDown}
            isStreaming={isStreaming}
            inputRef={inputRef}
            onAttach={triggerAttach}
            onOpenJudgments={openJudgments}
          />
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

                {/* Matched cases — clickable links to open the case workspace */}
                {msg.role === 'assistant' && msg.cases && msg.cases.length > 0 && (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                      maxWidth: '80%',
                      paddingRight: 8,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 12,
                        color: 'var(--color-text-secondary)',
                        fontFamily: ARABIC_FONT,
                      }}
                    >
                      القضايا المطابقة:
                    </span>
                    {msg.cases.map((c) => (
                      <div
                        key={c.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => navigate(`/cases/${c.id}`)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') navigate(`/cases/${c.id}`)
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: '10px 12px',
                          borderRadius: 10,
                          border: `1px solid ${BORDER_COLOR}`,
                          background: 'var(--color-surface-soft)',
                          cursor: 'pointer',
                          transition: 'border-color 0.15s',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.borderColor = GOLD
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.borderColor = BORDER_COLOR
                        }}
                      >
                        <FolderOpenOutlined style={{ color: GOLD, fontSize: 16 }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            style={{
                              fontSize: 13,
                              fontWeight: 600,
                              fontFamily: ARABIC_FONT,
                              color: 'var(--color-text-primary)',
                            }}
                          >
                            {c.title}
                          </div>
                          {(c.caseRef || c.clientName) && (
                            <div
                              style={{
                                fontSize: 11,
                                color: 'var(--color-text-tertiary)',
                                fontFamily: ARABIC_FONT,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {[c.clientName && `الموكل: ${c.clientName}`, c.caseRef]
                                .filter(Boolean)
                                .join(' — ')}
                            </div>
                          )}
                        </div>
                        <span
                          style={{
                            fontSize: 11,
                            color: GOLD,
                            fontFamily: ARABIC_FONT,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          فتح القضية ←
                        </span>
                      </div>
                    ))}
                  </div>
                )}

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

        {upload.items.length > 0 && (
          <div style={{ marginTop: showMessages ? 4 : 16, alignSelf: 'center', width: '100%', maxWidth: 760 }}>
            <ChatUploadCards
              items={upload.items}
              onLink={upload.linkToCase}
              onDismiss={upload.dismiss}
              onAsk={askAboutUpload}
            />
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf"
        style={{ display: 'none' }}
        onChange={handleFilePicked}
      />

      <JudgmentsManagerDrawer
        open={showJudgments}
        onClose={() => setShowJudgments(false)}
        onLink={upload.linkToCase}
        onAsk={askAboutUpload}
      />

      {/* Input area — only once a conversation has started; the empty state
          uses the centered LEXIA composer instead. */}
      {showMessages && (
      <div
        style={{
          position: 'sticky',
          bottom: 0,
          background: 'var(--color-bg-input-bar)',
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
          <Tooltip title="أحكامي المرفوعة">
            <Button
              icon={<ProfileOutlined />}
              onClick={openJudgments}
              style={{
                background: DARK_CARD,
                border: '1px solid var(--color-border-subtle)',
                color: 'var(--color-text-secondary)',
                height: 42,
                width: 42,
                borderRadius: 10,
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            />
          </Tooltip>
          <Tooltip title="إرفاق ملف (PDF) للتحليل">
            <Button
              icon={<PaperClipOutlined />}
              onClick={triggerAttach}
              disabled={isStreaming}
              style={{
                background: DARK_CARD,
                border: '1px solid var(--color-border-subtle)',
                color: 'var(--color-text-secondary)',
                height: 42,
                width: 42,
                borderRadius: 10,
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            />
          </Tooltip>
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
      )}
    </div>
  )
}
