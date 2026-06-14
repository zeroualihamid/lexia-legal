import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Button,
  Modal,
  Form,
  Input,
  Empty,
  Spin,
  Tag,
  Popconfirm,
  Segmented,
  Select,
  Tree,
  App as AntApp,
} from 'antd'
import {
  PlusOutlined,
  FileTextOutlined,
  DeleteOutlined,
  UserOutlined,
  AppstoreOutlined,
  UnorderedListOutlined,
  PictureOutlined,
  PartitionOutlined,
  SearchOutlined,
  FolderOpenOutlined,
  BankOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import {
  useCases,
  useCreateCase,
  useDeleteCase,
  useRefreshMahakim,
  useUpdateCase,
  type CaseRecord,
  type CaseDocument,
  type CourtType,
} from '../../../shared/hooks/useCases'
import apiClient from '../../../shared/api/client'
import {
  GOLD,
  BORDER_COLOR,
  BORDER_SUBTLE,
  TEXT_PRIMARY,
  TEXT_SECONDARY,
  TEXT_TERTIARY,
  DARK_CARD,
  ELEVATED,
  GOLD_TINT,
  CASE_STATUS_LABELS,
  DOCUMENT_TYPE_LABELS,
  DOCUMENT_TYPE_COLORS,
  DOCUMENT_STATUS_LABELS,
  MAHAKIM_STATUS_LABELS,
  APPEAL_COURTS,
  SUPREME_COURT_NAME,
} from '../../../shared/constants'

const FONT = "'Noto Naskh Arabic', 'Cairo', sans-serif"

type ViewMode = 'icons' | 'list' | 'gallery' | 'tree'
type SortKey = 'updated' | 'title' | 'docs'

const VIEW_KEY = 'lexia.cases.viewMode'
const SORT_KEY = 'lexia.cases.sortKey'

function loadPref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return (v as unknown as T) || fallback
  } catch {
    return fallback
  }
}

/** A macOS-style folder glyph (SVG) tinted with the brand gold. */
function FolderGlyph({ size = 64, open = false }: { size?: number; open?: boolean }) {
  const id = useMemo(() => `fg-${Math.random().toString(36).slice(2)}`, [])
  return (
    <svg
      width={size}
      height={size * 0.8}
      viewBox="0 0 64 52"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'block', filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.18))' }}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#e7cd83" />
          <stop offset="100%" stopColor={GOLD} />
        </linearGradient>
        <linearGradient id={`${id}-b`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#d8b860" />
          <stop offset="100%" stopColor="#b8923c" />
        </linearGradient>
      </defs>
      {/* back tab */}
      <path
        d="M6 8a4 4 0 0 1 4-4h13.2a4 4 0 0 1 2.83 1.17L30 9h24a4 4 0 0 1 4 4v4H6z"
        fill={`url(#${id}-b)`}
      />
      {/* front body */}
      <path
        d={
          open
            ? 'M6 16h52a4 4 0 0 1 3.9 4.9l-4.4 22A5 5 0 0 1 52.6 47H9a4 4 0 0 1-4-4V20a4 4 0 0 1 1-2.6z'
            : 'M6 14a4 4 0 0 1 4-4h44a4 4 0 0 1 4 4v30a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4z'
        }
        fill={`url(#${id})`}
      />
    </svg>
  )
}

