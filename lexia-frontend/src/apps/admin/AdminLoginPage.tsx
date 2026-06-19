import React, { useState, useEffect } from 'react';
import { Button, Form, Input, Alert, ConfigProvider } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { appPath } from '../../shared/basePath';
import { DARK, GOLD, NAVY, BORDER_COLOR } from '../../shared/constants';
import { loginAdmin, type AdminSession } from '../../shared/auth/adminSession';

const frenchLtrTheme = {
  token: {
    fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
  },
};

interface AdminLoginPageProps {
  onSuccess: (session: AdminSession) => void;
  currentEmail?: string | null;
}

export function AdminLoginPage({ onSuccess, currentEmail }: AdminLoginPageProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    const html = document.documentElement;
    const prevDir = html.getAttribute('dir');
    html.setAttribute('dir', 'ltr');
    return () => {
      if (prevDir) html.setAttribute('dir', prevDir);
      else html.setAttribute('dir', 'rtl');
    };
  }, []);

  const onFinish = async (values: { username: string; password: string }) => {
    setLoading(true);
    setError(null);
    try {
      const session = await loginAdmin(values.username.trim(), values.password);
      onSuccess(session);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Échec de connexion');
    } finally {
      setLoading(false);
    }
  };

  return (
    <ConfigProvider direction="ltr" theme={frenchLtrTheme}>
      <div
        className="admin-login-page"
        lang="fr"
        dir="ltr"
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: DARK,
          padding: 24,
          direction: 'ltr',
          textAlign: 'left',
        }}
      >
        <div
          style={{
            width: '100%',
            maxWidth: 400,
            padding: 32,
            borderRadius: 16,
            border: `1px solid ${BORDER_COLOR}`,
            background: NAVY,
            textAlign: 'left',
          }}
        >
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>⚖️</div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: GOLD }}>
              Administration Lexia Legal
            </h1>
            <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--color-text-secondary)' }}>
              Connectez-vous avec un compte administrateur
            </p>
          </div>

          {currentEmail && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16, textAlign: 'left' }}
              message={`Compte actuel : ${currentEmail}`}
              description="Ce compte n'a pas accès à l'administration. Utilisez un compte admin ci-dessous."
            />
          )}

          <Form
            form={form}
            layout="vertical"
            onFinish={onFinish}
            initialValues={{ username: 'admin', password: 'admin' }}
            requiredMark={false}
            style={{ textAlign: 'left' }}
          >
            <Form.Item
              name="username"
              label={<span style={{ color: 'var(--color-text-secondary)' }}>Identifiant</span>}
              rules={[{ required: true, message: 'Identifiant requis' }]}
            >
              <Input
                prefix={<UserOutlined />}
                placeholder="admin"
                autoComplete="username"
                size="large"
                style={{ textAlign: 'left' }}
              />
            </Form.Item>
            <Form.Item
              name="password"
              label={<span style={{ color: 'var(--color-text-secondary)' }}>Mot de passe</span>}
              rules={[{ required: true, message: 'Mot de passe requis' }]}
            >
              <Input.Password
                prefix={<LockOutlined />}
                placeholder="••••••••"
                autoComplete="current-password"
                size="large"
                style={{ textAlign: 'left' }}
              />
            </Form.Item>

            {error && (
              <Alert type="error" message={error} style={{ marginBottom: 16, textAlign: 'left' }} showIcon />
            )}

            <Button
              type="primary"
              htmlType="submit"
              loading={loading}
              block
              size="large"
              style={{
                height: 48,
                background: GOLD,
                borderColor: GOLD,
                color: '#000',
                fontWeight: 600,
              }}
            >
              Se connecter
            </Button>
          </Form>

          <div style={{ marginTop: 16, textAlign: 'center' }}>
            <Button type="link" href={appPath('/')} style={{ color: 'var(--color-text-tertiary)' }}>
              Retour à la plateforme
            </Button>
          </div>
        </div>
      </div>
    </ConfigProvider>
  );
}
