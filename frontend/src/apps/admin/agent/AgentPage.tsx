import React, { useState } from 'react'
import {
  Tabs,
  Card,
  Button,
  Switch,
  Table,
  Tag,
  Modal,
  Form,
  Input,
  Select,
  Slider,
  Space,
  message,
  Tooltip,
  Badge,
  Radio,
  InputNumber,
} from 'antd'
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  ApiOutlined,
  ThunderboltOutlined,
  RobotOutlined,
  PlayCircleOutlined,
  HeartOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import apiClient from '../../../shared/api/client'
import { GOLD, DARK_CARD, BORDER_COLOR, NAVY } from '../../../shared/constants'

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
]

const MOCK_SKILLS = [
  { id: '1', name: 'legal_qa', name_ar: 'الاستشارة القانونية', name_fr: 'Consultation Juridique', is_active: true, is_default: true, applicable_collections: ['legal_laws', 'judgments_civil'], system_prompt: 'أنت مساعد قانوني متخصص في القانون المغربي...' },
  { id: '2', name: 'document_summary', name_ar: 'تلخيص الوثائق', name_fr: 'Résumé de Documents', is_active: true, is_default: false, applicable_collections: ['legal_laws'], system_prompt: 'قم بتلخيص الوثيقة القانونية بشكل موجز...' },
  { id: '3', name: 'case_analysis', name_ar: 'تحليل القضايا', name_fr: 'Analyse de Cas', is_active: false, is_default: false, applicable_collections: ['judgments_commercial', 'judgments_civil'], system_prompt: 'حلّل القضية القانونية المقدمة...' },
]

const MOCK_TOOLS = [
  { id: '1', name: 'search_laws', name_ar: 'البحث في القوانين', name_fr: 'Recherche Légale', is_active: true, requires_subscription: false, timeout_ms: 5000 },
  { id: '2', name: 'get_article', name_ar: 'استرجاع مادة قانونية', name_fr: 'Récupérer Article', is_active: true, requires_subscription: true, timeout_ms: 3000 },
  { id: '3', name: 'translate_text', name_ar: 'ترجمة النص', name_fr: 'Traduction', is_active: false, requires_subscription: true, timeout_ms: 10000 },
]

const MOCK_MCP_SERVERS = [
  { id: '1', name_ar: 'خادم البحث', endpoint_url: 'http://localhost:3001/mcp', transport_type: 'http', health_status: 'healthy', tools_count: 5 },
  { id: '2', name_ar: 'خادم الأرشيف', endpoint_url: 'ws://localhost:3002/mcp', transport_type: 'websocket', health_status: 'degraded', tools_count: 3 },
  { id: '3', name_ar: 'خادم التحقق', endpoint_url: 'http://localhost:3003/mcp', transport_type: 'http', health_status: 'unhealthy', tools_count: 0 },
]

const MOCK_AGENT_CONFIG = {
  model: 'mistral-large-latest',
  temperature: 0.3,
  max_tokens: 4096,
  active_skills: ['1'],
  active_tools: ['1', '2'],
  active_mcp_servers: ['1'],
}

const HEALTH_CONFIG: Record<string, { color: string; label: string; icon: React.ReactNode }> = {
  healthy: { color: '#52c41a', label: 'سليم', icon: <CheckCircleOutlined /> },
  degraded: { color: '#fa8c16', label: 'متدهور', icon: <ExclamationCircleOutlined /> },
  unhealthy: { color: '#f5222d', label: 'غير سليم', icon: <ExclamationCircleOutlined /> },
  unknown: { color: '#8c8c8c', label: 'غير معروف', icon: <ExclamationCircleOutlined /> },
}

