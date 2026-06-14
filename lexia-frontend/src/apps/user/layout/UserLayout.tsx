import React, { useState, useCallback } from 'react'
import { Outlet, useNavigate, useLocation, Link } from 'react-router-dom'
import {
  Button,
  Avatar,
  Dropdown,
  Drawer,
  List,
  Tooltip,
  Badge,
  Space,
  Popconfirm,
  Empty,
  Spin,
  message,
} from 'antd'
import {
  MessageOutlined,
  FolderOpenOutlined,
  SearchOutlined,
  CreditCardOutlined,
  SettingOutlined,
  LogoutOutlined,
  UserOutlined,
  PlusOutlined,
  MenuOutlined,
  HistoryOutlined,
  DeleteOutlined,
} from '@ant-design/icons'
import { useAuthStore } from '../../../shared/store/authStore'
import { GOLD, DARK, NAVY, BORDER_COLOR, TEXT_PRIMARY, TEXT_SECONDARY, TEXT_TERTIARY, TEXT_QUATERNARY, GOLD_TINT, GOLD_BORDER } from '../../../shared/constants'
import { ThemeToggle } from '../../../shared/components/ThemeToggle'
import { useConversations, useDeleteConversation } from '../../../shared/hooks/useConversations'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'

dayjs.extend(relativeTime)

