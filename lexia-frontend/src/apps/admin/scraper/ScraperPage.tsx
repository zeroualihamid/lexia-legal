import React, { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Tabs,
  Table,
  Button,
  Switch,
  Tag,
  Modal,
  Form,
  Input,
  Select,
  Progress,
  Space,
  Tooltip,
  message,
  Popconfirm,
  Badge,
  Card,
  Descriptions,
  Alert,
  Spin,
} from 'antd'
import {
  PlusOutlined,
  PlayCircleOutlined,
  StopOutlined,
  EditOutlined,
  DeleteOutlined,
  ReloadOutlined,
  CloudDownloadOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import apiClient from '../../../shared/api/client'
import { CollectionTag } from '../../../shared/components/CollectionTag'
import { GOLD, DARK_CARD, BORDER_COLOR } from '../../../shared/constants'
import dayjs from 'dayjs'
import { useAdminUi } from '../locale/useAdminI18n'

const JOB_STATUS_COLORS: Record<string, string> = {
  running: '#1677ff',
  completed: '#52c41a',
  failed: '#f5222d',
  cancelled: '#8c8c8c',
  pending: '#fa8c16',
}

function jobTypeLabel(type: string, t: ReturnType<typeof useAdminUi>['t']) {
  return t.scraper.jobTypes[type as keyof typeof t.scraper.jobTypes] || type
}

function CorpusMonitorPanel({
  monitor,
  loading,
  ui,
  onResume,
  resumingId,
}: {
  monitor: any
  loading: boolean
  ui: ReturnType<typeof useAdminUi>
  onResume?: (sourceId: string) => void
  resumingId?: string | null
}) {
  const { t, font, labelStyle, numberLocale } = ui
  if (loading && !monitor) {
    return <Card loading style={{ marginBottom: 16, background: DARK_CARD, borderColor: BORDER_COLOR }} />
  }
  if (!monitor?.corpusSources?.length) return null

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ ...labelStyle, fontSize: 15 }}>{t.scraper.monitorTitle}</span>
        <Space size={8}>
          <Tag color="processing" style={{ fontFamily: font, margin: 0 }}>
            {t.scraper.monitorActiveJobs}: {monitor.queue?.active ?? 0}
          </Tag>
          <Tag color="warning" style={{ fontFamily: font, margin: 0 }}>
            {t.scraper.monitorWaitingJobs}: {monitor.queue?.waiting ?? 0}
          </Tag>
          {(monitor.queue?.failed ?? 0) > 0 && (
            <Tag color="error" style={{ fontFamily: font, margin: 0 }}>
              {t.scraper.monitorFailedJobs}: {monitor.queue.failed}
            </Tag>
          )}
        </Space>
      </div>

      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {monitor.corpusSources.map((src: any) => {
          const isRunning = src.last_status === 'running'
          const hasError = src.last_status === 'error'
          const statusColor = hasError ? '#f5222d' : isRunning ? '#1677ff' : '#8c8c8c'
          const statusText = hasError
            ? t.scraper.monitorError
            : isRunning
              ? t.scraper.monitorRunning
              : t.scraper.monitorIdle

          return (
            <Card
              key={src.id}
              size="small"
              style={{ background: DARK_CARD, borderColor: BORDER_COLOR }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
                <Space direction="vertical" size={0}>
                  <span style={{ fontFamily: font, fontWeight: 600, color: 'var(--color-text-primary)' }}>
                    {src.name_fr || src.name_ar}
                  </span>
                  <span style={{ fontFamily: font, fontSize: 12, color: 'var(--color-text-quaternary)' }}>
                    {src.name_ar}
                  </span>
                </Space>
                <Tag
                  style={{
                    background: `${statusColor}20`,
                    border: `1px solid ${statusColor}40`,
                    color: statusColor,
                    borderRadius: 12,
                    fontFamily: font,
                    alignSelf: 'flex-start',
                  }}
                >
                  {statusText}
                  {isRunning && <Spin size="small" style={{ marginInlineStart: 6 }} />}
                </Tag>
              </div>

              <div style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontFamily: font, fontSize: 12, color: 'var(--color-text-secondary)' }}>
                    {t.scraper.monitorCorpusProgress}
                  </span>
                  <span style={{ fontFamily: font, fontSize: 12, color: GOLD }}>
                    {src.downloaded.toLocaleString(numberLocale)} / {src.target.toLocaleString(numberLocale)} PDF ({src.percent}%)
                  </span>
                </div>
                <Progress percent={src.percent} strokeColor={GOLD} size="small" />
              </div>

              <Space wrap size={[16, 4]} style={{ fontFamily: font, fontSize: 12, color: 'var(--color-text-tertiary)' }}>
                {src.last_batch != null && (
                  <span>{t.scraper.monitorLastBatch}: +{src.last_batch.toLocaleString(numberLocale)}</span>
                )}
                {src.subject && <span>{t.scraper.monitorSubject}: {src.subject}</span>}
                {src.start_page != null && <span>{t.scraper.monitorPage}: {src.start_page}</span>}
                <span>{t.scraper.monitorDocsIndexed}: {src.docs_count.toLocaleString(numberLocale)}</span>
              </Space>

              {src.last_error && (
                <Alert
                  type="error"
                  showIcon
                  message={<span style={{ fontFamily: font, fontSize: 12 }}>{src.last_error}</span>}
                  style={{ marginTop: 10 }}
                />
              )}

              {src.downloaded < src.target && !isRunning && onResume && (
                <div style={{ marginTop: 12 }}>
                  <Button
                    type="primary"
                    size="small"
                    icon={<PlayCircleOutlined />}
                    loading={resumingId === src.id}
                    onClick={() => onResume(src.id)}
                    style={{ background: GOLD, borderColor: GOLD, color: '#000', fontFamily: font }}
                  >
                    {t.scraper.resumeCorpus}
                  </Button>
                </div>
              )}
            </Card>
          )
        })}
      </Space>
    </div>
  )
}

