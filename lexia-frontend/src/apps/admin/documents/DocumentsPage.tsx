import React, { useState } from 'react'
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
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import apiClient from '../../../shared/api/client'
import { CollectionTag } from '../../../shared/components/CollectionTag'
import { GOLD, DARK_CARD, BORDER_COLOR, NAVY } from '../../../shared/constants'
import dayjs from 'dayjs'
import { DocumentViewer } from './DocumentViewer'

const { Dragger } = Upload
const { TextArea } = Input

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
  { value: 'user_documents', label: 'وثائق المستخدم' },
]

const STATUS_CONFIG: Record<string, { color: string; label: string }> = {
  processing: { color: '#1677ff', label: 'قيد المعالجة' },
  pending_review: { color: '#fa8c16', label: 'في انتظار المراجعة' },
  published: { color: '#52c41a', label: 'منشور' },
  rejected: { color: '#f5222d', label: 'مرفوض' },
  archived: { color: '#8c8c8c', label: 'مؤرشف' },
}

const PROCESSING_STEPS = [
  { title: 'رفع الملف', description: 'تحميل الوثيقة' },
  { title: 'استخراج النص', description: 'قراءة محتوى PDF' },
  { title: 'التصنيف', description: 'تحديد المجموعة' },
  { title: 'التقطيع', description: 'تقسيم إلى أجزاء' },
  { title: 'التضمين', description: 'إنشاء المتجهات' },
  { title: 'الفهرسة', description: 'حفظ في قاعدة البيانات' },
]

const MOCK_DOCUMENTS = [
  { id: '1', title_ar: 'القانون التجاري المغربي', collection: 'judgments_commercial', status: 'published', owner_type: 'system', created_at: '2024-01-15T10:00:00Z' },
  { id: '2', title_ar: 'مدونة الشغل - المستجدات', collection: 'legal_laws', status: 'pending_review', owner_type: 'admin', created_at: '2024-02-10T09:00:00Z' },
  { id: '3', title_ar: 'أحكام محكمة النقض 2023', collection: 'judgments_civil', status: 'processing', owner_type: 'system', created_at: '2024-03-01T14:00:00Z' },
  { id: '4', title_ar: 'قانون العقوبات - الطبعة الجديدة', collection: 'judgments_criminal', status: 'published', owner_type: 'system', created_at: '2024-01-20T11:00:00Z' },
  { id: '5', title_ar: 'مدونة الأسرة المحدثة', collection: 'judgments_family', status: 'rejected', owner_type: 'admin', created_at: '2024-02-05T16:00:00Z' },
]

function UploadModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form] = Form.useForm()
  const [currentStep, setCurrentStep] = useState(-1)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const qc = useQueryClient()

  const handleUpload = async (values: any) => {
    if (!values.file) {
      message.error('يرجى اختيار ملف PDF')
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

      for (let i = 0; i < PROCESSING_STEPS.length; i++) {
        setCurrentStep(i)
        setProgress(((i + 1) / PROCESSING_STEPS.length) * 100)
        await new Promise((r) => setTimeout(r, 600))
      }

      await apiClient.post('/admin/documents/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })

      message.success('تم رفع الوثيقة بنجاح')
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
      title={
        <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'var(--color-text-primary)' }}>
          رفع وثيقة جديدة
        </span>
      }
      open={open}
      onCancel={onClose}
      footer={null}
      width={580}
      centered
      styles={{ body: { direction: 'rtl', padding: '20px 0 0' } }}
    >
      <Form form={form} layout="vertical" onFinish={handleUpload} style={{ direction: 'rtl' }}>
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
            <p
              className="ant-upload-text"
              style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'var(--color-text-secondary)' }}
            >
              اسحب ملف PDF هنا أو انقر للاختيار
            </p>
            <p
              className="ant-upload-hint"
              style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'var(--color-text-quaternary)' }}
            >
              الحد الأقصى: 200 ميغابايت
            </p>
          </Dragger>
        </Form.Item>

        <Form.Item
          name="title_ar"
          label={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'var(--color-text-secondary)' }}>العنوان بالعربية (اختياري - يُصنَّف تلقائياً)</span>}
        >
          <Input
            placeholder="سيتم التصنيف التلقائي إذا تُرك فارغاً"
            style={{ direction: 'rtl', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}
          />
        </Form.Item>

        <Form.Item
          name="collection"
          label={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'var(--color-text-secondary)' }}>المجموعة</span>}
          rules={[{ required: true, message: 'يرجى اختيار المجموعة' }]}
        >
          <Select
            options={COLLECTION_OPTIONS}
            placeholder="اختر المجموعة"
            style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}
          />
        </Form.Item>

        <Form.Item
          name="visibility"
          label={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'var(--color-text-secondary)' }}>إمكانية الوصول</span>}
          initialValue="public"
        >
          <Select
            options={[
              { value: 'private', label: 'خاص' },
              { value: 'pro_only', label: 'للمشتركين فقط' },
              { value: 'public', label: 'عام' },
            ]}
          />
        </Form.Item>

        {currentStep >= 0 && (
          <div style={{ marginBottom: 20 }}>
            <Steps
              current={currentStep}
              size="small"
              direction="vertical"
              items={PROCESSING_STEPS.map((s, i) => ({
                title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", fontSize: 13 }}>{s.title}</span>,
                description: (
                  <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                    {s.description}
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
            <Button onClick={onClose} style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>
              إلغاء
            </Button>
            <Button
              type="primary"
              htmlType="submit"
              loading={uploading}
              style={{ background: GOLD, borderColor: GOLD, color: '#000', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}
            >
              رفع الوثيقة
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
}: {
  open: boolean
  docId: string | null
  onClose: () => void
}) {
  const [reason, setReason] = useState('')
  const qc = useQueryClient()

  const { mutate: reject, isPending } = useMutation({
    mutationFn: async () => {
      await apiClient.post(`/admin/documents/${docId}/reject`, { reason })
    },
    onSuccess: () => {
      message.success('تم رفض الوثيقة')
      qc.invalidateQueries({ queryKey: ['documents'] })
      onClose()
      setReason('')
    },
    onError: () => message.error('حدث خطأ'),
  })

  return (
    <Modal
      title={
        <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>سبب الرفض</span>
      }
      open={open}
      onCancel={onClose}
      onOk={() => reject()}
      okText={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>تأكيد الرفض</span>}
      cancelText={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>إلغاء</span>}
      okButtonProps={{ danger: true, loading: isPending }}
      centered
    >
      <TextArea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="اكتب سبب الرفض هنا..."
        rows={4}
        style={{ direction: 'rtl', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}
      />
    </Modal>
  )
}

export function DocumentsPage() {
  const [uploadOpen, setUploadOpen] = useState(false)
  const [rejectDocId, setRejectDocId] = useState<string | null>(null)
  const [viewerDoc, setViewerDoc] = useState<{ id: string; filename: string } | null>(null)
  const qc = useQueryClient()

  const { data: docs, isLoading } = useQuery({
    queryKey: ['documents'],
    queryFn: async () => {
      try {
        const res = await apiClient.get('/admin/documents')
        return res.data
      } catch {
        return MOCK_DOCUMENTS
      }
    },
  })

  const { mutate: approve } = useMutation({
    mutationFn: async (id: string) => {
      await apiClient.post(`/admin/documents/${id}/approve`)
    },
    onSuccess: () => {
      message.success('تم نشر الوثيقة بنجاح')
      qc.invalidateQueries({ queryKey: ['documents'] })
    },
    onError: () => message.error('حدث خطأ'),
  })

  const allColumns = [
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>العنوان</span>,
      dataIndex: 'title_ar',
      key: 'title_ar',
      render: (v: string) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <FileTextOutlined style={{ color: GOLD }} />
          <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'var(--color-text-primary)', fontSize: 13 }}>
            {v}
          </span>
        </div>
      ),
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>المجموعة</span>,
      dataIndex: 'collection',
      key: 'collection',
      render: (v: string) => <CollectionTag collection={v} size="small" />,
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الحالة</span>,
      dataIndex: 'status',
      key: 'status',
      render: (v: string) => {
        const cfg = STATUS_CONFIG[v] || { color: '#8c8c8c', label: v }
        return (
          <Tag
            style={{
              background: `${cfg.color}20`,
              border: `1px solid ${cfg.color}40`,
              color: cfg.color,
              borderRadius: 12,
              fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
              fontSize: 12,
            }}
          >
            {cfg.label}
          </Tag>
        )
      },
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>المصدر</span>,
      dataIndex: 'owner_type',
      key: 'owner_type',
      render: (v: string) => (
        <span style={{ fontFamily: "'Cairo', sans-serif", color: 'var(--color-text-tertiary)', fontSize: 12 }}>{v}</span>
      ),
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>تاريخ الإضافة</span>,
      dataIndex: 'created_at',
      key: 'created_at',
      render: (v: string) => (
        <span style={{ fontFamily: "'Cairo', sans-serif", color: 'var(--color-text-tertiary)', fontSize: 12 }}>
          {dayjs(v).format('DD/MM/YYYY')}
        </span>
      ),
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الإجراءات</span>,
      key: 'actions',
      render: (_: any, record: any) => (
        <Space>
          <Tooltip title="عرض">
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
          <Popconfirm
            title={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>هل تريد حذف هذه الوثيقة؟</span>}
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

  const pendingColumns = [
    ...allColumns.slice(0, -1),
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الإجراءات</span>,
      key: 'actions',
      render: (_: any, record: any) => (
        <Space>
          <Button
            size="small"
            type="primary"
            icon={<CheckCircleOutlined />}
            onClick={() => approve(record.id)}
            style={{ background: '#52c41a', borderColor: '#52c41a', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}
          >
            موافقة
          </Button>
          <Button
            size="small"
            danger
            icon={<CloseCircleOutlined />}
            onClick={() => setRejectDocId(record.id)}
            style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}
          >
            رفض
          </Button>
        </Space>
      ),
    },
  ]

  const allDocs = docs || MOCK_DOCUMENTS
  const pendingDocs = allDocs.filter((d: any) => d.status === 'pending_review')

  const tabItems = [
    {
      key: 'all',
      label: (
        <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>
          جميع الوثائق
          <Badge count={allDocs.length} style={{ marginRight: 8, background: 'var(--color-border-subtle)' }} />
        </span>
      ),
      children: (
        <Table
          dataSource={allDocs}
          columns={allColumns}
          rowKey="id"
          loading={isLoading}
          pagination={{ pageSize: 15 }}
          style={{ direction: 'rtl' }}
          locale={{ emptyText: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>لا توجد وثائق</span> }}
        />
      ),
    },
    {
      key: 'pending',
      label: (
        <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>
          في انتظار المراجعة
          {pendingDocs.length > 0 && (
            <Badge count={pendingDocs.length} style={{ marginRight: 8, background: '#fa8c16' }} />
          )}
        </span>
      ),
      children: (
        <Table
          dataSource={pendingDocs}
          columns={pendingColumns}
          rowKey="id"
          loading={isLoading}
          pagination={{ pageSize: 15 }}
          style={{ direction: 'rtl' }}
          locale={{ emptyText: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>لا توجد وثائق في انتظار المراجعة</span> }}
        />
      ),
    },
  ]

  return (
    <div style={{ direction: 'rtl' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--color-text-primary)', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", margin: 0 }}>
          إدارة الوثائق
        </h1>
        <Button
          type="primary"
          icon={<UploadOutlined />}
          onClick={() => setUploadOpen(true)}
          style={{ background: GOLD, borderColor: GOLD, color: '#000', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", fontWeight: 600 }}
        >
          رفع وثيقة
        </Button>
      </div>

      <Tabs items={tabItems} style={{ direction: 'rtl' }} />

      <UploadModal open={uploadOpen} onClose={() => setUploadOpen(false)} />
      <RejectModal open={!!rejectDocId} docId={rejectDocId} onClose={() => setRejectDocId(null)} />
      <DocumentViewer
        documentId={viewerDoc?.id || null}
        filename={viewerDoc?.filename}
        onClose={() => setViewerDoc(null)}
      />
    </div>
  )
}
