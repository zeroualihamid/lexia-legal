import React, { useState } from 'react'
import { Outlet, useNavigate, useLocation, Link } from 'react-router-dom'
import { Layout, Menu, Button, Avatar, Dropdown, Badge, Tooltip, Space } from 'antd'
import {
  DashboardOutlined,
  FileTextOutlined,
  FileSearchOutlined,
  CloudDownloadOutlined,
  RobotOutlined,
  TeamOutlined,
  BarChartOutlined,
  BellOutlined,
  LogoutOutlined,
  UserOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import { useAuthStore } from '../../../shared/store/authStore'
import { useThemeStore } from '../../../shared/store/themeStore'
import { GOLD, DARK, NAVY, BORDER_COLOR, TEXT_SECONDARY, TEXT_TERTIARY } from '../../../shared/constants'
import { ThemeToggle } from '../../../shared/components/ThemeToggle'

const { Sider, Header, Content } = Layout

export function AdminLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const { email, accessLevel, keycloak, logout } = useAuthStore()
  const themeMode = useThemeStore((s) => s.mode)
  const [collapsed, setCollapsed] = useState(false)

  const isSuperAdmin = accessLevel === 'SUPERADMIN'

  const menuItems = [
    {
      key: '/admin',
      icon: <DashboardOutlined />,
      label: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>لوحة التحكم</span>,
    },
    {
      key: '/admin/documents',
      icon: <FileTextOutlined />,
      label: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الوثائق</span>,
    },
    {
      key: '/admin/scraper',
      icon: <CloudDownloadOutlined />,
      label: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>استخراج البيانات</span>,
    },
    {
      key: '/admin/agent',
      icon: <RobotOutlined />,
      label: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>إعداد الوكيل</span>,
    },
    {
      key: '/admin/judgment-analysis',
      icon: <FileSearchOutlined />,
      label: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>تحليل الأحكام</span>,
    },
    ...(isSuperAdmin
      ? [
          {
            key: '/admin/users',
            icon: <TeamOutlined />,
            label: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>المستخدمون</span>,
          },
        ]
      : []),
    {
      key: '/admin/analytics',
      icon: <BarChartOutlined />,
      label: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الإحصائيات</span>,
    },
  ]

  const userMenuItems = [
    {
      key: 'user',
      label: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>{email}</span>,
      icon: <UserOutlined />,
      disabled: true,
    },
    {
      key: 'frontend',
      label: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>العودة للمنصة</span>,
      icon: <SettingOutlined />,
    },
    { type: 'divider' as const },
    {
      key: 'logout',
      label: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>تسجيل الخروج</span>,
      icon: <LogoutOutlined />,
      danger: true,
    },
  ]

  const handleMenuClick = ({ key }: { key: string }) => {
    if (key === 'logout') {
      logout()
      if (keycloak) keycloak.logout()
    } else if (key === 'frontend') {
      navigate('/')
    }
  }

  const selectedKey = menuItems.find((m) => location.pathname === m.key)?.key ||
    menuItems.find((m) => m.key !== '/admin' && location.pathname.startsWith(m.key))?.key ||
    '/admin'

  return (
    <Layout style={{ minHeight: '100vh', background: DARK, direction: 'rtl' }}>
      {/* Sidebar */}
      <Sider
        width={240}
        collapsedWidth={64}
        collapsed={collapsed}
        trigger={null}
        style={{
          background: NAVY,
          borderLeft: `1px solid ${BORDER_COLOR}`,
          position: 'fixed',
          right: 0,
          top: 0,
          bottom: 0,
          zIndex: 100,
          overflow: 'auto',
        }}
      >
        {/* Logo */}
        <div
          style={{
            height: 60,
            display: 'flex',
            alignItems: 'center',
            padding: collapsed ? '0 20px' : '0 20px',
            gap: 10,
            borderBottom: `1px solid ${BORDER_COLOR}`,
            justifyContent: collapsed ? 'center' : 'flex-start',
          }}
        >
          <span style={{ fontSize: 20 }}>⚖️</span>
          {!collapsed && (
            <span
              style={{
                fontSize: 15,
                fontWeight: 700,
                color: GOLD,
                fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
                whiteSpace: 'nowrap',
              }}
            >
              لوحة الإدارة
            </span>
          )}
        </div>

        <Menu
          mode="inline"
          selectedKeys={[selectedKey]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
          style={{
            background: 'transparent',
            border: 'none',
            marginTop: 8,
            direction: 'rtl',
          }}
          theme={themeMode === 'dark' ? 'dark' : 'light'}
        />
      </Sider>

      {/* Main area */}
      <Layout
        style={{
          marginRight: collapsed ? 64 : 240,
          transition: 'margin-right 0.2s',
          background: DARK,
        }}
      >
        {/* Header */}
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
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Button
              type="text"
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed(!collapsed)}
              style={{ color: TEXT_SECONDARY }}
            />

            {/* Breadcrumb */}
            <span
              style={{
                fontSize: 15,
                color: TEXT_SECONDARY,
                fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
              }}
            >
              {menuItems.find((m) => m.key === selectedKey)?.label}
            </span>
          </div>

          <Space>
            <ThemeToggle />

            {/* Language toggle */}
            <Button
              type="text"
              style={{ color: TEXT_TERTIARY, fontFamily: "'Cairo', sans-serif", fontSize: 13 }}
            >
              FR / AR
            </Button>

            {/* Notifications */}
            <Tooltip title="الإشعارات">
              <Badge count={3} size="small">
                <Button
                  type="text"
                  icon={<BellOutlined />}
                  style={{ color: TEXT_SECONDARY }}
                />
              </Badge>
            </Tooltip>

            {/* User menu */}
            <Dropdown
              menu={{ items: userMenuItems, onClick: handleMenuClick }}
              placement="bottomLeft"
              trigger={['click']}
            >
              <div style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}>
                <Avatar
                  size={32}
                  style={{ background: `${GOLD}30`, color: GOLD, fontWeight: 700, cursor: 'pointer' }}
                >
                  {email?.[0]?.toUpperCase() || 'A'}
                </Avatar>
                {!collapsed && (
                  <span
                    style={{
                      fontSize: 13,
                      color: TEXT_SECONDARY,
                      fontFamily: "'Cairo', sans-serif",
                      maxWidth: 120,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {email}
                  </span>
                )}
              </div>
            </Dropdown>
          </Space>
        </Header>

        {/* Content */}
        <Content
          style={{
            padding: 24,
            minHeight: 'calc(100vh - 60px)',
            direction: 'rtl',
          }}
        >
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
