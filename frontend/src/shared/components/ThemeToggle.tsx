import React from 'react'
import { Button, Tooltip } from 'antd'
import { SunOutlined, MoonOutlined } from '@ant-design/icons'
import { useThemeStore } from '../store/themeStore'

interface Props {
  size?: 'small' | 'middle' | 'large'
}

export function ThemeToggle({ size = 'middle' }: Props) {
  const mode = useThemeStore((s) => s.mode)
  const toggle = useThemeStore((s) => s.toggle)
  const isDark = mode === 'dark'

  return (
    <Tooltip title={isDark ? 'الوضع الفاتح' : 'الوضع الداكن'}>
      <Button
        type="text"
        size={size}
        icon={isDark ? <SunOutlined /> : <MoonOutlined />}
        onClick={toggle}
        style={{ color: 'var(--color-text-secondary)' }}
      />
    </Tooltip>
  )
}