function SkillModal({
  open,
  editSkill,
  onClose,
}: {
  open: boolean
  editSkill: any | null
  onClose: () => void
}) {
  const [form] = Form.useForm()
  const qc = useQueryClient()

  React.useEffect(() => {
    if (editSkill) form.setFieldsValue(editSkill)
    else form.resetFields()
  }, [editSkill, form])

  const { mutate: save, isPending } = useMutation({
    mutationFn: async (values: any) => {
      if (editSkill) await apiClient.put(`/admin/agent/skills/${editSkill.id}`, values)
      else await apiClient.post('/admin/agent/skills', values)
    },
    onSuccess: () => {
      message.success(editSkill ? 'تم تحديث المهارة' : 'تم إضافة المهارة')
      qc.invalidateQueries({ queryKey: ['agent-skills'] })
      onClose()
    },
    onError: () => message.error('حدث خطأ'),
  })

  return (
    <Modal
      title={
        <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'rgba(255,255,255,0.9)' }}>
          {editSkill ? 'تعديل المهارة' : 'إضافة مهارة جديدة'}
        </span>
      }
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>حفظ</span>}
      cancelText={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>إلغاء</span>}
      okButtonProps={{ loading: isPending, style: { background: GOLD, borderColor: GOLD, color: '#000' } }}
      centered
      width={600}
    >
      <Form form={form} layout="vertical" onFinish={(v) => save(v)} style={{ direction: 'rtl', marginTop: 16 }}>
        <Form.Item name="name_ar" label={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الاسم بالعربية</span>} rules={[{ required: true }]}>
          <Input style={{ direction: 'rtl', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }} />
        </Form.Item>
        <Form.Item name="name_fr" label={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الاسم بالفرنسية</span>}>
          <Input style={{ fontFamily: "'Cairo', sans-serif" }} />
        </Form.Item>
        <Form.Item name="applicable_collections" label={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>المجموعات المطبقة</span>}>
          <Select mode="multiple" options={COLLECTION_OPTIONS} style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }} />
        </Form.Item>
        <Form.Item name="is_default" label={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>المهارة الافتراضية</span>}>
          <Radio.Group>
            <Radio value={true} style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'rgba(255,255,255,0.7)' }}>نعم</Radio>
            <Radio value={false} style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'rgba(255,255,255,0.7)' }}>لا</Radio>
          </Radio.Group>
        </Form.Item>
        <Form.Item name="system_prompt" label={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الرسالة النظامية (System Prompt)</span>} rules={[{ required: true }]}>
          <TextArea rows={6} style={{ direction: 'rtl', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }} placeholder="أنت مساعد قانوني متخصص في القانون المغربي..." />
        </Form.Item>
      </Form>
    </Modal>
  )
}

