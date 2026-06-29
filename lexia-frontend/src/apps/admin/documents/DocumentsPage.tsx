import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Tabs,
  Table,
  Tag,
  Button,
  Modal,
  Form,
  Input,
  Select,
  Upload,
  Steps,
  Progress,
  Space,
  message,
  Tooltip,
  Popconfirm,
  Badge,
} from 'antd'
import {
  UploadOutlined,
  InboxOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  EyeOutlined,
  DeleteOutlined,
  FileTextOutlined,
  FileSearchOutlined,
  CloudDownloadOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import apiClient from '../../../shared/api/client'
import { CollectionTag } from '../../../shared/components/CollectionTag'
import { JudgmentSummaryDrawer } from '../../../shared/components/JudgmentSummaryDrawer'
import {
  useSearchJudgmentSummary,
  useSummarizeSearchJudgment,
} from '../../../shared/hooks/useJudgmentSummary'
import { GOLD, BORDER_COLOR } from '../../../shared/constants'
import dayjs from 'dayjs'
import { DocumentViewer } from './DocumentViewer'
import { useAdminUi } from '../locale/useAdminI18n'

const { Dragger } = Upload
const { TextArea } = Input

type AdminUi = ReturnType<typeof useAdminUi>

const STATUS_COLORS: Record<string, string> = {
  processing: '#1677ff',
  pending_review: '#fa8c16',
  published: '#52c41a',
  rejected: '#f5222d',
  archived: '#8c8c8c',
}

const MOCK_DOCUMENTS = [
  { id: '1', title_ar: 'القانون التجاري المغربي', collection: 'judgments_commercial', status: 'published', owner_type: 'system', uploaded_by: null, summary_ready: true, analysis_status: 'completed', created_at: '2024-01-15T10:00:00Z' },
  { id: '2', title_ar: 'مدونة الشغل - المستجدات', collection: 'legal_laws', status: 'pending_review', owner_type: 'user', uploaded_by: 'fatima.z', summary_ready: false, analysis_status: null, created_at: '2024-02-10T09:00:00Z' },
  { id: '3', title_ar: 'أحكام محكمة النقض 2023', collection: 'judgments_civil', status: 'processing', owner_type: 'system', uploaded_by: null, summary_ready: false, analysis_status: 'running', created_at: '2024-03-01T14:00:00Z' },
  { id: '4', title_ar: 'قانون العقوبات - الطبعة الجديدة', collection: 'judgments_criminal', status: 'published', owner_type: 'system', uploaded_by: null, summary_ready: false, analysis_status: null, created_at: '2024-01-20T11:00:00Z' },
  { id: '5', title_ar: 'مدونة الأسرة المحدثة', collection: 'judgments_family', status: 'rejected', owner_type: 'user', uploaded_by: 'karim.h', summary_ready: false, analysis_status: 'failed', created_at: '2024-02-05T16:00:00Z' },
]

type AdminDocumentRow = {
  id: string
  title_ar: string
  collection: string
  status: string
  owner_type?: string
  uploaded_by?: string | null
  summary_ready?: boolean
  analysis_status?: string | null
}

function isJudgmentDocument(record: AdminDocumentRow) {
  return record.collection?.startsWith('judgments_')
}

function UploadModal({ open, onClose, ui }: { open: boolean; onClose: () => void; ui: AdminUi }) {
  const { t, font, dir, formStyle, labelStyle, titleStyle, collectionOptions } = ui
  const [form] = Form.useForm()
  const [currentStep, setCurrentStep] = useState(-1)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const qc = useQueryClient()

  const processingSteps = [
    t.documents.steps.upload,
    t.documents.steps.extract,
    t.documents.steps.classify,
    t.documents.steps.chunk,
    t.documents.steps.embed,
    t.documents.steps.index,
  ]

  const visibilityOptions = (['private', 'pro_only', 'public'] as const).map((value) => ({
    value,
    label: t.visibility[value],
  }))

  const handleUpload = async (values: any) => {
    if (!values.file) {
      message.error(t.documents.selectPdf)
      return
    }
    setUploading(true)
    setCurrentStep(0)

    try {
      const formData = new FormData()
      formData.append('file', values.file.file)
      if (values.title_ar) formData.append('title_ar', values.title_ar)
      formData.append('collection', values.collection)
      formData.append('visibility', values.visibility || 'public')

      for (let i = 0; i < processingSteps.length; i++) {
        setCurrentStep(i)
        setProgress(((i + 1) / processingSteps.length) * 100)
        await new Promise((r) => setTimeout(r, 600))
      }

      await apiClient.post('/admin/documents/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })

      message.success(t.documents.uploadSuccess)
      qc.invalidateQueries({ queryKey: ['documents'] })
      form.resetFields()
      setCurrentStep(-1)
      setProgress(0)
      onClose()
    } catch {
      setCurrentStep(-1)
      setProgress(0)
    } finally {
      setUploading(false)
    }
  }

  return (
    <Modal
      title={<span style={titleStyle}>{t.documents.uploadModalTitle}</span>}
      open={open}
      onCancel={onClose}
      footer={null}
      width={580}
      centered
      styles={{ body: { direction: dir, padding: '20px 0 0' } }}
    >
      <Form form={form} layout="vertical" onFinish={handleUpload} style={formStyle}>
        <Form.Item name="file">
          <Dragger
            name="file"
            accept=".pdf"
            beforeUpload={() => false}
            maxCount={1}
            style={{ background: 'var(--color-surface-faint)', borderColor: BORDER_COLOR }}
          >
            <p className="ant-upload-drag-icon">
              <InboxOutlined style={{ color: GOLD }} />
            </p>
            <p className="ant-upload-text" style={{ fontFamily: font, color: 'var(--color-text-secondary)' }}>
              {t.documents.dragHint}
            </p>
            <p className="ant-upload-hint" style={{ fontFamily: font, color: 'var(--color-text-quaternary)' }}>
              {t.documents.maxSize}
            </p>
          </Dragger>
        </Form.Item>

        <Form.Item
          name="title_ar"
          label={<span style={labelStyle}>{t.documents.titleArOptional}</span>}
        >
          <Input placeholder={t.documents.titlePlaceholder} style={{ direction: dir, fontFamily: font }} />
        </Form.Item>

        <Form.Item
          name="collection"
          label={<span style={labelStyle}>{t.common.collection}</span>}
          rules={[{ required: true, message: t.documents.selectCollectionRequired }]}
        >
          <Select
            options={collectionOptions}
            placeholder={t.documents.selectCollection}
            style={{ fontFamily: font }}
          />
        </Form.Item>

        <Form.Item
          name="visibility"
          label={<span style={labelStyle}>{t.documents.visibility}</span>}
          initialValue="public"
        >
          <Select options={visibilityOptions} style={{ fontFamily: font }} />
        </Form.Item>

        {currentStep >= 0 && (
          <div style={{ marginBottom: 20 }}>
            <Steps
              current={currentStep}
              size="small"
              direction="vertical"
              items={processingSteps.map((s, i) => ({
                title: <span style={{ fontFamily: font, fontSize: 13 }}>{s.title}</span>,
                description: (
                  <span style={{ fontFamily: font, fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                    {s.desc}
                  </span>
                ),
                status: i < currentStep ? 'finish' : i === currentStep ? 'process' : 'wait',
              }))}
            />
            <Progress percent={Math.round(progress)} strokeColor={GOLD} trailColor="var(--color-border-subtle)" />
          </div>
        )}

        <Form.Item style={{ marginBottom: 0, display: 'flex', justifyContent: 'flex-start', gap: 12 }}>
          <Space>
            <Button onClick={onClose} style={{ fontFamily: font }}>
              {t.common.cancel}
            </Button>
            <Button
              type="primary"
              htmlType="submit"
              loading={uploading}
              style={{ background: GOLD, borderColor: GOLD, color: '#000', fontFamily: font }}
            >
              {t.documents.upload}
            </Button>
          </Space>
        </Form.Item>
      </Form>
    </Modal>
  )
}

function RejectModal({
  open,
  docId,
  onClose,
  ui,
}: {
  open: boolean
  docId: string | null
  onClose: () => void
  ui: AdminUi
}) {
  const { t, font, dir, titleStyle } = ui
  const [reason, setReason] = useState('')
  const qc = useQueryClient()

  const { mutate: reject, isPending } = useMutation({
    mutationFn: async () => {
      await apiClient.post(`/admin/documents/${docId}/reject`, { reason })
    },
    onSuccess: () => {
      message.success(t.documents.rejectSuccess)
      qc.invalidateQueries({ queryKey: ['documents'] })
      onClose()
      setReason('')
    },
    onError: () => message.error(t.common.error),
  })

  return (
    <Modal
      title={<span style={titleStyle}>{t.documents.rejectTitle}</span>}
      open={open}
      onCancel={onClose}
      onOk={() => reject()}
      okText={<span style={{ fontFamily: font }}>{t.documents.confirmReject}</span>}
      cancelText={<span style={{ fontFamily: font }}>{t.common.cancel}</span>}
      okButtonProps={{ danger: true, loading: isPending }}
      centered
    >
      <TextArea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={t.documents.rejectPlaceholder}
        rows={4}
        style={{ direction: dir, fontFamily: font }}
      />
    </Modal>
  )
}

export function DocumentsPage() {
  const ui = useAdminUi()
  const { t, font, dir, pageStyle, tableStyle, h1Style, cellStyle, mutedStyle, collectionLabel, numberLocale } = ui
  const navigate = useNavigate()
  const [uploadOpen, setUploadOpen] = useState(false)
  const [rejectDocId, setRejectDocId] = useState<string | null>(null)
  const [viewerDoc, setViewerDoc] = useState<{ id: string; filename: string } | null>(null)
  const [summaryDocId, setSummaryDocId] = useState<string | null>(null)
  const [summaryReload, setSummaryReload] = useState(0)
  const [summarizingId, setSummarizingId] = useState<string | null>(null)
  const [allPage, setAllPage] = useState(1)
  const [pendingPage, setPendingPage] = useState(1)
  const pageSize = 50
  const qc = useQueryClient()
  const summaryStream = useSearchJudgmentSummary(summaryDocId, summaryReload)
  const summarizeJudgment = useSummarizeSearchJudgment()

  const statusLabel = (status: string) =>
    t.documents.status[status as keyof typeof t.documents.status] || status

  const summaryActionLabel = (record: AdminDocumentRow) => {
    if (record.summary_ready || record.analysis_status === 'completed') return t.documents.viewSummary
    if (record.analysis_status === 'pending' || record.analysis_status === 'running') {
      return t.documents.followSummary
    }
    if (record.analysis_status === 'failed') return t.documents.regenerateSummary
    return t.documents.generateSummary
  }

  const handleJudgmentSummary = async (record: AdminDocumentRow) => {
    const hasAnalysis =
      record.summary_ready ||
      record.analysis_status === 'completed' ||
      record.analysis_status === 'pending' ||
      record.analysis_status === 'running'

    if (hasAnalysis) {
      setSummaryDocId(record.id)
      setSummaryReload((n) => n + 1)
      return
    }

    setSummarizingId(record.id)
    try {
      await summarizeJudgment.mutateAsync(record.id)
      setSummaryDocId(record.id)
      setSummaryReload((n) => n + 1)
      qc.invalidateQueries({ queryKey: ['documents'] })
    } catch (err: any) {
      message.error(err?.response?.data?.message || t.documents.summarizeError)
    } finally {
      setSummarizingId(null)
    }
  }

  const renderDocActions = (record: AdminDocumentRow, extra?: React.ReactNode) => (
    <Space>
      <Tooltip title={t.common.view}>
        <Button
          type="text"
          size="small"
          icon={<EyeOutlined />}
          style={{ color: GOLD }}
          onClick={() =>
            setViewerDoc({ id: record.id, filename: record.title_ar || record.id })
          }
        />
      </Tooltip>
      {isJudgmentDocument(record) && (
        <Tooltip title={summaryActionLabel(record)}>
          <Button
            type="text"
            size="small"
            icon={<FileSearchOutlined />}
            style={{ color: '#1677ff' }}
            loading={summarizingId === record.id}
            onClick={() => handleJudgmentSummary(record)}
          />
        </Tooltip>
      )}
      {extra}
      <Popconfirm
        title={<span style={{ fontFamily: font }}>{t.documents.deleteConfirm}</span>}
        okText={<span style={{ fontFamily: font }}>{t.common.delete}</span>}
        cancelText={<span style={{ fontFamily: font }}>{t.common.cancel}</span>}
        okButtonProps={{ danger: true }}
        onConfirm={() => message.info(t.documents.deleted)}
      >
        <Button type="text" size="small" icon={<DeleteOutlined />} danger />
      </Popconfirm>
    </Space>
  )

  const { data: docsResult, isLoading } = useQuery({
    queryKey: ['documents', allPage, pendingPage],
    queryFn: async () => {
      try {
        const res = await apiClient.get('/admin/documents', {
          params: { meta: '1', limit: pageSize, offset: (allPage - 1) * pageSize },
        })
        return res.data as {
          items: AdminDocumentRow[]
          total: number
          pendingReview: number
        }
      } catch {
        return {
          items: MOCK_DOCUMENTS,
          total: MOCK_DOCUMENTS.length,
          pendingReview: MOCK_DOCUMENTS.filter((d) => d.status === 'pending_review').length,
        }
      }
    },
    refetchInterval: 30_000,
  })

  const { data: pendingResult, isLoading: pendingLoading } = useQuery({
    queryKey: ['documents-pending', pendingPage],
    queryFn: async () => {
      const res = await apiClient.get('/admin/documents', {
        params: {
          meta: '1',
          limit: pageSize,
          offset: (pendingPage - 1) * pageSize,
          status: 'pending_review',
        },
      })
      return res.data as { items: AdminDocumentRow[]; total: number }
    },
    enabled: (docsResult?.pendingReview ?? 0) > 0,
  })

  const { mutate: approve } = useMutation({
    mutationFn: async (id: string) => {
      await apiClient.post(`/admin/documents/${id}/approve`)
    },
    onSuccess: () => {
      message.success(t.documents.approveSuccess)
      qc.invalidateQueries({ queryKey: ['documents'] })
    },
    onError: () => message.error(t.common.error),
  })

  const allColumns = [
    {
      title: <span style={{ fontFamily: font }}>{t.common.title}</span>,
      dataIndex: 'title_ar',
      key: 'title_ar',
      render: (v: string) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <FileTextOutlined style={{ color: GOLD }} />
          <span style={cellStyle}>{v}</span>
        </div>
      ),
    },
    {
      title: <span style={{ fontFamily: font }}>{t.common.collection}</span>,
      dataIndex: 'collection',
      key: 'collection',
      render: (v: string) => (
        <CollectionTag collection={v} size="small" label={collectionLabel(v)} fontFamily={font} />
      ),
    },
    {
      title: <span style={{ fontFamily: font }}>{t.common.status}</span>,
      dataIndex: 'status',
      key: 'status',
      render: (v: string) => {
        const color = STATUS_COLORS[v] || '#8c8c8c'
        return (
          <Tag
            style={{
              background: `${color}20`,
              border: `1px solid ${color}40`,
              color,
              borderRadius: 12,
              fontFamily: font,
              fontSize: 12,
            }}
          >
            {statusLabel(v)}
          </Tag>
        )
      },
    },
    {
      title: <span style={{ fontFamily: font }}>{t.documents.owner}</span>,
      dataIndex: 'uploaded_by',
      key: 'uploaded_by',
      render: (v: string | null, record: { owner_type?: string }) => (
        <span style={mutedStyle}>
          {v || (record.owner_type === 'system' ? t.documents.ownerSystem : '—')}
        </span>
      ),
    },
    {
      title: <span style={{ fontFamily: font }}>{t.documents.addedAt}</span>,
      dataIndex: 'created_at',
      key: 'created_at',
      render: (v: string) => (
        <span style={mutedStyle}>{dayjs(v).format('DD/MM/YYYY')}</span>
      ),
    },
    {
      title: <span style={{ fontFamily: font }}>{t.common.actions}</span>,
      key: 'actions',
      render: (_: unknown, record: AdminDocumentRow) => renderDocActions(record),
    },
  ]

  const pendingColumns = [
    ...allColumns.slice(0, -1),
    {
      title: <span style={{ fontFamily: font }}>{t.common.actions}</span>,
      key: 'actions',
      render: (_: unknown, record: AdminDocumentRow) =>
        renderDocActions(
          record,
          <>
            <Button
              size="small"
              type="primary"
              icon={<CheckCircleOutlined />}
              onClick={() => approve(record.id)}
              style={{ background: '#52c41a', borderColor: '#52c41a', fontFamily: font }}
            >
              {t.documents.approve}
            </Button>
            <Button
              size="small"
              danger
              icon={<CloseCircleOutlined />}
              onClick={() => setRejectDocId(record.id)}
              style={{ fontFamily: font }}
            >
              {t.documents.reject}
            </Button>
          </>,
        ),
    },
  ]

  const allDocs = docsResult?.items ?? []
  const totalDocs = docsResult?.total ?? 0
  const pendingTotal = docsResult?.pendingReview ?? 0
  const pendingDocs = pendingResult?.items ?? []

  const tabItems = [
    {
      key: 'all',
      label: (
        <span style={{ fontFamily: font }}>
          {t.documents.tabAll}
          <Badge
            count={totalDocs}
            overflowCount={999_999}
            showZero
            style={{ marginInlineStart: 8, background: 'var(--color-border-subtle)', color: 'var(--color-text-secondary)' }}
          />
        </span>
      ),
      children: (
        <Table
          dataSource={allDocs}
          columns={allColumns}
          rowKey="id"
          loading={isLoading}
          pagination={{
            current: allPage,
            pageSize,
            total: totalDocs,
            showSizeChanger: false,
            showTotal: (total) => (
              <span style={{ fontFamily: font, color: 'var(--color-text-tertiary)' }}>
                {total.toLocaleString(numberLocale)} {t.documents.totalLabel}
              </span>
            ),
            onChange: (p) => setAllPage(p),
          }}
          style={tableStyle}
          locale={{ emptyText: <span style={{ fontFamily: font }}>{t.documents.emptyAll}</span> }}
        />
      ),
    },
    {
      key: 'pending',
      label: (
        <span style={{ fontFamily: font }}>
          {t.documents.tabPending}
          {pendingTotal > 0 && (
            <Badge
              count={pendingTotal}
              overflowCount={999_999}
              style={{ marginInlineStart: 8, background: '#fa8c16' }}
            />
          )}
        </span>
      ),
      children: (
        <Table
          dataSource={pendingDocs}
          columns={pendingColumns}
          rowKey="id"
          loading={pendingLoading || isLoading}
          pagination={{
            current: pendingPage,
            pageSize,
            total: pendingResult?.total ?? pendingTotal,
            showSizeChanger: false,
            showTotal: (total) => (
              <span style={{ fontFamily: font, color: 'var(--color-text-tertiary)' }}>
                {total.toLocaleString(numberLocale)} {t.documents.totalLabel}
              </span>
            ),
            onChange: (p) => setPendingPage(p),
          }}
          style={tableStyle}
          locale={{ emptyText: <span style={{ fontFamily: font }}>{t.documents.emptyPending}</span> }}
        />
      ),
    },
  ]

  return (
    <div style={pageStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h1 style={h1Style}>{t.documents.title}</h1>
        <Space>
          <Button
            icon={<CloudDownloadOutlined />}
            onClick={() => navigate('/admin/scraper?tab=by-ref')}
            style={{ fontFamily: font }}
          >
            {t.scraper.byReference}
          </Button>
          <Button
            type="primary"
            icon={<UploadOutlined />}
            onClick={() => setUploadOpen(true)}
            style={{ background: GOLD, borderColor: GOLD, color: '#000', fontFamily: font, fontWeight: 600 }}
          >
            {t.documents.upload}
          </Button>
        </Space>
      </div>

      <Tabs items={tabItems} style={{ direction: dir }} />

      <UploadModal open={uploadOpen} onClose={() => setUploadOpen(false)} ui={ui} />
      <RejectModal open={!!rejectDocId} docId={rejectDocId} onClose={() => setRejectDocId(null)} ui={ui} />
      <DocumentViewer
        documentId={viewerDoc?.id || null}
        filename={viewerDoc?.filename}
        onClose={() => setViewerDoc(null)}
      />
      <JudgmentSummaryDrawer
        documentId={summaryDocId}
        onClose={() => setSummaryDocId(null)}
        stream={summaryStream}
        title={t.documents.summaryTitle}
        loadingText={t.documents.summaryLoading}
        failedPrefix={t.documents.summaryFailed}
        font={font}
      />
    </div>
  )
}