export function UserLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const { token, email, accessLevel, keycloak, logout } = useAuthStore()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // null = a fresh, empty chat with no persisted history yet.
  const [activeConvId, setActiveConvId] = useState<string | null>(null)

  const isPro = accessLevel === 'PRO' || accessLevel === 'ADMIN' || accessLevel === 'SUPERADMIN'
  const isAdmin = accessLevel === 'ADMIN' || accessLevel === 'SUPERADMIN'

  const { data: conversations, isLoading: convLoading, refetch: refetchConversations } =
    useConversations(isPro)
  const { mutate: deleteConversation } = useDeleteConversation()

  const handleSelectConversation = useCallback(
    (id: string | null) => {
      setActiveConvId(id)
      navigate('/')
      setSidebarOpen(false)
    },
    [navigate],
  )

  const handleDeleteConversation = useCallback(
    (id: string) => {
      deleteConversation(id, {
        onSuccess: () => {
          message.success('تم حذف المحادثة')
          if (activeConvId === id) setActiveConvId(null)
        },
        onError: () => message.error('تعذّر حذف المحادثة'),
      })
    },
    [deleteConversation, activeConvId],
  )

  const handleLogin = useCallback(() => {
    if (keycloak) keycloak.login()
  }, [keycloak])

  const handleLogout = useCallback(() => {
    logout()
    if (keycloak) keycloak.logout()
  }, [keycloak, logout])

  const navItems = [
    { key: '/', label: 'المحادثة العامة', icon: <MessageOutlined /> },
    ...(token ? [{ key: '/cases', label: 'القضايا', icon: <FolderOpenOutlined /> }] : []),
    { key: '/search', label: 'البحث', icon: <SearchOutlined /> },
    { key: '/billing', label: 'الاشتراك', icon: <CreditCardOutlined /> },
  ]

  const userMenuItems = [
    {
      key: 'profile',
      label: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>{email || 'المستخدم'}</span>,
      icon: <UserOutlined />,
      disabled: true,
    },
    ...(isAdmin
      ? [{ key: 'admin', label: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>لوحة الإدارة</span>, icon: <SettingOutlined /> }]
      : []),
    { type: 'divider' as const },
    {
      key: 'logout',
      label: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>تسجيل الخروج</span>,
      icon: <LogoutOutlined />,
      danger: true,
    },
  ]

  const handleUserMenuClick = ({ key }: { key: string }) => {
    if (key === 'logout') handleLogout()
    if (key === 'admin') navigate('/admin')
  }

  const Sidebar = (
    <div
      style={{
        width: 260,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: NAVY,
        borderLeft: `1px solid ${BORDER_COLOR}`,
        padding: '16px 12px',
        gap: 8,
        direction: 'rtl',
      }}
    >
      <Button
        type="primary"
        icon={<PlusOutlined />}
        block
        style={{
          background: GOLD,
          borderColor: GOLD,
          color: '#000',
          fontWeight: 600,
          fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
          height: 40,
          marginBottom: 8,
        }}
        onClick={() => handleSelectConversation(null)}
      >
        محادثة جديدة
      </Button>

      <div
        style={{
          fontSize: 12,
          color: TEXT_TERTIARY,
          textTransform: 'uppercase',
          padding: '4px 8px',
          letterSpacing: 0.5,
          fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
        }}
      >
        المحادثات السابقة
      </div>

      {convLoading ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Spin />
        </div>
      ) : !conversations || conversations.length === 0 ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: TEXT_TERTIARY, fontSize: 13 }}>
                لا توجد محادثات سابقة
              </span>
            }
          />
        </div>
      ) : (
        <List
          dataSource={conversations}
          style={{ flex: 1, overflow: 'auto' }}
          renderItem={(conv) => (
            <List.Item
              key={conv.id}
              style={{
                padding: '8px 10px',
                cursor: 'pointer',
                borderRadius: 8,
                background: activeConvId === conv.id ? GOLD_TINT : 'transparent',
                border: activeConvId === conv.id ? `1px solid ${GOLD_BORDER}` : '1px solid transparent',
                marginBottom: 4,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                transition: 'all 0.2s',
              }}
              onClick={() => handleSelectConversation(conv.id)}
            >
              <div style={{ flex: 1, overflow: 'hidden' }}>
                <div
                  style={{
                    fontSize: 13,
                    color: activeConvId === conv.id ? GOLD : TEXT_PRIMARY,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
                    textAlign: 'right',
                  }}
                >
                  {conv.title_ar || 'محادثة جديدة'}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: TEXT_TERTIARY,
                    marginTop: 2,
                    fontFamily: "'Cairo', sans-serif",
                    textAlign: 'right',
                  }}
                >
                  {dayjs(conv.updated_at).fromNow?.() || dayjs(conv.updated_at).format('DD/MM')}
                </div>
              </div>
              <Popconfirm
                title={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>حذف هذه المحادثة؟</span>}
                okText={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>حذف</span>}
                cancelText={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>إلغاء</span>}
                okButtonProps={{ danger: true }}
                onConfirm={() => handleDeleteConversation(conv.id)}
              >
                <Tooltip title="حذف">
                  <Button
                    type="text"
                    size="small"
                    icon={<DeleteOutlined />}
                    style={{ color: TEXT_QUATERNARY, flexShrink: 0 }}
                    onClick={(e) => e.stopPropagation()}
                  />
                </Tooltip>
              </Popconfirm>
            </List.Item>
          )}
        />
      )}
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: DARK, direction: 'rtl' }}>
      {/* Navbar */}
      <header
        className="glass"
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 100,
          height: 60,
          display: 'flex',
          alignItems: 'center',
          padding: '0 20px',
          gap: 16,
          flexShrink: 0,
        }}
      >
        {/* Logo */}
        <Link
          to="/"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            textDecoration: 'none',
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontSize: 20,
              fontWeight: 700,
              color: GOLD,
              letterSpacing: 2,
              fontFamily: "'Georgia', 'Times New Roman', serif",
            }}
          >
            LEXIA
          </span>
        </Link>

        {/* Nav links */}
        <nav style={{ display: 'flex', gap: 4, flex: 1, justifyContent: 'center' }}>
          {navItems.map((item) => (
            <Link
              key={item.key}
              to={item.key}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 16px',
                borderRadius: 8,
                textDecoration: 'none',
                fontSize: 14,
                fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
                fontWeight: 500,
                color: location.pathname === item.key ? GOLD : TEXT_SECONDARY,
                background: location.pathname === item.key ? GOLD_TINT : 'transparent',
                border: location.pathname === item.key ? `1px solid ${GOLD_BORDER}` : '1px solid transparent',
                transition: 'all 0.2s',
              }}
            >
              {item.icon}
              {item.label}
            </Link>
          ))}
        </nav>

        {/* Right side */}
        <Space style={{ flexShrink: 0 }}>
          <ThemeToggle />

          {isPro && (
            <Tooltip title="المحادثات السابقة">
              <Button
                type="text"
                icon={<HistoryOutlined />}
                style={{ color: TEXT_SECONDARY }}
                onClick={() => setSidebarOpen(true)}
              />
            </Tooltip>
          )}

          {token ? (
            <Dropdown
              menu={{ items: userMenuItems, onClick: handleUserMenuClick }}
              placement="bottomLeft"
              trigger={['click']}
            >
              <div style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}>
                <Badge
                  dot
                  color={GOLD}
                  offset={[-2, 2]}
                >
                  <Avatar
                    size={34}
                    style={{ background: `${GOLD}30`, color: GOLD, fontWeight: 700, cursor: 'pointer' }}
                  >
                    {email?.[0]?.toUpperCase() || 'م'}
                  </Avatar>
                </Badge>
              </div>
            </Dropdown>
          ) : (
            <Button
              type="primary"
              onClick={handleLogin}
              style={{
                background: GOLD,
                borderColor: GOLD,
                color: '#000',
                fontWeight: 600,
                fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
              }}
            >
              تسجيل الدخول
            </Button>
          )}

          <Button
            type="text"
            icon={<MenuOutlined />}
            style={{ color: TEXT_SECONDARY, display: isPro ? 'none' : undefined }}
            onClick={() => setSidebarOpen(true)}
          />
        </Space>
      </header>

      {/* Body */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Desktop sidebar for PRO+ */}
        {isPro && (
          <aside
            style={{
              width: 260,
              flexShrink: 0,
              height: '100%',
              overflow: 'hidden',
              display: 'none',
            }}
            className="desktop-sidebar"
          >
            {Sidebar}
          </aside>
        )}

        {/* Main content */}
        <main style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
          <Outlet
            context={{
              conversationId: activeConvId,
              setConversationId: setActiveConvId,
              refetchConversations,
            }}
          />
        </main>
      </div>

      {/* Mobile / PRO drawer */}
      <Drawer
        title={
          <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: GOLD }}>
            المحادثات السابقة
          </span>
        }
        placement="right"
        onClose={() => setSidebarOpen(false)}
        open={sidebarOpen}
        width={280}
        styles={{
          body: { padding: 0, background: NAVY },
          header: { background: NAVY, borderBottom: `1px solid ${BORDER_COLOR}` },
          mask: { background: 'var(--color-mask)' },
        }}
      >
        {Sidebar}
      </Drawer>
    </div>
  )
}