function ToolModal({
  open,
  editTool,
  onClose,
}: {
  open: boolean
  editTool: any | null
  onClose: () => void
}) {
  const [form] = Form.useForm()
  const [testInput, setTestInput] = useState('')
  const [testResult, setTestResult] = useState('')
  const [testing, setTesting] = useState(false)
  const qc = useQueryClient()

  React.useEffect(() => {
    if (editTool) form.setFieldsValue({ ...editTool, function_schema: JSON.stringify(editTool.function_schema || {}, null, 2) })
    else form.resetFields()
    setTestResult('')
    setTestInput('')
  }, [editTool, form])

  const { mutate: save, isPending } = useMutation({
    mutationFn: async (values: any) => {
      const payload = { ...values, function_schema: JSON.parse(values.function_schema || '{}') }
      if (editTool) await apiClient.put(`/admin/agent/tools/${editTool.id}`, payload)
      else await apiClient.post('/admin/agent/tools', payload)
    },
    onSuccess: () => {
      message.success(editTool ? 'تم تحديث الأداة' : 'تم إضافة الأداة')
      qc.invalidateQueries({ queryKey: ['agent-tools'] })
      onClose()
    },
    onError: () => message.error('حدث خطأ'),
  })

  const handleTest = async () => {
    if (!editTool) return
    setTesting(true)
    try {
      const args = JSON.parse(testInput || '{}')
      const res = await apiClient.post(`/admin/agent/tools/${editTool.id}/test`, { args })
      setTestResult(JSON.stringify(res.data, null, 2))
    } catch (e: any) {
      setTestResult(e.message || 'خطأ في الاختبار')
    } finally {
      setTesting(false)
    }
  }

  return (
    <Modal
      title={
        <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'rgba(255,255,255,0.9)' }}>
          {editTool ? 'تعديل الأداة' : 'إضافة أداة جديدة'}
        </span>
      }
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>حفظ</span>}
      cancelText={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>إلغاء</span>}
      okButtonProps={{ loading: isPending, style: { background: GOLD, borderColor: GOLD, color: '#000' } }}
      centered
      width={680}
    >
      <Form form={form} layout="vertical" onFinish={(v) => save(v)} style={{ direction: 'rtl', marginTop: 16 }}>
        <Form.Item name="name" label={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>المعرّف (name)</span>} rules={[{ required: true }]}>
          <Input style={{ fontFamily: "'Cairo', sans-serif", direction: 'ltr' }} placeholder="search_laws" />
        </Form.Item>
        <Form.Item name="name_ar" label={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الاسم بالعربية</span>} rules={[{ required: true }]}>
          <Input style={{ direction: 'rtl', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }} />
        </Form.Item>
        <Form.Item name="name_fr" label={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الاسم بالفرنسية</span>}>
          <Input style={{ fontFamily: "'Cairo', sans-serif" }} />
        </Form.Item>
        <Form.Item name="timeout_ms" label={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>مهلة الانتظار (ms)</span>} initialValue={5000}>
          <InputNumber min={100} max={60000} step={500} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="function_schema" label={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>مخطط الدالة (JSON)</span>}>
          <TextArea rows={4} style={{ fontFamily: 'monospace', direction: 'ltr', fontSize: 12 }} placeholder='{"type": "object", "properties": {...}}' />
        </Form.Item>
        <Form.Item name="implementation_code" label={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>كود التنفيذ</span>}>
          <TextArea rows={5} style={{ fontFamily: 'monospace', direction: 'ltr', fontSize: 12 }} placeholder="async def execute(args): ..." />
        </Form.Item>

        {editTool && (
          <div style={{ border: `1px solid ${BORDER_COLOR}`, borderRadius: 8, padding: 12, marginBottom: 16 }}>
            <div style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'rgba(255,255,255,0.6)', fontSize: 13, marginBottom: 8 }}>
              اختبار الأداة
            </div>
            <TextArea
              value={testInput}
              onChange={(e) => setTestInput(e.target.value)}
              placeholder='{"query": "قانون الشركات"}'
              rows={2}
              style={{ fontFamily: 'monospace', direction: 'ltr', fontSize: 12, marginBottom: 8 }}
            />
            <Button
              size="small"
              icon={<PlayCircleOutlined />}
              onClick={handleTest}
              loading={testing}
              style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", marginBottom: 8 }}
            >
              اختبار
            </Button>
            {testResult && (
              <pre style={{ background: 'rgba(0,0,0,0.3)', padding: 8, borderRadius: 6, fontSize: 11, color: '#52c41a', direction: 'ltr', overflow: 'auto', maxHeight: 120 }}>
                {testResult}
              </pre>
            )}
          </div>
        )}
      </Form>
    </Modal>
  )
}

