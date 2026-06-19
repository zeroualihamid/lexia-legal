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
import { TasksPage } from './apps/user/tasks/TasksPage'
import { ComingSoonPage } from './apps/user/shared/ComingSoonPage'
import { AdminLayout } from './apps/admin/layout/AdminLayout'
import { AdminDashboard } from './apps/admin/AdminDashboard'
import { DocumentsPage } from './apps/admin/documents/DocumentsPage'
import { ScraperPage } from './apps/admin/scraper/ScraperPage'
import { AgentPage } from './apps/admin/agent/AgentPage'
import { AnalyticsPage } from './apps/admin/analytics/AnalyticsPage'
import { UsersPage } from './apps/admin/users/UsersPage'
import { JudgmentAnalysisPage } from './apps/admin/judgment-analysis/JudgmentAnalysisPage'
import { LegalGraphsPage } from './apps/admin/legal-graphs/LegalGraphsPage'
import { DARK, GOLD } from './shared/constants'
import { APP_BASE, appPath } from './shared/basePath'
import { AdminLoginPage } from './apps/admin/AdminLoginPage'
import { readAdminSession, clearAdminSession, type AdminSession } from './shared/auth/adminSession'
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
      // Disable the session-status iframe: it polls Keycloak in a hidden iframe
      // and reloads the page when the session-state cookie appears to change.
      // Under third-party-cookie restrictions (SPA and Keycloak on different
      // origins/ports) this misfires and causes an infinite refresh loop.
      // Token freshness is handled by onTokenExpired/updateToken below.
      checkLoginIframe: false,
    })
  }
  return keycloakInitPromise
}

function applyAdminSession(session: AdminSession, setAuth: ReturnType<typeof useAuthStore.getState>['setAuth']) {
  setAuth({
    token: session.token,
    userId: session.userId,
    email: session.email,
    accessLevel: session.accessLevel,
  })
}

function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { token, email, accessLevel, setAuth } = useAuthStore()
  const [adminSession, setAdminSession] = useState<AdminSession | null>(() => readAdminSession())

  useEffect(() => {
    const stored = readAdminSession()
    if (stored) {
      setAdminSession(stored)
      applyAdminSession(stored, setAuth)
    }
  }, [setAuth])

  useEffect(() => {
    if (adminSession && adminSession.token !== token) {
      applyAdminSession(adminSession, setAuth)
    }
  }, [adminSession, token, setAuth])

  const handleAdminLogin = (session: AdminSession) => {
    applyAdminSession(session, setAuth)
    setAdminSession(session)
  }

  const isAdmin =
    adminSession?.accessLevel === 'ADMIN' ||
    adminSession?.accessLevel === 'SUPERADMIN' ||
    accessLevel === 'ADMIN' ||
    accessLevel === 'SUPERADMIN'

  if (!isAdmin) {
    return (
      <AdminLoginPage
        onSuccess={handleAdminLogin}
        currentEmail={token && (accessLevel === 'PRO' || accessLevel === 'PUBLIC') ? email : null}
      />
    )
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
          // These tokens MUST be real, parseable colors — NOT `var(--…)` strings.
          // Ant Design runs color math on them (e.g. Tag's defaultBg does
          // `FastColor(colorFillQuaternary).onBackground(colorBgContainer)`, Segmented's
          // track derives from colorBgBase). A CSS-variable string can't be parsed, so
          // that math falls back to black → black-on-black default Tags / Segmented track.
          // Values mirror the --color-* vars in index.css for each theme; ConfigProvider
          // re-renders on theme toggle (isDark), so they stay in sync.
          colorBgBase: isDark ? '#060d18' : '#f5f6f8',
          colorTextBase: isDark ? '#ffffff' : '#000000',
          colorBgContainer: isDark ? '#0d1b2e' : '#ffffff',
          colorBgElevated: isDark ? '#0f2040' : '#ffffff',
          colorBorder: isDark ? 'rgba(201, 168, 76, 0.2)' : 'rgba(201, 168, 76, 0.35)',
          colorBorderSecondary: isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.08)',
          colorText: isDark ? 'rgba(255, 255, 255, 0.85)' : 'rgba(0, 0, 0, 0.88)',
          colorTextSecondary: isDark ? 'rgba(255, 255, 255, 0.55)' : 'rgba(0, 0, 0, 0.6)',
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
                <Route path="/tasks" element={<TasksPage />} />
                <Route path="/search" element={<SearchPage />} />
                <Route path="/billing" element={<BillingPage />} />
                <Route path="/drafting" element={<ComingSoonPage title="المولّد والصياغة" description="نماذج تلقائية لطلبات المحكمة وعقود الإيجار والعمل والإنذارات." />} />
                <Route path="/clients" element={<ComingSoonPage title="إدارة الموكّلين" description="قاعدة بيانات جهات الاتصال وسجل المراسلات وربطها بالملفات." />} />
                <Route path="/sessions" element={<ComingSoonPage title="إدارة الجلسات" description="جدول الجلسات وتعيين المحاكم والتذكيرات التلقائية." />} />
                <Route path="/tools/severance" element={<ComingSoonPage title="حاسبة تعويضات الإنهاء" description="محاكاة الحقوق المالية للأجراء وفق مدونة الشغل المغربية." />} />
                <Route path="/tools/notary" element={<ComingSoonPage title="حاسبة رسوم التوثيق" description="تقدير رسوم التسجيل والتوثيق للمعاملات العقارية والرسمية." />} />
                <Route path="/tools/salary" element={<ComingSoonPage title="حاسبة الراتب والضريبة" description="تقدير صافي الأجر وضريبة الدخل." />} />
                <Route path="/history" element={<ComingSoonPage title="سجل البحث" description="سجل الاستعلامات السابقة والوثائق التي تم تحليلها." />} />
                <Route path="/directory" element={<ComingSoonPage title="دليل المحامين" description="قائمة المحامين المرجعيين على المنصة." />} />
              </Route>
            </Route>
            <Route path="/admin" element={<RequireAdmin><AdminLayout /></RequireAdmin>}>
              <Route index element={<AdminDashboard />} />
              <Route path="documents" element={<DocumentsPage />} />
              <Route path="scraper" element={<ScraperPage />} />
              <Route path="agent" element={<AgentPage />} />
              <Route path="judgment-analysis" element={<JudgmentAnalysisPage />} />
              <Route path="legal-graphs" element={<LegalGraphsPage />} />
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
