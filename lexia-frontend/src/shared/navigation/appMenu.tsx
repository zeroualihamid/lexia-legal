import React from 'react'
import {
  BankOutlined,
  CalculatorOutlined,
  CalendarOutlined,
  CreditCardOutlined,
  EditOutlined,
  FileProtectOutlined,
  FolderOpenOutlined,
  HistoryOutlined,
  HomeOutlined,
  MessageOutlined,
  RobotOutlined,
  SearchOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons'

export interface AppMenuEntry {
  key: string
  label: string
  description: string
  path: string
  icon: React.ReactNode
  requiresAuth?: boolean
  count?: number
}

export interface AppMenuGroup {
  id: string
  title: string
  eyebrow: string
  icon: React.ReactNode
  items: AppMenuEntry[]
}

export function buildAppMenuGroups(options?: {
  activeTaskCount?: number
}): AppMenuGroup[] {
  const taskCount = options?.activeTaskCount ?? 0

  return [
    {
      id: 'ai-research',
      title: 'الذكاء الاصطناعي والبحث',
      eyebrow: '01 · IA & RECHERCHE',
      icon: <RobotOutlined />,
      items: [
        {
          key: 'assistant',
          label: 'المساعد القانوني',
          description: 'محادثة موثّقة بالمصادر القانونية',
          path: '/',
          icon: <MessageOutlined />,
        },
        {
          key: 'legal-search',
          label: 'البحث القانوني الخطي',
          description: 'أسئلة بلغة طبيعية مع إجابات موثّقة بالمصادر',
          path: '/search',
          icon: <SearchOutlined />,
        },
        {
          key: 'document-analysis',
          label: 'تحليل الوثائق',
          description: 'رفع PDF أو Word لاستخراج الملخص والمخاطر والامتثال',
          path: '/tasks?filter=documents',
          icon: <FileProtectOutlined />,
          requiresAuth: true,
          count: taskCount > 0 ? taskCount : undefined,
        },
        {
          key: 'document-drafting',
          label: 'المولّد والصياغة',
          description: 'نماذج تلقائية للعقود والطلبات والإنذارات',
          path: '/drafting',
          icon: <EditOutlined />,
        },
      ],
    },
    {
      id: 'cabinet',
      title: 'إدارة المكتب',
      eyebrow: '02 · CABINET',
      icon: <FolderOpenOutlined />,
      items: [
        {
          key: 'cases',
          label: 'إدارة الملفات',
          description: 'متابعة الإجراءات حسب النوع والحالة',
          path: '/cases',
          icon: <HomeOutlined />,
          requiresAuth: true,
        },
        {
          key: 'clients',
          label: 'إدارة الموكّلين',
          description: 'جهات الاتصال والملاحظات وربطها بالملفات',
          path: '/clients',
          icon: <TeamOutlined />,
          requiresAuth: true,
        },
        {
          key: 'sessions',
          label: 'إدارة الجلسات',
          description: 'جدول الجلسات والمحاكم والتذكيرات',
          path: '/sessions',
          icon: <CalendarOutlined />,
          requiresAuth: true,
        },
      ],
    },
    {
      id: 'tools',
      title: 'الأدوات والحاسبات',
      eyebrow: '03 · OUTILS',
      icon: <CalculatorOutlined />,
      items: [
        {
          key: 'severance',
          label: 'تعويضات الإنهاء',
          description: 'تقدير الحقوق المالية وفق مدونة الشغل',
          path: '/tools/severance',
          icon: <CalculatorOutlined />,
        },
        {
          key: 'notary',
          label: 'رسوم التوثيق والتسجيل',
          description: 'تقدير الرسوم للمعاملات العقارية والرسمية',
          path: '/tools/notary',
          icon: <BankOutlined />,
        },
        {
          key: 'salary-tax',
          label: 'الراتب الصافي والضريبة',
          description: 'تقدير الأجور وضريبة الدخل',
          path: '/tools/salary',
          icon: <CalculatorOutlined />,
        },
      ],
    },
    {
      id: 'account',
      title: 'الحساب والإعدادات',
      eyebrow: '04 · COMPTE',
      icon: <SettingOutlined />,
      items: [
        {
          key: 'search-history',
          label: 'سجل البحث',
          description: 'الاستعلامات والوثائق التي تم تحليلها',
          path: '/history',
          icon: <HistoryOutlined />,
          requiresAuth: true,
        },
        {
          key: 'lawyer-directory',
          label: 'دليل المحامين',
          description: 'المحترفون المرجعيون على المنصة',
          path: '/directory',
          icon: <UserOutlined />,
        },
        {
          key: 'billing',
          label: 'إدارة الاشتراك',
          description: 'الخطط المجانية والاحترافية والمميزات',
          path: '/billing',
          icon: <CreditCardOutlined />,
        },
      ],
    },
  ]
}

export function filterMenuGroups(
  groups: AppMenuGroup[],
  options: { hasToken: boolean; query?: string },
): AppMenuGroup[] {
  const normalized = options.query?.trim().toLocaleLowerCase('ar') ?? ''

  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => {
        if (item.requiresAuth && !options.hasToken) return false
        if (!normalized) return true
        return (
          item.label.toLocaleLowerCase('ar').includes(normalized) ||
          item.description.toLocaleLowerCase('ar').includes(normalized)
        )
      }),
    }))
    .filter((group) => group.items.length > 0)
}

export function isMenuEntryActive(
  entry: AppMenuEntry,
  pathname: string,
  search: string,
): boolean {
  const current = `${pathname}${search}`
  if (entry.path.includes('?')) return current === entry.path
  if (entry.path === '/')
    return pathname === '/' && !search
  return pathname === entry.path || pathname.startsWith(`${entry.path}/`)
}