function SourceModal({
  open,
  editSource,
  onClose,
  ui,
}: {
  open: boolean
  editSource: any | null
  onClose: () => void
  ui: ReturnType<typeof useAdminUi>
}) {
  const { t, font, formStyle, labelStyle, titleStyle, collectionOptions } = ui
  const scraperTypeOptions = Object.entries(t.scraper.scraperTypes).map(([value, label]) => ({ value, label }))
  const [form] = Form.useForm()
  const qc = useQueryClient()
  const scraperType = Form.useWatch('scraper_type', form)
  const isJuriscassation = scraperType === 'juriscassation' || scraperType === 'cour_cassation'

  React.useEffect(() => {
    if (editSource) {
      const cfg = editSource.config || {}
      form.setFieldsValue({
        name_ar: editSource.name_ar,
        name_fr: editSource.name_fr,
        url: editSource.url,
        scraper_type: editSource.scraper_type,
        collection: editSource.collection,
        max_pages: cfg.max_pages,
        max_downloads: cfg.max_downloads,
        corpus_target: cfg.corpus_target,
        batch_downloads: cfg.batch_downloads,
        search_subject: cfg.search_subject,
        search_subjects_text: (cfg.search_subjects || []).join(', '),
      })
    } else {
      form.resetFields()
    }
  }, [editSource, form])

  const { mutate: save, isPending } = useMutation({
    mutationFn: async (values: any) => {
      if (editSource) {
        await apiClient.patch(`/admin/scraper/sources/${editSource.id}`, values)
      } else {
        await apiClient.post('/admin/scraper/sources', values)
      }
    },
    onSuccess: () => {
      message.success(editSource ? t.scraper.sourceUpdated : t.scraper.sourceAdded)
      qc.invalidateQueries({ queryKey: ['scraper-sources'] })
      onClose()
    },
    onError: () => message.error(t.common.error),
  })

  return (
    <Modal
      title={<span style={titleStyle}>{editSource ? t.scraper.editSource : t.scraper.newSource}</span>}
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText={<span style={{ fontFamily: font }}>{t.common.save}</span>}
      cancelText={<span style={{ fontFamily: font }}>{t.common.cancel}</span>}
      okButtonProps={{ loading: isPending, style: { background: GOLD, borderColor: GOLD, color: '#000' } }}
      centered
      width={540}
    >
      <Form form={form} layout="vertical" onFinish={(v) => save(v)} style={formStyle}>
        <Form.Item
          name="name_ar"
          label={<span style={labelStyle}>{t.scraper.nameAr}</span>}
          rules={[{ required: true, message: t.common.required }]}
        >
          <Input style={{ direction: 'rtl', fontFamily: font }} />
        </Form.Item>

        <Form.Item name="name_fr" label={<span style={labelStyle}>{t.scraper.nameFr}</span>}>
          <Input style={{ fontFamily: font }} />
        </Form.Item>

        <Form.Item
          name="url"
          label={<span style={labelStyle}>{t.scraper.sourceUrl}</span>}
          rules={[{ required: true, message: t.common.required }, { type: 'url', message: t.scraper.invalidUrl }]}
        >
          <Input style={{ fontFamily: font, direction: 'ltr' }} />
        </Form.Item>

        <Form.Item
          name="scraper_type"
          label={<span style={labelStyle}>{t.scraper.scraperType}</span>}
          rules={[{ required: true, message: t.common.required }]}
        >
          <Select options={scraperTypeOptions} style={{ fontFamily: font }} />
        </Form.Item>

        <Form.Item
          name="collection"
          label={<span style={labelStyle}>{t.common.collection}</span>}
          rules={[{ required: true, message: t.common.required }]}
        >
          <Select options={collectionOptions} style={{ fontFamily: font }} />
        </Form.Item>

        {isJuriscassation && (
          <>
            <Form.Item
              name="corpus_target"
              label={<span style={labelStyle}>{t.scraper.corpusTarget}</span>}
              tooltip="51770 pour l'intégralité des arrêts de la Cour de cassation (CSPJ)"
            >
              <Input type="number" min={1} style={{ fontFamily: font, direction: 'ltr' }} placeholder="51770" />
            </Form.Item>

            <Form.Item
              name="batch_downloads"
              label={<span style={labelStyle}>{t.scraper.batchDownloads}</span>}
            >
              <Input type="number" min={1} max={200} style={{ fontFamily: font, direction: 'ltr' }} placeholder="50" />
            </Form.Item>

            <Form.Item
              name="search_subject"
              label={<span style={labelStyle}>{t.scraper.searchSubject}</span>}
            >
              <Input style={{ fontFamily: font, direction: 'rtl' }} placeholder="ال" />
            </Form.Item>

            <Form.Item
              name="search_subjects_text"
              label={<span style={labelStyle}>{t.scraper.searchSubjects}</span>}
            >
              <Input.TextArea rows={2} style={{ fontFamily: font, direction: 'rtl' }} />
            </Form.Item>
          </>
        )}

        {!isJuriscassation && (
          <>
            <Form.Item name="max_pages" label={<span style={labelStyle}>max pages</span>}>
              <Input type="number" min={1} style={{ fontFamily: font, direction: 'ltr' }} placeholder="10" />
            </Form.Item>
            <Form.Item name="max_downloads" label={<span style={labelStyle}>max downloads</span>}>
              <Input type="number" min={1} style={{ fontFamily: font, direction: 'ltr' }} placeholder="100" />
            </Form.Item>
          </>
        )}
      </Form>
    </Modal>
  )
}

