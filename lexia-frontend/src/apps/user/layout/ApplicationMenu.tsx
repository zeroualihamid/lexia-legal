import React, { useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Badge, Drawer, Input } from 'antd'
import {
  AppstoreOutlined,
  BarChartOutlined,
  DatabaseOutlined,
  FileSearchOutlined,
  RobotOutlined,
  SearchOutlined,
  SettingOutlined,
  TeamOutlined,
} from '@ant-design/icons'
import {
  GOLD,
  TEXT_PRIMARY,
  TEXT_SECONDARY,
  TEXT_TERTIARY,
} from '../../../shared/constants'
import {
  AppMenuEntry,
  AppMenuGroup,
  buildAppMenuGroups,
  filterMenuGroups,
  isMenuEntryActive,
} from '../../../shared/navigation/appMenu'

const FONT = "'Noto Naskh Arabic', 'Cairo', sans-serif"

const ADMIN_GROUP: AppMenuGroup = {
  id: 'admin',
  title: 'إدارة المنصة',
  eyebrow: '05 · ADMIN',
  icon: <SettingOutlined />,
  items: [
    {
      key: 'admin-dashboard',
      label: 'لوحة الإدارة',
      description: 'نظرة تشغيلية شاملة',
      path: '/admin',
      icon: <SettingOutlined />,
    },
    {
      key: 'admin-documents',
      label: 'المحتوى القانوني',
      description: 'الوثائق والمراجعة والنشر',
      path: '/admin/documents',
      icon: <DatabaseOutlined />,
    },
    {
      key: 'admin-scraper',
      label: 'مصادر الجمع',
      description: 'تشغيل ومراقبة الاستيراد',
      path: '/admin/scraper',
      icon: <AppstoreOutlined />,
    },
    {
      key: 'admin-agent',
      label: 'إعداد الوكيل',
      description: 'النماذج والمهارات والأدوات',
      path: '/admin/agent',
      icon: <RobotOutlined />,
    },
    {
      key: 'admin-analysis',
      label: 'تحليل الأحكام',
      description: 'إدارة التحليلات القانونية',
      path: '/admin/judgment-analysis',
      icon: <FileSearchOutlined />,
    },
    {
      key: 'admin-users',
      label: 'المستخدمون والصلاحيات',
      description: 'الحسابات ومستويات الوصول',
      path: '/admin/users',
      icon: <TeamOutlined />,
    },
    {
      key: 'admin-analytics',
      label: 'التحليلات',
      description: 'مؤشرات الاستخدام والأداء',
      path: '/admin/analytics',
      icon: <BarChartOutlined />,
    },
  ],
}

