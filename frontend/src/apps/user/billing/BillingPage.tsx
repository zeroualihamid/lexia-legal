import React, { useState } from 'react'
import {
  Tabs,
  Card,
  Button,
  Switch,
  Progress,
  Table,
  Tag,
  Modal,
  Space,
  Divider,
  message,
  Spin,
  Badge,
} from 'antd'
import {
  CheckCircleOutlined,
  DownloadOutlined,
  CrownOutlined,
  ThunderboltOutlined,
  StarOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import {
  usePlans,
  useSubscription,
  useUsage,
  useInvoices,
  useSubscribeMutation,
  useCancelSubscriptionMutation,
  useToggleAutoRenewMutation,
} from '../../../shared/hooks/useBilling'
import { GOLD, DARK, DARK_CARD, BORDER_COLOR, NAVY } from '../../../shared/constants'

const PLAN_ICONS: Record<string, React.ReactNode> = {
  free: <StarOutlined />,
  pro: <ThunderboltOutlined />,
  enterprise: <CrownOutlined />,
}

const MOCK_PLANS = [
  {
    id: 'free',
    name: 'free',
    name_ar: 'مجاني',
    price_monthly: 0,
    price_yearly: 0,
    features: ['10 رسائل يومياً', '5 عمليات بحث يومياً', 'الوصول للقوانين العامة', 'دون مصادر'],
    limits: { messages_per_day: 10, searches_per_day: 5, uploads_per_month: 0 },
  },
  {
    id: 'pro',
    name: 'pro',
    name_ar: 'محترف',
    price_monthly: 299,
    price_yearly: 2990,
    features: [
      'رسائل غير محدودة',
      '100 عملية بحث يومياً',
      'الوصول لجميع المجموعات',
      'عرض المصادر والمراجع',
      'سجل المحادثات',
      '5 وثائق شخصية',
    ],
    limits: { messages_per_day: -1, searches_per_day: 100, uploads_per_month: 5 },
  },
  {
    id: 'enterprise',
    name: 'enterprise',
    name_ar: 'مؤسسي',
    price_monthly: 1499,
    price_yearly: 14990,
    features: [
      'كل مزايا المحترف',
      'بحث غير محدود',
      'وثائق غير محدودة',
      'واجهة برمجية (API)',
      'إدارة فريق',
      'دعم أولوي',
    ],
    limits: { messages_per_day: -1, searches_per_day: -1, uploads_per_month: -1 },
  },
]

const MOCK_INVOICES = [
  { id: '1', number: 'INV-2024-001', date: '2024-01-15', amount: 299, currency: 'MAD', status: 'paid', pdf_url: '#' },
  { id: '2', number: 'INV-2024-002', date: '2024-02-15', amount: 299, currency: 'MAD', status: 'paid', pdf_url: '#' },
  { id: '3', number: 'INV-2024-003', date: '2024-03-15', amount: 299, currency: 'MAD', status: 'pending', pdf_url: '#' },
]

function PlansTab({ currentPlanId }: { currentPlanId?: string }) {
  const [billing, setBilling] = useState<'monthly' | 'yearly'>('monthly')
  const { mutate: subscribe, isPending } = useSubscribeMutation()
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null)

  const handleSubscribe = (planId: string) => {
    if (planId === 'free') return
    setSelectedPlan(planId)
    subscribe(
      { plan_id: planId, billing_cycle: billing },
      {
        onSuccess: () => {
          message.success('تم الاشتراك بنجاح')
          setSelectedPlan(null)
        },
        onError: () => {
          message.error('حدث خطأ أثناء الاشتراك')
          setSelectedPlan(null)
        },
      }
    )
  }

  return (
    <div style={{ direction: 'rtl' }}>
      {/* Monthly/Yearly toggle */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginBottom: 32, alignItems: 'center' }}>
        <span
          style={{
            fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
            color: billing === 'monthly' ? GOLD : 'rgba(255,255,255,0.5)',
            fontSize: 15,
            fontWeight: billing === 'monthly' ? 600 : 400,
          }}
        >
          شهري
        </span>
        <Switch
          checked={billing === 'yearly'}
          onChange={(v) => setBilling(v ? 'yearly' : 'monthly')}
          style={{ background: billing === 'yearly' ? GOLD : undefined }}
        />
        <span
          style={{
            fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
            color: billing === 'yearly' ? GOLD : 'rgba(255,255,255,0.5)',
            fontSize: 15,
            fontWeight: billing === 'yearly' ? 600 : 400,
          }}
        >
          سنوي
          <Tag
            style={{
              marginRight: 6,
              background: 'rgba(201,168,76,0.15)',
              border: '1px solid rgba(201,168,76,0.3)',
              color: GOLD,
              fontSize: 11,
            }}
          >
            وفّر 17%
          </Tag>
        </span>
      </div>

      {/* Plan cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 20,
          maxWidth: 960,
          margin: '0 auto',
        }}
      >
        {MOCK_PLANS.map((plan) => {
          const isCurrent = plan.id === currentPlanId
          const isPro = plan.id === 'pro'
          const price = billing === 'monthly' ? plan.price_monthly : Math.floor(plan.price_yearly / 12)

          return (
            <div
              key={plan.id}
              style={{
                background: isPro ? 'linear-gradient(135deg, #0f2040, #0a1628)' : DARK_CARD,
                border: `1px solid ${isCurrent ? GOLD : isPro ? 'rgba(201,168,76,0.4)' : BORDER_COLOR}`,
                borderRadius: 16,
                padding: '28px 24px',
                position: 'relative',
                direction: 'rtl',
                boxShadow: isPro ? `0 0 40px rgba(201,168,76,0.1)` : undefined,
              }}
            >
              {isPro && (
                <div
                  style={{
                    position: 'absolute',
                    top: -12,
                    left: '50%',
                    transform: 'translateX(-50%)',
                    background: GOLD,
                    color: '#000',
                    fontSize: 12,
                    fontWeight: 700,
                    padding: '2px 16px',
                    borderRadius: 20,
                    fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
                    whiteSpace: 'nowrap',
                  }}
                >
                  الأكثر شعبية
                </div>
              )}

              {isCurrent && (
                <div
                  style={{
                    position: 'absolute',
                    top: -12,
                    right: 16,
                    background: '#52c41a',
                    color: '#fff',
                    fontSize: 11,
                    fontWeight: 600,
                    padding: '2px 12px',
                    borderRadius: 20,
                    fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
                  }}
                >
                  خطتك الحالية
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                <span style={{ fontSize: 24, color: GOLD }}>{PLAN_ICONS[plan.id]}</span>
                <h3
                  style={{
                    fontSize: 20,
                    fontWeight: 700,
                    color: 'rgba(255,255,255,0.9)',
                    margin: 0,
                    fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
                  }}
                >
                  {plan.name_ar}
                </h3>
              </div>

              <div style={{ marginBottom: 24 }}>
                <span
                  style={{
                    fontSize: 36,
                    fontWeight: 700,
                    color: GOLD,
                    fontFamily: "'Cairo', sans-serif",
                  }}
                >
                  {price === 0 ? 'مجاني' : `${price}`}
                </span>
                {price > 0 && (
                  <span
                    style={{
                      fontSize: 14,
                      color: 'rgba(255,255,255,0.4)',
                      fontFamily: "'Cairo', sans-serif",
                      marginRight: 4,
                    }}
                  >
                    درهم / شهر
                  </span>
                )}
                {billing === 'yearly' && price > 0 && (
                  <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)', fontFamily: "'Cairo', sans-serif", marginTop: 4 }}>
                    يُدفع {plan.price_yearly} درهم سنوياً
                  </div>
                )}
              </div>

              <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 24px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                {plan.features.map((feature, i) => (
                  <li
                    key={i}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 13,
                      color: 'rgba(255,255,255,0.75)',
                      fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
                    }}
                  >
                    <CheckCircleOutlined style={{ color: isPro ? GOLD : '#52c41a', fontSize: 14, flexShrink: 0 }} />
                    {feature}
                  </li>
                ))}
              </ul>

              <Button
                type={isPro ? 'primary' : 'default'}
                block
                size="large"
                loading={isPending && selectedPlan === plan.id}
                disabled={isCurrent || plan.id === 'free'}
                onClick={() => handleSubscribe(plan.id)}
                style={{
                  borderRadius: 10,
                  fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
                  fontWeight: 600,
                  height: 44,
                  ...(isPro && !isCurrent
                    ? { background: GOLD, borderColor: GOLD, color: '#000' }
                    : {}),
                }}
              >
                {isCurrent ? 'خطتك الحالية' : plan.id === 'free' ? 'مجاني' : 'اشترك الآن'}
              </Button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function CurrentSubscriptionTab() {
  const { data: sub, isLoading } = useSubscription()
  const { mutate: cancel, isPending: cancelling } = useCancelSubscriptionMutation()
  const { mutate: toggleAutoRenew } = useToggleAutoRenewMutation()
  const [cancelModal, setCancelModal] = useState(false)

  if (isLoading) return <div style={{ padding: 40, textAlign: 'center' }}><Spin /></div>

  if (!sub) {
    return (
      <div
        style={{
          padding: 60,
          textAlign: 'center',
          fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
          color: 'rgba(255,255,255,0.4)',
        }}
      >
        لا يوجد اشتراك نشط. اختر خطة مناسبة من تبويب "خطط الاشتراك"
      </div>
    )
  }

  const statusColor = sub.status === 'active' ? '#52c41a' : sub.status === 'cancelled' ? '#fa8c16' : '#f5222d'

  return (
    <div style={{ maxWidth: 600, margin: '0 auto', direction: 'rtl' }}>
      <Card
        style={{ background: DARK_CARD, border: `1px solid ${BORDER_COLOR}`, borderRadius: 16 }}
        bodyStyle={{ padding: 28 }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h3 style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", fontSize: 20, fontWeight: 700, color: 'rgba(255,255,255,0.9)', margin: 0 }}>
            {sub.plan_name_ar}
          </h3>
          <Badge
            color={statusColor}
            text={
              <span style={{ color: statusColor, fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", fontSize: 13 }}>
                {sub.status === 'active' ? 'نشط' : sub.status === 'cancelled' ? 'ملغى' : 'منتهي'}
              </span>
            }
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: 'rgba(255,255,255,0.5)', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", fontSize: 14 }}>
              دورة الفوترة
            </span>
            <span style={{ color: 'rgba(255,255,255,0.8)', fontFamily: "'Cairo', sans-serif", fontSize: 14 }}>
              {sub.billing_cycle === 'monthly' ? 'شهري' : 'سنوي'}
            </span>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: 'rgba(255,255,255,0.5)', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", fontSize: 14 }}>
              السعر
            </span>
            <span style={{ color: GOLD, fontFamily: "'Cairo', sans-serif", fontSize: 16, fontWeight: 600 }}>
              {sub.price} درهم / {sub.billing_cycle === 'monthly' ? 'شهر' : 'سنة'}
            </span>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: 'rgba(255,255,255,0.5)', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", fontSize: 14 }}>
              تاريخ الانتهاء
            </span>
            <span style={{ color: 'rgba(255,255,255,0.8)', fontFamily: "'Cairo', sans-serif", fontSize: 14 }}>
              {dayjs(sub.expires_at).format('DD/MM/YYYY')}
            </span>
          </div>

          <Divider style={{ borderColor: BORDER_COLOR, margin: '8px 0' }} />

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: 'rgba(255,255,255,0.5)', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", fontSize: 14 }}>
              التجديد التلقائي
            </span>
            <Switch
              checked={sub.auto_renew}
              onChange={(v) => toggleAutoRenew(v)}
              style={{ background: sub.auto_renew ? GOLD : undefined }}
            />
          </div>
        </div>

        {sub.status === 'active' && (
          <>
            <Divider style={{ borderColor: BORDER_COLOR, margin: '20px 0 16px' }} />
            <Button
              danger
              ghost
              block
              icon={<WarningOutlined />}
              onClick={() => setCancelModal(true)}
              loading={cancelling}
              style={{ borderRadius: 10, fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", height: 40 }}
            >
              إلغاء الاشتراك
            </Button>
          </>
        )}
      </Card>

      <Modal
        title={
          <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'rgba(255,255,255,0.9)' }}>
            إلغاء الاشتراك
          </span>
        }
        open={cancelModal}
        onCancel={() => setCancelModal(false)}
        onOk={() => {
          cancel(undefined, {
            onSuccess: () => {
              message.success('تم إلغاء الاشتراك بنجاح')
              setCancelModal(false)
            },
            onError: () => message.error('حدث خطأ أثناء إلغاء الاشتراك'),
          })
        }}
        okText={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>تأكيد الإلغاء</span>}
        cancelText={<span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>لا</span>}
        okButtonProps={{ danger: true, loading: cancelling }}
        centered
      >
        <p style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", direction: 'rtl', color: 'rgba(255,255,255,0.7)' }}>
          هل أنت متأكد من إلغاء الاشتراك؟ ستفقد الوصول إلى المزايا المتقدمة في نهاية الفترة الحالية (
          {dayjs(sub.expires_at).format('DD/MM/YYYY')}).
        </p>
      </Modal>
    </div>
  )
}

function UsageTab() {
  const { data: usage, isLoading } = useUsage()

  if (isLoading) return <div style={{ padding: 40, textAlign: 'center' }}><Spin /></div>

  const mockUsage = usage || {
    messages_today: 7,
    messages_limit: 10,
    searches_today: 3,
    searches_limit: 5,
    uploads_this_month: 0,
    uploads_limit: 0,
    history: [
      { month: 'يناير', messages: 245, searches: 89 },
      { month: 'فبراير', messages: 312, searches: 134 },
      { month: 'مارس', messages: 287, searches: 96 },
      { month: 'أبريل', messages: 401, searches: 178 },
      { month: 'مايو', messages: 356, searches: 145 },
      { month: 'يونيو', messages: 189, searches: 67 },
    ],
  }

  const maxMessages = Math.max(...mockUsage.history.map((h) => h.messages))
  const maxSearches = Math.max(...mockUsage.history.map((h) => h.searches))

  return (
    <div style={{ maxWidth: 700, margin: '0 auto', direction: 'rtl', display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Progress bars */}
      <Card
        title={
          <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'rgba(255,255,255,0.85)' }}>
            الاستهلاك اليومي
          </span>
        }
        style={{ background: DARK_CARD, border: `1px solid ${BORDER_COLOR}`, borderRadius: 16 }}
        headStyle={{ borderBottom: `1px solid ${BORDER_COLOR}` }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", fontSize: 14, color: 'rgba(255,255,255,0.7)' }}>الرسائل</span>
              <span style={{ fontFamily: "'Cairo', sans-serif", fontSize: 13, color: 'rgba(255,255,255,0.5)' }}>
                {mockUsage.messages_today} / {mockUsage.messages_limit === -1 ? '∞' : mockUsage.messages_limit}
              </span>
            </div>
            <Progress
              percent={mockUsage.messages_limit === -1 ? 0 : (mockUsage.messages_today / mockUsage.messages_limit) * 100}
              showInfo={false}
              strokeColor={GOLD}
              trailColor="rgba(255,255,255,0.08)"
              strokeLinecap="round"
            />
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", fontSize: 14, color: 'rgba(255,255,255,0.7)' }}>عمليات البحث</span>
              <span style={{ fontFamily: "'Cairo', sans-serif", fontSize: 13, color: 'rgba(255,255,255,0.5)' }}>
                {mockUsage.searches_today} / {mockUsage.searches_limit === -1 ? '∞' : mockUsage.searches_limit}
              </span>
            </div>
            <Progress
              percent={mockUsage.searches_limit === -1 ? 0 : (mockUsage.searches_today / mockUsage.searches_limit) * 100}
              showInfo={false}
              strokeColor="#1677ff"
              trailColor="rgba(255,255,255,0.08)"
              strokeLinecap="round"
            />
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", fontSize: 14, color: 'rgba(255,255,255,0.7)' }}>الرفع (شهرياً)</span>
              <span style={{ fontFamily: "'Cairo', sans-serif", fontSize: 13, color: 'rgba(255,255,255,0.5)' }}>
                {mockUsage.uploads_this_month} / {mockUsage.uploads_limit === -1 ? '∞' : mockUsage.uploads_limit}
              </span>
            </div>
            <Progress
              percent={mockUsage.uploads_limit === 0 ? 100 : mockUsage.uploads_limit === -1 ? 0 : (mockUsage.uploads_this_month / mockUsage.uploads_limit) * 100}
              showInfo={false}
              strokeColor="#52c41a"
              trailColor="rgba(255,255,255,0.08)"
              strokeLinecap="round"
            />
          </div>
        </div>
      </Card>

      {/* History chart */}
      <Card
        title={
          <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'rgba(255,255,255,0.85)' }}>
            الاستهلاك الشهري (آخر 6 أشهر)
          </span>
        }
        style={{ background: DARK_CARD, border: `1px solid ${BORDER_COLOR}`, borderRadius: 16 }}
        headStyle={{ borderBottom: `1px solid ${BORDER_COLOR}` }}
      >
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', height: 160, padding: '16px 0' }}>
          {mockUsage.history.map((item, i) => (
            <div
              key={i}
              style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}
            >
              <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 120 }}>
                <div
                  style={{
                    width: 18,
                    height: `${Math.max(4, (item.messages / maxMessages) * 110)}px`,
                    background: GOLD,
                    borderRadius: '3px 3px 0 0',
                    opacity: 0.8,
                  }}
                />
                <div
                  style={{
                    width: 18,
                    height: `${Math.max(4, (item.searches / maxSearches) * 110)}px`,
                    background: '#1677ff',
                    borderRadius: '3px 3px 0 0',
                    opacity: 0.7,
                  }}
                />
              </div>
              <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', fontFamily: "'Cairo', sans-serif", whiteSpace: 'nowrap' }}>
                {item.month}
              </span>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 16, justifyContent: 'center', marginTop: 8 }}>
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
    </div>
  )
}

