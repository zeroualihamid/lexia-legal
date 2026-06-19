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
  App as AntApp,
} from 'antd'
import type { UploadProps } from 'antd'
import {
  ArrowRightOutlined,
  EyeOutlined,
  DeleteOutlined,
  SearchOutlined,
  MessageOutlined,
  SendOutlined,
  LoadingOutlined,
  FileTextOutlined,
  UploadOutlined,
  ReadOutlined,
  EditOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import apiClient from '../../../shared/api/client'
import { useAuthStore } from '../../../shared/store/authStore'
import {
  useCase,
  useCaseDocuments,
  useDeleteCaseDocument,
  useUpdateCaseDocumentType,
  useSummarizeJudgment,
  useUpdateDocumentTitle,
  suggestDocumentTitle,
  useUploadQuota,
  searchCase,
  CaseDocument,
  CaseSearchHit,
} from '../../../shared/hooks/useCases'
import { useDocumentJudgmentSummary } from '../../../shared/hooks/useJudgmentSummary'
import { JudgmentSummaryDrawer } from '../../../shared/components/JudgmentSummaryDrawer'
import {
  RenameDocumentModal,
  RenamableDocument,
} from '../../../shared/components/RenameDocumentModal'
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
  const updateDocType = useUpdateCaseDocumentType(id)
  const summarizeJudgment = useSummarizeJudgment(id)
  const updateTitle = useUpdateDocumentTitle(id)

  const [docType, setDocType] = useState('other')
  const [uploading, setUploading] = useState(false)
  const [viewerId, setViewerId] = useState<string | null>(null)
  const [viewerName, setViewerName] = useState<string | undefined>()
  const [summaryDocId, setSummaryDocId] = useState<string | null>(null)
  const [summaryReload, setSummaryReload] = useState(0)
  const summaryStream = useDocumentJudgmentSummary(summaryDocId, summaryReload)
  const [renameDoc, setRenameDoc] = useState<RenamableDocument | null>(null)
  const [updatingTypeId, setUpdatingTypeId] = useState<string | null>(null)
  const [summarizingId, setSummarizingId] = useState<string | null>(null)

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
        qc.invalidateQueries({ queryKey: ['upload-tasks'] })
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

  const handleTypeChange = async (docId: string, nextType: string) => {
    setUpdatingTypeId(docId)
    try {
      await updateDocType.mutateAsync({ documentId: docId, documentType: nextType })
      message.success('تم تحديث نوع المستند')
    } catch (err: any) {
      message.error(err?.response?.data?.message || 'تعذّر تحديث النوع')
    } finally {
      setUpdatingTypeId(null)
    }
  }

  const handleJudgmentSummary = async (row: CaseDocument) => {
    const hasAnalysis =
      row.summary_ready ||
      row.analysis_status === 'completed' ||
      row.analysis_status === 'pending' ||
      row.analysis_status === 'running'

    if (hasAnalysis) {
      setSummaryDocId(row.id)
      setSummaryReload((n) => n + 1)
      return
    }

    setSummarizingId(row.id)
    try {
      await summarizeJudgment.mutateAsync(row.id)
      setSummaryDocId(row.id)
      setSummaryReload((n) => n + 1)
    } catch (err: any) {
      message.error(err?.response?.data?.message || 'تعذّر بدء تلخيص الحكم')
    } finally {
      setSummarizingId(null)
    }
  }

  const judgmentSummaryLabel = (row: CaseDocument) => {
    if (row.summary_ready || row.analysis_status === 'completed') return 'عرض الملخص'
    if (row.analysis_status === 'pending' || row.analysis_status === 'running') {
      return 'متابعة الملخص'
    }
    if (row.analysis_status === 'failed') return 'إعادة التلخيص'
    return 'تلخيص الحكم'
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
      render: (t: string, row: CaseDocument) => (
        <span style={{ fontFamily: FONT, color: TEXT_PRIMARY, display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <FileTextOutlined style={{ color: GOLD, flexShrink: 0 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t}</span>
          <Tooltip title="إعادة تسمية">
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              style={{ color: TEXT_TERTIARY, flexShrink: 0 }}
              onClick={() => setRenameDoc({ id: row.id, title_ar: row.title_ar, status: row.status })}
            />
          </Tooltip>
        </span>
      ),
    },
    {
      title: <span style={{ fontFamily: FONT }}>النوع</span>,
      dataIndex: 'document_type',
      key: 'type',
      width: 200,
      render: (dt: string | null, row: CaseDocument) => (
        <Select
          size="small"
          value={dt || 'other'}
          options={DOC_TYPE_OPTIONS}
          loading={updatingTypeId === row.id}
          disabled={row.status === 'processing' || updatingTypeId === row.id}
          onChange={(value) => handleTypeChange(row.id, value)}
          style={{ minWidth: 168, fontFamily: FONT }}
          popupMatchSelectWidth={false}
        />
      ),
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
      width: 200,
      render: (_: any, row: CaseDocument) => (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {row.document_type === 'judgment' && row.status === 'ready' && (
            <Tooltip title={judgmentSummaryLabel(row)}>
              <Button
                type="text"
                size="small"
                icon={
                  summarizingId === row.id ? (
                    <LoadingOutlined />
                  ) : (
                    <ReadOutlined />
                  )
                }
                loading={summarizingId === row.id}
                style={{ color: GOLD, fontFamily: FONT, fontSize: 12 }}
                onClick={() => handleJudgmentSummary(row)}
              >
                {judgmentSummaryLabel(row)}
              </Button>
            </Tooltip>
          )}
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
    <div className="case-workspace" style={{ padding: '16px 20px 24px', direction: 'rtl', maxWidth: 1100, margin: '0 auto', width: '100%' }}>
      <style>{`
        .case-workspace-header {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 6px;
          flex-wrap: wrap;
        }
        .case-workspace-meta {
          color: ${TEXT_SECONDARY};
          font-family: ${FONT};
          font-size: 13px;
          margin-bottom: 14px;
        }
        .case-documents-panel {
          background: ${DARK_CARD};
          border: 1px solid ${BORDER_COLOR};
          border-radius: 14px;
          overflow: hidden;
        }
        .case-documents-toolbar {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
          padding: 12px 14px;
          border-bottom: 1px solid ${BORDER_SUBTLE};
          background: var(--color-bg-elevated);
        }
        .case-upload-bar {
          display: flex;
          align-items: center;
          gap: 8px;
          flex: 1;
          min-width: 220px;
        }
        .case-upload-hint {
          font-family: ${FONT};
          font-size: 11.5px;
          color: ${TEXT_TERTIARY};
          white-space: nowrap;
        }
        .case-upload-quota {
          font-family: ${FONT};
          font-size: 11.5px;
          color: ${TEXT_TERTIARY};
          margin-inline-start: auto;
          white-space: nowrap;
        }
        .case-search-row {
          padding: 10px 14px;
          border-bottom: 1px solid ${BORDER_SUBTLE};
        }
        .case-search-row .ant-input-search .ant-input {
          font-family: ${FONT};
        }
        .case-search-results {
          padding: 0 14px 10px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .case-search-hit {
          background: var(--color-bg-base);
          border: 1px solid ${BORDER_SUBTLE};
          border-radius: 8px;
          padding: 8px 10px;
        }
        .case-documents-table {
          padding: 0;
        }
        .case-documents-table .ant-table {
          background: transparent;
        }
        @media (max-width: 640px) {
          .case-upload-hint { display: none; }
          .case-upload-bar { min-width: 100%; }
        }
      `}</style>

      {/* Header */}
      <div className="case-workspace-header">
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
        <div className="case-workspace-meta">
          {c?.client_name && <span>الموكّل: {c.client_name}</span>}
          {c?.client_name && c?.case_ref && <span> · </span>}
          {c?.case_ref && <span>المرجع: {c.case_ref}</span>}
        </div>
      )}

      {c && <div style={{ marginBottom: 14 }}><MahakimPanel c={c} /></div>}

      {/* Documents panel: upload + search + table */}
      <section className="case-documents-panel">
        <div className="case-documents-toolbar">
          <span style={{ fontFamily: FONT, color: TEXT_PRIMARY, fontWeight: 600, fontSize: 14 }}>
            المستندات
          </span>
          <div className="case-upload-bar">
            <Select
              value={docType}
              onChange={setDocType}
              options={DOC_TYPE_OPTIONS}
              size="small"
              style={{ minWidth: 148, fontFamily: FONT }}
            />
            <Upload
              name="file"
              accept="application/pdf"
              multiple
              showUploadList={false}
              customRequest={customUpload}
              disabled={uploading}
            >
              <Button
                type="primary"
                size="small"
                icon={uploading ? <LoadingOutlined /> : <UploadOutlined />}
                loading={uploading}
                style={{
                  background: GOLD,
                  borderColor: GOLD,
                  color: '#000',
                  fontWeight: 600,
                  fontFamily: FONT,
                }}
              >
                رفع PDF
              </Button>
            </Upload>
            <span className="case-upload-hint">استخراج وفهرسة تلقائية</span>
          </div>
          {quota && (
            <span className="case-upload-quota">
              الرفع الشهري: {quota.used}/{quota.limit}
            </span>
          )}
        </div>

        <div className="case-search-row">
          <Input.Search
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onSearch={handleSearch}
            enterButton={<SearchOutlined />}
            loading={searching}
            size="middle"
            placeholder="بحث دلالي داخل مستندات هذه القضية..."
          />
        </div>

        {searchResults && (
          <div className="case-search-results">
            {searchResults.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<span style={{ fontFamily: FONT }}>لا نتائج</span>} />
            ) : (
              searchResults.map((hit, i) => (
                <div key={`${hit.documentId}-${hit.chunkIndex}-${i}`} className="case-search-hit">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ fontFamily: FONT, color: GOLD, fontSize: 13, fontWeight: 600 }}>
                      {hit.titleAr || 'مستند'}
                    </span>
                    <span style={{ fontFamily: FONT, color: TEXT_TERTIARY, fontSize: 11 }}>
                      {(hit.score * 100).toFixed(0)}%
                    </span>
                  </div>
                  <div style={{ fontFamily: FONT, color: TEXT_SECONDARY, fontSize: 13, lineHeight: 1.6 }}>
                    {hit.content.slice(0, 280)}
                    {hit.content.length > 280 ? '…' : ''}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        <Table
          className="case-documents-table"
          rowKey="id"
          loading={docsQ.isLoading}
          dataSource={docsQ.data || []}
          columns={columns as any}
          pagination={false}
          size="small"
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <span style={{ fontFamily: FONT, color: TEXT_SECONDARY }}>
                    لا توجد مستندات — استخدم «رفع PDF» أعلاه
                  </span>
                }
              />
            ),
          }}
        />
      </section>

      {/* Viewer */}
      <DocumentViewer
        documentId={viewerId}
        filename={viewerName}
        basePath="/documents"
        onClose={() => setViewerId(null)}
      />

      <JudgmentSummaryDrawer
        documentId={summaryDocId}
        onClose={() => setSummaryDocId(null)}
        stream={summaryStream}
      />

      <RenameDocumentModal
        document={renameDoc}
        onClose={() => setRenameDoc(null)}
        onSave={async (documentId, titleAr) => {
          await updateTitle.mutateAsync({ documentId, titleAr })
          message.success('تم تحديث اسم المستند')
          setRenameDoc(null)
        }}
        onSuggest={suggestDocumentTitle}
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
