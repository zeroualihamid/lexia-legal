import React, { useState } from 'react'
import {
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
  message,
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
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import apiClient from '../../../shared/api/client'
import { GOLD, DARK_CARD, BORDER_COLOR } from '../../../shared/constants'
import dayjs from 'dayjs'

const ROLE_CONFIG: Record<string, { color: string; label: string }> = {
  PUBLIC: { color: '#8c8c8c', label: 'عام' },
  PRO: { color: GOLD, label: 'محترف' },
  ADMIN: { color: '#1677ff', label: 'مشرف' },
  SUPERADMIN: { color: '#eb2f96', label: 'مشرف عام' },
}

const MOCK_USERS = [
  { id: '1', email: 'ahmed@example.ma', name: 'أحمد المختار', role: 'PRO', is_active: true, created_at: '2024-01-10T10:00:00Z', last_login: '2024-03-15T09:00:00Z', subscription: 'pro', messages_today: 45 },
  { id: '2', email: 'fatima@example.ma', name: 'فاطمة الزهراء', role: 'PUBLIC', is_active: true, created_at: '2024-02-05T14:00:00Z', last_login: '2024-03-14T16:00:00Z', subscription: null, messages_today: 3 },
  { id: '3', email: 'youssef@example.ma', name: 'يوسف بنعلي', role: 'ADMIN', is_active: true, created_at: '2023-11-20T08:00:00Z', last_login: '2024-03-15T11:00:00Z', subscription: 'enterprise', messages_today: 120 },
  { id: '4', email: 'sara@example.ma', name: 'سارة الإدريسي', role: 'PUBLIC', is_active: false, created_at: '2024-03-01T10:00:00Z', last_login: null, subscription: null, messages_today: 0 },
  { id: '5', email: 'karim@cabinet-legal.ma', name: 'كريم الحسني', role: 'PRO', is_active: true, created_at: '2024-01-25T09:00:00Z', last_login: '2024-03-15T08:00:00Z', subscription: 'pro', messages_today: 78 },
]

function EditUserModal({
  open,
  user,
  onClose,
}: {
  open: boolean
  user: any | null
  onClose: () => void
}) {
  const [form] = Form.useForm()
  const qc = useQueryClient()

  React.useEffect(() => {
    if (user) form.setFieldsValue(user)
    else form.resetFields()
  }, [user, form])

  const { mutate: save, isPending } = useMutation({
    mutationFn: async (values: any) => {
      await apiClient.patch(`/admin/users/${user?.id}`, values)
    },
    onSuccess: () => {
      message.success('تم تحديث المستخدم')
      qc.invalidateQueries({ queryKey: ['admin-users'] })
      onClose()
    },
    onError: () => message.error('حدث خطأ'),
  })

  return (
    <Modal
      title={
        <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'rgba(255,255,255,0.9)' }}>
          تعديل المستخدم
        </span>
      }
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>حفظ</span>}
      cancelText={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>إلغاء</span>}
      okButtonProps={{ loading: isPending, style: { background: GOLD, borderColor: GOLD, color: '#000' } }}
      centered
    >
      <Form form={form} layout="vertical" onFinish={(v) => save(v)} style={{ direction: 'rtl', marginTop: 16 }}>
        <Form.Item name="name" label={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الاسم الكامل</span>}>
          <Input style={{ direction: 'rtl', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }} />
        </Form.Item>
        <Form.Item name="role" label={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الدور</span>} rules={[{ required: true }]}>
          <Select
            options={[
              { value: 'PUBLIC', label: 'عام' },
              { value: 'PRO', label: 'محترف' },
              { value: 'ADMIN', label: 'مشرف' },
              { value: 'SUPERADMIN', label: 'مشرف عام' },
            ]}
          />
        </Form.Item>
      </Form>
    </Modal>
  )
}

