import React, { useState } from 'react'
import {
  App,
  Table,
  Tag,
  Button,
  Input,
  Select,
  Space,
  Avatar,
  Modal,
  Form,
  Tooltip,
  Popconfirm,
  Badge,
} from 'antd'
import {
  SearchOutlined,
  EditOutlined,
  DeleteOutlined,
  UserOutlined,
  CrownOutlined,
  LockOutlined,
  UnlockOutlined,
  PlusOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import apiClient from '../../../shared/api/client'
import { GOLD, DARK_CARD, BORDER_COLOR } from '../../../shared/constants'
import dayjs from 'dayjs'
import { useAdminUi } from '../locale/useAdminI18n'

const ROLE_COLORS: Record<string, string> = {
  PUBLIC: '#8c8c8c',
  PRO: GOLD,
  ADMIN: '#1677ff',
  SUPERADMIN: '#eb2f96',
}

const MOCK_USERS = [
  { id: '1', email: 'ahmed@example.ma', name: 'أحمد المختار', role: 'PRO', is_active: true, created_at: '2024-01-10T10:00:00Z', last_login: '2024-03-15T09:00:00Z', subscription: 'pro', messages_today: 45 },
  { id: '2', email: 'fatima@example.ma', name: 'فاطمة الزهراء', role: 'PUBLIC', is_active: true, created_at: '2024-02-05T14:00:00Z', last_login: '2024-03-14T16:00:00Z', subscription: null, messages_today: 3 },
  { id: '3', email: 'youssef@example.ma', name: 'يوسف بنعلي', role: 'ADMIN', is_active: true, created_at: '2023-11-20T08:00:00Z', last_login: '2024-03-15T11:00:00Z', subscription: 'enterprise', messages_today: 120 },
  { id: '4', email: 'sara@example.ma', name: 'سارة الإدريسي', role: 'PUBLIC', is_active: false, created_at: '2024-03-01T10:00:00Z', last_login: null, subscription: null, messages_today: 0 },
  { id: '5', email: 'karim@cabinet-legal.ma', name: 'كريم الحسني', role: 'PRO', is_active: true, created_at: '2024-01-25T09:00:00Z', last_login: '2024-03-15T08:00:00Z', subscription: 'pro', messages_today: 78 },
]

type AdminUi = ReturnType<typeof useAdminUi>

function EditUserModal({
  open,
  user,
  onClose,
  ui,
}: {
  open: boolean
  user: any | null
  onClose: () => void
  ui: AdminUi
}) {
  const { message } = App.useApp()
  const { t, font, formStyle, labelStyle, titleStyle, roleOptions } = ui
  const [form] = Form.useForm()
  const qc = useQueryClient()

  React.useEffect(() => {
    if (user) form.setFieldsValue(user)
    else form.resetFields()
  }, [user, form])

  const { mutate: save, isPending } = useMutation({
    mutationFn: async (values: any) => {
      const { password, ...profile } = values
      await apiClient.patch(`/admin/users/${user?.id}`, profile)
      if (password) await apiClient.patch(`/admin/users/${user?.id}/password`, { password })
    },
    onSuccess: () => {
      message.success(t.users.updateSuccess)
      qc.invalidateQueries({ queryKey: ['admin-users'] })
      onClose()
    },
    onError: () => message.error(t.common.error),
  })

  return (
    <Modal
      title={<span style={titleStyle}>{t.users.editUser}</span>}
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText={<span style={{ fontFamily: font }}>{t.common.save}</span>}
      cancelText={<span style={{ fontFamily: font }}>{t.common.cancel}</span>}
      okButtonProps={{ loading: isPending, style: { background: GOLD, borderColor: GOLD, color: '#000' } }}
      centered
    >
      <Form form={form} layout="vertical" onFinish={(v) => save(v)} style={formStyle}>
        <Form.Item name="name" label={<span style={labelStyle}>{t.users.fullName}</span>}>
          <Input style={{ direction: ui.dir, fontFamily: font }} />
        </Form.Item>
        <Form.Item name="role" label={<span style={labelStyle}>{t.users.role}</span>} rules={[{ required: true }]}>
          <Select options={roleOptions()} />
        </Form.Item>
        <Form.Item name="password" label={<span style={labelStyle}>{t.users.newPassword}</span>}>
          <Input.Password placeholder={t.users.passwordPlaceholder} />
        </Form.Item>
      </Form>
    </Modal>
  )
}

function CreateUserModal({
  open,
  onClose,
  ui,
}: {
  open: boolean
  onClose: () => void
  ui: AdminUi
}) {
  const { message } = App.useApp()
  const { t, font, formStyle, labelStyle, titleStyle, roleOptions } = ui
  const [form] = Form.useForm()
  const qc = useQueryClient()

  const { mutate: create, isPending } = useMutation({
    mutationFn: async (values: any) => {
      await apiClient.post('/admin/users', values)
    },
    onSuccess: () => {
      message.success(t.users.createSuccess)
      qc.invalidateQueries({ queryKey: ['admin-users'] })
      form.resetFields()
      onClose()
    },
    onError: (err: any) => message.error(err?.response?.data?.message || t.common.error),
  })

  return (
    <Modal
      title={<span style={titleStyle}>{t.users.createUser}</span>}
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText={<span style={{ fontFamily: font }}>{t.common.create}</span>}
      cancelText={<span style={{ fontFamily: font }}>{t.common.cancel}</span>}
      okButtonProps={{ loading: isPending, style: { background: GOLD, borderColor: GOLD, color: '#000' } }}
      centered
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{ role: 'ADMIN', enabled: true }}
        onFinish={(v) => create(v)}
        style={formStyle}
      >
        <Form.Item name="username" label={<span style={labelStyle}>{t.users.username}</span>} rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item name="email" label={<span style={labelStyle}>{t.users.email}</span>} rules={[{ required: true, type: 'email' }]}>
          <Input />
        </Form.Item>
        <Form.Item name="name" label={<span style={labelStyle}>{t.users.fullName}</span>}>
          <Input />
        </Form.Item>
        <Form.Item name="password" label={<span style={labelStyle}>{t.users.password}</span>} rules={[{ required: true }]}>
          <Input.Password />
        </Form.Item>
        <Form.Item name="role" label={<span style={labelStyle}>{t.users.role}</span>} rules={[{ required: true }]}>
          <Select options={roleOptions()} />
        </Form.Item>
      </Form>
    </Modal>
  )
}