function McpModal({
  open,
  editServer,
  onClose,
}: {
  open: boolean
  editServer: any | null
  onClose: () => void
}) {
  const [form] = Form.useForm()
  const qc = useQueryClient()

  React.useEffect(() => {
    if (editServer) form.setFieldsValue(editServer)
    else form.resetFields()
  }, [editServer, form])

  const { mutate: save, isPending } = useMutation({
    mutationFn: async (values: any) => {
      if (editServer) await apiClient.put(`/admin/agent/mcp/${editServer.id}`, values)
      else await apiClient.post('/admin/agent/mcp', values)
    },
    onSuccess: () => {
      message.success('تم الحفظ')
      qc.invalidateQueries({ queryKey: ['agent-mcp'] })
      onClose()
    },
    onError: () => message.error('حدث خطأ'),
  })

  return (
    <Modal
      title={
        <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'rgba(255,255,255,0.9)' }}>
          {editServer ? 'تعديل خادم MCP' : 'إضافة خادم MCP'}
        </span>
      }
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>حفظ</span>}
      cancelText={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>إلغاء</span>}
      okButtonProps={{ loading: isPending, style: { background: GOLD, borderColor: GOLD, color: '#000' } }}
      centered
      width={520}
    >
      <Form form={form} layout="vertical" onFinish={(v) => save(v)} style={{ direction: 'rtl', marginTop: 16 }}>
        <Form.Item name="name_ar" label={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>اسم الخادم</span>} rules={[{ required: true }]}>
          <Input style={{ direction: 'rtl', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }} />
        </Form.Item>
        <Form.Item name="endpoint_url" label={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>رابط الخادم</span>} rules={[{ required: true }]}>
          <Input style={{ fontFamily: "'Cairo', sans-serif", direction: 'ltr' }} placeholder="http://localhost:3001/mcp" />
        </Form.Item>
        <Form.Item name="transport_type" label={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>نوع النقل</span>} initialValue="http">
          <Select options={[
            { value: 'http', label: 'HTTP' },
            { value: 'websocket', label: 'WebSocket' },
            { value: 'stdio', label: 'stdio' },
          ]} />
        </Form.Item>
      </Form>
    </Modal>
  )
}