export function UsersPage() {
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState<string>('')
  const [editUser, setEditUser] = useState<any | null>(null)
  const qc = useQueryClient()

  const { data: users, isLoading } = useQuery({
    queryKey: ['admin-users', search, roleFilter],
    queryFn: async () => {
      try {
        const res = await apiClient.get('/admin/users', { params: { q: search, role: roleFilter } })
        return res.data
      } catch {
        return MOCK_USERS.filter((u) => {
          const matchSearch = !search || u.name.includes(search) || u.email.includes(search)
          const matchRole = !roleFilter || u.role === roleFilter
          return matchSearch && matchRole
        })
      }
    },
  })

  const { mutate: toggleActive } = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      await apiClient.patch(`/admin/users/${id}`, { is_active: active })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
    onError: () => message.error('حدث خطأ'),
  })

  const { mutate: deleteUser } = useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`/admin/users/${id}`)
    },
    onSuccess: () => {
      message.success('تم حذف المستخدم')
      qc.invalidateQueries({ queryKey: ['admin-users'] })
    },
    onError: () => message.error('حدث خطأ'),
  })

  const columns = [
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>المستخدم</span>,
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
            <div style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'rgba(255,255,255,0.85)', fontSize: 13, fontWeight: 500 }}>
              {r.name}
            </div>
            <div style={{ fontFamily: "'Cairo', sans-serif", color: 'rgba(255,255,255,0.35)', fontSize: 11 }}>
              {r.email}
            </div>
          </div>
        </div>
      ),
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الدور</span>,
      dataIndex: 'role',
      key: 'role',
      render: (v: string) => {
        const cfg = ROLE_CONFIG[v] || { color: '#8c8c8c', label: v }
        return (
          <Tag style={{ background: `${cfg.color}20`, border: `1px solid ${cfg.color}40`, color: cfg.color, borderRadius: 12, fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>
            {v === 'SUPERADMIN' && <CrownOutlined style={{ marginLeft: 4 }} />}
            {cfg.label}
          </Tag>
        )
      },
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الاشتراك</span>,
      dataIndex: 'subscription',
      key: 'subscription',
      render: (v: string | null) => (
        v ? (
          <Tag style={{ background: 'rgba(201,168,76,0.15)', color: GOLD, border: `1px solid rgba(201,168,76,0.3)`, borderRadius: 12, fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", fontSize: 11 }}>
            {v === 'pro' ? 'محترف' : v === 'enterprise' ? 'مؤسسي' : v}
          </Tag>
        ) : (
          <span style={{ color: 'rgba(255,255,255,0.25)', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", fontSize: 12 }}>بدون اشتراك</span>
        )
      ),
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الرسائل اليوم</span>,
      dataIndex: 'messages_today',
      key: 'messages_today',
      render: (v: number) => (
        <span style={{ fontFamily: "'Cairo', sans-serif", color: v > 50 ? GOLD : 'rgba(255,255,255,0.4)', fontWeight: v > 50 ? 600 : 400 }}>
          {v}
        </span>
      ),
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>آخر دخول</span>,
      dataIndex: 'last_login',
      key: 'last_login',
      render: (v: string | null) => (
        <span style={{ fontFamily: "'Cairo', sans-serif", color: 'rgba(255,255,255,0.3)', fontSize: 12 }}>
          {v ? dayjs(v).format('DD/MM HH:mm') : 'لم يسجل دخولاً'}
        </span>
      ),
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الحالة</span>,
      dataIndex: 'is_active',
      key: 'is_active',
      render: (v: boolean) => (
        <Badge
          color={v ? '#52c41a' : '#f5222d'}
          text={
            <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", fontSize: 12, color: v ? '#52c41a' : '#f5222d' }}>
              {v ? 'نشط' : 'موقوف'}
            </span>
          }
        />
      ),
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الإجراءات</span>,
      key: 'actions',
      render: (_: any, r: any) => (
        <Space>
          <Tooltip title="تعديل">
            <Button type="text" size="small" icon={<EditOutlined />} style={{ color: GOLD }} onClick={() => setEditUser(r)} />
          </Tooltip>
          <Tooltip title={r.is_active ? 'إيقاف' : 'تفعيل'}>
            <Button
              type="text"
              size="small"
              icon={r.is_active ? <LockOutlined /> : <UnlockOutlined />}
              style={{ color: r.is_active ? '#fa8c16' : '#52c41a' }}
              onClick={() => toggleActive({ id: r.id, active: !r.is_active })}
            />
          </Tooltip>
          <Popconfirm
            title={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>هل تريد حذف هذا المستخدم؟</span>}
            okText={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>حذف</span>}
            cancelText={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>إلغاء</span>}
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
    <div style={{ direction: 'rtl' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <UserOutlined style={{ fontSize: 22, color: GOLD }} />
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'rgba(255,255,255,0.9)', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", margin: 0 }}>
            إدارة المستخدمين
          </h1>
          <Badge
            count={displayUsers.length}
            style={{ background: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.6)', boxShadow: 'none' }}
          />
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <Input
          placeholder="بحث بالاسم أو البريد..."
          prefix={<SearchOutlined style={{ color: 'rgba(255,255,255,0.3)' }} />}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            maxWidth: 280,
            background: DARK_CARD,
            border: `1px solid ${BORDER_COLOR}`,
            direction: 'rtl',
            fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
          }}
          allowClear
        />
        <Select
          value={roleFilter}
          onChange={setRoleFilter}
          style={{ minWidth: 160 }}
          options={[
            { value: '', label: 'جميع الأدوار' },
            { value: 'PUBLIC', label: 'عام' },
            { value: 'PRO', label: 'محترف' },
            { value: 'ADMIN', label: 'مشرف' },
            { value: 'SUPERADMIN', label: 'مشرف عام' },
          ]}
        />
      </div>

      {/* Stats summary */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        {Object.entries(ROLE_CONFIG).map(([role, cfg]) => {
          const count = displayUsers.filter((u: any) => u.role === role).length
          return (
            <div
              key={role}
              style={{
                background: DARK_CARD,
                border: `1px solid ${cfg.color}30`,
                borderRadius: 10,
                padding: '8px 16px',
                display: 'flex',
                gap: 8,
                alignItems: 'center',
              }}
            >
              <span style={{ fontSize: 13, color: cfg.color, fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>{cfg.label}</span>
              <span style={{ fontSize: 16, fontWeight: 700, color: cfg.color, fontFamily: "'Cairo', sans-serif" }}>{count}</span>
            </div>
          )
        })}
      </div>

      <Table
        dataSource={displayUsers}
        columns={columns}
        rowKey="id"
        loading={isLoading}
        pagination={{ pageSize: 20, showTotal: (t) => <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'rgba(255,255,255,0.4)' }}>{t} مستخدم</span> }}
        style={{ direction: 'rtl' }}
        locale={{ emptyText: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>لا توجد نتائج</span> }}
      />

      <EditUserModal open={!!editUser} user={editUser} onClose={() => setEditUser(null)} />
    </div>
  )
}
