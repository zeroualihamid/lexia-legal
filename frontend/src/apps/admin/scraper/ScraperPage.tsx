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

const COLLECTION_OPTIONS = [
  { value: 'legal_laws', label: 'القوانين التشريعية' },
  { value: 'judgments_commercial', label: 'الأحكام التجارية' },
  { value: 'judgments_civil', label: 'الأحكام المدنية' },
  { value: 'judgments_admin', label: 'الأحكام الإدارية' },
  { value: 'judgments_criminal', label: 'الأحكام الجنائية' },
  { value: 'judgments_family', label: 'أحكام الأسرة' },
  { value: 'judgments_social', label: 'الأحكام الاجتماعية' },
  { value: 'judgments_real_estate', label: 'الأحكام العقارية' },
  { value: 'judgments_constitutional', label: 'الأحكام الدستورية' },
]

const SCRAPER_TYPES = [
  { value: 'boa', label: 'الجريدة الرسمية (BOA)' },
  { value: 'cour_cassation', label: 'محكمة النقض' },
  { value: 'cour_appel', label: 'محاكم الاستئناف' },
  { value: 'tribunal', label: 'المحاكم الابتدائية' },
  { value: 'generic_pdf', label: 'PDF عام' },
  { value: 'api', label: 'واجهة برمجية (API)' },
]

const JOB_STATUS_CONFIG: Record<string, { color: string; label: string }> = {
  running: { color: '#1677ff', label: 'جاري' },
  completed: { color: '#52c41a', label: 'مكتمل' },
  failed: { color: '#f5222d', label: 'فشل' },
  cancelled: { color: '#8c8c8c', label: 'ملغى' },
  pending: { color: '#fa8c16', label: 'في الانتظار' },
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
}: {
  open: boolean
  editSource: any | null
  onClose: () => void
}) {
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
      message.success(editSource ? 'تم تحديث المصدر' : 'تم إضافة المصدر')
      qc.invalidateQueries({ queryKey: ['scraper-sources'] })
      onClose()
    },
    onError: () => message.error('حدث خطأ'),
  })

  return (
    <Modal
      title={
        <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'rgba(255,255,255,0.9)' }}>
          {editSource ? 'تعديل المصدر' : 'إضافة مصدر جديد'}
        </span>
      }
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>حفظ</span>}
      cancelText={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>إلغاء</span>}
      okButtonProps={{ loading: isPending, style: { background: GOLD, borderColor: GOLD, color: '#000' } }}
      centered
      width={540}
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={(v) => save(v)}
        style={{ direction: 'rtl', marginTop: 16 }}
      >
        <Form.Item
          name="name_ar"
          label={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الاسم بالعربية</span>}
          rules={[{ required: true, message: 'مطلوب' }]}
        >
          <Input style={{ direction: 'rtl', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }} />
        </Form.Item>

        <Form.Item
          name="name_fr"
          label={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الاسم بالفرنسية</span>}
        >
          <Input style={{ fontFamily: "'Cairo', sans-serif" }} />
        </Form.Item>

        <Form.Item
          name="url"
          label={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>رابط المصدر</span>}
          rules={[{ required: true, message: 'مطلوب' }, { type: 'url', message: 'رابط غير صالح' }]}
        >
          <Input style={{ fontFamily: "'Cairo', sans-serif", direction: 'ltr' }} />
        </Form.Item>

        <Form.Item
          name="scraper_type"
          label={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>نوع الاستخراج</span>}
          rules={[{ required: true, message: 'مطلوب' }]}
        >
          <Select options={SCRAPER_TYPES} style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }} />
        </Form.Item>

        <Form.Item
          name="collection"
          label={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>المجموعة</span>}
          rules={[{ required: true, message: 'مطلوب' }]}
        >
          <Select options={COLLECTION_OPTIONS} style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }} />
        </Form.Item>
      </Form>
    </Modal>
  )
}

