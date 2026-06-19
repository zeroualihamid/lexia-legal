import React, { useState, useCallback, useMemo } from 'react'
import { Outlet, useNavigate, useLocation, Link } from 'react-router-dom'
import {
  Layout,
  Menu,
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
  PlusOutlined,
  HistoryOutlined,
  DeleteOutlined,
  AppstoreOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SettingOutlined,
  LogoutOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { useAuthStore } from '../../../shared/store/authStore'
import { GOLD, DARK, NAVY, BORDER_COLOR, TEXT_PRIMARY, TEXT_SECONDARY, TEXT_TERTIARY, TEXT_QUATERNARY, GOLD_TINT, GOLD_BORDER } from '../../../shared/constants'
import { ThemeToggle } from '../../../shared/components/ThemeToggle'
import { useConversations, useDeleteConversation } from '../../../shared/hooks/useConversations'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import { ApplicationMenu } from './ApplicationMenu'
import { useUploadTasks } from '../../../shared/hooks/useTasks'
import { useThemeStore } from '../../../shared/store/themeStore'
import {
  buildAppMenuGroups,
  filterMenuGroups,
  isMenuEntryActive,
} from '../../../shared/navigation/appMenu'
import type { MenuProps } from 'antd'

dayjs.extend(relativeTime)

const { Sider, Header, Content } = Layout
const SIDEBAR_WIDTH = 260
const SIDEBAR_COLLAPSED = 72

export function UserLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const themeMode = useThemeStore((s) => s.mode)
  const { token, email, accessLevel, keycloak, logout } = useAuthStore()
  const [collapsed, setCollapsed] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [applicationMenuOpen, setApplicationMenuOpen] = useState(false)
  // null = a fresh, empty chat with no persisted history yet.
  const [activeConvId, setActiveConvId] = useState<string | null>(null)

  const isPro = accessLevel === 'PRO' || accessLevel === 'ADMIN' || accessLevel === 'SUPERADMIN'
  const isAdmin = accessLevel === 'ADMIN' || accessLevel === 'SUPERADMIN'

  const { data: conversations, isLoading: convLoading, refetch: refetchConversations } =
    useConversations(isPro)
  const { mutate: deleteConversation } = useDeleteConversation()
  const tasksQ = useUploadTasks(!!token)
  const activeTaskCount = (tasksQ.data || []).filter(
    (task) => task.state === 'queued' || task.state === 'running',
  ).length

  const handleSelectConversation = useCallback(
    (id: string | null) => {
      setActiveConvId(id)
      navigate('/')
      setHistoryOpen(false)
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

  const navGroups = useMemo(
    () => filterMenuGroups(buildAppMenuGroups({ activeTaskCount }), { hasToken: !!token }),
    [token, activeTaskCount],
  )

  const selectedNavKey = useMemo(() => {
    for (const group of navGroups) {
      for (const item of group.items) {
        if (isMenuEntryActive(item, location.pathname, location.search)) {
          return item.key
        }
      }
    }
    return 'assistant'
  }, [navGroups, location.pathname, location.search])

  const sidebarMenuItems: MenuProps['items'] = useMemo(
    () =>
      navGroups.map((group) => ({
        key: group.id,
        icon: group.icon,
        label: (
          <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>
            {group.title}
          </span>
        ),
        children: group.items.map((item) => ({
          key: item.key,
          icon: item.icon,
          label: (
            <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>
              {item.label}
            </span>
          ),
        })),
      })),
    [navGroups],
  )

  const handleNavClick: MenuProps['onClick'] = ({ key }) => {
    for (const group of navGroups) {
      const entry = group.items.find((item) => item.key === key)
      if (entry) {
        navigate(entry.path)
        setMobileNavOpen(false)
        return
      }
    }
  }

  const sidebarMargin = collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_WIDTH

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

  const renderConversationList = (compact: boolean) => (
    <>
      {!compact && (
        <div
          style={{
            fontSize: 12,
            color: TEXT_TERTIARY,
            textTransform: 'uppercase',
            padding: '12px 16px 4px',
            letterSpacing: 0.5,
            fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
          }}
        >
          المحادثات السابقة
        </div>
      )}

      {convLoading ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <Spin />
        </div>
      ) : !conversations || conversations.length === 0 ? (
        !compact && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '8px 12px' }}>
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: TEXT_TERTIARY, fontSize: 13 }}>
                  لا توجد محادثات سابقة
                </span>
              }
            />
          </div>
        )
      ) : (
        <List
          dataSource={conversations}
          style={{ flex: 1, overflow: 'auto', padding: compact ? '0 8px' : '0 8px 12px' }}
          renderItem={(conv) => (
            <List.Item
              key={conv.id}
              style={{
                padding: compact ? '8px 4px' : '8px 10px',
                cursor: 'pointer',
                borderRadius: 8,
                background: activeConvId === conv.id ? GOLD_TINT : 'transparent',
                border: activeConvId === conv.id ? `1px solid ${GOLD_BORDER}` : '1px solid transparent',
                marginBottom: 4,
                display: 'flex',
                alignItems: 'center',
                justifyContent: compact ? 'center' : 'space-between',
                transition: 'all 0.2s',
              }}
              onClick={() => handleSelectConversation(conv.id)}
            >
              {compact ? (
                <Tooltip title={conv.title_ar || 'محادثة جديدة'} placement="left">
                  <MessageOutlined style={{ color: activeConvId === conv.id ? GOLD : TEXT_SECONDARY }} />
                </Tooltip>
              ) : (
                <>
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
                </>
              )}
            </List.Item>
          )}
        />
      )}
    </>
  )

  const RightSidebar = ({
    menuCollapsed = collapsed,
    showNewChatLabel = !collapsed,
  }: {
    menuCollapsed?: boolean
    showNewChatLabel?: boolean
  }) => (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        direction: 'rtl',
      }}
    >
      <div style={{ padding: menuCollapsed ? '12px 8px' : '12px 12px 8px' }}>
        {showNewChatLabel ? (
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
            }}
            onClick={() => {
              handleSelectConversation(null)
              setMobileNavOpen(false)
            }}
          >
            محادثة جديدة
          </Button>
        ) : (
          <Tooltip title="محادثة جديدة" placement="left">
            <Button
              type="primary"
              icon={<PlusOutlined />}
              block
              style={{ background: GOLD, borderColor: GOLD, color: '#000' }}
              onClick={() => {
                handleSelectConversation(null)
                setMobileNavOpen(false)
              }}
            />
          </Tooltip>
        )}
      </div>

      <Menu
        mode="inline"
        selectedKeys={[selectedNavKey]}
        defaultOpenKeys={navGroups.map((g) => g.id)}
        items={sidebarMenuItems}
        inlineCollapsed={menuCollapsed}
        onClick={handleNavClick}
        style={{
          background: 'transparent',
          border: 'none',
          flexShrink: 0,
          direction: 'rtl',
        }}
        theme={themeMode === 'dark' ? 'dark' : 'light'}
      />

      {isPro && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', borderTop: `1px solid ${BORDER_COLOR}` }}>
          {isPro && renderConversationList(menuCollapsed)}
        </div>
      )}
    </div>
  )

  return (
    <Layout style={{ minHeight: '100vh', background: DARK, direction: 'rtl' }}>
      {/* Right-side navigation menu (desktop) */}
      <Sider
        width={SIDEBAR_WIDTH}
        collapsedWidth={SIDEBAR_COLLAPSED}
        collapsed={collapsed}
        trigger={null}
        breakpoint="lg"
        onBreakpoint={(broken) => {
          if (broken) setCollapsed(true)
        }}
        className="user-layout-sider"
        style={{
          background: NAVY,
          borderLeft: `1px solid ${BORDER_COLOR}`,
          position: 'fixed',
          right: 0,
          top: 0,
          bottom: 0,
          zIndex: 100,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: 60,
            display: 'flex',
            alignItems: 'center',
            padding: collapsed ? '0 16px' : '0 20px',
            gap: 10,
            borderBottom: `1px solid ${BORDER_COLOR}`,
            justifyContent: collapsed ? 'center' : 'flex-start',
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 20 }}>⚖️</span>
          {!collapsed && (
            <Link
              to="/"
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: GOLD,
                letterSpacing: 2,
                fontFamily: "'Georgia', 'Times New Roman', serif",
                textDecoration: 'none',
              }}
            >
              LEXIA
            </Link>
          )}
        </div>

        <RightSidebar />
      </Sider>

      <Layout
        style={{
          marginRight: sidebarMargin,
          transition: 'margin-right 0.2s',
          background: DARK,
          minHeight: '100vh',
        }}
        className="user-layout-main"
      >
        <Header
          className="glass"
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 99,
            height: 60,
            padding: '0 20px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            direction: 'rtl',
            flexShrink: 0,
          }}
        >
          <Space>
            <Button
              type="text"
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed(!collapsed)}
              style={{ color: TEXT_SECONDARY }}
              className="user-layout-collapse-btn"
            />
            <Button
              type="text"
              icon={<MenuUnfoldOutlined />}
              onClick={() => setMobileNavOpen(true)}
              style={{ color: TEXT_SECONDARY }}
              className="user-layout-mobile-nav-btn"
            />
          </Space>

          <Space style={{ flexShrink: 0 }}>
            <ThemeToggle />

            {isPro && (
              <Tooltip title="المحادثات السابقة">
                <Button
                  type="text"
                  icon={<HistoryOutlined />}
                  style={{ color: TEXT_SECONDARY }}
                  className="user-layout-mobile-history-btn"
                  onClick={() => setHistoryOpen(true)}
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
                  <Badge dot color={GOLD} offset={[-2, 2]}>
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

            <Tooltip title="قائمة التطبيق">
              <Badge count={activeTaskCount} size="small" offset={[-2, 2]}>
                <Button
                  type="text"
                  icon={<AppstoreOutlined />}
                  style={{ color: TEXT_SECONDARY }}
                  onClick={() => setApplicationMenuOpen(true)}
                />
              </Badge>
            </Tooltip>
          </Space>
        </Header>

        <Content style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
          <Outlet
            context={{
              conversationId: activeConvId,
              setConversationId: setActiveConvId,
              refetchConversations,
            }}
          />
        </Content>
      </Layout>

      {/* Mobile right-side menu drawer */}
      <Drawer
        title={
          <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: GOLD }}>
            القائمة
          </span>
        }
        placement="right"
        onClose={() => setMobileNavOpen(false)}
        open={mobileNavOpen}
        width={280}
        styles={{
          body: { padding: 0, background: NAVY },
          header: { background: NAVY, borderBottom: `1px solid ${BORDER_COLOR}` },
          mask: { background: 'var(--color-mask)' },
        }}
        className="user-layout-mobile-drawer"
      >
        <RightSidebar menuCollapsed={false} showNewChatLabel />
      </Drawer>

      {/* Mobile conversation history drawer */}
      <Drawer
        title={
          <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: GOLD }}>
            المحادثات السابقة
          </span>
        }
        placement="right"
        onClose={() => setHistoryOpen(false)}
        open={historyOpen}
        width={280}
        styles={{
          body: { padding: 0, background: NAVY },
          header: { background: NAVY, borderBottom: `1px solid ${BORDER_COLOR}` },
          mask: { background: 'var(--color-mask)' },
        }}
      >
        <div style={{ padding: '12px', direction: 'rtl' }}>
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
              marginBottom: 12,
            }}
            onClick={() => handleSelectConversation(null)}
          >
            محادثة جديدة
          </Button>
          {renderConversationList(false)}
        </div>
      </Drawer>

      <ApplicationMenu
        open={applicationMenuOpen}
        onClose={() => setApplicationMenuOpen(false)}
        isAdmin={isAdmin}
        hasToken={!!token}
        activeTaskCount={activeTaskCount}
      />
    </Layout>
  )
}
