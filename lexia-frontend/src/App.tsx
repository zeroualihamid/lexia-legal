import React, { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { App as AntApp, ConfigProvider, theme, Spin } from 'antd'
import Keycloak from 'keycloak-js'
import { useAuthStore } from './shared/store/authStore'
import { useThemeStore } from './shared/store/themeStore'
import { UserLayout } from './apps/user/layout/UserLayout'
import { ChatPage } from './apps/user/chat/ChatPage'
import { SearchPage } from './apps/user/search/SearchPage'
import { BillingPage } from './apps/user/billing/BillingPage'
import { CasesPage } from './apps/user/cases/CasesPage'
import { CaseWorkspace } from './apps/user/cases/CaseWorkspace'
import { AdminLayout } from './apps/admin/layout/AdminLayout'
import { AdminDashboard } from './apps/admin/AdminDashboard'
import { DocumentsPage } from './apps/admin/documents/DocumentsPage'
import { ScraperPage } from './apps/admin/scraper/ScraperPage'
import { AgentPage } from './apps/admin/agent/AgentPage'
import { AnalyticsPage } from './apps/admin/analytics/AnalyticsPage'
import { UsersPage } from './apps/admin/users/UsersPage'
import { JudgmentAnalysisPage } from './apps/admin/judgment-analysis/JudgmentAnalysisPage'
import { DARK, GOLD } from './shared/constants'
import { APP_BASE, appPath } from './shared/basePath'
import { RequireAuth } from './shared/components/RequireAuth'

const keycloakConfig = {
  url: import.meta.env.VITE_KEYCLOAK_URL || 'http://localhost:8080',
  realm: import.meta.env.VITE_KEYCLOAK_REALM || 'legal-ai',
  clientId: import.meta.env.VITE_KEYCLOAK_CLIENT_ID || 'legal-ai-frontend',
}

const keycloak = new Keycloak(keycloakConfig)
let keycloakInitPromise: Promise<boolean> | null = null

const cleanCurrentUrl = () => `${window.location.origin}${window.location.pathname}${window.location.search}`

const hasKeycloakCallbackHash = () => {
  const hash = window.location.hash
  return hash.includes('state=') && hash.includes('session_state=') && hash.includes('code=')
}

const clearKeycloakCallbackHash = () => {
  if (hasKeycloakCallbackHash()) {
    window.history.replaceState(null, document.title, cleanCurrentUrl())
  }
}

const ensureKeycloakInit = () => {
  if (!keycloakInitPromise) {
    keycloakInitPromise = keycloak.init({
      onLoad: 'check-sso',
      silentCheckSsoRedirectUri: window.location.origin + appPath('/silent-check-sso.html'),
      pkceMethod: 'S256',
    })
  }
  return keycloakInitPromise
}

function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { token, accessLevel, keycloak } = useAuthStore()

  useEffect(() => {
    if (!token && keycloak) {
      keycloak.login({ redirectUri: cleanCurrentUrl() })
    }
  }, [keycloak, token])

  if (!token) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: DARK,
          color: GOLD,
          fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
        }}
      >
        جارٍ تحويلك إلى تسجيل الدخول...
      </div>
    )
  }

  if (accessLevel !== 'ADMIN' && accessLevel !== 'SUPERADMIN') {
    return <Navigate to="/" replace />
  }

  return <>{children}</>
}

export default function App() {
  const setAuth = useAuthStore((s) => s.setAuth)
  const themeMode = useThemeStore((s) => s.mode)
  const [keycloakReady, setKeycloakReady] = useState(false)

  // Reflect the active theme on <html> so CSS variables in index.css resolve correctly.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', themeMode)
  }, [themeMode])

  useEffect(() => {
    const kc = keycloak

    ensureKeycloakInit()
      .then((authenticated) => {
        clearKeycloakCallbackHash()

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
            kc.login({ redirectUri: cleanCurrentUrl() })
          })
        }

        setKeycloakReady(true)
      })
      .catch(() => {
        clearKeycloakCallbackHash()
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

  const isDark = themeMode === 'dark'

  return (
    <ConfigProvider
      direction="rtl"
      theme={{
        algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: GOLD,
          colorBgBase: 'var(--color-bg-base)',
          colorBgContainer: 'var(--color-bg-card)',
          colorBgElevated: 'var(--color-bg-elevated)',
          colorBorder: 'var(--color-border)',
          colorBorderSecondary: 'var(--color-border-subtle)',
          colorText: 'var(--color-text-primary)',
          colorTextSecondary: 'var(--color-text-secondary)',
          borderRadius: 8,
          fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
        },
        components: {
          Menu: {
            darkItemBg: 'var(--color-bg-sidebar)',
            darkSubMenuItemBg: 'var(--color-bg-deep)',
            itemBg: 'var(--color-bg-sidebar)',
            subMenuItemBg: 'var(--color-bg-deep)',
          },
          Table: {
            headerBg: 'var(--color-bg-sidebar)',
            rowHoverBg: 'var(--color-gold-tint)',
          },
          Card: {
            colorBgContainer: 'var(--color-bg-card)',
          },
          Modal: {
            contentBg: 'var(--color-bg-card)',
            headerBg: 'var(--color-bg-card)',
          },
          Drawer: {
            colorBgContainer: 'var(--color-bg-card)',
          },
        },
      }}
    >
      <AntApp>
        <BrowserRouter basename={APP_BASE || undefined}>
          <Routes>
            <Route element={<RequireAuth />}>
              <Route element={<UserLayout />}>
                <Route path="/" element={<ChatPage />} />
                <Route path="/cases" element={<CasesPage />} />
                <Route path="/cases/:id" element={<CaseWorkspace />} />
                <Route path="/search" element={<SearchPage />} />
                <Route path="/billing" element={<BillingPage />} />
              </Route>
            </Route>
            <Route path="/admin" element={<RequireAdmin><AdminLayout /></RequireAdmin>}>
              <Route index element={<AdminDashboard />} />
              <Route path="documents" element={<DocumentsPage />} />
              <Route path="scraper" element={<ScraperPage />} />
              <Route path="agent" element={<AgentPage />} />
              <Route path="judgment-analysis" element={<JudgmentAnalysisPage />} />
              <Route path="users" element={<UsersPage />} />
              <Route path="analytics" element={<AnalyticsPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  )
}