export function ScraperPage() {
  const ui = useAdminUi()
  const { t, font, pageStyle, tableStyle, h1Style, labelStyle, collectionLabel, numberLocale, isRtl } = ui
  const [searchParams, setSearchParams] = useSearchParams()
  const activeTab = searchParams.get('tab') || 'by-ref'
  const [sourceModalOpen, setSourceModalOpen] = useState(false)
  const [editSource, setEditSource] = useState<any | null>(null)
  const [refPreview, setRefPreview] = useState<any | null>(null)
  const [refForm] = Form.useForm()
  const qc = useQueryClient()

  const jobStatusLabel = (status: string) =>
    t.scraper.jobStatus[status as keyof typeof t.scraper.jobStatus] || status

  const { data: sources, isLoading: sourcesLoading, isError: sourcesError, refetch: refetchSources } = useQuery({
    queryKey: ['scraper-sources'],
    queryFn: async () => {
      const res = await apiClient.get('/admin/scraper/sources')
      return res.data
    },
  })

  const { data: jobs, isLoading: jobsLoading } = useQuery({
    queryKey: ['scraper-jobs'],
    queryFn: async () => {
      const res = await apiClient.get('/admin/scraper/jobs')
      return res.data
    },
    refetchInterval: 5000,
  })

  const { data: monitor, isLoading: monitorLoading } = useQuery({
    queryKey: ['scraper-monitor'],
    queryFn: async () => {
      const res = await apiClient.get('/admin/scraper/monitor')
      return res.data
    },
    refetchInterval: 5000,
  })

  const runningCorpusCount =
    monitor?.corpusSources?.filter((s: any) => s.last_status === 'running').length ??
    jobs?.filter((j: any) => j.status === 'running').length ??
    0

  const { mutate: deleteSource } = useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`/admin/scraper/sources/${id}`)
    },
    onSuccess: () => {
      message.success(t.documents.deleted)
      qc.invalidateQueries({ queryKey: ['scraper-sources'] })
    },
    onError: () => message.error(t.common.error),
  })

  const { mutate: toggleSource } = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      await apiClient.patch(`/admin/scraper/sources/${id}`, { is_active: active })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scraper-sources'] }),
    onError: () => message.error(t.common.error),
  })

  const { mutate: launchScraping, isPending: launching } = useMutation({
    mutationFn: async (sourceId: string) => {
      await apiClient.post(`/admin/scraper/sources/${sourceId}/scrape`)
    },
    onSuccess: () => {
      message.success(t.scraper.scrapeStarted)
      qc.invalidateQueries({ queryKey: ['scraper-jobs'] })
    },
    onError: () => message.error(t.common.error),
  })

  const { mutate: cancelJob } = useMutation({
    mutationFn: async (jobId: string) => {
      await apiClient.post(`/admin/scraper/jobs/${jobId}/cancel`)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scraper-jobs'] }),
    onError: () => message.error(t.common.error),
  })

  const { mutate: previewByRef, isPending: previewingRef } = useMutation({
    mutationFn: async (values: any) => {
      const res = await apiClient.post('/admin/scraper/scrape-by-reference/preview', values)
      return res.data
    },
    onSuccess: (data) => {
      setRefPreview(data)
      message.success(data.found ? t.scraper.previewDone : t.scraper.notFound)
    },
    onError: () => message.error(t.common.error),
  })

  const { mutate: enqueueByRef, isPending: enqueuingRef } = useMutation({
    mutationFn: async (values: any) => {
      const res = await apiClient.post('/admin/scraper/scrape-by-reference', values)
      return res.data
    },
    onSuccess: () => {
      message.success(t.scraper.enqueueDone)
      qc.invalidateQueries({ queryKey: ['scraper-jobs'] })
    },
    onError: () => message.error(t.common.error),
  })

  const [resumingId, setResumingId] = useState<string | null>(null)

  const { mutate: resumeCorpus } = useMutation({
    mutationFn: async (sourceId: string) => {
      setResumingId(sourceId)
      const res = await apiClient.post(`/admin/scraper/sources/${sourceId}/resume-corpus`)
      return res.data
    },
    onSuccess: (data) => {
      message.success(data.message || t.scraper.resumeCorpusDone)
      qc.invalidateQueries({ queryKey: ['scraper-jobs'] })
      qc.invalidateQueries({ queryKey: ['scraper-monitor'] })
    },
    onError: () => message.error(t.common.error),
    onSettled: () => setResumingId(null),
  })

  const { mutate: drainDocQueue, isPending: drainingQueue } = useMutation({
    mutationFn: async () => {
      const res = await apiClient.post('/admin/scraper/drain-document-queue')
      return res.data
    },
    onSuccess: (data) => {
      message.success(
        `${t.scraper.drainQueueDone}: ${data.waitingRemoved} ${t.scraper.drainQueueWaiting}, ${data.documentsUpdated} ${t.scraper.drainQueueDocs}`,
      )
    },
    onError: () => message.error(t.common.error),
  })

  const { mutate: bulkReindex, isPending: bulkReindexing } = useMutation({
    mutationFn: async (payload: { sourceId?: string; limit?: number }) => {
      const res = await apiClient.post('/admin/scraper/bulk-reindex', payload)
      return res.data
    },
    onSuccess: (data) => {
      message.success(`${t.scraper.bulkReindexDone}: ${data.enqueued}`)
    },
    onError: () => message.error(t.common.error),
  })

  const sourcesColumns = [
    {
      title: <span style={labelStyle}>{t.common.source}</span>,
      dataIndex: 'name_ar',
      key: 'name_ar',
      render: (v: string) => (
        <span style={{ fontFamily: font, color: 'var(--color-text-primary)', fontWeight: 500 }}>
          {v}
        </span>
      ),
    },
    {
      title: <span style={labelStyle}>{t.common.url}</span>,
      dataIndex: 'url',
      key: 'url',
      render: (v: string) => (
        <a
          href={v}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontFamily: font, color: GOLD, fontSize: 12, direction: 'ltr', display: 'inline-block' }}
        >
          {v.length > 35 ? v.slice(0, 35) + '...' : v}
        </a>
      ),
    },
    {
      title: <span style={labelStyle}>{t.common.collection}</span>,
      dataIndex: 'collection',
      key: 'collection',
      render: (v: string) => (
        <CollectionTag collection={v} size="small" label={collectionLabel(v)} fontFamily={font} />
      ),
    },
    {
      title: <span style={labelStyle}>{t.scraper.docs}</span>,
      key: 'docs_progress',
      render: (_: unknown, record: any) => {
        const cfg = record.config || {}
        const target = Number(cfg.corpus_target || 0)
        const downloaded = Number(cfg.corpus_downloaded ?? record.docs_count ?? 0)
        if (target > 0) {
          const pct = Math.min(100, Math.round((downloaded / target) * 100))
          return (
            <Space direction="vertical" size={0} style={{ minWidth: 120 }}>
              <span style={{ fontFamily: font, color: 'var(--color-text-secondary)', fontSize: 12 }}>
                {downloaded.toLocaleString(numberLocale)} / {target.toLocaleString(numberLocale)}
              </span>
              <Progress percent={pct} size="small" strokeColor={GOLD} showInfo={false} />
            </Space>
          )
        }
        return (
          <span style={{ fontFamily: font, color: 'var(--color-text-secondary)' }}>
            {(record.docs_count ?? 0).toLocaleString(numberLocale)}
          </span>
        )
      },
    },
    {
      title: <span style={labelStyle}>{t.scraper.lastScrape}</span>,
      dataIndex: 'last_scraped_at',
      key: 'last_scraped_at',
      render: (v: string) => (
        <span style={{ fontFamily: font, color: 'var(--color-text-quaternary)', fontSize: 12 }}>
          {v ? dayjs(v).format('DD/MM/YYYY HH:mm') : '-'}
        </span>
      ),
    },
    {
      title: <span style={labelStyle}>{t.common.active}</span>,
      dataIndex: 'is_active',
      key: 'is_active',
      render: (v: boolean, r: any) => (
        <Switch
          checked={v}
          onChange={(checked) => toggleSource({ id: r.id, active: checked })}
          style={{ background: v ? GOLD : undefined }}
        />
      ),
    },
    {
      title: <span style={labelStyle}>{t.common.actions}</span>,
      key: 'actions',
      render: (_: any, record: any) => (
        <Space>
          <Tooltip title={t.scraper.startScrape}>
            <Button
              type="text"
              size="small"
              icon={<PlayCircleOutlined />}
              style={{ color: '#52c41a' }}
              loading={launching}
              onClick={() => launchScraping(record.id)}
            />
          </Tooltip>
          <Tooltip title={t.common.edit}>
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              style={{ color: GOLD }}
              onClick={() => { setEditSource(record); setSourceModalOpen(true) }}
            />
          </Tooltip>
          <Popconfirm
            title={<span style={{ fontFamily: font }}>{t.scraper.deleteSourceConfirm}</span>}
            okText={<span style={{ fontFamily: font }}>{t.common.delete}</span>}
            cancelText={<span style={{ fontFamily: font }}>{t.common.cancel}</span>}
            okButtonProps={{ danger: true }}
            onConfirm={() => deleteSource(record.id)}
          >
            <Button type="text" size="small" icon={<DeleteOutlined />} danger />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const jobsColumns = [
    {
      title: <span style={labelStyle}>{t.scraper.type}</span>,
      dataIndex: 'type',
      key: 'type',
      render: (v: string) => (
        <span style={{ fontFamily: font, color: 'var(--color-text-secondary)', fontSize: 12 }}>
          {jobTypeLabel(v, t)}
        </span>
      ),
    },
    {
      title: <span style={labelStyle}>{t.common.source}</span>,
      key: 'source',
      render: (_: unknown, record: any) => (
        <Space direction="vertical" size={0}>
          <span style={{ fontFamily: font, color: 'var(--color-text-secondary)', fontSize: 13 }}>
            {record.source_name_fr || record.source_name_ar || record.data?.fileReference || '-'}
          </span>
          {record.source_name_ar && record.source_name_fr && (
            <span style={{ fontFamily: font, color: 'var(--color-text-quaternary)', fontSize: 11 }}>
              {record.source_name_ar}
            </span>
          )}
        </Space>
      ),
    },
    {
      title: <span style={labelStyle}>{t.common.status}</span>,
      dataIndex: 'status',
      key: 'status',
      render: (v: string) => {
        const color = JOB_STATUS_COLORS[v] || '#8c8c8c'
        return (
          <Tag
            style={{
              background: `${color}20`,
              border: `1px solid ${color}40`,
              color,
              borderRadius: 12,
              fontFamily: font,
            }}
          >
            {jobStatusLabel(v)}
          </Tag>
        )
      },
    },
    {
      title: <span style={labelStyle}>{t.scraper.progress}</span>,
      key: 'progress',
      render: (_: unknown, r: any) => {
        const pct = r.corpus?.percent ?? r.progress ?? 0
        const label = r.progressLabel || (r.corpus
          ? `${r.corpus.downloaded?.toLocaleString(numberLocale)} / ${r.corpus.target?.toLocaleString(numberLocale)}`
          : '')
        return (
          <Space direction="vertical" size={0} style={{ minWidth: 140 }}>
            {label && (
              <span style={{ fontFamily: font, fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                {label}
                {r.batchCount != null && r.status === 'completed' ? ` (+${r.batchCount})` : ''}
              </span>
            )}
            <Progress
              percent={pct}
              size="small"
              strokeColor={JOB_STATUS_COLORS[r.status] || GOLD}
              trailColor="var(--color-border-subtle)"
            />
          </Space>
        )
      },
    },
    {
      title: <span style={labelStyle}>{t.scraper.startedAt}</span>,
      dataIndex: 'created_at',
      key: 'created_at',
      render: (v: string) => (
        <span style={{ fontFamily: font, color: 'var(--color-text-quaternary)', fontSize: 12 }}>
          {v ? dayjs(v).format('HH:mm DD/MM') : '-'}
        </span>
      ),
    },
    {
      title: <span style={labelStyle}>{t.scraper.jobDetails}</span>,
      key: 'details',
      render: (_: unknown, r: any) => {
        if (r.status === 'failed' && r.failedReason) {
          return (
            <Tooltip title={r.failedReason}>
              <span style={{ fontFamily: font, fontSize: 11, color: '#f5222d', maxWidth: 160, display: 'inline-block' }}>
                {r.failedReason.slice(0, 60)}{r.failedReason.length > 60 ? '…' : ''}
              </span>
            </Tooltip>
          )
        }
        if (r.corpus?.subject) {
          return (
            <span style={{ fontFamily: font, fontSize: 11, color: 'var(--color-text-quaternary)' }}>
              {t.scraper.monitorSubject}: {r.corpus.subject}
              {r.corpus.startPage != null ? ` · ${t.scraper.monitorPage} ${r.corpus.startPage}` : ''}
            </span>
          )
        }
        return <span style={{ color: 'var(--color-text-quaternary)' }}>-</span>
      },
    },
    {
      title: <span style={labelStyle}>{t.common.actions}</span>,
      key: 'actions',
      render: (_: any, record: any) => (
        record.status === 'running' ? (
          <Popconfirm
            title={<span style={{ fontFamily: font }}>{t.scraper.cancelJobConfirm}</span>}
            onConfirm={() => cancelJob(record.id)}
            okText={<span style={{ fontFamily: font }}>{t.scraper.cancelJob}</span>}
            cancelText={<span style={{ fontFamily: font }}>{t.common.close}</span>}
            okButtonProps={{ danger: true }}
          >
            <Button type="text" size="small" icon={<StopOutlined />} danger style={{ fontFamily: font }}>
              {t.scraper.stop}
            </Button>
          </Popconfirm>
        ) : null
      ),
    },
  ]

  const tabItems = [
    {
      key: 'by-ref',
      label: <span style={{ fontFamily: font }}>{t.scraper.byReference}</span>,
      children: (
        <Card style={{ background: DARK_CARD, borderColor: BORDER_COLOR, maxWidth: 720 }}>
          <Form
            form={refForm}
            layout="vertical"
            onFinish={(values) => previewByRef(values)}
            initialValues={{ collection: 'judgments_civil' }}
          >
            <Form.Item
              name="fileReference"
              label={<span style={labelStyle}>{t.scraper.fileReference}</span>}
              rules={[{ required: true, message: t.common.required }]}
              extra={<span style={{ fontFamily: font, fontSize: 12 }}>{t.scraper.fileReferenceHint}</span>}
            >
              <Input placeholder="2018/8221/4933" style={{ direction: 'ltr', fontFamily: font }} />
            </Form.Item>
            <Form.Item name="courtName" label={<span style={labelStyle}>{t.scraper.courtName}</span>}>
              <Input style={{ direction: 'rtl', fontFamily: font }} />
            </Form.Item>
            <Form.Item name="collection" label={<span style={labelStyle}>{t.common.collection}</span>}>
              <Select options={ui.collectionOptions} style={{ fontFamily: font }} />
            </Form.Item>
            <Space>
              <Button
                type="primary"
                htmlType="submit"
                loading={previewingRef}
                style={{ background: GOLD, borderColor: GOLD, color: '#000', fontFamily: font }}
              >
                {t.scraper.preview}
              </Button>
              <Button
                loading={enqueuingRef}
                onClick={() => {
                  refForm.validateFields().then((values) => enqueueByRef(values))
                }}
                style={{ fontFamily: font }}
              >
                {t.scraper.enqueue}
              </Button>
            </Space>
          </Form>

          {refPreview && (
            <div style={{ marginTop: 24 }}>
              <Alert
                type={refPreview.found ? 'success' : 'warning'}
                message={
                  <span style={{ fontFamily: font }}>
                    {refPreview.found
                      ? `${refPreview.format === 'cassation' ? t.scraper.formatCassation : t.scraper.formatAppeal} — ${refPreview.source === 'mahakim' ? t.scraper.sourceMahakim : t.scraper.sourceCspj}`
                      : refPreview.message || t.scraper.notFound}
                  </span>
                }
                style={{ marginBottom: 16 }}
              />
              {refPreview.found && (
                <Descriptions
                  bordered
                  size="small"
                  column={1}
                  style={{ fontFamily: font }}
                  items={[
                    { label: t.scraper.fileReference, children: refPreview.fileReference },
                    { label: t.common.status, children: refPreview.title || '-' },
                    ...(refPreview.metadata?.mahakim
                      ? Object.entries(refPreview.metadata.mahakim).map(([k, v]) => ({
                          label: k,
                          children: String(v),
                        }))
                      : []),
                  ]}
                />
              )}
            </div>
          )}
        </Card>
      ),
    },
    {
      key: 'sources',
      label: <span style={{ fontFamily: font }}>{t.scraper.sources}</span>,
      children: (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => { setEditSource(null); setSourceModalOpen(true) }}
              style={{ background: GOLD, borderColor: GOLD, color: '#000', fontFamily: font }}
            >
              {t.scraper.addSource}
            </Button>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => qc.invalidateQueries({ queryKey: ['scraper-sources'] })}
              style={{ fontFamily: font }}
            >
              {t.common.refresh}
            </Button>
          </div>
          <Table
            dataSource={sources || []}
            columns={sourcesColumns}
            rowKey="id"
            loading={sourcesLoading}
            locale={{ emptyText: sourcesError ? t.common.error : undefined }}
            pagination={{ pageSize: 15 }}
            style={tableStyle}
          />
        </div>
      ),
    },
    {
      key: 'jobs',
      label: (
        <span style={{ fontFamily: font }}>
          {t.scraper.jobs}
          {runningCorpusCount > 0 && (
            <Badge
              count={runningCorpusCount}
              style={{ [isRtl ? 'marginRight' : 'marginLeft']: 8, background: '#1677ff' }}
            />
          )}
        </span>
      ),
      children: (
        <div>
          <CorpusMonitorPanel
            monitor={monitor}
            loading={monitorLoading}
            ui={ui}
            onResume={(id) => resumeCorpus(id)}
            resumingId={resumingId}
          />

          <Card
            size="small"
            title={<span style={{ fontFamily: font, fontSize: 13 }}>{t.scraper.maintenanceTitle}</span>}
            style={{ marginBottom: 16, background: DARK_CARD, borderColor: BORDER_COLOR }}
          >
            <Space wrap>
              <Popconfirm
                title={t.scraper.drainQueueConfirm}
                okText={t.common.confirm}
                cancelText={t.common.cancel}
                onConfirm={() => drainDocQueue()}
              >
                <Button loading={drainingQueue} style={{ fontFamily: font }}>
                  {t.scraper.drainQueue}
                </Button>
              </Popconfirm>
              <Popconfirm
                title={t.scraper.bulkReindexConfirm}
                okText={t.common.confirm}
                cancelText={t.common.cancel}
                onConfirm={() => bulkReindex({ limit: 50 })}
              >
                <Button loading={bulkReindexing} style={{ fontFamily: font }}>
                  {t.scraper.bulkReindex}
                </Button>
              </Popconfirm>
            </Space>
          </Card>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => {
                qc.invalidateQueries({ queryKey: ['scraper-jobs'] })
                qc.invalidateQueries({ queryKey: ['scraper-monitor'] })
                qc.invalidateQueries({ queryKey: ['scraper-sources'] })
              }}
              style={{ fontFamily: font }}
            >
              {t.common.refresh}
            </Button>
          </div>
          <Table
            dataSource={jobs || []}
            columns={jobsColumns}
            rowKey="id"
            loading={jobsLoading}
            pagination={{ pageSize: 20 }}
            style={tableStyle}
          />
        </div>
      ),
    },
  ]

  return (
    <div style={pageStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <CloudDownloadOutlined style={{ fontSize: 22, color: GOLD }} />
        <h1 style={h1Style}>{t.scraper.title}</h1>
      </div>

      <Tabs
        activeKey={activeTab}
        onChange={(key) => setSearchParams({ tab: key }, { replace: true })}
        items={tabItems}
        style={{ direction: ui.dir }}
      />

      <SourceModal
        open={sourceModalOpen}
        editSource={editSource}
        onClose={() => { setSourceModalOpen(false); setEditSource(null) }}
        ui={ui}
      />
    </div>
  )
}