export function ScraperPage() {
  const [sourceModalOpen, setSourceModalOpen] = useState(false)
  const [editSource, setEditSource] = useState<any | null>(null)
  const qc = useQueryClient()

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
    onError: () => message.error('حدث خطأ'),
  })

  const { mutate: launchScraping, isPending: launching } = useMutation({
    mutationFn: async (sourceId: string) => {
      await apiClient.post(`/admin/scraper/sources/${sourceId}/scrape`)
    },
    onSuccess: () => {
      message.success('تم بدء الاستخراج')
      qc.invalidateQueries({ queryKey: ['scraper-jobs'] })
    },
    onError: () => message.error('حدث خطأ'),
  })

  const { mutate: cancelJob } = useMutation({
    mutationFn: async (jobId: string) => {
      await apiClient.post(`/admin/scraper/jobs/${jobId}/cancel`)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scraper-jobs'] }),
    onError: () => message.error('حدث خطأ'),
  })

  const sourcesColumns = [
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>المصدر</span>,
      dataIndex: 'name_ar',
      key: 'name_ar',
      render: (v: string) => (
        <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'rgba(255,255,255,0.8)', fontWeight: 500 }}>
          {v}
        </span>
      ),
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الرابط</span>,
      dataIndex: 'url',
      key: 'url',
      render: (v: string) => (
        <a href={v} target="_blank" rel="noopener noreferrer"
          style={{ fontFamily: "'Cairo', sans-serif", color: GOLD, fontSize: 12, direction: 'ltr', display: 'inline-block' }}>
          {v.length > 35 ? v.slice(0, 35) + '...' : v}
        </a>
      ),
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>المجموعة</span>,
      dataIndex: 'collection',
      key: 'collection',
      render: (v: string) => <CollectionTag collection={v} size="small" />,
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الوثائق</span>,
      dataIndex: 'docs_count',
      key: 'docs_count',
      render: (v: number) => (
        <span style={{ fontFamily: "'Cairo', sans-serif", color: 'rgba(255,255,255,0.5)' }}>
          {v?.toLocaleString() || '0'}
        </span>
      ),
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>آخر استخراج</span>,
      dataIndex: 'last_scraped_at',
      key: 'last_scraped_at',
      render: (v: string) => (
        <span style={{ fontFamily: "'Cairo', sans-serif", color: 'rgba(255,255,255,0.35)', fontSize: 12 }}>
          {v ? dayjs(v).format('DD/MM/YYYY HH:mm') : '-'}
        </span>
      ),
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>نشط</span>,
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
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الإجراءات</span>,
      key: 'actions',
      render: (_: any, record: any) => (
        <Space>
          <Tooltip title="بدء الاستخراج">
            <Button
              type="text"
              size="small"
              icon={<PlayCircleOutlined />}
              style={{ color: '#52c41a' }}
              loading={launching}
              onClick={() => launchScraping(record.id)}
            />
          </Tooltip>
          <Tooltip title="تعديل">
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              style={{ color: GOLD }}
              onClick={() => { setEditSource(record); setSourceModalOpen(true) }}
            />
          </Tooltip>
          <Popconfirm
            title={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>هل تريد حذف هذا المصدر؟</span>}
            okText={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>حذف</span>}
            cancelText={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>إلغاء</span>}
            okButtonProps={{ danger: true }}
            onConfirm={() => message.info('تم الحذف')}
          >
            <Button type="text" size="small" icon={<DeleteOutlined />} danger />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const jobsColumns = [
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>النوع</span>,
      dataIndex: 'type',
      key: 'type',
      render: (v: string) => (
        <span style={{ fontFamily: "'Cairo', sans-serif", color: 'rgba(255,255,255,0.6)', fontSize: 12 }}>{v}</span>
      ),
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>المصدر</span>,
      dataIndex: 'source_name_ar',
      key: 'source_name_ar',
      render: (v: string) => (
        <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'rgba(255,255,255,0.7)', fontSize: 13 }}>{v}</span>
      ),
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الحالة</span>,
      dataIndex: 'status',
      key: 'status',
      render: (v: string) => {
        const cfg = JOB_STATUS_CONFIG[v] || { color: '#8c8c8c', label: v }
        return (
          <Tag style={{ background: `${cfg.color}20`, border: `1px solid ${cfg.color}40`, color: cfg.color, borderRadius: 12, fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>
            {cfg.label}
          </Tag>
        )
      },
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>التقدم</span>,
      dataIndex: 'progress',
      key: 'progress',
      render: (v: number, r: any) => (
        <Progress
          percent={v}
          size="small"
          strokeColor={JOB_STATUS_CONFIG[r.status]?.color || GOLD}
          trailColor="rgba(255,255,255,0.08)"
          style={{ minWidth: 100 }}
        />
      ),
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>وقت البدء</span>,
      dataIndex: 'created_at',
      key: 'created_at',
      render: (v: string) => (
        <span style={{ fontFamily: "'Cairo', sans-serif", color: 'rgba(255,255,255,0.35)', fontSize: 12 }}>
          {dayjs(v).format('HH:mm DD/MM')}
        </span>
      ),
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الإجراءات</span>,
      key: 'actions',
      render: (_: any, record: any) => (
        record.status === 'running' ? (
          <Popconfirm
            title={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>هل تريد إلغاء هذه المهمة؟</span>}
            onConfirm={() => cancelJob(record.id)}
            okText={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>إلغاء المهمة</span>}
            cancelText={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>إغلاق</span>}
            okButtonProps={{ danger: true }}
          >
            <Button type="text" size="small" icon={<StopOutlined />} danger style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>
              إيقاف
            </Button>
          </Popconfirm>
        ) : null
      ),
    },
  ]

  const tabItems = [
    {
      key: 'sources',
      label: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>المصادر</span>,
      children: (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => { setEditSource(null); setSourceModalOpen(true) }}
              style={{ background: GOLD, borderColor: GOLD, color: '#000', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}
            >
              إضافة مصدر
            </Button>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => qc.invalidateQueries({ queryKey: ['scraper-sources'] })}
              style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}
            >
              تحديث
            </Button>
          </div>
          <Table
            dataSource={sources || MOCK_SOURCES}
            columns={sourcesColumns}
            rowKey="id"
            loading={sourcesLoading}
            pagination={{ pageSize: 15 }}
            style={{ direction: 'rtl' }}
          />
        </div>
      ),
    },
    {
      key: 'jobs',
      label: (
        <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>
          المهام
          {jobs?.filter((j: any) => j.status === 'running').length > 0 && (
            <Badge
              count={jobs.filter((j: any) => j.status === 'running').length}
              style={{ marginRight: 8, background: '#1677ff' }}
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
              style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}
            >
              تحديث
            </Button>
          </div>
          <Table
            dataSource={jobs || MOCK_JOBS}
            columns={jobsColumns}
            rowKey="id"
            loading={jobsLoading}
            pagination={{ pageSize: 20 }}
            style={{ direction: 'rtl' }}
          />
        </div>
      ),
    },
  ]

  return (
    <div style={{ direction: 'rtl' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <CloudDownloadOutlined style={{ fontSize: 22, color: GOLD }} />
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'rgba(255,255,255,0.9)', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", margin: 0 }}>
          استخراج البيانات
        </h1>
      </div>

      <Tabs items={tabItems} style={{ direction: 'rtl' }} />

      <SourceModal
        open={sourceModalOpen}
        editSource={editSource}
        onClose={() => { setSourceModalOpen(false); setEditSource(null) }}
      />
    </div>
  )
}
