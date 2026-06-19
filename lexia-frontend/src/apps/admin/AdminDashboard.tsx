import React from 'react'
import { Card, Row, Col, Spin } from 'antd'
import {
  TeamOutlined,
  FileTextOutlined,
  DollarOutlined,
  CrownOutlined,
  MessageOutlined,
} from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import apiClient from '../../shared/api/client'
import { GOLD, DARK_CARD, BORDER_COLOR, COLLECTION_COLORS } from '../../shared/constants'
import { useAdminUi } from './locale/useAdminI18n'

function StatCard({
  title,
  value,
  suffix,
  icon,
  color,
  loading,
  font,
  numberLocale,
}: {
  title: string
  value: number | string
  suffix?: string
  icon: React.ReactNode
  color: string
  loading?: boolean
  font: string
  numberLocale: string
}) {
  return (
    <Card
      style={{ background: DARK_CARD, border: `1px solid ${BORDER_COLOR}`, borderRadius: 16, overflow: 'hidden' }}
      styles={{ body: { padding: 20 } }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', fontFamily: font, marginBottom: 8 }}>
            {title}
          </div>
          {loading ? (
            <Spin size="small" />
          ) : (
            <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--color-text-primary)', fontFamily: font }}>
              {typeof value === 'number' ? value.toLocaleString(numberLocale) : value}
              {suffix && (
                <span style={{ fontSize: 14, color: 'var(--color-text-tertiary)', marginInlineStart: 4 }}>{suffix}</span>
              )}
            </div>
          )}
        </div>
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 12,
            background: `${color}20`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 22,
            color,
          }}
        >
          {icon}
        </div>
      </div>
    </Card>
  )
}

