import React from 'react'
import { Card, Row, Col, Statistic, Spin } from 'antd'
import {
  TeamOutlined,
  FileTextOutlined,
  DollarOutlined,
  CrownOutlined,
  ThunderboltOutlined,
  MessageOutlined,
} from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import apiClient from '../../shared/api/client'
import { GOLD, DARK_CARD, BORDER_COLOR, COLLECTION_COLORS, COLLECTION_LABELS } from '../../shared/constants'

function StatCard({
  title,
  value,
  suffix,
  icon,
  color,
  loading,
}: {
  title: string
  value: number | string
  suffix?: string
  icon: React.ReactNode
  color: string
  loading?: boolean
}) {
  return (
    <Card
      style={{
        background: DARK_CARD,
        border: `1px solid ${BORDER_COLOR}`,
        borderRadius: 16,
        overflow: 'hidden',
      }}
      bodyStyle={{ padding: 20 }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div
            style={{
              fontSize: 13,
              color: 'rgba(255,255,255,0.5)',
              fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
              marginBottom: 8,
            }}
          >
            {title}
          </div>
          {loading ? (
            <Spin size="small" />
          ) : (
            <div style={{ fontSize: 28, fontWeight: 700, color: 'rgba(255,255,255,0.9)', fontFamily: "'Cairo', sans-serif" }}>
              {typeof value === 'number' ? value.toLocaleString('ar-MA') : value}
              {suffix && (
                <span style={{ fontSize: 14, color: 'rgba(255,255,255,0.4)', marginRight: 4 }}>{suffix}</span>
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
            color: color,
          }}
        >
          {icon}
        </div>
      </div>
    </Card>
  )
}

function CollectionPieChart({ data }: { data: Array<{ collection: string; count: number }> }) {
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
            stroke="#060d18"
            strokeWidth={2}
          />
        ))}
        <text x={cx} y={cy - 6} textAnchor="middle" fill="rgba(255,255,255,0.7)" fontSize={12} fontFamily="Cairo">
          إجمالي
        </text>
        <text x={cx} y={cy + 12} textAnchor="middle" fill="rgba(255,255,255,0.9)" fontSize={16} fontWeight="700" fontFamily="Cairo">
          {total.toLocaleString()}
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
              <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>
                {COLLECTION_LABELS[seg.collection] || seg.collection}
              </span>
            </div>
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', fontFamily: "'Cairo', sans-serif" }}>
              {seg.count.toLocaleString()} ({seg.pct.toFixed(1)}%)
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
    { month: 'يناير', messages: 4521, searches: 1823 },
    { month: 'فبراير', messages: 5234, searches: 2156 },
    { month: 'مارس', messages: 6012, searches: 2489 },
    { month: 'أبريل', messages: 7845, searches: 3124 },
    { month: 'مايو', messages: 8901, searches: 3567 },
    { month: 'يونيو', messages: 9432, searches: 3892 },
  ],
}

export function AdminDashboard() {
  const { data: stats, isLoading } = useQuery({
    queryKey: ['admin-stats'],
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
  const maxMsg = Math.max(...s.monthly_usage.map((h: any) => h.messages))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, direction: 'rtl' }}>
      <h1
        style={{
          fontSize: 22,
          fontWeight: 700,
          color: 'rgba(255,255,255,0.9)',
          fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
          margin: 0,
        }}
      >
        لوحة التحكم
      </h1>

      {/* Overview cards */}
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}>
          <StatCard title="إجمالي المستخدمين" value={s.total_users} icon={<TeamOutlined />} color="#1677ff" loading={isLoading} />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatCard title="إجمالي الوثائق" value={s.total_documents} icon={<FileTextOutlined />} color={GOLD} loading={isLoading} />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatCard title="إجمالي الإيرادات" value={s.total_revenue} suffix="درهم" icon={<DollarOutlined />} color="#52c41a" loading={isLoading} />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatCard title="الاشتراكات النشطة" value={s.active_subscriptions} icon={<CrownOutlined />} color="#eb2f96" loading={isLoading} />
        </Col>
      </Row>

      {/* Real-time stats */}
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12}>
          <Card
            style={{ background: DARK_CARD, border: `1px solid rgba(22,119,255,0.3)`, borderRadius: 16 }}
            bodyStyle={{ padding: 20 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", marginBottom: 4 }}>
                  المستخدمون النشطون (ساعة)
                </div>
                <div style={{ fontSize: 32, fontWeight: 700, color: '#1677ff', fontFamily: "'Cairo', sans-serif" }}>
                  {s.active_users_hour}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#52c41a', animation: 'pulse 2s infinite' }} />
                <span style={{ fontSize: 11, color: '#52c41a', fontFamily: "'Cairo', sans-serif" }}>مباشر</span>
              </div>
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={12}>
          <Card
            style={{ background: DARK_CARD, border: `1px solid rgba(201,168,76,0.3)`, borderRadius: 16 }}
            bodyStyle={{ padding: 20 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", marginBottom: 4 }}>
                  الرسائل (ساعة أخيرة)
                </div>
                <div style={{ fontSize: 32, fontWeight: 700, color: GOLD, fontFamily: "'Cairo', sans-serif" }}>
                  {s.messages_hour}
                </div>
              </div>
              <MessageOutlined style={{ fontSize: 32, color: `${GOLD}40` }} />
            </div>
          </Card>
        </Col>
      </Row>

      {/* Charts */}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card
            title={
              <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'rgba(255,255,255,0.85)', fontSize: 15 }}>
                الاستخدام الشهري
              </span>
            }
            style={{ background: DARK_CARD, border: `1px solid ${BORDER_COLOR}`, borderRadius: 16 }}
            headStyle={{ borderBottom: `1px solid ${BORDER_COLOR}` }}
          >
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', height: 160 }}>
              {s.monthly_usage.map((item: any, i: number) => (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 130 }}>
                    <div
                      style={{
                        width: 20,
                        height: `${Math.max(4, (item.messages / maxMsg) * 120)}px`,
                        background: GOLD,
                        borderRadius: '3px 3px 0 0',
                        opacity: 0.85,
                        transition: 'height 0.5s ease',
                      }}
                    />
                    <div
                      style={{
                        width: 20,
                        height: `${Math.max(4, (item.searches / maxMsg) * 120)}px`,
                        background: '#1677ff',
                        borderRadius: '3px 3px 0 0',
                        opacity: 0.7,
                        transition: 'height 0.5s ease',
                      }}
                    />
                  </div>
                  <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', fontFamily: "'Cairo', sans-serif" }}>
                    {item.month}
                  </span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 16, justifyContent: 'center', marginTop: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 12, height: 12, background: GOLD, borderRadius: 2 }} />
                <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>رسائل</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 12, height: 12, background: '#1677ff', borderRadius: 2 }} />
                <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>بحث</span>
              </div>
            </div>
          </Card>
        </Col>

        <Col xs={24} lg={10}>
          <Card
            title={
              <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'rgba(255,255,255,0.85)', fontSize: 15 }}>
                توزيع الوثائق
              </span>
            }
            style={{ background: DARK_CARD, border: `1px solid ${BORDER_COLOR}`, borderRadius: 16 }}
            headStyle={{ borderBottom: `1px solid ${BORDER_COLOR}` }}
          >
            <CollectionPieChart data={s.collections} />
          </Card>
        </Col>
      </Row>
    </div>
  )
}
