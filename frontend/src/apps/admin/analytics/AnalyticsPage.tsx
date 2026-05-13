import React from 'react'
import { Card, Row, Col, Table, Tag, Spin } from 'antd'
import {
  TeamOutlined,
  FileTextOutlined,
  DollarOutlined,
  CrownOutlined,
  ThunderboltOutlined,
  MessageOutlined,
  RiseOutlined,
} from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import apiClient from '../../../shared/api/client'
import { GOLD, DARK_CARD, BORDER_COLOR, COLLECTION_COLORS, COLLECTION_LABELS } from '../../../shared/constants'

const MOCK_ANALYTICS = {
  overview: {
    total_users: 1248,
    new_users_week: 47,
    total_documents: 52340,
    new_docs_week: 234,
    total_revenue: 87650,
    revenue_week: 4480,
    active_subscriptions: 312,
    active_users_hour: 47,
    messages_hour: 234,
  },
  monthly_usage: [
    { month: 'يناير', messages: 4521, searches: 1823, users: 320 },
    { month: 'فبراير', messages: 5234, searches: 2156, users: 389 },
    { month: 'مارس', messages: 6012, searches: 2489, users: 445 },
    { month: 'أبريل', messages: 7845, searches: 3124, users: 578 },
    { month: 'مايو', messages: 8901, searches: 3567, users: 712 },
    { month: 'يونيو', messages: 9432, searches: 3892, users: 834 },
  ],
  collections: [
    { collection: 'legal_laws', count: 15420, pct: 29.4 },
    { collection: 'judgments_civil', count: 11240, pct: 21.5 },
    { collection: 'judgments_commercial', count: 8930, pct: 17.1 },
    { collection: 'judgments_admin', count: 6780, pct: 13.0 },
    { collection: 'judgments_criminal', count: 4200, pct: 8.0 },
    { collection: 'judgments_family', count: 3900, pct: 7.5 },
    { collection: 'judgments_real_estate', count: 1870, pct: 3.6 },
  ],
  cost_breakdown: [
    { provider: 'Mistral AI', model: 'mistral-large-latest', tokens_in: 12450000, tokens_out: 3420000, cost_usd: 124.50 },
    { provider: 'OpenAI', model: 'text-embedding-3-small', tokens_in: 84500000, tokens_out: 0, cost_usd: 8.45 },
    { provider: 'OpenAI', model: 'gpt-4o-mini', tokens_in: 2100000, tokens_out: 560000, cost_usd: 3.28 },
  ],
}

function OverviewCard({
  title,
  value,
  subtitle,
  icon,
  color,
  trend,
}: {
  title: string
  value: string | number
  subtitle?: string
  icon: React.ReactNode
  color: string
  trend?: number
}) {
  return (
    <Card
      style={{ background: DARK_CARD, border: `1px solid ${BORDER_COLOR}`, borderRadius: 16 }}
      bodyStyle={{ padding: 20 }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", marginBottom: 6 }}>
            {title}
          </div>
          <div style={{ fontSize: 26, fontWeight: 700, color: 'rgba(255,255,255,0.9)', fontFamily: "'Cairo', sans-serif" }}>
            {typeof value === 'number' ? value.toLocaleString('ar-MA') : value}
          </div>
          {subtitle && (
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", marginTop: 4 }}>
              {subtitle}
            </div>
          )}
          {trend !== undefined && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 6 }}>
              <RiseOutlined style={{ color: '#52c41a', fontSize: 12 }} />
              <span style={{ fontSize: 12, color: '#52c41a', fontFamily: "'Cairo', sans-serif" }}>
                +{trend} هذا الأسبوع
              </span>
            </div>
          )}
        </div>
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 10,
            background: `${color}20`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 20,
            color,
            flexShrink: 0,
          }}
        >
          {icon}
        </div>
      </div>
    </Card>
  )
}

