import React, { useState, useCallback, useRef, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Button,
  Upload,
  Select,
  Table,
  Tag,
  Input,
  Spin,
  Empty,
  Drawer,
  Popconfirm,
  Tooltip,
  Progress,
  App as AntApp,
} from 'antd'
import type { UploadProps } from 'antd'
import {
  ArrowRightOutlined,
  InboxOutlined,
  EyeOutlined,
  DeleteOutlined,
  SearchOutlined,
  MessageOutlined,
  SendOutlined,
  LoadingOutlined,
  FileTextOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import apiClient from '../../../shared/api/client'
import { useAuthStore } from '../../../shared/store/authStore'
import {
  useCase,
  useCaseDocuments,
  useDeleteCaseDocument,
  useUploadQuota,
  searchCase,
  CaseDocument,
  CaseSearchHit,
} from '../../../shared/hooks/useCases'
import { useCaseChat } from '../../../shared/hooks/useCaseChat'
import { DocumentViewer } from '../../admin/documents/DocumentViewer'
import { MahakimPanel } from './CasesPage'
import {
  GOLD,
  BORDER_COLOR,
  BORDER_SUBTLE,
  DARK_CARD,
  TEXT_PRIMARY,
  TEXT_SECONDARY,
  TEXT_TERTIARY,
  DOCUMENT_TYPE_LABELS,
  DOCUMENT_TYPE_COLORS,
  DOCUMENT_STATUS_LABELS,
  CASE_STATUS_LABELS,
} from '../../../shared/constants'
import { useQueryClient } from '@tanstack/react-query'

const FONT = "'Noto Naskh Arabic', 'Cairo', sans-serif"

const DOC_TYPE_OPTIONS = Object.entries(DOCUMENT_TYPE_LABELS).map(([value, label]) => ({
  value,
  label,
}))

export function CaseWorkspace() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { message } = AntApp.useApp()
  const qc = useQueryClient()
  const token = useAuthStore((s) => s.token)

  const caseQ = useCase(id)
  const docsQ = useCaseDocuments(id)
  const quotaQ = useUploadQuota()
  const deleteDoc = useDeleteCaseDocument(id)

  const [docType, setDocType] = useState('other')
  const [uploading, setUploading] = useState(false)
  const [viewerId, setViewerId] = useState<string | null>(null)
  const [viewerName, setViewerName] = useState<string | undefined>()

  // Per-case semantic search
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<CaseSearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)

  // Case chat
  const [chatOpen, setChatOpen] = useState(false)

  const customUpload: UploadProps['customRequest'] = useCallback(
    async (options) => {
      const { file, onSuccess, onError } = options
      const form = new FormData()
      form.append('file', file as Blob)
      form.append('caseId', id)
      form.append('documentType', docType)
      setUploading(true)
      try {
        const res = await apiClient.post('/documents/upload', form, {
          headers: { 'Content-Type': 'multipart/form-data' },
        })
        onSuccess?.(res.data)
        message.success('تم رفع المستند، جارٍ المعالجة')
        qc.invalidateQueries({ queryKey: ['case-documents', id] })
        qc.invalidateQueries({ queryKey: ['upload-quota'] })
        qc.invalidateQueries({ queryKey: ['cases'] })
      } catch (err: any) {
        onError?.(err)
        message.error(err?.response?.data?.message || 'تعذّر رفع المستند')
      } finally {
        setUploading(false)
      }
    },
    [id, docType, message, qc],
  )

  const handleSearch = async () => {
    const q = searchQuery.trim()
    if (!q) return
    setSearching(true)
    try {
      const results = await searchCase(id, q)
      setSearchResults(results)
    } catch {
      message.error('تعذّر إجراء البحث')
    } finally {
      setSearching(false)
    }
  }

  const handleDeleteDoc = async (docId: string) => {
    try {
      await deleteDoc.mutateAsync(docId)
      message.success('تم حذف المستند')
    } catch {
      message.error('تعذّر حذف المستند')
    }
  }

  const statusTag = (status: string) => {
    const cfg = DOCUMENT_STATUS_LABELS[status] || { label: status, color: '#8c8c8c' }
    return (
      <Tag style={{ background: `${cfg.color}20`, border: `1px solid ${cfg.color}40`, color: cfg.color, borderRadius: 12, fontFamily: FONT }}>
        {cfg.label}
      </Tag>
    )
  }

  const columns = [
    {
      title: <span style={{ fontFamily: FONT }}>المستند</span>,
      dataIndex: 'title_ar',
      key: 'title',
      render: (t: string) => (
        <span style={{ fontFamily: FONT, color: TEXT_PRIMARY, display: 'flex', alignItems: 'center', gap: 6 }}>
          <FileTextOutlined style={{ color: GOLD }} />
          {t}
        </span>
      ),
    },
    {
      title: <span style={{ fontFamily: FONT }}>النوع</span>,
      dataIndex: 'document_type',
      key: 'type',
      width: 160,
      render: (dt: string) => {
        if (!dt) return <span style={{ color: TEXT_TERTIARY }}>—</span>
        const color = DOCUMENT_TYPE_COLORS[dt] || '#8c8c8c'
        return (
          <Tag style={{ background: `${color}20`, border: `1px solid ${color}40`, color, borderRadius: 12, fontFamily: FONT }}>
            {DOCUMENT_TYPE_LABELS[dt] || dt}
          </Tag>
        )
      },
    },
    {
      title: <span style={{ fontFamily: FONT }}>الحالة</span>,
      dataIndex: 'status',
      key: 'status',
      width: 130,
      render: (s: string, row: CaseDocument) =>
        row.error_message ? (
          <Tooltip title={row.error_message}>{statusTag(s)}</Tooltip>
        ) : (
          statusTag(s)
        ),
    },
    {
      title: <span style={{ fontFamily: FONT }}>التاريخ</span>,
      dataIndex: 'created_at',
      key: 'created',
      width: 120,
      render: (d: string) => (
        <span style={{ fontFamily: FONT, color: TEXT_TERTIARY, fontSize: 12 }}>
          {dayjs(d).format('DD/MM/YYYY')}
        </span>
      ),
    },
    {
      title: <span style={{ fontFamily: FONT }}>إجراءات</span>,
      key: 'actions',
      width: 110,
      render: (_: any, row: CaseDocument) => (
        <div style={{ display: 'flex', gap: 4 }}>
          <Tooltip title="عرض">
            <Button
              type="text"
              size="small"
              icon={<EyeOutlined />}
              style={{ color: GOLD }}
              onClick={() => {
                setViewerId(row.id)
                setViewerName(row.title_ar)
              }}
            />
          </Tooltip>
          <Popconfirm
            title={<span style={{ fontFamily: FONT }}>حذف المستند؟</span>}
            okText="حذف"
            cancelText="إلغاء"
            okButtonProps={{ danger: true }}
            onConfirm={() => handleDeleteDoc(row.id)}
          >
            <Button type="text" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </div>
      ),
    },
  ]

  if (caseQ.isLoading) {
    return (
      <div style={{ textAlign: 'center', padding: 60 }}>
        <Spin size="large" />
      </div>
    )
  }

  const c = caseQ.data
  const status = c ? CASE_STATUS_LABELS[c.status] || CASE_STATUS_LABELS.open : null
  const quota = quotaQ.data

  return (
    <div style={{ padding: '20px', direction: 'rtl', maxWidth: 1100, margin: '0 auto', width: '100%' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
        <Button icon={<ArrowRightOutlined />} onClick={() => navigate('/cases')} style={{ fontFamily: FONT }}>
          القضايا
        </Button>
        <h1 style={{ margin: 0, color: GOLD, fontFamily: FONT, fontSize: 22, flex: 1, minWidth: 0 }}>
          {c?.title}
        </h1>
        {status && (
          <Tag style={{ background: `${status.color}20`, border: `1px solid ${status.color}40`, color: status.color, borderRadius: 12, fontFamily: FONT }}>
            {status.label}
          </Tag>
        )}
        <Button
          type="primary"
          icon={<MessageOutlined />}
          onClick={() => setChatOpen(true)}
          style={{ background: GOLD, borderColor: GOLD, color: '#000', fontWeight: 600, fontFamily: FONT }}
        >
          محادثة مع هذه القضية
        </Button>
      </div>
      {(c?.client_name || c?.case_ref) && (
        <div style={{ color: TEXT_SECONDARY, fontFamily: FONT, fontSize: 13, marginBottom: 16 }}>
          {c?.client_name && <span>الموكّل: {c.client_name}</span>}
          {c?.client_name && c?.case_ref && <span> · </span>}
          {c?.case_ref && <span>المرجع: {c.case_ref}</span>}
        </div>
      )}

      {c && <div style={{ marginBottom: 20 }}><MahakimPanel c={c} /></div>}

      {/* Upload */}
      <div
        style={{
          background: DARK_CARD,
          border: `1px solid ${BORDER_COLOR}`,
          borderRadius: 12,
          padding: 16,
          marginBottom: 20,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: FONT, color: TEXT_SECONDARY, fontSize: 13 }}>نوع المستند:</span>
          <Select
            value={docType}
            onChange={setDocType}
            options={DOC_TYPE_OPTIONS}
            style={{ minWidth: 200, fontFamily: FONT }}
          />
          {quota && (
            <span style={{ fontFamily: FONT, color: TEXT_TERTIARY, fontSize: 12, marginInlineStart: 'auto' }}>
              الرفع الشهري: {quota.used}/{quota.limit}
            </span>
          )}
        </div>
        <Upload.Dragger
          name="file"
          accept="application/pdf"
          multiple
          showUploadList={false}
          customRequest={customUpload}
          disabled={uploading}
          style={{ background: 'transparent', borderColor: BORDER_SUBTLE }}
        >
          <p style={{ margin: 0 }}>
            <InboxOutlined style={{ color: GOLD, fontSize: 36 }} />
          </p>
          <p style={{ fontFamily: FONT, color: TEXT_PRIMARY, margin: '8px 0 4px' }}>
            اسحب ملفات PDF هنا أو انقر للرفع
          </p>
          <p style={{ fontFamily: FONT, color: TEXT_TERTIARY, fontSize: 12, margin: 0 }}>
            يتم استخراج النص وفهرسته تلقائياً للبحث والمحادثة
          </p>
          {uploading && <Progress percent={100} status="active" showInfo={false} style={{ marginTop: 12 }} />}
        </Upload.Dragger>
      </div>

      {/* Semantic search */}
      <div style={{ marginBottom: 20 }}>
        <Input.Search
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onSearch={handleSearch}
          enterButton={<SearchOutlined />}
          loading={searching}
          placeholder="بحث دلالي داخل مستندات هذه القضية..."
          style={{ fontFamily: FONT }}
        />
        {searchResults && (
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {searchResults.length === 0 ? (
              <Empty description={<span style={{ fontFamily: FONT }}>لا نتائج</span>} />
            ) : (
              searchResults.map((hit, i) => (
                <div
                  key={`${hit.documentId}-${hit.chunkIndex}-${i}`}
                  style={{
                    background: DARK_CARD,
                    border: `1px solid ${BORDER_SUBTLE}`,
                    borderRadius: 8,
                    padding: '10px 12px',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ fontFamily: FONT, color: GOLD, fontSize: 13, fontWeight: 600 }}>
                      {hit.titleAr || 'مستند'}
                    </span>
                    <span style={{ fontFamily: FONT, color: TEXT_TERTIARY, fontSize: 11 }}>
                      {(hit.score * 100).toFixed(0)}%
                    </span>
                  </div>
                  <div style={{ fontFamily: FONT, color: TEXT_SECONDARY, fontSize: 13, lineHeight: 1.6 }}>
                    {hit.content.slice(0, 320)}
                    {hit.content.length > 320 ? '…' : ''}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Documents table */}
      <Table
        rowKey="id"
        loading={docsQ.isLoading}
        dataSource={docsQ.data || []}
        columns={columns as any}
        pagination={false}
        locale={{
          emptyText: (
            <Empty description={<span style={{ fontFamily: FONT, color: TEXT_SECONDARY }}>لا توجد مستندات بعد</span>} />
          ),
        }}
        style={{ background: DARK_CARD, borderRadius: 12 }}
      />

      {/* Viewer */}
      <DocumentViewer
        documentId={viewerId}
        filename={viewerName}
        basePath="/documents"
        onClose={() => setViewerId(null)}
      />

      {/* Case chat drawer */}
      <CaseChatDrawer
        caseId={id}
        caseTitle={c?.title}
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        token={token}
      />
    </div>
  )
}

// ─── Case chat drawer ─────────────────────────────────────────

function CaseChatDrawer({
  caseId,
  caseTitle,
  open,
  onClose,
  token,
}: {
  caseId: string
  caseTitle?: string
  open: boolean
  onClose: () => void
  token: string | null
}) {
  const qc = useQueryClient()
  const { message } = AntApp.useApp()
  const { messages, isStreaming, currentMessage, sendMessage } = useCaseChat(
    open ? caseId : null,
    {
      onReference: (ev) => {
        qc.invalidateQueries({ queryKey: ['case', caseId] })
        qc.invalidateQueries({ queryKey: ['cases'] })
        if (ev.mahakimSupported) {
          message.success('تم حفظ مرجع الملف، جارٍ الجلب من محاكم')
        } else if (ev.mahakimStatus === 'unsupported') {
          message.info('تم حفظ مرجع الملف (محكمة النقض غير متاحة للتتبّع الآلي)')
        } else {
          message.success('تم حفظ مرجع الملف')
        }
      },
    },
  )
  const [input, setInput] = useState('')
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, currentMessage])

  const handleSend = () => {
    const q = input.trim()
    if (!q || isStreaming) return
    setInput('')
    sendMessage(q, token)
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="min(560px, 95vw)"
      title={
        <span style={{ fontFamily: FONT, color: GOLD }}>
          <MessageOutlined /> محادثة: {caseTitle}
        </span>
      }
      styles={{
        body: { padding: 0, display: 'flex', flexDirection: 'column', background: 'var(--color-bg-base)' },
        header: { background: 'var(--color-bg-card)', borderBottom: `1px solid ${BORDER_SUBTLE}` },
      }}
    >
      <div style={{ flex: 1, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12, direction: 'rtl' }}>
        {messages.length === 0 && !isStreaming ? (
          <Empty
            description={
              <span style={{ fontFamily: FONT, color: TEXT_SECONDARY }}>
                اطرح سؤالاً حول هذه القضية. ستُبنى الإجابة على مستنداتك والقانون المغربي.
              </span>
            }
            style={{ marginTop: 40 }}
          />
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              style={{
                alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '85%',
              }}
            >
              <div
                className={m.role === 'user' ? 'message-user' : 'message-assistant'}
                style={{ fontFamily: FONT, fontSize: 14, lineHeight: 1.75, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
              >
                {m.content}
              </div>
              {m.role === 'assistant' && m.sources && m.sources.length > 0 && (
                <div style={{ marginTop: 4, fontFamily: FONT, color: TEXT_TERTIARY, fontSize: 11 }}>
                  المصادر: {m.sources.map((s) => s.title).filter(Boolean).slice(0, 4).join(' · ')}
                </div>
              )}
            </div>
          ))
        )}
        {isStreaming && (
          <div style={{ alignSelf: 'flex-start', maxWidth: '85%' }}>
            <div className="message-assistant" style={{ fontFamily: FONT, fontSize: 14, lineHeight: 1.75, whiteSpace: 'pre-wrap' }}>
              {currentMessage || <span style={{ color: TEXT_TERTIARY, fontStyle: 'italic' }}>جاري التفكير...</span>}
              <span className="streaming-cursor" />
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div style={{ padding: 12, borderTop: `1px solid ${BORDER_SUBTLE}`, background: 'var(--color-bg-card)', display: 'flex', gap: 8 }}>
        <Input.TextArea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSend()
            }
          }}
          autoSize={{ minRows: 1, maxRows: 5 }}
          placeholder="اكتب سؤالك..."
          disabled={isStreaming}
          style={{ fontFamily: FONT }}
        />
        <Button
          type="primary"
          icon={isStreaming ? <LoadingOutlined /> : <SendOutlined />}
          onClick={handleSend}
          disabled={!input.trim() || isStreaming}
          style={{ background: GOLD, borderColor: GOLD, color: '#000', height: 'auto' }}
        />
      </div>
    </Drawer>
  )
}