export function ApplicationMenu({
  open,
  onClose,
  isAdmin,
  hasToken,
  activeTaskCount,
}: {
  open: boolean
  onClose: () => void
  isAdmin: boolean
  hasToken: boolean
  activeTaskCount: number
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const [query, setQuery] = useState('')

  const groups = useMemo(() => {
    const base = buildAppMenuGroups({ activeTaskCount })
    return isAdmin ? [...base, ADMIN_GROUP] : base
  }, [activeTaskCount, isAdmin])

  const visibleGroups = useMemo(
    () => filterMenuGroups(groups, { hasToken, query }),
    [groups, hasToken, query],
  )

  const openEntry = (entry: AppMenuEntry) => {
    navigate(entry.path)
    onClose()
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      placement="right"
      width="min(420px, 92vw)"
      closable
      title={
        <span style={{ fontFamily: FONT, color: GOLD, fontSize: 18 }}>
          قائمة التطبيق
        </span>
      }
      styles={{
        body: {
          padding: 0,
          background: 'var(--color-bg-base)',
          direction: 'rtl',
        },
        header: {
          background: 'var(--color-bg-sidebar)',
          borderBottom: '1px solid var(--color-border-subtle)',
        },
      }}
    >
      <div className="application-menu">
        <style>{`
          .application-menu {
            min-height: 100%;
            padding: 20px 18px 28px;
            font-family: ${FONT};
          }
          .application-menu-header {
            display: flex;
            flex-direction: column;
            gap: 14px;
            padding-bottom: 18px;
            border-bottom: 1px solid var(--color-border-subtle);
          }
          .application-menu-brand {
            color: ${GOLD};
            font-family: Georgia, 'Times New Roman', serif;
            font-size: 12px;
            font-weight: 700;
            letter-spacing: 3px;
          }
          .application-menu-title {
            margin: 5px 0 0;
            color: ${TEXT_PRIMARY};
            font-size: clamp(22px, 4vw, 32px);
            line-height: 1.25;
          }
          .application-menu-groups {
            display: flex;
            flex-direction: column;
            gap: 24px;
            margin-top: 20px;
          }
          .application-menu-items {
            display: flex;
            flex-direction: column;
            gap: 8px;
          }
          .application-menu-eyebrow {
            color: ${GOLD};
            font-family: Georgia, 'Times New Roman', serif;
            font-size: 10px;
            letter-spacing: 1.5px;
          }
          .application-menu-group-title {
            margin: 4px 0 13px;
            color: ${TEXT_PRIMARY};
            font-size: 16px;
            display: flex;
            align-items: center;
            gap: 8px;
          }
          .application-menu-group-icon {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            color: ${GOLD};
            font-size: 16px;
          }
          .application-menu-group-icon .anticon {
            font-size: 16px;
          }
          .application-menu-item {
            width: 100%;
            display: grid;
            grid-template-columns: 38px minmax(0, 1fr);
            gap: 10px;
            align-items: center;
            padding: 11px;
            border: 1px solid transparent;
            border-radius: 13px;
            background: transparent;
            text-align: right;
            cursor: pointer;
            transition: background .16s ease, border-color .16s ease, transform .16s ease;
          }
          .application-menu-item:hover,
          .application-menu-item.active {
            border-color: var(--color-gold-border);
            background: var(--color-gold-tint);
            transform: translateY(-1px);
          }
          .application-menu-icon {
            width: 38px;
            height: 38px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            border: 1px solid var(--color-border-subtle);
            border-radius: 11px;
            color: ${GOLD};
            background: var(--color-bg-card);
            font-size: 16px;
          }
          .application-menu-icon .anticon {
            font-size: 16px;
          }
          .application-menu-label {
            overflow: hidden;
            color: ${TEXT_PRIMARY};
            font-family: ${FONT};
            font-size: 13px;
            font-weight: 700;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .application-menu-description {
            overflow: hidden;
            margin-top: 2px;
            color: ${TEXT_TERTIARY};
            font-family: ${FONT};
            font-size: 10.5px;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
        `}</style>

        <div className="application-menu-header">
          <div>
            <div className="application-menu-brand">LEXIA LEGAL OS</div>
            <h2 className="application-menu-title">مكتبك القانوني، في مكان واحد</h2>
            <p
              style={{
                margin: '7px 0 0',
                color: TEXT_SECONDARY,
                fontSize: 12.5,
              }}
            >
              أربعة أقسام: الذكاء الاصطناعي، إدارة المكتب، الحاسبات، والحساب.
            </p>
          </div>
          <Input
            size="large"
            allowClear
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            prefix={<SearchOutlined style={{ color: TEXT_TERTIARY }} />}
            placeholder="ابحث عن وظيفة..."
            style={{ fontFamily: FONT, borderRadius: 12 }}
          />
        </div>

        <div className="application-menu-groups">
          {visibleGroups.map((group) => (
            <section className="application-menu-group" key={group.id}>
              <div className="application-menu-eyebrow">{group.eyebrow}</div>
              <h3 className="application-menu-group-title">
                <span className="application-menu-group-icon">{group.icon}</span>
                <span>{group.title}</span>
              </h3>
              <div className="application-menu-items">
                {group.items.map((item) => {
                  const active = isMenuEntryActive(
                    item,
                    location.pathname,
                    location.search,
                  )
                  return (
                    <button
                      type="button"
                      key={item.key}
                      className={`application-menu-item${active ? ' active' : ''}`}
                      onClick={() => openEntry(item)}
                    >
                      <Badge count={item.count} size="small" offset={[-2, 2]}>
                        <span className="application-menu-icon">{item.icon}</span>
                      </Badge>
                      <span style={{ minWidth: 0 }}>
                        <span className="application-menu-label">{item.label}</span>
                        <span className="application-menu-description">
                          {item.description}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    </Drawer>
  )
}
