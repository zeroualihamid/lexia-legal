import React from 'react'
import { Button } from 'antd'
import { ArrowRightOutlined, RocketOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { DARK_CARD, GOLD, BORDER_COLOR } from '../../../shared/constants'

const FONT = "'Noto Naskh Arabic', 'Cairo', sans-serif"

export function ComingSoonPage({
  title,
  description,
}: {
  title: string
  description?: string
}) {
  const navigate = useNavigate()

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        direction: 'rtl',
      }}
    >
      <div
        style={{
          maxWidth: 520,
          width: '100%',
          textAlign: 'center',
          padding: '48px 32px',
          borderRadius: 18,
          border: `1px solid ${BORDER_COLOR}`,
          background: DARK_CARD,
        }}
      >
        <RocketOutlined style={{ fontSize: 48, color: GOLD, marginBottom: 16 }} />
        <h1
          style={{
            margin: '0 0 12px',
            fontSize: 24,
            fontWeight: 700,
            color: 'var(--color-text-primary)',
            fontFamily: FONT,
          }}
        >
          {title}
        </h1>
        <p
          style={{
            margin: '0 0 28px',
            fontSize: 15,
            lineHeight: 1.8,
            color: 'var(--color-text-secondary)',
            fontFamily: FONT,
          }}
        >
          {description || 'هذه الوظيفة قيد التطوير وستتوفر قريباً على المنصة.'}
        </p>
        <Button
          type="primary"
          icon={<ArrowRightOutlined />}
          onClick={() => navigate('/search')}
          style={{
            background: GOLD,
            borderColor: GOLD,
            color: '#000',
            fontWeight: 600,
            fontFamily: FONT,
            height: 42,
          }}
        >
          الانتقال إلى البحث القانوني
        </Button>
      </div>
    </div>
  )
}
