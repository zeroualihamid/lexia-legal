import React, { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ConfigProvider, theme, Spin } from 'antd'
import Keycloak from 'keycloak-js'
import { useAuthStore } from './shared/store/authStore'
import { UserLayout } from './apps/user/layout/UserLayout'
import { ChatPage } from './apps/user/chat/ChatPage'
import { SearchPage } from './apps/user/search/SearchPage'
import { BillingPage } from './apps/user/billing/BillingPage'
import { AdminLayout } from './apps/admin/layout/AdminLayout'
import { AdminDashboard } from './apps/admin/AdminDashboard'
import { DocumentsPage } from './apps/admin/documents/DocumentsPage'
import { ScraperPage } from './apps/admin/scraper/ScraperPage'
import { AgentPage } from './apps/admin/agent/AgentPage'
import { AnalyticsPage } from './apps/admin/analytics/AnalyticsPage'
import { UsersPage } from './apps/admin/users/UsersPage'
import { DARK, GOLD, NAVY } from './shared/constants'

const keycloakConfig = {
  url: import.meta.env.VITE_KEYCLOAK_URL || 'http://localhost:8080',
  realm: import.meta.env.VITE_KEYCLOAK_REALM || 'lexia',
  clientId: import.meta.env.VITE_KEYCLOAK_CLIENT_ID || 'lexia-frontend',
}

export default function App() {
  const setAuth = useAuthStore((s) => s.setAuth)
  const [keycloakReady, setKeycloakReady] = useState(false)

  useEffect(() => {
    const kc = new Keycloak(keycloakConfig)

    kc.init({
      onLoad: 'check-sso',
      silentCheckSsoRedirectUri: window.location.origin + '/silent-check-sso.html',
      pkceMethod: 'S256',
    })
      .then((authenticated) => {
        if (authenticated && kc.token) {
          const parsed = kc.tokenParsed as any
          const roles: string[] = parsed?.realm_access?.roles || []
          let accessLevel: 'PUBLIC' | 'PRO' | 'ADMIN' | 'SUPERADMIN' = 'PUBLIC'
          if (roles.includes('superadmin')) accessLevel = 'SUPERADMIN'
          else if (roles.includes('admin')) accessLevel = 'ADMIN'
          else if (roles.includes('pro')) accessLevel = 'PRO'

          setAuth({
            token: kc.token,
            userId: parsed?.sub || null,
            email: parsed?.email || null,
            accessLevel,
            keycloak: kc,
          })
        } else {
          setAuth({ keycloak: kc })
        }

        kc.onTokenExpired = () => {
          kc.updateToken(60).then((refreshed) => {
            if (refreshed && kc.token) {
              setAuth({ token: kc.token })
            }
          }).catch(() => {
            setAuth({ token: null, userId: null, email: null, accessLevel: 'PUBLIC' })
          })
        }

        setKeycloakReady(true)
      })
      .catch(() => {
        setAuth({ keycloak: kc })
        setKeycloakReady(true)
      })
  }, [setAuth])

  if (!keycloakReady) {
    return (
      <div
        style={{
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: DARK,
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <div style={{ fontSize: 32 }}>⚖️</div>
        <Spin size="large" />
        <div style={{ color: GOLD, fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", fontSize: 16 }}>
          المنصة القانونية
        </div>
      </div>
    )
  }

  return (
    <ConfigProvider
      direction="rtl"
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: GOLD,
          colorBgBase: DARK,
          colorBgContainer: '#0d1b2e',
          colorBgElevated: '#0f2040',
          colorBorder: 'rgba(201, 168, 76, 0.2)',
          colorBorderSecondary: 'rgba(255,255,255,0.08)',
          colorText: 'rgba(255,255,255,0.85)',
          colorTextSecondary: 'rgba(255,255,255,0.55)',
          borderRadius: 8,
          fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
        },
        components: {
          Menu: {
            darkItemBg: NAVY,
            darkSubMenuItemBg: '#07111f',
            itemBg: NAVY,
            subMenuItemBg: '#07111f',
          },
          Table: {
            headerBg: '#0a1628',
            rowHoverBg: 'rgba(201, 168, 76, 0.05)',
          },
          Card: {
            colorBgContainer: '#0d1b2e',
          },
          Modal: {
            contentBg: '#0d1b2e',
            headerBg: '#0d1b2e',
          },
          Drawer: {
            colorBgContainer: '#0d1b2e',
          },
        },
      }}
    >
      <BrowserRouter>
        <Routes>
          <Route element={<UserLayout />}>
            <Route path="/" element={<ChatPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/billing" element={<BillingPage />} />
          </Route>
          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<AdminDashboard />} />
            <Route path="documents" element={<DocumentsPage />} />
            <Route path="scraper" element={<ScraperPage />} />
            <Route path="agent" element={<AgentPage />} />
            <Route path="users" element={<UsersPage />} />
            <Route path="analytics" element={<AnalyticsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </ConfigProvider>
  )
}