export function UsersPage() {
  const ui = useAdminUi()
  const { t, font, pageStyle, tableStyle, h1Style, labelStyle, mutedStyle, roleOptions } = ui
  const { message } = App.useApp()
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState<string>('')
  const [editUser, setEditUser] = useState<any | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const qc = useQueryClient()

  const { data: users, isLoading } = useQuery({
    queryKey: ['admin-users', search, roleFilter],
    queryFn: async () => {
      try {
        const res = await apiClient.get('/admin/users', { params: { search } })
        const data = res.data
        return roleFilter ? data.filter((u: any) => u.role === roleFilter) : data
      } catch (err) {
        throw err
      }
    },
  })

  const { mutate: toggleActive } = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      await apiClient.patch(`/admin/users/${id}`, { is_active: active })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
    onError: () => message.error(t.common.error),
  })

  const { mutate: deleteUser } = useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`/admin/users/${id}`)
    },
    onSuccess: () => {
      message.success(t.users.deleteSuccess)
      qc.invalidateQueries({ queryKey: ['admin-users'] })
    },
    onError: () => message.error(t.common.error),
  })

  const columns = [
    {
      title: <span style={labelStyle}>{t.users.userColumn}</span>,
      key: 'user',
      render: (_: any, r: any) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Avatar
            size={36}
            style={{ background: `${GOLD}30`, color: GOLD, flexShrink: 0 }}
          >
            {r.name?.[0] || r.email?.[0]?.toUpperCase()}
          </Avatar>
          <div>
            <div style={{ fontFamily: font, color: 'var(--color-text-primary)', fontSize: 13, fontWeight: 500 }}>
              {r.name}
            </div>
            <div style={{ ...mutedStyle, color: 'var(--color-text-quaternary)', fontSize: 11 }}>
              {r.email}
            </div>
          </div>
        </div>
      ),
    },
    {
      title: <span style={labelStyle}>{t.users.role}</span>,
      dataIndex: 'role',
      key: 'role',
      render: (v: string) => {
        const color = ROLE_COLORS[v] || '#8c8c8c'
        const label = t.roles[v as keyof typeof t.roles] || v
        return (
          <Tag style={{ background: `${color}20`, border: `1px solid ${color}40`, color, borderRadius: 12, fontFamily: font }}>
            {v === 'SUPERADMIN' && <CrownOutlined style={{ marginLeft: 4 }} />}
            {label}
          </Tag>
        )
      },
    },
    {
      title: <span style={labelStyle}>{t.users.subscription}</span>,
      dataIndex: 'subscription',
      key: 'subscription',
      render: (v: string | null) => (
        v ? (
          <Tag style={{ background: 'rgba(201,168,76,0.15)', color: GOLD, border: `1px solid rgba(201,168,76,0.3)`, borderRadius: 12, fontFamily: font, fontSize: 11 }}>
            {v === 'pro' ? t.users.proPlan : v === 'enterprise' ? t.users.enterprisePlan : v}
          </Tag>
        ) : (
          <span style={mutedStyle}>{t.users.noSubscription}</span>
        )
      ),
    },
    {
      title: <span style={labelStyle}>{t.users.messagesToday}</span>,
      dataIndex: 'messages_today',
      key: 'messages_today',
      render: (v: number) => (
        <span style={{ fontFamily: font, color: v > 50 ? GOLD : 'var(--color-text-tertiary)', fontWeight: v > 50 ? 600 : 400 }}>
          {v}
        </span>
      ),
    },
    {
      title: <span style={labelStyle}>{t.users.lastLogin}</span>,
      dataIndex: 'last_login',
      key: 'last_login',
      render: (v: string | null) => (
        <span style={mutedStyle}>
          {v ? dayjs(v).format('DD/MM HH:mm') : t.users.neverLoggedIn}
        </span>
      ),
    },
    {
      title: <span style={labelStyle}>{t.common.status}</span>,
      dataIndex: 'is_active',
      key: 'is_active',
      render: (v: boolean) => (
        <Badge
          color={v ? '#52c41a' : '#f5222d'}
          text={
            <span style={{ fontFamily: font, fontSize: 12, color: v ? '#52c41a' : '#f5222d' }}>
              {v ? t.common.active : t.common.inactive}
            </span>
          }
        />
      ),
    },
    {
      title: <span style={labelStyle}>{t.common.actions}</span>,
      key: 'actions',
      render: (_: any, r: any) => (
        <Space>
          <Tooltip title={t.common.edit}>
            <Button type="text" size="small" icon={<EditOutlined />} style={{ color: GOLD }} onClick={() => setEditUser(r)} />
          </Tooltip>
          <Tooltip title={r.is_active ? t.users.suspend : t.users.activate}>
            <Button
              type="text"
              size="small"
              icon={r.is_active ? <LockOutlined /> : <UnlockOutlined />}
              style={{ color: r.is_active ? '#fa8c16' : '#52c41a' }}
              onClick={() => toggleActive({ id: r.id, active: !r.is_active })}
            />
          </Tooltip>
          <Popconfirm
            title={<span style={{ fontFamily: font }}>{t.users.deleteConfirm}</span>}
            okText={<span style={{ fontFamily: font }}>{t.common.delete}</span>}
            cancelText={<span style={{ fontFamily: font }}>{t.common.cancel}</span>}
            okButtonProps={{ danger: true }}
            onConfirm={() => deleteUser(r.id)}
          >
            <Button type="text" size="small" icon={<DeleteOutlined />} danger />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const displayUsers = users || MOCK_USERS

  return (
    <div style={pageStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <UserOutlined style={{ fontSize: 22, color: GOLD }} />
          <h1 style={h1Style}>{t.users.title}</h1>
          <Badge
            count={displayUsers.length}
            style={{ background: 'var(--color-border-subtle)', color: 'var(--color-text-secondary)', boxShadow: 'none' }}
          />
        </div>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setCreateOpen(true)}
          style={{ background: GOLD, borderColor: GOLD, color: '#000', fontFamily: font }}
        >
          {t.users.addUser}
        </Button>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <Input
          placeholder={t.users.searchPlaceholder}
          prefix={<SearchOutlined style={{ color: 'var(--color-text-quaternary)' }} />}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            maxWidth: 280,
            background: DARK_CARD,
            border: `1px solid ${BORDER_COLOR}`,
            direction: ui.dir,
            fontFamily: font,
          }}
          allowClear
        />
        <Select
          value={roleFilter}
          onChange={setRoleFilter}
          style={{ minWidth: 160 }}
          options={roleOptions(true)}
        />
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        {Object.entries(ROLE_COLORS).map(([role, color]) => {
          const count = displayUsers.filter((u: any) => u.role === role).length
          const label = t.roles[role as keyof typeof t.roles]
          return (
            <div
              key={role}
              style={{
                background: DARK_CARD,
                border: `1px solid ${color}30`,
                borderRadius: 10,
                padding: '8px 16px',
                display: 'flex',
                gap: 8,
                alignItems: 'center',
              }}
            >
              <span style={{ fontSize: 13, color, fontFamily: font }}>{label}</span>
              <span style={{ fontSize: 16, fontWeight: 700, color, fontFamily: font }}>{count}</span>
            </div>
          )
        })}
      </div>

      <Table
        dataSource={displayUsers}
        columns={columns}
        rowKey="id"
        loading={isLoading}
        pagination={{ pageSize: 20, showTotal: (total) => <span style={mutedStyle}>{t.common.usersCount(total)}</span> }}
        style={tableStyle}
        locale={{ emptyText: <span style={{ fontFamily: font }}>{t.users.empty}</span> }}
      />

      <EditUserModal open={!!editUser} user={editUser} onClose={() => setEditUser(null)} ui={ui} />
      <CreateUserModal open={createOpen} onClose={() => setCreateOpen(false)} ui={ui} />
    </div>
  )
}