export function CasesPage() {
  const navigate = useNavigate()
  const { message } = AntApp.useApp()
  const casesQ = useCases()
  const createCase = useCreateCase()
  const deleteCase = useDeleteCase()
  const [modalOpen, setModalOpen] = useState(false)
  const [form] = Form.useForm()

  const [view, setView] = useState<ViewMode>(() => loadPref<ViewMode>(VIEW_KEY, 'icons'))
  const [sortKey, setSortKey] = useState<SortKey>(() => loadPref<SortKey>(SORT_KEY, 'updated'))
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    try { localStorage.setItem(VIEW_KEY, view) } catch {}
  }, [view])
  useEffect(() => {
    try { localStorage.setItem(SORT_KEY, sortKey) } catch {}
  }, [sortKey])

  const handleCreate = async () => {
    try {
      const values = await form.validateFields()
      const created = await createCase.mutateAsync(values)
      message.success('تم إنشاء القضية')
      setModalOpen(false)
      form.resetFields()
      if (created?.id) navigate(`/cases/${created.id}`)
    } catch (err: any) {
      if (err?.errorFields) return
      message.error(err?.response?.data?.message || 'تعذّر إنشاء القضية')
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await deleteCase.mutateAsync(id)
      message.success('تم حذف القضية')
    } catch {
      message.error('تعذّر حذف القضية')
    }
  }

  const open = (id: string) => navigate(`/cases/${id}`)

  const items = useMemo(() => {
    let list = [...(casesQ.data || [])]
    const q = query.trim().toLowerCase()
    if (q) {
      list = list.filter(
        (c) =>
          c.title?.toLowerCase().includes(q) ||
          c.client_name?.toLowerCase().includes(q) ||
          c.case_ref?.toLowerCase().includes(q),
      )
    }
    list.sort((a, b) => {
      if (sortKey === 'title') return (a.title || '').localeCompare(b.title || '', 'ar')
      if (sortKey === 'docs') return (b.document_count || 0) - (a.document_count || 0)
      return dayjs(b.updated_at).valueOf() - dayjs(a.updated_at).valueOf()
    })
    return list
  }, [casesQ.data, query, sortKey])

  return (
    <div style={{ direction: 'rtl', maxWidth: 1180, margin: '0 auto', width: '100%', display: 'flex', flexDirection: 'column', height: '100%' }}>
      <style>{`
        .finder-item { cursor: pointer; transition: background .12s, border-color .12s, transform .12s; }
        .finder-icon { border: 1px solid transparent; border-radius: 12px; }
        .finder-icon:hover { background: ${GOLD_TINT}; }
        .finder-icon.selected { background: ${GOLD_TINT}; border-color: ${GOLD}; }
        .finder-row:hover { background: ${ELEVATED}; }
        .finder-row.selected { background: ${GOLD_TINT}; }
        .finder-gallery { border: 1px solid ${BORDER_COLOR}; border-radius: 14px; }
        .finder-gallery:hover { transform: translateY(-2px); border-color: ${GOLD}; }
        .finder-gallery.selected { border-color: ${GOLD}; box-shadow: 0 0 0 2px ${GOLD_TINT}; }
        .finder-del { opacity: 0; transition: opacity .12s; }
        .finder-item:hover .finder-del, .finder-row:hover .finder-del { opacity: 1; }
      `}</style>

      {/* ── Finder toolbar ───────────────────────────────── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '16px 20px 12px',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h1 style={{ margin: 0, color: GOLD, fontFamily: FONT, fontSize: 22 }}>القضايا</h1>
          <p style={{ margin: '2px 0 0', color: TEXT_SECONDARY, fontFamily: FONT, fontSize: 12.5 }}>
            نظّم مستنداتك حسب ملفات القضايا، وحاور كل قضية بمعزل عن غيرها.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Input
            allowClear
            prefix={<SearchOutlined style={{ color: TEXT_TERTIARY }} />}
            placeholder="بحث في القضايا..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ width: 200, fontFamily: FONT }}
          />
          <Select<SortKey>
            value={sortKey}
            onChange={setSortKey}
            style={{ width: 150, fontFamily: FONT }}
            options={[
              { value: 'updated', label: 'الأحدث تعديلاً' },
              { value: 'title', label: 'الاسم' },
              { value: 'docs', label: 'عدد المستندات' },
            ]}
          />
          <Segmented<ViewMode>
            value={view}
            onChange={(v) => setView(v as ViewMode)}
            options={[
              { value: 'icons', icon: <AppstoreOutlined />, title: 'أيقونات' },
              { value: 'list', icon: <UnorderedListOutlined />, title: 'قائمة' },
              { value: 'gallery', icon: <PictureOutlined />, title: 'معرض' },
              { value: 'tree', icon: <PartitionOutlined />, title: 'شجرة' },
            ]}
          />
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setModalOpen(true)}
            style={{ background: GOLD, borderColor: GOLD, color: '#000', fontWeight: 600, fontFamily: FONT }}
          >
            قضية جديدة
          </Button>
        </div>
      </div>

      {/* ── Content ──────────────────────────────────────── */}
      <div style={{ flex: 1, overflow: 'auto', padding: '8px 20px 16px' }}>
        {casesQ.isLoading ? (
          <div style={{ textAlign: 'center', padding: 60 }}>
            <Spin size="large" />
          </div>
        ) : items.length === 0 ? (
          <Empty
            description={
              <span style={{ fontFamily: FONT, color: TEXT_SECONDARY }}>
                {query ? 'لا نتائج مطابقة' : 'لا توجد قضايا بعد'}
              </span>
            }
            style={{ padding: 60 }}
          />
        ) : view === 'icons' ? (
          <IconsView
            items={items}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onOpen={open}
            onDelete={handleDelete}
          />
        ) : view === 'list' ? (
          <ListView
            items={items}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onOpen={open}
            onDelete={handleDelete}
          />
        ) : view === 'tree' ? (
          <TreeView
            items={items}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onOpen={open}
            onDelete={handleDelete}
          />
        ) : (
          <GalleryView
            items={items}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onOpen={open}
            onDelete={handleDelete}
          />
        )}
      </div>

      {/* ── Finder-style status bar ──────────────────────── */}
      {!casesQ.isLoading && (
        <div
          style={{
            borderTop: `1px solid ${BORDER_SUBTLE}`,
            padding: '8px 20px',
            color: TEXT_TERTIARY,
            fontFamily: FONT,
            fontSize: 12,
            textAlign: 'center',
            flexShrink: 0,
          }}
        >
          {items.length} {items.length === 1 ? 'قضية' : 'قضايا'}
          {selectedId ? ' · عنصر محدد' : ''}
        </div>
      )}

      <CreateCaseModal
        open={modalOpen}
        form={form}
        loading={createCase.isPending}
        onCancel={() => setModalOpen(false)}
        onOk={handleCreate}
      />
    </div>
  )
}

// ── Delete confirm button (shared) ──────────────────────────
function DeleteButton({ id, onDelete }: { id: string; onDelete: (id: string) => void }) {
  return (
    <Popconfirm
      title={<span style={{ fontFamily: FONT }}>حذف القضية وكل مستنداتها؟</span>}
      okText="حذف"
      cancelText="إلغاء"
      okButtonProps={{ danger: true }}
      onConfirm={(e) => {
        e?.stopPropagation?.()
        onDelete(id)
      }}
      onCancel={(e) => e?.stopPropagation?.()}
    >
      <Button
        className="finder-del"
        type="text"
        size="small"
        danger
        icon={<DeleteOutlined />}
        onClick={(e) => e.stopPropagation()}
      />
    </Popconfirm>
  )
}

interface ViewProps {
  items: CaseRecord[]
  selectedId: string | null
  onSelect: (id: string) => void
  onOpen: (id: string) => void
  onDelete: (id: string) => void
}