function CollectionPieChart({
  data,
  font,
  numberLocale,
  totalLabel,
  collectionLabel,
}: {
  data: Array<{ collection: string; count: number }>
  font: string
  numberLocale: string
  totalLabel: string
  collectionLabel: (key: string) => string
}) {
  const total = data.reduce((sum, d) => sum + d.count, 0)
  if (total === 0) return null

  let cumulative = 0
  const segments = data.map((d) => {
    const pct = (d.count / total) * 100
    const start = cumulative
    cumulative += pct
    return { ...d, pct, start }
  })

  const size = 180
  const cx = size / 2
  const cy = size / 2
  const r = 70
  const innerR = 40

  const polarToCartesian = (angle: number, radius: number) => {
    const rad = ((angle - 90) * Math.PI) / 180
    return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) }
  }

  const describeArc = (startAngle: number, endAngle: number) => {
    const largeArc = endAngle - startAngle > 180 ? 1 : 0
    const s = polarToCartesian(startAngle, r)
    const e = polarToCartesian(endAngle, r)
    const si = polarToCartesian(startAngle, innerR)
    const ei = polarToCartesian(endAngle, innerR)
    return `M ${s.x} ${s.y} A ${r} ${r} 0 ${largeArc} 1 ${e.x} ${e.y} L ${ei.x} ${ei.y} A ${innerR} ${innerR} 0 ${largeArc} 0 ${si.x} ${si.y} Z`
  }

  return (
    <div style={{ display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap' }}>
      <svg width={size} height={size} style={{ flexShrink: 0 }}>
        {segments.map((seg, i) => (
          <path
            key={i}
            d={describeArc(seg.start * 3.6, (seg.start + seg.pct) * 3.6)}
            fill={COLLECTION_COLORS[seg.collection] || '#8c8c8c'}
            stroke="var(--color-bg-base)"
            strokeWidth={2}
          />
        ))}
        <text x={cx} y={cy - 6} textAnchor="middle" fill="var(--color-text-secondary)" fontSize={12} fontFamily={font}>
          {totalLabel}
        </text>
        <text x={cx} y={cy + 12} textAnchor="middle" fill="var(--color-text-primary)" fontSize={16} fontWeight="700" fontFamily={font}>
          {total.toLocaleString(numberLocale)}
        </text>
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
        {segments.map((seg, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: COLLECTION_COLORS[seg.collection] || '#8c8c8c',
                  flexShrink: 0,
                }}
              />
              <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', fontFamily: font }}>
                {collectionLabel(seg.collection)}
              </span>
            </div>
            <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)', fontFamily: font }}>
              {seg.count.toLocaleString(numberLocale)} ({seg.pct.toFixed(1)}%)
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

const MOCK_STATS = {
  total_users: 1248,
  total_documents: 52340,
  total_revenue: 87650,
  active_subscriptions: 312,
  active_users_hour: 47,
  messages_hour: 234,
  collections: [
    { collection: 'legal_laws', count: 15420 },
    { collection: 'judgments_commercial', count: 8930 },
    { collection: 'judgments_civil', count: 11240 },
    { collection: 'judgments_admin', count: 6780 },
    { collection: 'judgments_criminal', count: 4200 },
    { collection: 'judgments_family', count: 3900 },
    { collection: 'judgments_real_estate', count: 1870 },
  ],
  monthly_usage: [
    { month: 'Jan', messages: 4521, searches: 1823 },
    { month: 'Fév', messages: 5234, searches: 2156 },
    { month: 'Mar', messages: 6012, searches: 2489 },
    { month: 'Avr', messages: 7845, searches: 3124 },
    { month: 'Mai', messages: 8901, searches: 3567 },
    { month: 'Juin', messages: 9432, searches: 3892 },
  ],
}

export function AdminDashboard() {
  const { t, font, numberLocale, pageStyle, h1Style, collectionLabel, locale } = useAdminUi()

  const { data: stats, isLoading } = useQuery({
    queryKey: ['admin-stats', locale],
    queryFn: async () => {
      try {
        const res = await apiClient.get('/admin/stats')
        return res.data
      } catch {
        return MOCK_STATS
      }
    },
    refetchInterval: 30000,
  })

  const s = stats || MOCK_STATS
  const maxMsg = Math.max(...s.monthly_usage.map((h: { messages: number }) => h.messages))
  const monthLabels = t.months.slice(0, 6)

  return (
    <div style={{ ...pageStyle, display: 'flex', flexDirection: 'column', gap: 24 }}>
      <h1 style={h1Style}>{t.dashboard.title}</h1>

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}>
          <StatCard title={t.dashboard.totalUsers} value={s.total_users} icon={<TeamOutlined />} color="#1677ff" loading={isLoading} font={font} numberLocale={numberLocale} />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatCard title={t.dashboard.totalDocuments} value={s.total_documents} icon={<FileTextOutlined />} color={GOLD} loading={isLoading} font={font} numberLocale={numberLocale} />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatCard title={t.dashboard.totalRevenue} value={s.total_revenue} suffix={t.common.currency} icon={<DollarOutlined />} color="#52c41a" loading={isLoading} font={font} numberLocale={numberLocale} />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatCard title={t.dashboard.activeSubscriptions} value={s.active_subscriptions} icon={<CrownOutlined />} color="#eb2f96" loading={isLoading} font={font} numberLocale={numberLocale} />
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12}>
          <Card style={{ background: DARK_CARD, border: '1px solid rgba(22,119,255,0.3)', borderRadius: 16 }} styles={{ body: { padding: 20 } }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', fontFamily: font, marginBottom: 4 }}>
                  {t.dashboard.activeUsersHour}
                </div>
                <div style={{ fontSize: 32, fontWeight: 700, color: '#1677ff', fontFamily: font }}>
                  {s.active_users_hour}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#52c41a', animation: 'pulse 2s infinite' }} />
                <span style={{ fontSize: 11, color: '#52c41a', fontFamily: font }}>{t.common.live}</span>
              </div>
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={12}>
          <Card style={{ background: DARK_CARD, border: `1px solid rgba(201,168,76,0.3)`, borderRadius: 16 }} styles={{ body: { padding: 20 } }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', fontFamily: font, marginBottom: 4 }}>
                  {t.dashboard.messagesHour}
                </div>
                <div style={{ fontSize: 32, fontWeight: 700, color: GOLD, fontFamily: font }}>
                  {s.messages_hour}
                </div>
              </div>
              <MessageOutlined style={{ fontSize: 32, color: `${GOLD}40` }} />
            </div>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card
            title={<span style={{ fontFamily: font, color: 'var(--color-text-primary)', fontSize: 15 }}>{t.dashboard.monthlyUsage}</span>}
            style={{ background: DARK_CARD, border: `1px solid ${BORDER_COLOR}`, borderRadius: 16 }}
            styles={{ header: { borderBottom: `1px solid ${BORDER_COLOR}` } }}
          >
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', height: 160 }}>
              {s.monthly_usage.map((item: { month: string; messages: number; searches: number }, i: number) => (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 130 }}>
                    <div
                      style={{
                        width: 20,
                        height: `${Math.max(4, (item.messages / maxMsg) * 120)}px`,
                        background: GOLD,
                        borderRadius: '3px 3px 0 0',
                        opacity: 0.85,
                      }}
                    />
                    <div
                      style={{
                        width: 20,
                        height: `${Math.max(4, (item.searches / maxMsg) * 120)}px`,
                        background: '#1677ff',
                        borderRadius: '3px 3px 0 0',
                        opacity: 0.7,
                      }}
                    />
                  </div>
                  <span style={{ fontSize: 10, color: 'var(--color-text-quaternary)', fontFamily: font }}>
                    {monthLabels[i] || item.month}
                  </span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 16, justifyContent: 'center', marginTop: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 12, height: 12, background: GOLD, borderRadius: 2 }} />
                <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', fontFamily: font }}>{t.common.messages}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 12, height: 12, background: '#1677ff', borderRadius: 2 }} />
                <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', fontFamily: font }}>{t.common.searches}</span>
              </div>
            </div>
          </Card>
        </Col>

        <Col xs={24} lg={10}>
          <Card
            title={<span style={{ fontFamily: font, color: 'var(--color-text-primary)', fontSize: 15 }}>{t.dashboard.documentDistribution}</span>}
            style={{ background: DARK_CARD, border: `1px solid ${BORDER_COLOR}`, borderRadius: 16 }}
            styles={{ header: { borderBottom: `1px solid ${BORDER_COLOR}` } }}
          >
            <CollectionPieChart
              data={s.collections}
              font={font}
              numberLocale={numberLocale}
              totalLabel={t.common.total}
              collectionLabel={collectionLabel}
            />
          </Card>
        </Col>
      </Row>
    </div>
  )
}