export function AgentPage() {
  const [skillModalOpen, setSkillModalOpen] = useState(false)
  const [editSkill, setEditSkill] = useState<any | null>(null)
  const [toolModalOpen, setToolModalOpen] = useState(false)
  const [editTool, setEditTool] = useState<any | null>(null)
  const [mcpModalOpen, setMcpModalOpen] = useState(false)
  const [editServer, setEditServer] = useState<any | null>(null)
  const [agentConfig, setAgentConfig] = useState(MOCK_AGENT_CONFIG)
  const [savingConfig, setSavingConfig] = useState(false)
  const qc = useQueryClient()

  const { data: skills } = useQuery({
    queryKey: ['agent-skills'],
    queryFn: async () => {
      try { return (await apiClient.get('/admin/agent/skills')).data } catch { return MOCK_SKILLS }
    },
  })

  const { data: tools } = useQuery({
    queryKey: ['agent-tools'],
    queryFn: async () => {
      try { return (await apiClient.get('/admin/agent/tools')).data } catch { return MOCK_TOOLS }
    },
  })

  const { data: mcpServers } = useQuery({
    queryKey: ['agent-mcp'],
    queryFn: async () => {
      try { return (await apiClient.get('/admin/agent/mcp')).data } catch { return MOCK_MCP_SERVERS }
    },
  })

  const { mutate: toggleSkill } = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      await apiClient.patch(`/admin/agent/skills/${id}`, { is_active: active })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent-skills'] }),
    onError: () => message.error('حدث خطأ'),
  })

  const { mutate: toggleTool } = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      await apiClient.patch(`/admin/agent/tools/${id}`, { is_active: active })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent-tools'] }),
    onError: () => message.error('حدث خطأ'),
  })

  const { mutate: pingMcp } = useMutation({
    mutationFn: async (id: string) => {
      return (await apiClient.post(`/admin/agent/mcp/${id}/ping`)).data
    },
    onSuccess: (data) => {
      message.success(`الخادم ${data.healthy ? 'سليم' : 'غير متاح'}`)
      qc.invalidateQueries({ queryKey: ['agent-mcp'] })
    },
    onError: () => message.error('تعذّر الاتصال'),
  })

  const { mutate: discoverTools } = useMutation({
    mutationFn: async (id: string) => {
      return (await apiClient.post(`/admin/agent/mcp/${id}/discover`)).data
    },
    onSuccess: (data) => {
      message.success(`تم اكتشاف ${data.tools_count} أداة`)
      qc.invalidateQueries({ queryKey: ['agent-mcp'] })
    },
    onError: () => message.error('حدث خطأ'),
  })

  const handleSaveConfig = async () => {
    setSavingConfig(true)
    try {
      await apiClient.put('/admin/agent/config', agentConfig)
      message.success('تم حفظ الإعدادات')
    } catch {
      message.error('حدث خطأ')
    } finally {
      setSavingConfig(false)
    }
  }

  const skillsColumns = [
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الاسم</span>,
      dataIndex: 'name_ar',
      render: (v: string, r: any) => (
        <div>
          <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'rgba(255,255,255,0.85)', fontSize: 13 }}>{v}</span>
          {r.is_default && <Tag style={{ marginRight: 8, background: `${GOLD}20`, color: GOLD, border: `1px solid ${GOLD}40`, fontSize: 10 }}>افتراضي</Tag>}
        </div>
      ),
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>بالفرنسية</span>,
      dataIndex: 'name_fr',
      render: (v: string) => <span style={{ fontFamily: "'Cairo', sans-serif", color: 'rgba(255,255,255,0.4)', fontSize: 12 }}>{v}</span>,
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>مفعّل</span>,
      dataIndex: 'is_active',
      render: (v: boolean, r: any) => (
        <Switch checked={v} onChange={(c) => toggleSkill({ id: r.id, active: c })} style={{ background: v ? GOLD : undefined }} />
      ),
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>إجراءات</span>,
      render: (_: any, r: any) => (
        <Space>
          <Button type="text" size="small" icon={<EditOutlined />} style={{ color: GOLD }} onClick={() => { setEditSkill(r); setSkillModalOpen(true) }} />
          <Button type="text" size="small" icon={<DeleteOutlined />} danger />
        </Space>
      ),
    },
  ]

  const toolsColumns = [
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الاسم</span>,
      dataIndex: 'name_ar',
      render: (v: string, r: any) => (
        <div>
          <div style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'rgba(255,255,255,0.85)', fontSize: 13 }}>{v}</div>
          <div style={{ fontFamily: "'Cairo', sans-serif", color: 'rgba(255,255,255,0.3)', fontSize: 11 }}>{r.name}</div>
        </div>
      ),
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>يتطلب اشتراك</span>,
      dataIndex: 'requires_subscription',
      render: (v: boolean) => (
        <Tag style={{ background: v ? 'rgba(201,168,76,0.15)' : 'rgba(255,255,255,0.05)', color: v ? GOLD : 'rgba(255,255,255,0.3)', border: 'none', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>
          {v ? 'نعم' : 'لا'}
        </Tag>
      ),
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>المهلة</span>,
      dataIndex: 'timeout_ms',
      render: (v: number) => <span style={{ fontFamily: "'Cairo', sans-serif", color: 'rgba(255,255,255,0.4)', fontSize: 12 }}>{v}ms</span>,
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>مفعّل</span>,
      dataIndex: 'is_active',
      render: (v: boolean, r: any) => (
        <Switch checked={v} onChange={(c) => toggleTool({ id: r.id, active: c })} style={{ background: v ? GOLD : undefined }} />
      ),
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>إجراءات</span>,
      render: (_: any, r: any) => (
        <Space>
          <Button type="text" size="small" icon={<EditOutlined />} style={{ color: GOLD }} onClick={() => { setEditTool(r); setToolModalOpen(true) }} />
          <Button type="text" size="small" icon={<DeleteOutlined />} danger />
        </Space>
      ),
    },
  ]

  const mcpColumns = [
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الخادم</span>,
      dataIndex: 'name_ar',
      render: (v: string) => <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'rgba(255,255,255,0.85)', fontSize: 13 }}>{v}</span>,
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الرابط</span>,
      dataIndex: 'endpoint_url',
      render: (v: string) => <span style={{ fontFamily: "'Cairo', sans-serif", color: 'rgba(255,255,255,0.4)', fontSize: 11, direction: 'ltr', display: 'inline-block' }}>{v}</span>,
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>النقل</span>,
      dataIndex: 'transport_type',
      render: (v: string) => <Tag style={{ fontFamily: "'Cairo', sans-serif", fontSize: 11 }}>{v}</Tag>,
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الأدوات</span>,
      dataIndex: 'tools_count',
      render: (v: number) => <span style={{ fontFamily: "'Cairo', sans-serif", color: 'rgba(255,255,255,0.4)' }}>{v || 0}</span>,
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الحالة</span>,
      dataIndex: 'health_status',
      render: (v: string) => {
        const cfg = HEALTH_CONFIG[v] || HEALTH_CONFIG.unknown
        return (
          <Tag style={{ background: `${cfg.color}20`, border: `1px solid ${cfg.color}40`, color: cfg.color, borderRadius: 12, fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", display: 'flex', alignItems: 'center', gap: 4, width: 'fit-content' }}>
            {cfg.icon} {cfg.label}
          </Tag>
        )
      },
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>إجراءات</span>,
      render: (_: any, r: any) => (
        <Space>
          <Tooltip title="فحص الصحة">
            <Button type="text" size="small" icon={<HeartOutlined />} style={{ color: '#52c41a' }} onClick={() => pingMcp(r.id)} />
          </Tooltip>
          <Tooltip title="اكتشاف الأدوات">
            <Button type="text" size="small" icon={<ThunderboltOutlined />} style={{ color: '#1677ff' }} onClick={() => discoverTools(r.id)} />
          </Tooltip>
          <Button type="text" size="small" icon={<EditOutlined />} style={{ color: GOLD }} onClick={() => { setEditServer(r); setMcpModalOpen(true) }} />
          <Button type="text" size="small" icon={<DeleteOutlined />} danger />
        </Space>
      ),
    },
  ]

  const tabItems = [
    {
      key: 'skills',
      label: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>المهارات</span>,
      children: (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditSkill(null); setSkillModalOpen(true) }} style={{ background: GOLD, borderColor: GOLD, color: '#000', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>
              إضافة مهارة
            </Button>
          </div>
          <Table dataSource={skills || MOCK_SKILLS} columns={skillsColumns} rowKey="id" pagination={{ pageSize: 10 }} style={{ direction: 'rtl' }} />
        </div>
      ),
    },
    {
      key: 'tools',
      label: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الأدوات</span>,
      children: (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditTool(null); setToolModalOpen(true) }} style={{ background: GOLD, borderColor: GOLD, color: '#000', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>
              إضافة أداة
            </Button>
          </div>
          <Table dataSource={tools || MOCK_TOOLS} columns={toolsColumns} rowKey="id" pagination={{ pageSize: 10 }} style={{ direction: 'rtl' }} />
        </div>
      ),
    },
    {
      key: 'mcp',
      label: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>خوادم MCP</span>,
      children: (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditServer(null); setMcpModalOpen(true) }} style={{ background: GOLD, borderColor: GOLD, color: '#000', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>
              إضافة خادم
            </Button>
          </div>
          <Table dataSource={mcpServers || MOCK_MCP_SERVERS} columns={mcpColumns} rowKey="id" pagination={{ pageSize: 10 }} style={{ direction: 'rtl' }} />
        </div>
      ),
    },
    {
      key: 'config',
      label: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>إعداد الوكيل</span>,
      children: (
        <div style={{ maxWidth: 640 }}>
          <Card style={{ background: DARK_CARD, border: `1px solid ${BORDER_COLOR}`, borderRadius: 16 }} bodyStyle={{ padding: 24 }}>
            <h3 style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'rgba(255,255,255,0.9)', marginBottom: 24 }}>
              إعدادات النموذج
            </h3>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <div>
                <div style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'rgba(255,255,255,0.6)', fontSize: 13, marginBottom: 8 }}>النموذج</div>
                <Select
                  value={agentConfig.model}
                  onChange={(v) => setAgentConfig({ ...agentConfig, model: v })}
                  style={{ width: '100%' }}
                  options={[
                    { value: 'mistral-large-latest', label: 'Mistral Large (Latest)' },
                    { value: 'mistral-medium-latest', label: 'Mistral Medium (Latest)' },
                    { value: 'gpt-4o', label: 'GPT-4o' },
                    { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
                  ]}
                />
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'rgba(255,255,255,0.6)', fontSize: 13 }}>درجة الإبداعية (Temperature)</span>
                  <span style={{ fontFamily: "'Cairo', sans-serif", color: GOLD, fontSize: 13 }}>{agentConfig.temperature}</span>
                </div>
                <Slider
                  min={0}
                  max={1}
                  step={0.05}
                  value={agentConfig.temperature}
                  onChange={(v) => setAgentConfig({ ...agentConfig, temperature: v })}
                  styles={{ track: { background: GOLD }, handle: { borderColor: GOLD } }}
                />
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'rgba(255,255,255,0.6)', fontSize: 13 }}>الحد الأقصى للرموز (Max Tokens)</span>
                  <span style={{ fontFamily: "'Cairo', sans-serif", color: GOLD, fontSize: 13 }}>{agentConfig.max_tokens}</span>
                </div>
                <Slider
                  min={512}
                  max={16384}
                  step={512}
                  value={agentConfig.max_tokens}
                  onChange={(v) => setAgentConfig({ ...agentConfig, max_tokens: v })}
                  styles={{ track: { background: GOLD }, handle: { borderColor: GOLD } }}
                />
              </div>

              <div>
                <div style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'rgba(255,255,255,0.6)', fontSize: 13, marginBottom: 8 }}>المهارات النشطة</div>
                <Select
                  mode="multiple"
                  value={agentConfig.active_skills}
                  onChange={(v) => setAgentConfig({ ...agentConfig, active_skills: v })}
                  style={{ width: '100%' }}
                  options={(skills || MOCK_SKILLS).map((s: any) => ({ value: s.id, label: s.name_ar }))}
                />
              </div>

              <div>
                <div style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'rgba(255,255,255,0.6)', fontSize: 13, marginBottom: 8 }}>الأدوات النشطة</div>
                <Select
                  mode="multiple"
                  value={agentConfig.active_tools}
                  onChange={(v) => setAgentConfig({ ...agentConfig, active_tools: v })}
                  style={{ width: '100%' }}
                  options={(tools || MOCK_TOOLS).map((t: any) => ({ value: t.id, label: t.name_ar }))}
                />
              </div>

              <div>
                <div style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'rgba(255,255,255,0.6)', fontSize: 13, marginBottom: 8 }}>خوادم MCP النشطة</div>
                <Select
                  mode="multiple"
                  value={agentConfig.active_mcp_servers}
                  onChange={(v) => setAgentConfig({ ...agentConfig, active_mcp_servers: v })}
                  style={{ width: '100%' }}
                  options={(mcpServers || MOCK_MCP_SERVERS).map((m: any) => ({ value: m.id, label: m.name_ar }))}
                />
              </div>

              <Button
                type="primary"
                onClick={handleSaveConfig}
                loading={savingConfig}
                style={{ background: GOLD, borderColor: GOLD, color: '#000', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", fontWeight: 600, height: 44 }}
              >
                حفظ الإعدادات
              </Button>
            </div>
          </Card>
        </div>
      ),
    },
  ]

  return (
    <div style={{ direction: 'rtl' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <RobotOutlined style={{ fontSize: 22, color: GOLD }} />
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'rgba(255,255,255,0.9)', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", margin: 0 }}>
          إعداد الوكيل
        </h1>
      </div>

      <Tabs items={tabItems} style={{ direction: 'rtl' }} />

      <SkillModal open={skillModalOpen} editSkill={editSkill} onClose={() => { setSkillModalOpen(false); setEditSkill(null) }} />
      <ToolModal open={toolModalOpen} editTool={editTool} onClose={() => { setToolModalOpen(false); setEditTool(null) }} />
      <McpModal open={mcpModalOpen} editServer={editServer} onClose={() => { setMcpModalOpen(false); setEditServer(null) }} />
    </div>
  )
}