// ── Icon (grid) view ───────────────────────────────────────
function IconsView({ items, selectedId, onSelect, onOpen, onDelete }: ViewProps) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))',
        gap: 6,
      }}
    >
      {items.map((c) => {
        const status = CASE_STATUS_LABELS[c.status] || CASE_STATUS_LABELS.open
        const selected = selectedId === c.id
        return (
          <div
            key={c.id}
            className={`finder-item finder-icon${selected ? ' selected' : ''}`}
            onClick={() => onSelect(c.id)}
            onDoubleClick={() => onOpen(c.id)}
            style={{ padding: '14px 8px 10px', textAlign: 'center', position: 'relative' }}
          >
            <div style={{ position: 'absolute', top: 4, insetInlineEnd: 4 }}>
              <DeleteButton id={c.id} onDelete={onDelete} />
            </div>
            <div style={{ position: 'relative', display: 'inline-block' }}>
              <FolderGlyph size={72} />
              {(c.document_count || 0) > 0 && (
                <span
                  style={{
                    position: 'absolute',
                    bottom: 6,
                    insetInlineStart: -4,
                    background: '#1f1f1f',
                    color: '#fff',
                    borderRadius: 10,
                    fontSize: 10,
                    fontWeight: 600,
                    padding: '1px 6px',
                    border: `1px solid ${GOLD}`,
                    fontFamily: FONT,
                  }}
                >
                  {c.document_count}
                </span>
              )}
              <span
                style={{
                  position: 'absolute',
                  top: 8,
                  insetInlineEnd: 4,
                  width: 9,
                  height: 9,
                  borderRadius: '50%',
                  background: status.color,
                  border: '2px solid var(--color-bg-card)',
                }}
                title={status.label}
              />
            </div>
            <div
              style={{
                marginTop: 6,
                color: TEXT_PRIMARY,
                fontFamily: FONT,
                fontSize: 13,
                fontWeight: 600,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={c.title}
            >
              {c.title}
            </div>
            <div
              style={{
                color: TEXT_TERTIARY,
                fontFamily: FONT,
                fontSize: 11,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {c.client_name || dayjs(c.updated_at).format('DD/MM/YYYY')}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── List view ──────────────────────────────────────────────
function ListView({ items, selectedId, onSelect, onOpen, onDelete }: ViewProps) {
  const cols = '1fr 160px 110px 90px 120px 40px'
  return (
    <div style={{ border: `1px solid ${BORDER_SUBTLE}`, borderRadius: 10, overflow: 'hidden' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: cols,
          gap: 8,
          padding: '8px 14px',
          background: ELEVATED,
          borderBottom: `1px solid ${BORDER_SUBTLE}`,
          color: TEXT_SECONDARY,
          fontFamily: FONT,
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        <span>الاسم</span>
        <span>الموكّل</span>
        <span>الحالة</span>
        <span>المستندات</span>
        <span>آخر تعديل</span>
        <span />
      </div>
      {items.map((c, i) => {
        const status = CASE_STATUS_LABELS[c.status] || CASE_STATUS_LABELS.open
        const selected = selectedId === c.id
        return (
          <div
            key={c.id}
            className={`finder-item finder-row${selected ? ' selected' : ''}`}
            onClick={() => onSelect(c.id)}
            onDoubleClick={() => onOpen(c.id)}
            style={{
              display: 'grid',
              gridTemplateColumns: cols,
              gap: 8,
              padding: '10px 14px',
              alignItems: 'center',
              borderBottom: i === items.length - 1 ? 'none' : `1px solid ${BORDER_SUBTLE}`,
              fontFamily: FONT,
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <FolderGlyph size={26} />
              <span
                style={{
                  color: TEXT_PRIMARY,
                  fontSize: 13.5,
                  fontWeight: 600,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={c.title}
              >
                {c.title}
              </span>
            </span>
            <span style={{ color: TEXT_SECONDARY, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c.client_name || '—'}
            </span>
            <span>
              <Tag
                style={{
                  background: `${status.color}20`,
                  border: `1px solid ${status.color}40`,
                  color: status.color,
                  borderRadius: 10,
                  fontFamily: FONT,
                  margin: 0,
                }}
              >
                {status.label}
              </Tag>
            </span>
            <span style={{ color: TEXT_SECONDARY, fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 4 }}>
              <FileTextOutlined style={{ fontSize: 12 }} />
              {c.document_count || 0}
            </span>
            <span style={{ color: TEXT_TERTIARY, fontSize: 12 }}>
              {dayjs(c.updated_at).format('DD/MM/YYYY')}
            </span>
            <span style={{ textAlign: 'end' }}>
              <DeleteButton id={c.id} onDelete={onDelete} />
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ── Gallery view ───────────────────────────────────────────
function GalleryView({ items, selectedId, onSelect, onOpen, onDelete }: ViewProps) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
        gap: 16,
      }}
    >
      {items.map((c) => {
        const status = CASE_STATUS_LABELS[c.status] || CASE_STATUS_LABELS.open
        const selected = selectedId === c.id
        return (
          <div
            key={c.id}
            className={`finder-item finder-gallery${selected ? ' selected' : ''}`}
            onClick={() => onSelect(c.id)}
            onDoubleClick={() => onOpen(c.id)}
            style={{ background: DARK_CARD, overflow: 'hidden' }}
          >
            <div
              style={{
                position: 'relative',
                height: 130,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: `linear-gradient(135deg, ${GOLD_TINT}, transparent)`,
              }}
            >
              <FolderGlyph size={92} open />
              <div style={{ position: 'absolute', top: 8, insetInlineEnd: 8 }}>
                <DeleteButton id={c.id} onDelete={onDelete} />
              </div>
              {(c.document_count || 0) > 0 && (
                <span
                  style={{
                    position: 'absolute',
                    bottom: 10,
                    insetInlineStart: 10,
                    background: '#1f1f1f',
                    color: '#fff',
                    borderRadius: 12,
                    fontSize: 11,
                    fontWeight: 600,
                    padding: '2px 9px',
                    border: `1px solid ${GOLD}`,
                    fontFamily: FONT,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  <FileTextOutlined style={{ fontSize: 11 }} />
                  {c.document_count}
                </span>
              )}
            </div>
            <div style={{ padding: 14 }}>
              <div
                style={{
                  color: TEXT_PRIMARY,
                  fontFamily: FONT,
                  fontSize: 15,
                  fontWeight: 600,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={c.title}
              >
                {c.title}
              </div>
              {c.client_name && (
                <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6, color: TEXT_SECONDARY, fontFamily: FONT, fontSize: 12.5 }}>
                  <UserOutlined style={{ fontSize: 12 }} />
                  {c.client_name}
                </div>
              )}
              <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <Tag
                  style={{
                    background: `${status.color}20`,
                    border: `1px solid ${status.color}40`,
                    color: status.color,
                    borderRadius: 12,
                    fontFamily: FONT,
                    margin: 0,
                  }}
                >
                  {status.label}
                </Tag>
                <span style={{ color: TEXT_TERTIARY, fontFamily: FONT, fontSize: 11 }}>
                  {dayjs(c.updated_at).format('DD/MM/YYYY')}
                </span>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Tree (file-manager) view ───────────────────────────────
interface TNode {
  key: string
  title: React.ReactNode
  isLeaf?: boolean
  icon?: React.ReactNode
  children?: TNode[]
  nodeType: 'case' | 'doc'
  caseId: string
  raw: any
}

function formatBytes(n?: number | null): string {
  if (!n || n <= 0) return '—'
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`
}

function caseToNode(c: CaseRecord): TNode {
  const count = c.document_count || 0
  return {
    key: `case:${c.id}`,
    nodeType: 'case',
    caseId: c.id,
    raw: c,
    isLeaf: count === 0,
    icon: <FolderGlyph size={16} />,
    title: (
      <span style={{ fontFamily: FONT, fontSize: 13.5, color: TEXT_PRIMARY }}>
        {c.title}
        {count > 0 && (
          <span style={{ color: TEXT_TERTIARY, fontSize: 11, marginInlineStart: 6 }}>
            ({count})
          </span>
        )}
      </span>
    ),
  }
}

function docToNode(d: CaseDocument, caseId: string): TNode {
  const st = DOCUMENT_STATUS_LABELS[d.status]
  return {
    key: `doc:${d.id}`,
    nodeType: 'doc',
    caseId,
    raw: d,
    isLeaf: true,
    icon: <FileTextOutlined style={{ color: DOCUMENT_TYPE_COLORS[d.document_type || 'other'] }} />,
    title: (
      <span style={{ fontFamily: FONT, fontSize: 13, color: TEXT_SECONDARY, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {d.title_ar}
        </span>
        {st && (
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: st.color }} title={st.label} />
        )}
      </span>
    ),
  }
}

function injectChildren(list: TNode[], key: string, children: TNode[]): TNode[] {
  return list.map((n) => {
    if (n.key === key) return { ...n, children }
    if (n.children) return { ...n, children: injectChildren(n.children, key, children) }
    return n
  })
}

function TreeView({ items, selectedId, onSelect, onOpen, onDelete }: ViewProps) {
  const [treeData, setTreeData] = useState<TNode[]>(() => items.map(caseToNode))
  const [selected, setSelected] = useState<TNode | null>(null)

  useEffect(() => {
    setTreeData(items.map(caseToNode))
  }, [items])

  const onLoadData = async (node: any): Promise<void> => {
    if (node.nodeType !== 'case' || (node.children && node.children.length)) return
    try {
      const docs: CaseDocument[] = (await apiClient.get(`/cases/${node.caseId}/documents`)).data
      setTreeData((prev) => injectChildren(prev, node.key, docs.map((d) => docToNode(d, node.caseId))))
    } catch {
      setTreeData((prev) => injectChildren(prev, node.key, []))
    }
  }

  return (
    <div style={{ display: 'flex', gap: 14, minHeight: 420, height: '100%', alignItems: 'stretch' }}>
      {/* Tree pane */}
      <div
        style={{
          width: 340,
          flexShrink: 0,
          border: `1px solid ${BORDER_SUBTLE}`,
          borderRadius: 10,
          padding: '10px 8px',
          background: DARK_CARD,
          overflow: 'auto',
        }}
      >
        <Tree
          showIcon
          blockNode
          treeData={treeData as any}
          loadData={onLoadData}
          selectedKeys={selected ? [selected.key] : []}
          onSelect={(_keys, info) => {
            const node = info.node as unknown as TNode
            setSelected(node)
            onSelect(node.caseId)
          }}
          onDoubleClick={(_e, node) => {
            const n = node as unknown as TNode
            onOpen(n.caseId)
          }}
          style={{ background: 'transparent', fontFamily: FONT }}
        />
      </div>

      {/* Details / preview pane */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          border: `1px solid ${BORDER_SUBTLE}`,
          borderRadius: 10,
          padding: 20,
          background: DARK_CARD,
          overflow: 'auto',
        }}
      >
        {!selected ? (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10, color: TEXT_TERTIARY, fontFamily: FONT }}>
            <FolderOpenOutlined style={{ fontSize: 40, color: GOLD }} />
            <span>اختر قضية أو مستندًا لعرض التفاصيل</span>
          </div>
        ) : selected.nodeType === 'case' ? (
          <CaseDetails c={selected.raw as CaseRecord} onOpen={onOpen} onDelete={onDelete} />
        ) : (
          <DocDetails d={selected.raw as CaseDocument} caseId={selected.caseId} onOpen={onOpen} />
        )}
      </div>
    </div>
  )
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 10, padding: '7px 0', borderBottom: `1px solid ${BORDER_SUBTLE}`, fontFamily: FONT, fontSize: 13 }}>
      <span style={{ color: TEXT_TERTIARY, width: 110, flexShrink: 0 }}>{label}</span>
      <span style={{ color: TEXT_PRIMARY, minWidth: 0 }}>{children}</span>
    </div>
  )
}

export function MahakimPanel({ c }: { c: CaseRecord }) {
  const refresh = useRefreshMahakim()
  const update = useUpdateCase(c.id)
  const { message } = AntApp.useApp()
  const st = MAHAKIM_STATUS_LABELS[c.mahakim_status] || MAHAKIM_STATUS_LABELS.idle
  const data = c.mahakim_data
  const canTrack =
    c.court_type !== 'cassation' &&
    !!(c.court_name && c.file_number && c.file_code && c.file_year)
  const busy = c.mahakim_status === 'queued' || c.mahakim_status === 'processing'

  const blank = {
    courtType: (c.court_type || 'appeal') as CourtType,
    courtName: c.court_name || '',
    fileNumber: c.file_number || '',
    fileCode: c.file_code || '',
    fileYear: c.file_year || '',
    courtSection: c.court_section || '',
    courtPanel: c.court_panel || '',
    caseCategory: c.case_category || 'file',
  }
  const [editing, setEditing] = useState(false)
  const [f, setF] = useState(blank)
  const isCassation = f.courtType === 'cassation'

  const openEditor = () => {
    setF(blank)
    setEditing(true)
  }

  const save = async () => {
    const cass = f.courtType === 'cassation'
    const courtName = cass ? SUPREME_COURT_NAME : f.courtName
    if (cass) {
      if (!f.fileNumber || !f.fileYear) {
        message.warning('رقم الملف والسنة مطلوبان')
        return
      }
    } else if (!courtName || !f.fileNumber || !f.fileCode || !f.fileYear) {
      message.warning('المحكمة ورقم الملف ورمز الملف والسنة كلها مطلوبة للتتبّع')
      return
    }
    try {
      await update.mutateAsync({
        courtType: f.courtType,
        courtName,
        fileNumber: f.fileNumber,
        fileCode: f.fileCode,
        fileYear: f.fileYear,
        courtSection: f.courtSection,
        courtPanel: f.courtPanel,
        caseCategory: f.caseCategory as 'file' | 'hearings',
      })
      message.success(
        cass
          ? 'تم حفظ المرجع (محكمة النقض غير متاحة للتتبّع الآلي)'
          : 'تم حفظ المرجع، جارٍ الجلب من محاكم',
      )
      setEditing(false)
    } catch (e: any) {
      message.error(e?.response?.data?.message || 'تعذّر حفظ المرجع')
    }
  }

  const doRefresh = async () => {
    try {
      await refresh.mutateAsync(c.id)
      message.success('بدأ جلب حالة الملف من محاكم')
    } catch (e: any) {
      message.error(e?.response?.data?.message || 'تعذّر بدء الجلب')
    }
  }

  const inputStyle = { fontFamily: FONT } as const

  return (
    <div
      style={{
        marginTop: 16,
        border: `1px solid ${BORDER_SUBTLE}`,
        borderRadius: 10,
        padding: 14,
        background: ELEVATED,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <BankOutlined style={{ color: GOLD }} />
        <span style={{ fontFamily: FONT, color: TEXT_PRIMARY, fontWeight: 600, fontSize: 13 }}>
          تتبّع الملف على محاكم
        </span>
        <Tag
          style={{
            background: `${st.color}20`,
            border: `1px solid ${st.color}40`,
            color: st.color,
            borderRadius: 10,
            fontFamily: FONT,
            marginInlineStart: 'auto',
            margin: 0,
          }}
        >
          {(busy ? <Spin size="small" style={{ marginInlineEnd: 6 }} /> : null)}
          {st.label}
        </Tag>
      </div>

      {(c.case_ref || c.court_name) && (
        <div style={{ color: TEXT_SECONDARY, fontFamily: FONT, fontSize: 12, marginBottom: 8 }}>
          {c.case_ref ||
            `${c.court_name}${c.file_number ? ` — ${c.file_number}/${c.file_code || ''}/${c.file_year || ''}` : ''}`}
        </div>
      )}

      {c.mahakim_status === 'unsupported' && (
        <div style={{ color: '#faad14', fontFamily: FONT, fontSize: 12, marginBottom: 8 }}>
          {c.mahakim_error ||
            'تتبّع ملفات محكمة النقض غير متاح على بوابة محاكم العمومية. تم حفظ المرجع.'}
        </div>
      )}

      {c.mahakim_fetched_at && (
        <div style={{ color: TEXT_TERTIARY, fontFamily: FONT, fontSize: 11, marginBottom: 8 }}>
          آخر جلب: {dayjs(c.mahakim_fetched_at).format('DD/MM/YYYY HH:mm')}
        </div>
      )}

      {c.mahakim_status === 'failed' && c.mahakim_error && (
        <div style={{ color: '#f5222d', fontFamily: FONT, fontSize: 12, marginBottom: 8 }}>
          {c.mahakim_error}
        </div>
      )}

      {c.mahakim_status === 'not_found' && (
        <div style={{ color: '#faad14', fontFamily: FONT, fontSize: 12, marginBottom: 8 }}>
          {c.mahakim_error || 'لم يتم العثور على الملف بهذا المرجع.'}
        </div>
      )}

      {data?.fields && Object.keys(data.fields).length > 0 && (
        <div style={{ marginBottom: 8 }}>
          {Object.entries(data.fields).slice(0, 12).map(([k, v]) => (
            <div key={k} style={{ display: 'flex', gap: 8, padding: '4px 0', fontFamily: FONT, fontSize: 12 }}>
              <span style={{ color: TEXT_TERTIARY, minWidth: 120 }}>{k}</span>
              <span style={{ color: TEXT_PRIMARY }}>{v}</span>
            </div>
          ))}
        </div>
      )}

      {data?.tables?.map((t, ti) => (
        <div key={ti} style={{ overflowX: 'auto', marginBottom: 10 }}>
          {t.caption && (
            <div style={{ color: TEXT_SECONDARY, fontFamily: FONT, fontSize: 12, marginBottom: 4 }}>
              {t.caption}
            </div>
          )}
          <table style={{ borderCollapse: 'collapse', width: '100%', fontFamily: FONT, fontSize: 12 }}>
            {t.headers.length > 0 && (
              <thead>
                <tr>
                  {t.headers.map((h, hi) => (
                    <th
                      key={hi}
                      style={{ textAlign: 'start', padding: '6px 8px', borderBottom: `1px solid ${BORDER_COLOR}`, color: TEXT_SECONDARY, whiteSpace: 'nowrap' }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {t.rows.slice(0, 30).map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      style={{ padding: '6px 8px', borderBottom: `1px solid ${BORDER_SUBTLE}`, color: TEXT_PRIMARY }}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {editing ? (
        <div style={{ marginTop: 4 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <Select
              value={f.courtType}
              onChange={(v) => setF((s) => ({ ...s, courtType: v }))}
              style={{ width: 160, ...inputStyle }}
              options={[
                { value: 'first_instance', label: 'المحكمة الابتدائية' },
                { value: 'appeal', label: 'محكمة الاستئناف' },
                { value: 'cassation', label: 'محكمة النقض' },
              ]}
            />
            {isCassation ? (
              <Input
                value={SUPREME_COURT_NAME}
                disabled
                style={{ flex: 1, ...inputStyle }}
              />
            ) : (
              <Select
                showSearch
                allowClear
                value={f.courtName || undefined}
                onChange={(v) => setF((s) => ({ ...s, courtName: v || '' }))}
                placeholder="اختر المحكمة"
                style={{ flex: 1, ...inputStyle }}
                options={APPEAL_COURTS.map((x) => ({ value: x, label: x }))}
                filterOption={(input, opt) =>
                  (opt?.value as string)?.toLowerCase().includes(input.toLowerCase())
                }
              />
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <Input
              value={f.fileNumber}
              onChange={(e) => setF((s) => ({ ...s, fileNumber: e.target.value }))}
              placeholder="رقم الملف"
              style={{ flex: 1, ...inputStyle }}
            />
            <Input
              value={f.fileCode}
              onChange={(e) => setF((s) => ({ ...s, fileCode: e.target.value }))}
              placeholder={isCassation ? 'رمز الملف (اختياري)' : 'رمز الملف'}
              style={{ flex: 1, ...inputStyle }}
            />
            <Input
              value={f.fileYear}
              onChange={(e) => setF((s) => ({ ...s, fileYear: e.target.value }))}
              placeholder="السنة"
              style={{ width: 90, ...inputStyle }}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <Input
              value={f.courtSection}
              onChange={(e) => setF((s) => ({ ...s, courtSection: e.target.value }))}
              placeholder="القسم / الغرفة (مثال: القسم التجاري عدد 3)"
              style={{ flex: 1, ...inputStyle }}
            />
            <Input
              value={f.courtPanel}
              onChange={(e) => setF((s) => ({ ...s, courtPanel: e.target.value }))}
              placeholder="الهيئة (مثال: الهيئة عدد 3)"
              style={{ width: 200, ...inputStyle }}
            />
            <Select
              value={f.caseCategory}
              onChange={(v) => setF((s) => ({ ...s, caseCategory: v }))}
              disabled={isCassation}
              style={{ width: 150, ...inputStyle }}
              options={[
                { value: 'file', label: 'ملف / محضر / شكاية' },
                { value: 'hearings', label: 'جدول الجلسات' },
              ]}
            />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              type="primary"
              size="small"
              loading={update.isPending}
              onClick={save}
              style={{ background: GOLD, borderColor: GOLD, color: '#000', fontWeight: 600, fontFamily: FONT }}
            >
              حفظ وجلب من محاكم
            </Button>
            <Button size="small" onClick={() => setEditing(false)} style={{ fontFamily: FONT }}>
              إلغاء
            </Button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            size="small"
            icon={<ReloadOutlined spin={busy} />}
            loading={refresh.isPending}
            disabled={!canTrack || busy}
            onClick={doRefresh}
            style={{ fontFamily: FONT }}
          >
            تحديث من محاكم
          </Button>
          <Button
            size="small"
            type={canTrack ? 'default' : 'primary'}
            icon={<BankOutlined />}
            onClick={openEditor}
            style={
              canTrack
                ? { fontFamily: FONT }
                : { background: GOLD, borderColor: GOLD, color: '#000', fontWeight: 600, fontFamily: FONT }
            }
          >
            {canTrack ? 'تعديل المرجع' : 'إضافة مرجع المحكمة'}
          </Button>
        </div>
      )}
    </div>
  )
}

function CaseDetails({ c, onOpen, onDelete }: { c: CaseRecord; onOpen: (id: string) => void; onDelete: (id: string) => void }) {
  const status = CASE_STATUS_LABELS[c.status] || CASE_STATUS_LABELS.open
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <FolderGlyph size={48} />
        <div style={{ minWidth: 0 }}>
          <div style={{ color: TEXT_PRIMARY, fontFamily: FONT, fontSize: 18, fontWeight: 700 }}>{c.title}</div>
          <div style={{ color: TEXT_TERTIARY, fontFamily: FONT, fontSize: 12 }}>قضية</div>
        </div>
      </div>
      <DetailRow label="الموكّل">{c.client_name || '—'}</DetailRow>
      <DetailRow label="المرجع">{c.case_ref || '—'}</DetailRow>
      <DetailRow label="الحالة">
        <Tag style={{ background: `${status.color}20`, border: `1px solid ${status.color}40`, color: status.color, borderRadius: 10, fontFamily: FONT, margin: 0 }}>
          {status.label}
        </Tag>
      </DetailRow>
      <DetailRow label="المستندات">{c.document_count || 0}</DetailRow>
      <DetailRow label="آخر تعديل">{dayjs(c.updated_at).format('DD/MM/YYYY HH:mm')}</DetailRow>
      <DetailRow label="أُنشئت">{dayjs(c.created_at).format('DD/MM/YYYY')}</DetailRow>
      {c.description && <DetailRow label="وصف">{c.description}</DetailRow>}

      <MahakimPanel c={c} />

      <div style={{ marginTop: 18, display: 'flex', gap: 10 }}>
        <Button
          type="primary"
          icon={<FolderOpenOutlined />}
          onClick={() => onOpen(c.id)}
          style={{ background: GOLD, borderColor: GOLD, color: '#000', fontWeight: 600, fontFamily: FONT }}
        >
          فتح القضية
        </Button>
        <Popconfirm
          title={<span style={{ fontFamily: FONT }}>حذف القضية وكل مستنداتها؟</span>}
          okText="حذف"
          cancelText="إلغاء"
          okButtonProps={{ danger: true }}
          onConfirm={() => onDelete(c.id)}
        >
          <Button danger icon={<DeleteOutlined />} style={{ fontFamily: FONT }}>
            حذف
          </Button>
        </Popconfirm>
      </div>
    </div>
  )
}

function DocDetails({ d, caseId, onOpen }: { d: CaseDocument; caseId: string; onOpen: (id: string) => void }) {
  const type = d.document_type ? DOCUMENT_TYPE_LABELS[d.document_type] || d.document_type : '—'
  const typeColor = DOCUMENT_TYPE_COLORS[d.document_type || 'other']
  const st = DOCUMENT_STATUS_LABELS[d.status]
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <FileTextOutlined style={{ fontSize: 40, color: typeColor }} />
        <div style={{ minWidth: 0 }}>
          <div style={{ color: TEXT_PRIMARY, fontFamily: FONT, fontSize: 16, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.title_ar}</div>
          <div style={{ color: TEXT_TERTIARY, fontFamily: FONT, fontSize: 12 }}>مستند</div>
        </div>
      </div>
      <DetailRow label="النوع">
        <Tag style={{ background: `${typeColor}20`, border: `1px solid ${typeColor}40`, color: typeColor, borderRadius: 10, fontFamily: FONT, margin: 0 }}>
          {type}
        </Tag>
      </DetailRow>
      <DetailRow label="الحالة">
        {st ? (
          <Tag style={{ background: `${st.color}20`, border: `1px solid ${st.color}40`, color: st.color, borderRadius: 10, fontFamily: FONT, margin: 0 }}>
            {st.label}
          </Tag>
        ) : (
          d.status
        )}
      </DetailRow>
      <DetailRow label="الصفحات">{d.page_count ?? '—'}</DetailRow>
      <DetailRow label="الحجم">{formatBytes(d.file_size_bytes)}</DetailRow>
      <DetailRow label="أُضيف">{dayjs(d.created_at).format('DD/MM/YYYY HH:mm')}</DetailRow>
      {d.error_message && (
        <DetailRow label="خطأ"><span style={{ color: '#f5222d' }}>{d.error_message}</span></DetailRow>
      )}
      <div style={{ marginTop: 18 }}>
        <Button
          type="primary"
          icon={<FolderOpenOutlined />}
          onClick={() => onOpen(caseId)}
          style={{ background: GOLD, borderColor: GOLD, color: '#000', fontWeight: 600, fontFamily: FONT }}
        >
          فتح في مساحة العمل
        </Button>
      </div>
    </div>
  )
}

// ── Create case modal ──────────────────────────────────────
function CreateCaseModal({
  open,
  form,
  loading,
  onCancel,
  onOk,
}: {
  open: boolean
  form: any
  loading: boolean
  onCancel: () => void
  onOk: () => void
}) {
  return (
    <Modal
      open={open}
      title={<span style={{ fontFamily: FONT, color: GOLD }}>قضية جديدة</span>}
      onCancel={onCancel}
      onOk={onOk}
      okText="إنشاء"
      cancelText="إلغاء"
      confirmLoading={loading}
      okButtonProps={{ style: { background: GOLD, borderColor: GOLD, color: '#000', fontWeight: 600 } }}
    >
      <Form form={form} layout="vertical" requiredMark={false} style={{ fontFamily: FONT }}>
        <Form.Item
          name="title"
          label={<span style={{ fontFamily: FONT }}>عنوان القضية</span>}
          rules={[{ required: true, message: 'العنوان مطلوب' }]}
        >
          <Input placeholder="مثال: نزاع تجاري — شركة ..." style={{ fontFamily: FONT }} />
        </Form.Item>
        <Form.Item name="clientName" label={<span style={{ fontFamily: FONT }}>اسم الموكّل</span>}>
          <Input placeholder="اسم العميل" style={{ fontFamily: FONT }} />
        </Form.Item>
        <Form.Item name="description" label={<span style={{ fontFamily: FONT }}>وصف</span>}>
          <Input.TextArea rows={2} placeholder="وصف مختصر للقضية" style={{ fontFamily: FONT }} />
        </Form.Item>

        <div
          style={{
            border: `1px solid ${BORDER_SUBTLE}`,
            borderRadius: 10,
            padding: '12px 14px 2px',
            marginBottom: 8,
            background: ELEVATED,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <BankOutlined style={{ color: GOLD }} />
            <span style={{ fontFamily: FONT, color: TEXT_PRIMARY, fontWeight: 600, fontSize: 13 }}>
              ربط بمحاكم (تتبع الملف القضائي)
            </span>
          </div>
          <div style={{ color: TEXT_TERTIARY, fontFamily: FONT, fontSize: 11.5, marginBottom: 12 }}>
            عند إدخال المحكمة ورمز الملف والسنة، يجلب النظام حالة الملف تلقائيًا من mahakim.ma في الخلفية.
          </div>
          <Form.Item
            name="courtType"
            label={<span style={{ fontFamily: FONT }}>نوع المحكمة</span>}
            initialValue="appeal"
          >
            <Select
              style={{ fontFamily: FONT }}
              options={[
                { value: 'first_instance', label: 'المحكمة الابتدائية' },
                { value: 'appeal', label: 'محكمة الاستئناف' },
                { value: 'cassation', label: 'محكمة النقض' },
              ]}
            />
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(p, c) => p.courtType !== c.courtType}
          >
            {({ getFieldValue }) =>
              getFieldValue('courtType') === 'cassation' ? (
                <Form.Item label={<span style={{ fontFamily: FONT }}>المحكمة</span>}>
                  <Input value={SUPREME_COURT_NAME} disabled style={{ fontFamily: FONT }} />
                </Form.Item>
              ) : (
                <Form.Item name="courtName" label={<span style={{ fontFamily: FONT }}>المحكمة</span>}>
                  <Select
                    showSearch
                    allowClear
                    placeholder="اختر أو اكتب اسم المحكمة"
                    style={{ fontFamily: FONT }}
                    options={APPEAL_COURTS.map((c) => ({ value: c, label: c }))}
                    filterOption={(input, opt) =>
                      (opt?.value as string)?.toLowerCase().includes(input.toLowerCase())
                    }
                  />
                </Form.Item>
              )
            }
          </Form.Item>
          <div style={{ display: 'flex', gap: 10 }}>
            <Form.Item
              name="fileNumber"
              label={<span style={{ fontFamily: FONT }}>رقم الملف</span>}
              style={{ flex: 1 }}
            >
              <Input placeholder="مثال: 100" style={{ fontFamily: FONT }} />
            </Form.Item>
            <Form.Item
              name="fileCode"
              label={<span style={{ fontFamily: FONT }}>رمز الملف</span>}
              style={{ flex: 1 }}
            >
              <Input placeholder="مثال: 2101" style={{ fontFamily: FONT }} />
            </Form.Item>
            <Form.Item
              name="fileYear"
              label={<span style={{ fontFamily: FONT }}>السنة</span>}
              style={{ width: 100 }}
            >
              <Input placeholder="2024" style={{ fontFamily: FONT }} />
            </Form.Item>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Form.Item
              name="courtSection"
              label={<span style={{ fontFamily: FONT }}>القسم / الغرفة</span>}
              style={{ flex: 1 }}
            >
              <Input placeholder="مثال: القسم التجاري عدد 3" style={{ fontFamily: FONT }} />
            </Form.Item>
            <Form.Item
              name="courtPanel"
              label={<span style={{ fontFamily: FONT }}>الهيئة</span>}
              style={{ flex: 1 }}
            >
              <Input placeholder="مثال: الهيئة عدد 3" style={{ fontFamily: FONT }} />
            </Form.Item>
          </div>
          <Form.Item
            name="caseCategory"
            label={<span style={{ fontFamily: FONT }}>نوع البحث</span>}
            initialValue="file"
          >
            <Select
              style={{ fontFamily: FONT }}
              options={[
                { value: 'file', label: 'ملف / محضر / شكاية' },
                { value: 'hearings', label: 'جدول الجلسات' },
              ]}
            />
          </Form.Item>
        </div>

        <Form.Item name="caseRef" label={<span style={{ fontFamily: FONT }}>مرجع مخصص (اختياري)</span>}>
          <Input placeholder="يُبنى تلقائيًا من المحكمة/الرمز/السنة إن تُرك فارغًا" style={{ fontFamily: FONT }} />
        </Form.Item>
      </Form>
    </Modal>
  )
}
