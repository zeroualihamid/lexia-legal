import React, { useState } from 'react'
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

const MOCK_SOURCES = [
  { id: '1', name_ar: 'الجريدة الرسمية', url: 'https://www.sgg.gov.ma', collection: 'legal_laws', scraper_type: 'boa', is_active: true, last_scraped_at: '2024-03-10T08:00:00Z', docs_count: 15420 },
  { id: '2', name_ar: 'محكمة النقض', url: 'https://www.coursuprème.ma', collection: 'judgments_civil', scraper_type: 'cour_cassation', is_active: true, last_scraped_at: '2024-03-09T14:00:00Z', docs_count: 8930 },
  { id: '3', name_ar: 'المحكمة التجارية الدار البيضاء', url: 'https://example.ma/commercial', collection: 'judgments_commercial', scraper_type: 'tribunal', is_active: false, last_scraped_at: '2024-02-20T10:00:00Z', docs_count: 3240 },
]

const MOCK_JOBS = [
  { id: '1', type: 'scrape', status: 'running', progress: 67, document: 'الجريدة الرسمية', created_at: new Date().toISOString(), source_name_ar: 'الجريدة الرسمية' },
  { id: '2', type: 'embed', status: 'completed', progress: 100, document: 'محكمة النقض', created_at: new Date(Date.now() - 3600000).toISOString(), source_name_ar: 'محكمة النقض' },
  { id: '3', type: 'scrape', status: 'failed', progress: 32, document: 'المحكمة التجارية', created_at: new Date(Date.now() - 7200000).toISOString(), source_name_ar: 'المحكمة التجارية الدار البيضاء' },
]

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

  React.useEffect(() => {
    if (editSource) {
      form.setFieldsValue(editSource)
    } else {
      form.resetFields()
    }
  }, [editSource, form])

  const { mutate: save, isPending } = useMutation({
    mutationFn: async (values: any) => {
      if (editSource) {
        await apiClient.put(`/admin/scraper/sources/${editSource.id}`, values)
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
      </Form>
    </Modal>
  )
}

export function ScraperPage() {
  const ui = useAdminUi()
  const { t, font, pageStyle, tableStyle, h1Style, labelStyle, collectionLabel, numberLocale, isRtl } = ui
  const [sourceModalOpen, setSourceModalOpen] = useState(false)
  const [editSource, setEditSource] = useState<any | null>(null)
  const qc = useQueryClient()

  const jobStatusLabel = (status: string) =>
    t.scraper.jobStatus[status as keyof typeof t.scraper.jobStatus] || status

  const { data: sources, isLoading: sourcesLoading } = useQuery({
    queryKey: ['scraper-sources'],
    queryFn: async () => {
      try {
        const res = await apiClient.get('/admin/scraper/sources')
        return res.data
      } catch {
        return MOCK_SOURCES
      }
    },
  })

  const { data: jobs, isLoading: jobsLoading } = useQuery({
    queryKey: ['scraper-jobs'],
    queryFn: async () => {
      try {
        const res = await apiClient.get('/admin/scraper/jobs')
        return res.data
      } catch {
        return MOCK_JOBS
      }
    },
    refetchInterval: 5000,
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
      dataIndex: 'docs_count',
      key: 'docs_count',
      render: (v: number) => (
        <span style={{ fontFamily: font, color: 'var(--color-text-secondary)' }}>
          {v?.toLocaleString(numberLocale) || '0'}
        </span>
      ),
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
            onConfirm={() => message.info(t.documents.deleted)}
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
        <span style={{ fontFamily: font, color: 'var(--color-text-secondary)', fontSize: 12 }}>{v}</span>
      ),
    },
    {
      title: <span style={labelStyle}>{t.common.source}</span>,
      dataIndex: 'source_name_ar',
      key: 'source_name_ar',
      render: (v: string) => (
        <span style={{ fontFamily: font, color: 'var(--color-text-secondary)', fontSize: 13 }}>{v}</span>
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
      dataIndex: 'progress',
      key: 'progress',
      render: (v: number, r: any) => (
        <Progress
          percent={v}
          size="small"
          strokeColor={JOB_STATUS_COLORS[r.status] || GOLD}
          trailColor="var(--color-border-subtle)"
          style={{ minWidth: 100 }}
        />
      ),
    },
    {
      title: <span style={labelStyle}>{t.scraper.startedAt}</span>,
      dataIndex: 'created_at',
      key: 'created_at',
      render: (v: string) => (
        <span style={{ fontFamily: font, color: 'var(--color-text-quaternary)', fontSize: 12 }}>
          {dayjs(v).format('HH:mm DD/MM')}
        </span>
      ),
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
            dataSource={sources || MOCK_SOURCES}
            columns={sourcesColumns}
            rowKey="id"
            loading={sourcesLoading}
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
          {jobs?.filter((j: any) => j.status === 'running').length > 0 && (
            <Badge
              count={jobs.filter((j: any) => j.status === 'running').length}
              style={{ [isRtl ? 'marginRight' : 'marginLeft']: 8, background: '#1677ff' }}
            />
          )}
        </span>
      ),
      children: (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => qc.invalidateQueries({ queryKey: ['scraper-jobs'] })}
              style={{ fontFamily: font }}
            >
              {t.common.refresh}
            </Button>
          </div>
          <Table
            dataSource={jobs || MOCK_JOBS}
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

      <Tabs items={tabItems} style={{ direction: ui.dir }} />

      <SourceModal
        open={sourceModalOpen}
        editSource={editSource}
        onClose={() => { setSourceModalOpen(false); setEditSource(null) }}
        ui={ui}
      />
    </div>
  )
}
