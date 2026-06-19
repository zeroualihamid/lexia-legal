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
  Radio,
  InputNumber,
} from 'antd'
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  ThunderboltOutlined,
  RobotOutlined,
  PlayCircleOutlined,
  HeartOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import apiClient from '../../../shared/api/client'
import { GOLD, DARK_CARD, BORDER_COLOR } from '../../../shared/constants'
import { useAdminUi } from '../locale/useAdminI18n'

const { TextArea } = Input

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

const HEALTH_STYLE: Record<string, { color: string; icon: React.ReactNode }> = {
  healthy: { color: '#52c41a', icon: <CheckCircleOutlined /> },
  degraded: { color: '#fa8c16', icon: <ExclamationCircleOutlined /> },
  unhealthy: { color: '#f5222d', icon: <ExclamationCircleOutlined /> },
  unknown: { color: '#8c8c8c', icon: <ExclamationCircleOutlined /> },
}

function healthStatusLabel(t: ReturnType<typeof useAdminUi>['t'], status: string) {
  return t.agent.healthStatus[status as keyof typeof t.agent.healthStatus] ?? t.agent.healthStatus.unknown
}

function SkillModal({
  open,
  editSkill,
  onClose,
  ui,
}: {
  open: boolean
  editSkill: any | null
  onClose: () => void
  ui: ReturnType<typeof useAdminUi>
}) {
  const { t, font, formStyle, labelStyle, titleStyle, collectionOptions } = ui
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
      message.success(editSkill ? t.agent.skillUpdated : t.agent.skillAdded)
      qc.invalidateQueries({ queryKey: ['agent-skills'] })
      onClose()
    },
    onError: () => message.error(t.common.error),
  })

  return (
    <Modal
      title={<span style={titleStyle}>{editSkill ? t.agent.editSkill : t.agent.newSkill}</span>}
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText={<span style={{ fontFamily: font }}>{t.common.save}</span>}
      cancelText={<span style={{ fontFamily: font }}>{t.common.cancel}</span>}
      okButtonProps={{ loading: isPending, style: { background: GOLD, borderColor: GOLD, color: '#000' } }}
      centered
      width={600}
    >
      <Form form={form} layout="vertical" onFinish={(v) => save(v)} style={formStyle}>
        <Form.Item name="name_ar" label={<span style={labelStyle}>{t.agent.nameAr}</span>} rules={[{ required: true, message: t.common.required }]}>
          <Input style={{ direction: 'rtl', fontFamily: font }} />
        </Form.Item>
        <Form.Item name="name_fr" label={<span style={labelStyle}>{t.agent.nameFr}</span>}>
          <Input style={{ fontFamily: font }} />
        </Form.Item>
        <Form.Item name="applicable_collections" label={<span style={labelStyle}>{t.agent.applicableCollections}</span>}>
          <Select mode="multiple" options={collectionOptions} style={{ fontFamily: font }} />
        </Form.Item>
        <Form.Item name="is_default" label={<span style={labelStyle}>{t.agent.defaultSkill}</span>}>
          <Radio.Group>
            <Radio value={true} style={{ fontFamily: font, color: 'var(--color-text-secondary)' }}>{t.common.yes}</Radio>
            <Radio value={false} style={{ fontFamily: font, color: 'var(--color-text-secondary)' }}>{t.common.no}</Radio>
          </Radio.Group>
        </Form.Item>
        <Form.Item name="system_prompt" label={<span style={labelStyle}>{t.agent.systemPrompt}</span>} rules={[{ required: true, message: t.common.required }]}>
          <TextArea rows={6} style={{ direction: 'rtl', fontFamily: font }} placeholder={t.agent.systemPromptPlaceholder} />
        </Form.Item>
      </Form>
    </Modal>
  )
}

