import React, { useState } from 'react'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
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
import { clearAdminSession } from '../../../shared/auth/adminSession'
import { appPath } from '../../../shared/basePath'
import { useThemeStore } from '../../../shared/store/themeStore'
import { GOLD, DARK, NAVY, BORDER_COLOR, TEXT_SECONDARY, TEXT_TERTIARY } from '../../../shared/constants'
import { ThemeToggle } from '../../../shared/components/ThemeToggle'
import { AdminLocaleProvider } from '../locale/AdminLocaleProvider'
import { useAdminUi } from '../locale/useAdminI18n'

const { Sider, Header, Content } = Layout

function AdminLanguageSwitcher() {
  const { locale, setLocale, font, t } = useAdminUi()

  return (
    <Space size={4}>
      <Button
        type={locale === 'fr' ? 'primary' : 'text'}
        size="small"
        onClick={() => setLocale('fr')}
        style={
          locale === 'fr'
            ? { background: GOLD, borderColor: GOLD, color: '#000', fontFamily: font, fontWeight: 600 }
            : { color: TEXT_TERTIARY, fontFamily: font }
        }
      >
        FR
      </Button>
      <span style={{ color: TEXT_TERTIARY, fontSize: 12 }}>/</span>
      <Button
        type={locale === 'ar' ? 'primary' : 'text'}
        size="small"
        onClick={() => setLocale('ar')}
        style={
          locale === 'ar'
            ? { background: GOLD, borderColor: GOLD, color: '#000', fontFamily: font, fontWeight: 600 }
            : { color: TEXT_TERTIARY, fontFamily: font }
        }
      >
        AR
      </Button>
      <Tooltip title={t.common.switchLanguage}>
        <span style={{ color: TEXT_TERTIARY, fontFamily: font, fontSize: 12, marginInlineStart: 4 }}>
          {locale === 'fr' ? t.common.languageFr : t.common.languageAr}
        </span>
      </Tooltip>
    </Space>
  )
}

function AdminShell() {
  const navigate = useNavigate()
  const location = useLocation()
  const { email, logout } = useAuthStore()
  const themeMode = useThemeStore((s) => s.mode)
  const [collapsed, setCollapsed] = useState(false)
  const { t, font, dir, isRtl, textAlign } = useAdminUi()

  const menuItems = [
    { key: '/admin', icon: <DashboardOutlined />, label: t.menu.dashboard },
    { key: '/admin/documents', icon: <FileTextOutlined />, label: t.menu.documents },
    { key: '/admin/scraper', icon: <CloudDownloadOutlined />, label: t.menu.scraper },
    { key: '/admin/agent', icon: <RobotOutlined />, label: t.menu.agent },
    { key: '/admin/judgment-analysis', icon: <FileSearchOutlined />, label: t.menu.judgmentAnalysis },
    { key: '/admin/users', icon: <TeamOutlined />, label: t.menu.users },
    { key: '/admin/analytics', icon: <BarChartOutlined />, label: t.menu.analytics },
  ]

  const userMenuItems = [
    { key: 'user', label: email || 'Admin', icon: <UserOutlined />, disabled: true },
    { key: 'frontend', label: t.common.backToPlatform, icon: <SettingOutlined /> },
    { type: 'divider' as const },
    { key: 'logout', label: t.common.logout, icon: <LogoutOutlined />, danger: true },
  ]

  const handleMenuClick = ({ key }: { key: string }) => {
    if (key === 'logout') {
      clearAdminSession()
      logout()
      window.location.assign(appPath('/admin'))
    } else if (key === 'frontend') {
      navigate('/')
    }
  }

  const selectedKey =
    menuItems.find((m) => location.pathname === m.key)?.key ||
    menuItems.find((m) => m.key !== '/admin' && location.pathname.startsWith(m.key))?.key ||
    '/admin'

  const pageTitle = menuItems.find((m) => m.key === selectedKey)?.label || t.menu.dashboard
  const siderWidth = collapsed ? 64 : 240

  const siderStyle: React.CSSProperties = {
    background: NAVY,
    position: 'fixed',
    top: 0,
    bottom: 0,
    zIndex: 100,
    overflow: 'auto',
    ...(isRtl
      ? { right: 0, borderLeft: `1px solid ${BORDER_COLOR}` }
      : { left: 0, borderRight: `1px solid ${BORDER_COLOR}` }),
  }

  const mainStyle: React.CSSProperties = {
    transition: 'margin 0.2s',
    background: DARK,
    ...(isRtl ? { marginRight: siderWidth } : { marginLeft: siderWidth }),
  }

  return (
    <Layout style={{ minHeight: '100vh', background: DARK, direction: dir }}>
      <Sider width={240} collapsedWidth={64} collapsed={collapsed} trigger={null} style={siderStyle}>
        <div
          style={{
            height: 60,
            display: 'flex',
            alignItems: 'center',
            padding: '0 20px',
            gap: 10,
            borderBottom: `1px solid ${BORDER_COLOR}`,
            justifyContent: collapsed ? 'center' : 'flex-start',
          }}
        >
          <span style={{ fontSize: 20 }}>⚖️</span>
          {!collapsed && (
            <span style={{ fontSize: 14, fontWeight: 700, color: GOLD, fontFamily: font, whiteSpace: 'nowrap' }}>
              {t.menu.panelTitle}
            </span>
          )}
        </div>

        <Menu
          mode="inline"
          selectedKeys={[selectedKey]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
          style={{ background: 'transparent', border: 'none', marginTop: 8, direction: dir, textAlign }}
          theme={themeMode === 'dark' ? 'dark' : 'light'}
        />
      </Sider>

      <Layout style={mainStyle}>
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
            direction: dir,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Button
              type="text"
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed(!collapsed)}
              style={{ color: TEXT_SECONDARY }}
            />
            <span style={{ fontSize: 15, color: TEXT_SECONDARY, fontFamily: font }}>{pageTitle}</span>
          </div>

          <Space>
            <ThemeToggle />
            <AdminLanguageSwitcher />
            <Tooltip title={t.common.notifications}>
              <Badge count={3} size="small">
                <Button type="text" icon={<BellOutlined />} style={{ color: TEXT_SECONDARY }} />
              </Badge>
            </Tooltip>
            <Dropdown menu={{ items: userMenuItems, onClick: handleMenuClick }} placement="bottomRight" trigger={['click']}>
              <div style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}>
                <Avatar size={32} style={{ background: `${GOLD}30`, color: GOLD, fontWeight: 700 }}>
                  {email?.[0]?.toUpperCase() || 'A'}
                </Avatar>
                <span
                  style={{
                    fontSize: 13,
                    color: TEXT_SECONDARY,
                    fontFamily: font,
                    maxWidth: 120,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {email}
                </span>
              </div>
            </Dropdown>
          </Space>
        </Header>

        <Content style={{ padding: 24, minHeight: 'calc(100vh - 60px)', direction: dir, textAlign }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}

export function AdminLayout() {
  return (
    <AdminLocaleProvider>
      <AdminShell />
    </AdminLocaleProvider>
  )
}