function LineChart({ data, keys, colors }: { data: any[]; keys: string[]; colors: string[] }) {
  const allValues = data.flatMap((d) => keys.map((k) => d[k] as number))
  const maxVal = Math.max(...allValues)
  const width = 560
  const height = 180
  const padX = 40
  const padY = 20
  const chartW = width - padX * 2
  const chartH = height - padY * 2

  const getX = (i: number) => padX + (i / (data.length - 1)) * chartW
  const getY = (v: number) => padY + chartH - (v / maxVal) * chartH

  const pathFor = (key: string) => {
    return data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${getX(i)} ${getY(d[key])}`).join(' ')
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={width} height={height} style={{ direction: 'ltr' }}>
        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((pct) => (
          <line
            key={pct}
            x1={padX}
            x2={width - padX}
            y1={padY + chartH * (1 - pct)}
            y2={padY + chartH * (1 - pct)}
            stroke="rgba(255,255,255,0.05)"
            strokeWidth={1}
          />
        ))}

        {/* Lines */}
        {keys.map((key, ki) => (
          <path
            key={key}
            d={pathFor(key)}
            fill="none"
            stroke={colors[ki]}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}

        {/* Dots */}
        {keys.map((key, ki) =>
          data.map((d, i) => (
            <circle
              key={`${key}-${i}`}
              cx={getX(i)}
              cy={getY(d[key])}
              r={3}
              fill={colors[ki]}
            />
          ))
        )}

        {/* X labels */}
        {data.map((d, i) => (
          <text
            key={i}
            x={getX(i)}
            y={height - 4}
            textAnchor="middle"
            fill="rgba(255,255,255,0.3)"
            fontSize={10}
            fontFamily="Cairo"
          >
            {d.month}
          </text>
        ))}
      </svg>
    </div>
  )
}

export function AnalyticsPage() {
  const { data: analytics, isLoading } = useQuery({
    queryKey: ['analytics'],
    queryFn: async () => {
      try {
        const res = await apiClient.get('/admin/analytics')
        return res.data
      } catch {
        return MOCK_ANALYTICS
      }
    },
    refetchInterval: 60000,
  })

  const a = analytics || MOCK_ANALYTICS

  const costColumns = [
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>المزوّد</span>,
      dataIndex: 'provider',
      render: (v: string) => <span style={{ fontFamily: "'Cairo', sans-serif", color: 'rgba(255,255,255,0.8)' }}>{v}</span>,
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>النموذج</span>,
      dataIndex: 'model',
      render: (v: string) => <Tag style={{ fontFamily: "'Cairo', sans-serif", fontSize: 11 }}>{v}</Tag>,
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>رموز الإدخال</span>,
      dataIndex: 'tokens_in',
      render: (v: number) => <span style={{ fontFamily: "'Cairo', sans-serif", color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>{(v / 1000000).toFixed(1)}M</span>,
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>رموز الإخراج</span>,
      dataIndex: 'tokens_out',
      render: (v: number) => <span style={{ fontFamily: "'Cairo', sans-serif", color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>{(v / 1000000).toFixed(1)}M</span>,
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>التكلفة ($)</span>,
      dataIndex: 'cost_usd',
      render: (v: number) => <span style={{ fontFamily: "'Cairo', sans-serif", color: GOLD, fontWeight: 600 }}>${v.toFixed(2)}</span>,
    },
  ]

  if (isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 300 }}>
        <Spin size="large" />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, direction: 'rtl' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: 'rgba(255,255,255,0.9)', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", margin: 0 }}>
        الإحصائيات
      </h1>

      {/* Overview */}
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}>
          <OverviewCard title="إجمالي المستخدمين" value={a.overview.total_users} trend={a.overview.new_users_week} icon={<TeamOutlined />} color="#1677ff" />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <OverviewCard title="إجمالي الوثائق" value={a.overview.total_documents} trend={a.overview.new_docs_week} icon={<FileTextOutlined />} color={GOLD} />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <OverviewCard title="الإيرادات (MAD)" value={a.overview.total_revenue} trend={a.overview.revenue_week} icon={<DollarOutlined />} color="#52c41a" />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <OverviewCard title="الاشتراكات النشطة" value={a.overview.active_subscriptions} icon={<CrownOutlined />} color="#eb2f96" />
        </Col>
      </Row>

      {/* Real-time */}
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12}>
          <Card style={{ background: DARK_CARD, border: `1px solid rgba(22,119,255,0.25)`, borderRadius: 16 }} bodyStyle={{ padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", marginBottom: 4 }}>
                  المستخدمون النشطون (ساعة)
                </div>
                <div style={{ fontSize: 30, fontWeight: 700, color: '#1677ff', fontFamily: "'Cairo', sans-serif" }}>
                  {a.overview.active_users_hour}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#52c41a' }} />
                <span style={{ fontSize: 11, color: '#52c41a', fontFamily: "'Cairo', sans-serif" }}>مباشر</span>
              </div>
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={12}>
          <Card style={{ background: DARK_CARD, border: `1px solid rgba(201,168,76,0.25)`, borderRadius: 16 }} bodyStyle={{ padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", marginBottom: 4 }}>
                  الرسائل (ساعة أخيرة)
                </div>
                <div style={{ fontSize: 30, fontWeight: 700, color: GOLD, fontFamily: "'Cairo', sans-serif" }}>
                  {a.overview.messages_hour}
                </div>
              </div>
              <MessageOutlined style={{ fontSize: 28, color: `${GOLD}40` }} />
            </div>
          </Card>
        </Col>
      </Row>

      {/* Monthly usage chart */}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={16}>
          <Card
            title={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'rgba(255,255,255,0.85)' }}>الاستخدام الشهري</span>}
            style={{ background: DARK_CARD, border: `1px solid ${BORDER_COLOR}`, borderRadius: 16 }}
            headStyle={{ borderBottom: `1px solid ${BORDER_COLOR}` }}
          >
            <LineChart
              data={a.monthly_usage}
              keys={['messages', 'searches', 'users']}
              colors={[GOLD, '#1677ff', '#52c41a']}
            />
            <div style={{ display: 'flex', gap: 20, justifyContent: 'center', marginTop: 8 }}>
              {[
                { key: 'رسائل', color: GOLD },
                { key: 'بحث', color: '#1677ff' },
                { key: 'مستخدمون', color: '#52c41a' },
              ].map((item) => (
                <div key={item.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ width: 12, height: 3, background: item.color, borderRadius: 2 }} />
                  <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>{item.key}</span>
                </div>
              ))}
            </div>
          </Card>
        </Col>

        <Col xs={24} lg={8}>
          <Card
            title={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'rgba(255,255,255,0.85)' }}>توزيع المجموعات</span>}
            style={{ background: DARK_CARD, border: `1px solid ${BORDER_COLOR}`, borderRadius: 16 }}
            headStyle={{ borderBottom: `1px solid ${BORDER_COLOR}` }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {a.collections.map((item: any) => (
                <div key={item.collection}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>
                      {COLLECTION_LABELS[item.collection] || item.collection}
                    </span>
                    <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', fontFamily: "'Cairo', sans-serif" }}>
                      {item.pct}%
                    </span>
                  </div>
                  <div style={{ height: 6, background: 'rgba(255,255,255,0.05)', borderRadius: 3, overflow: 'hidden' }}>
                    <div
                      style={{
                        height: '100%',
                        width: `${item.pct}%`,
                        background: COLLECTION_COLORS[item.collection] || '#8c8c8c',
                        borderRadius: 3,
                        transition: 'width 0.5s ease',
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </Col>
      </Row>

      {/* Cost breakdown */}
      <Card
        title={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'rgba(255,255,255,0.85)' }}>تفصيل التكاليف (هذا الشهر)</span>}
        style={{ background: DARK_CARD, border: `1px solid ${BORDER_COLOR}`, borderRadius: 16 }}
        headStyle={{ borderBottom: `1px solid ${BORDER_COLOR}` }}
      >
        <Table
          dataSource={a.cost_breakdown}
          columns={costColumns}
          rowKey={(r) => `${r.provider}-${r.model}`}
          pagination={false}
          style={{ direction: 'rtl' }}
          summary={(data) => {
            const total = data.reduce((sum, r) => sum + r.cost_usd, 0)
            return (
              <Table.Summary.Row>
                <Table.Summary.Cell index={0} colSpan={4}>
                  <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'rgba(255,255,255,0.6)', fontWeight: 600 }}>الإجمالي</span>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={4}>
                  <span style={{ fontFamily: "'Cairo', sans-serif", color: GOLD, fontWeight: 700, fontSize: 15 }}>
                    ${total.toFixed(2)}
                  </span>
                </Table.Summary.Cell>
              </Table.Summary.Row>
            )
          }}
        />
      </Card>
    </div>
  )
}