function ToolModal({
  open,
  editTool,
  onClose,
  ui,
}: {
  open: boolean
  editTool: any | null
  onClose: () => void
  ui: ReturnType<typeof useAdminUi>
}) {
  const { t, font, formStyle, labelStyle, titleStyle } = ui
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
      message.success(editTool ? t.agent.toolUpdated : t.agent.toolAdded)
      qc.invalidateQueries({ queryKey: ['agent-tools'] })
      onClose()
    },
    onError: () => message.error(t.common.error),
  })

  const handleTest = async () => {
    if (!editTool) return
    setTesting(true)
    try {
      const args = JSON.parse(testInput || '{}')
      const res = await apiClient.post(`/admin/agent/tools/${editTool.id}/test`, { args })
      setTestResult(JSON.stringify(res.data, null, 2))
    } catch (e: any) {
      setTestResult(e.message || t.agent.testError)
    } finally {
      setTesting(false)
    }
  }

  return (
    <Modal
      title={<span style={titleStyle}>{editTool ? t.agent.editTool : t.agent.newTool}</span>}
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText={<span style={{ fontFamily: font }}>{t.common.save}</span>}
      cancelText={<span style={{ fontFamily: font }}>{t.common.cancel}</span>}
      okButtonProps={{ loading: isPending, style: { background: GOLD, borderColor: GOLD, color: '#000' } }}
      centered
      width={680}
    >
      <Form form={form} layout="vertical" onFinish={(v) => save(v)} style={formStyle}>
        <Form.Item name="name" label={<span style={labelStyle}>{t.agent.identifier}</span>} rules={[{ required: true, message: t.common.required }]}>
          <Input style={{ fontFamily: font, direction: 'ltr' }} placeholder="search_laws" />
        </Form.Item>
        <Form.Item name="name_ar" label={<span style={labelStyle}>{t.agent.nameAr}</span>} rules={[{ required: true, message: t.common.required }]}>
          <Input style={{ direction: 'rtl', fontFamily: font }} />
        </Form.Item>
        <Form.Item name="name_fr" label={<span style={labelStyle}>{t.agent.nameFr}</span>}>
          <Input style={{ fontFamily: font }} />
        </Form.Item>
        <Form.Item name="timeout_ms" label={<span style={labelStyle}>{t.agent.timeoutMs}</span>} initialValue={5000}>
          <InputNumber min={100} max={60000} step={500} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="function_schema" label={<span style={labelStyle}>{t.agent.functionSchema}</span>}>
          <TextArea rows={4} style={{ fontFamily: 'monospace', direction: 'ltr', fontSize: 12 }} placeholder='{"type": "object", "properties": {...}}' />
        </Form.Item>
        <Form.Item name="implementation_code" label={<span style={labelStyle}>{t.agent.implementationCode}</span>}>
          <TextArea rows={5} style={{ fontFamily: 'monospace', direction: 'ltr', fontSize: 12 }} placeholder="async def execute(args): ..." />
        </Form.Item>

        {editTool && (
          <div style={{ border: `1px solid ${BORDER_COLOR}`, borderRadius: 8, padding: 12, marginBottom: 16 }}>
            <div style={{ ...labelStyle, fontSize: 13, marginBottom: 8 }}>
              {t.agent.testTool}
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
              style={{ fontFamily: font, marginBottom: 8 }}
            >
              {t.agent.testTool}
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
  ui,
}: {
  open: boolean
  editServer: any | null
  onClose: () => void
  ui: ReturnType<typeof useAdminUi>
}) {
  const { t, font, formStyle, labelStyle, titleStyle } = ui
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
      message.success(editServer ? t.agent.serverUpdated : t.agent.serverAdded)
      qc.invalidateQueries({ queryKey: ['agent-mcp'] })
      onClose()
    },
    onError: () => message.error(t.common.error),
  })

  return (
    <Modal
      title={<span style={titleStyle}>{editServer ? t.agent.editServer : t.agent.newServer}</span>}
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText={<span style={{ fontFamily: font }}>{t.common.save}</span>}
      cancelText={<span style={{ fontFamily: font }}>{t.common.cancel}</span>}
      okButtonProps={{ loading: isPending, style: { background: GOLD, borderColor: GOLD, color: '#000' } }}
      centered
      width={520}
    >
      <Form form={form} layout="vertical" onFinish={(v) => save(v)} style={formStyle}>
        <Form.Item name="name_ar" label={<span style={labelStyle}>{t.agent.server}</span>} rules={[{ required: true, message: t.common.required }]}>
          <Input style={{ direction: 'rtl', fontFamily: font }} />
        </Form.Item>
        <Form.Item name="endpoint_url" label={<span style={labelStyle}>{t.common.url}</span>} rules={[{ required: true, message: t.common.required }]}>
          <Input style={{ fontFamily: font, direction: 'ltr' }} placeholder="http://localhost:3001/mcp" />
        </Form.Item>
        <Form.Item name="transport_type" label={<span style={labelStyle}>{t.agent.transport}</span>} initialValue="http">
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
  const ui = useAdminUi()
  const { t, locale, font, dir, pageStyle, tableStyle, h1Style, labelStyle, cellStyle, mutedStyle } = ui

  const [skillModalOpen, setSkillModalOpen] = useState(false)
  const [editSkill, setEditSkill] = useState<any | null>(null)
  const [toolModalOpen, setToolModalOpen] = useState(false)
  const [editTool, setEditTool] = useState<any | null>(null)
  const [mcpModalOpen, setMcpModalOpen] = useState(false)
  const [editServer, setEditServer] = useState<any | null>(null)
  const [agentConfig, setAgentConfig] = useState(MOCK_AGENT_CONFIG)
  const [savingConfig, setSavingConfig] = useState(false)
  const qc = useQueryClient()

  const skillLabel = (item: { name_ar: string; name_fr?: string }) =>
    locale === 'fr' ? item.name_fr || item.name_ar : item.name_ar

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
    onError: () => message.error(t.common.error),
  })

  const { mutate: toggleTool } = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      await apiClient.patch(`/admin/agent/tools/${id}`, { is_active: active })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent-tools'] }),
    onError: () => message.error(t.common.error),
  })

  const { mutate: pingMcp } = useMutation({
    mutationFn: async (id: string) => {
      return (await apiClient.post(`/admin/agent/mcp/${id}/ping`)).data
    },
    onSuccess: (data) => {
      message.success(`${t.agent.server}: ${data.healthy ? t.agent.healthStatus.healthy : t.agent.healthStatus.unhealthy}`)
      qc.invalidateQueries({ queryKey: ['agent-mcp'] })
    },
    onError: () => message.error(t.common.error),
  })

  const { mutate: discoverTools } = useMutation({
    mutationFn: async (id: string) => {
      return (await apiClient.post(`/admin/agent/mcp/${id}/discover`)).data
    },
    onSuccess: (data) => {
      message.success(`${t.agent.discoverTools} (${data.tools_count})`)
      qc.invalidateQueries({ queryKey: ['agent-mcp'] })
    },
    onError: () => message.error(t.common.error),
  })

  const handleSaveConfig = async () => {
    setSavingConfig(true)
    try {
      await apiClient.put('/admin/agent/config', agentConfig)
      message.success(t.agent.settingsSaved)
    } catch {
      message.error(t.common.error)
    } finally {
      setSavingConfig(false)
    }
  }

  const skillsColumns = [
    {
      title: <span style={labelStyle}>{t.agent.nameAr}</span>,
      dataIndex: 'name_ar',
      render: (v: string, r: any) => (
        <div>
          <span style={cellStyle}>{v}</span>
          {r.is_default && (
            <Tag style={{ marginRight: 8, background: `${GOLD}20`, color: GOLD, border: `1px solid ${GOLD}40`, fontSize: 10, fontFamily: font }}>
              {t.agent.defaultSkill}
            </Tag>
          )}
        </div>
      ),
    },
    {
      title: <span style={labelStyle}>{t.agent.nameFr}</span>,
      dataIndex: 'name_fr',
      render: (v: string) => <span style={mutedStyle}>{v}</span>,
    },
    {
      title: <span style={labelStyle}>{t.agent.enabled}</span>,
      dataIndex: 'is_active',
      render: (v: boolean, r: any) => (
        <Switch checked={v} onChange={(c) => toggleSkill({ id: r.id, active: c })} style={{ background: v ? GOLD : undefined }} />
      ),
    },
    {
      title: <span style={labelStyle}>{t.common.actions}</span>,
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
      title: <span style={labelStyle}>{t.agent.nameAr}</span>,
      dataIndex: 'name_ar',
      render: (v: string, r: any) => (
        <div>
          <div style={cellStyle}>{v}</div>
          <div style={{ ...mutedStyle, fontSize: 11, color: 'var(--color-text-quaternary)' }}>{r.name}</div>
        </div>
      ),
    },
    {
      title: <span style={labelStyle}>{t.agent.requiresSubscription}</span>,
      dataIndex: 'requires_subscription',
      render: (v: boolean) => (
        <Tag style={{ background: v ? 'rgba(201,168,76,0.15)' : 'var(--color-surface-soft)', color: v ? GOLD : 'var(--color-text-quaternary)', border: 'none', fontFamily: font }}>
          {v ? t.common.yes : t.common.no}
        </Tag>
      ),
    },
    {
      title: <span style={labelStyle}>{t.agent.timeoutMs}</span>,
      dataIndex: 'timeout_ms',
      render: (v: number) => <span style={mutedStyle}>{v}ms</span>,
    },
    {
      title: <span style={labelStyle}>{t.agent.enabled}</span>,
      dataIndex: 'is_active',
      render: (v: boolean, r: any) => (
        <Switch checked={v} onChange={(c) => toggleTool({ id: r.id, active: c })} style={{ background: v ? GOLD : undefined }} />
      ),
    },
    {
      title: <span style={labelStyle}>{t.common.actions}</span>,
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
      title: <span style={labelStyle}>{t.agent.server}</span>,
      dataIndex: 'name_ar',
      render: (v: string) => <span style={cellStyle}>{v}</span>,
    },
    {
      title: <span style={labelStyle}>{t.common.url}</span>,
      dataIndex: 'endpoint_url',
      render: (v: string) => <span style={{ ...mutedStyle, fontSize: 11, direction: 'ltr', display: 'inline-block' }}>{v}</span>,
    },
    {
      title: <span style={labelStyle}>{t.agent.transport}</span>,
      dataIndex: 'transport_type',
      render: (v: string) => <Tag style={{ fontFamily: font, fontSize: 11 }}>{v}</Tag>,
    },
    {
      title: <span style={labelStyle}>{t.agent.tools}</span>,
      dataIndex: 'tools_count',
      render: (v: number) => <span style={mutedStyle}>{v || 0}</span>,
    },
    {
      title: <span style={labelStyle}>{t.agent.health}</span>,
      dataIndex: 'health_status',
      render: (v: string) => {
        const cfg = HEALTH_STYLE[v] || HEALTH_STYLE.unknown
        return (
          <Tag style={{ background: `${cfg.color}20`, border: `1px solid ${cfg.color}40`, color: cfg.color, borderRadius: 12, fontFamily: font, display: 'flex', alignItems: 'center', gap: 4, width: 'fit-content' }}>
            {cfg.icon} {healthStatusLabel(t, v)}
          </Tag>
        )
      },
    },
    {
      title: <span style={labelStyle}>{t.common.actions}</span>,
      render: (_: any, r: any) => (
        <Space>
          <Tooltip title={t.agent.healthCheck}>
            <Button type="text" size="small" icon={<HeartOutlined />} style={{ color: '#52c41a' }} onClick={() => pingMcp(r.id)} />
          </Tooltip>
          <Tooltip title={t.agent.discoverTools}>
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
      label: <span style={{ fontFamily: font }}>{t.agent.skills}</span>,
      children: (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditSkill(null); setSkillModalOpen(true) }} style={{ background: GOLD, borderColor: GOLD, color: '#000', fontFamily: font }}>
              {t.agent.addSkill}
            </Button>
          </div>
          <Table dataSource={skills || MOCK_SKILLS} columns={skillsColumns} rowKey="id" pagination={{ pageSize: 10 }} style={tableStyle} />
        </div>
      ),
    },
    {
      key: 'tools',
      label: <span style={{ fontFamily: font }}>{t.agent.tools}</span>,
      children: (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditTool(null); setToolModalOpen(true) }} style={{ background: GOLD, borderColor: GOLD, color: '#000', fontFamily: font }}>
              {t.agent.addTool}
            </Button>
          </div>
          <Table dataSource={tools || MOCK_TOOLS} columns={toolsColumns} rowKey="id" pagination={{ pageSize: 10 }} style={tableStyle} />
        </div>
      ),
    },
    {
      key: 'mcp',
      label: <span style={{ fontFamily: font }}>{t.agent.mcpServers}</span>,
      children: (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditServer(null); setMcpModalOpen(true) }} style={{ background: GOLD, borderColor: GOLD, color: '#000', fontFamily: font }}>
              {t.agent.addServer}
            </Button>
          </div>
          <Table dataSource={mcpServers || MOCK_MCP_SERVERS} columns={mcpColumns} rowKey="id" pagination={{ pageSize: 10 }} style={tableStyle} />
        </div>
      ),
    },
    {
      key: 'config',
      label: <span style={{ fontFamily: font }}>{t.agent.config}</span>,
      children: (
        <div style={{ maxWidth: 640 }}>
          <Card style={{ background: DARK_CARD, border: `1px solid ${BORDER_COLOR}`, borderRadius: 16 }} bodyStyle={{ padding: 24 }}>
            <h3 style={{ ...h1Style, marginBottom: 24 }}>
              {t.agent.modelSettings}
            </h3>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <div>
                <div style={{ ...labelStyle, fontSize: 13, marginBottom: 8 }}>{t.agent.model}</div>
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
                  <span style={{ ...labelStyle, fontSize: 13 }}>{t.agent.temperature}</span>
                  <span style={{ fontFamily: font, color: GOLD, fontSize: 13 }}>{agentConfig.temperature}</span>
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
                  <span style={{ ...labelStyle, fontSize: 13 }}>{t.agent.maxTokens}</span>
                  <span style={{ fontFamily: font, color: GOLD, fontSize: 13 }}>{agentConfig.max_tokens}</span>
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
                <div style={{ ...labelStyle, fontSize: 13, marginBottom: 8 }}>{t.agent.activeSkills}</div>
                <Select
                  mode="multiple"
                  value={agentConfig.active_skills}
                  onChange={(v) => setAgentConfig({ ...agentConfig, active_skills: v })}
                  style={{ width: '100%' }}
                  options={(skills || MOCK_SKILLS).map((s: any) => ({ value: s.id, label: skillLabel(s) }))}
                />
              </div>

              <div>
                <div style={{ ...labelStyle, fontSize: 13, marginBottom: 8 }}>{t.agent.activeTools}</div>
                <Select
                  mode="multiple"
                  value={agentConfig.active_tools}
                  onChange={(v) => setAgentConfig({ ...agentConfig, active_tools: v })}
                  style={{ width: '100%' }}
                  options={(tools || MOCK_TOOLS).map((tool: any) => ({ value: tool.id, label: skillLabel(tool) }))}
                />
              </div>

              <div>
                <div style={{ ...labelStyle, fontSize: 13, marginBottom: 8 }}>{t.agent.activeMcpServers}</div>
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
                style={{ background: GOLD, borderColor: GOLD, color: '#000', fontFamily: font, fontWeight: 600, height: 44 }}
              >
                {t.agent.saveSettings}
              </Button>
            </div>
          </Card>
        </div>
      ),
    },
  ]

  return (
    <div style={pageStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <RobotOutlined style={{ fontSize: 22, color: GOLD }} />
        <h1 style={h1Style}>
          {t.agent.title}
        </h1>
      </div>

      <Tabs items={tabItems} style={{ direction: dir }} />

      <SkillModal open={skillModalOpen} editSkill={editSkill} onClose={() => { setSkillModalOpen(false); setEditSkill(null) }} ui={ui} />
      <ToolModal open={toolModalOpen} editTool={editTool} onClose={() => { setToolModalOpen(false); setEditTool(null) }} ui={ui} />
      <McpModal open={mcpModalOpen} editServer={editServer} onClose={() => { setMcpModalOpen(false); setEditServer(null) }} ui={ui} />
    </div>
  )
}