function InvoicesTab() {
  const { data: invoices, isLoading } = useInvoices()

  const displayInvoices = invoices || MOCK_INVOICES

  const statusColors: Record<string, string> = {
    paid: '#52c41a',
    pending: '#fa8c16',
    failed: '#f5222d',
  }
  const statusLabels: Record<string, string> = {
    paid: 'مدفوع',
    pending: 'معلق',
    failed: 'فشل',
  }

  const columns = [
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>رقم الفاتورة</span>,
      dataIndex: 'number',
      key: 'number',
      render: (v: string) => (
        <span style={{ fontFamily: "'Cairo', sans-serif", color: 'rgba(255,255,255,0.8)', fontSize: 13 }}>{v}</span>
      ),
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>التاريخ</span>,
      dataIndex: 'date',
      key: 'date',
      render: (v: string) => (
        <span style={{ fontFamily: "'Cairo', sans-serif", color: 'rgba(255,255,255,0.6)', fontSize: 13 }}>
          {dayjs(v).format('DD/MM/YYYY')}
        </span>
      ),
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>المبلغ</span>,
      dataIndex: 'amount',
      key: 'amount',
      render: (v: number, r: any) => (
        <span style={{ fontFamily: "'Cairo', sans-serif", color: GOLD, fontWeight: 600, fontSize: 14 }}>
          {v} {r.currency}
        </span>
      ),
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الحالة</span>,
      dataIndex: 'status',
      key: 'status',
      render: (v: string) => (
        <Tag
          style={{
            background: `${statusColors[v]}20`,
            border: `1px solid ${statusColors[v]}40`,
            color: statusColors[v],
            fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
            borderRadius: 12,
          }}
        >
          {statusLabels[v]}
        </Tag>
      ),
    },
    {
      title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>تحميل</span>,
      key: 'download',
      render: (_: any, record: any) => (
        <Button
          type="text"
          size="small"
          icon={<DownloadOutlined />}
          href={record.pdf_url}
          style={{ color: GOLD }}
        />
      ),
    },
  ]

  return (
    <Table
      dataSource={displayInvoices}
      columns={columns}
      rowKey="id"
      loading={isLoading}
      pagination={{ pageSize: 10 }}
      style={{ direction: 'rtl' }}
      locale={{
        emptyText: (
          <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif", color: 'rgba(255,255,255,0.3)' }}>
            لا توجد فواتير
          </span>
        ),
      }}
    />
  )
}

export function BillingPage() {
  const { data: subscription } = useSubscription()

  const tabItems = [
    {
      key: 'plans',
      label: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>خطط الاشتراك</span>,
      children: <PlansTab currentPlanId={subscription?.plan_id} />,
    },
    {
      key: 'current',
      label: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الاشتراك الحالي</span>,
      children: <CurrentSubscriptionTab />,
    },
    {
      key: 'usage',
      label: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الاستهلاك</span>,
      children: <UsageTab />,
    },
    {
      key: 'invoices',
      label: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الفواتير</span>,
      children: <InvoicesTab />,
    },
  ]

  return (
    <div
      style={{
        padding: '24px 20px',
        maxWidth: 1000,
        margin: '0 auto',
        width: '100%',
        direction: 'rtl',
      }}
    >
      <h1
        style={{
          fontSize: 24,
          fontWeight: 700,
          color: 'rgba(255,255,255,0.9)',
          fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
          marginBottom: 24,
        }}
      >
        إدارة الاشتراك
      </h1>
      <Tabs
        defaultActiveKey="plans"
        items={tabItems}
        style={{ direction: 'rtl' }}
      />
    </div>
  )
}
