import { type ReactNode, useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useSession } from './lib/auth-client';
import AdminLogin from './components/auth/AdminLogin';
import AdminLayout from './components/layout/AdminLayout';

function AuthLoadingScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="h-8 w-8 rounded-full border-2 border-primary/25 border-t-primary animate-spin" />
    </div>
  );
}

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { data: session, isPending } = useSession();
  if (isPending) return <AuthLoadingScreen />;
  if (!session) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  // Admin is a dark-first internal tool; apply the dark theme class once.
  const [isDarkMode, setIsDarkMode] = useState(() => {
    const stored = localStorage.getItem('admin-theme');
    return stored ? stored === 'dark' : true;
  });
  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDarkMode);
    localStorage.setItem('admin-theme', isDarkMode ? 'dark' : 'light');
  }, [isDarkMode]);

  return (
    <Routes>
      <Route path="/login" element={<AdminLogin />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <AdminLayout isDarkMode={isDarkMode} toggleTheme={() => setIsDarkMode((v) => !v)} />
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
