import React, { useCallback } from 'react'
import { Outlet } from 'react-router-dom'
import { Button, Space } from 'antd'
import { LoginOutlined, UserAddOutlined } from '@ant-design/icons'
import { useAuthStore } from '../store/authStore'
import { DARK, GOLD } from '../constants'

const redirectUri = () =>
  `${window.location.origin}${window.location.pathname}${window.location.search}`

export function RequireAuth() {
  const { token, keycloak } = useAuthStore()

  const handleLogin = useCallback(() => {
    keycloak?.login({ redirectUri: redirectUri() })
  }, [keycloak])

  const handleRegister = useCallback(() => {
    keycloak?.register({ redirectUri: redirectUri() })
  }, [keycloak])

  if (token) {
    return <Outlet />
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: DARK,
        padding: 24,
        direction: 'rtl',
      }}
    >
      <div
        style={{
          maxWidth: 440,
          width: '100%',
          textAlign: 'center',
          padding: '48px 32px',
          borderRadius: 16,
          border: '1px solid var(--color-border)',
          background: 'var(--color-bg-card)',
        }}
      >
        <div style={{ fontSize: 56, marginBottom: 16 }}>⚖️</div>
        <h1
          style={{
            margin: '0 0 12px',
            fontSize: 26,
            fontWeight: 700,
            color: GOLD,
            fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
          }}
        >
          المنصة القانونية
        </h1>
        <p
          style={{
            margin: '0 0 32px',
            fontSize: 15,
            lineHeight: 1.8,
            color: 'var(--color-text-secondary)',
            fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
          }}
        >
          يُرجى تسجيل الدخول أو إنشاء حساب للوصول إلى المنصة والاستفادة من المساعد القانوني
        </p>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Button
            type="primary"
            size="large"
            block
            icon={<LoginOutlined />}
            onClick={handleLogin}
            style={{
              height: 48,
              background: GOLD,
              borderColor: GOLD,
              color: '#000',
              fontWeight: 600,
              fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
            }}
          >
            تسجيل الدخول
          </Button>
          <Button
            size="large"
            block
            icon={<UserAddOutlined />}
            onClick={handleRegister}
            style={{
              height: 48,
              fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
            }}
          >
            إنشاء حساب
          </Button>
        </Space>
      </div>
    </div>
  )
}
