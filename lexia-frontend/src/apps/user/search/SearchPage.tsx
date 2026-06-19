import React, { useState, useCallback, useEffect, useRef } from 'react'
import {
  Input,
  Select,
  Cascader,
  Collapse,
  Segmented,
  Pagination,
  Empty,
  Spin,
  Tag,
  Drawer,
  Button,
  Divider,
  AutoComplete,
  Tooltip,
  Upload,
  Progress,
  Alert,
  message,
} from 'antd'
import type { UploadProps } from 'antd'
import {
  SearchOutlined,
  FileTextOutlined,
  FilePdfOutlined,
  CloseOutlined,
  FilterOutlined,
  LinkOutlined,
  CloudServerOutlined,
  EyeOutlined,
  CalendarOutlined,
  DatabaseOutlined,
  CloudUploadOutlined,
  SyncOutlined,
  UploadOutlined,
  LoadingOutlined,
  EditOutlined,
  AppstoreOutlined,
  UnorderedListOutlined,
  ReadOutlined,
} from '@ant-design/icons'
import {
  useSearch,
  useMinioFiles,
  useRenameSearchFile,
  useUpdateDocumentClassification,
  useResetDocumentClassification,
  SearchResult,
  MinioFile,
  isJudgmentFile,
} from '../../../shared/hooks/useSearch'
import {
  useSearchJudgmentSummary,
  useSummarizeSearchJudgment,
} from '../../../shared/hooks/useJudgmentSummary'
import { JudgmentSummaryDrawer } from '../../../shared/components/JudgmentSummaryDrawer'
import { suggestDocumentTitle } from '../../../shared/hooks/useCases'
import {
  RenameDocumentModal,
  RenamableDocument,
} from '../../../shared/components/RenameDocumentModal'
import {
  EditLegalClassificationModal,
  ClassifiableDocument,
} from '../../../shared/components/EditLegalClassificationModal'
import { useSearchUpload } from '../../../shared/hooks/useSearchUpload'
import { UploadTask } from '../../../shared/hooks/useTasks'
import { CollectionTag } from '../../../shared/components/CollectionTag'
import {
  GOLD,
  DARK_CARD,
  BORDER_COLOR,
  DOCUMENT_STATUS_LABELS,
} from '../../../shared/constants'
import {
  LEGAL_CLASSIFICATION,
  LEGAL_CLASSIFICATION_CASCADER_OPTIONS,
  resolveClassificationLabels,
} from '../../../shared/legalClassification'
import dayjs from 'dayjs'

const COLLECTIONS = [
  { value: '', label: 'جميع المجموعات' },
  { value: 'legal_laws', label: 'القوانين التشريعية' },
  { value: 'judgments_commercial', label: 'الأحكام التجارية' },
  { value: 'judgments_civil', label: 'الأحكام المدنية' },
  { value: 'judgments_admin', label: 'الأحكام الإدارية' },
  { value: 'judgments_criminal', label: 'الأحكام الجنائية' },
  { value: 'judgments_family', label: 'أحكام الأسرة' },
  { value: 'judgments_social', label: 'الأحكام الاجتماعية' },
  { value: 'judgments_real_estate', label: 'الأحكام العقارية' },
  { value: 'judgments_constitutional', label: 'الأحكام الدستورية' },
  { value: 'user_documents', label: 'وثائقي' },
]

const FONT = "'Noto Naskh Arabic', 'Cairo', sans-serif"
const FILES_PAGE_SIZE = 24
type FileLibraryView = 'grid' | 'list'

const UPLOAD_STAGE_LABELS: Record<string, string> = {
  queued: 'في قائمة Redis',
  preparing: 'تهيئة الملف',
  ocr: 'استخراج النص',
  indexing: 'الفهرسة',
  finalizing: 'إنهاء المعالجة',
  summary_queued: 'ملخص في الانتظار',
  summarizing: 'إعداد الملخص',
  completed: 'اكتمل',
  failed: 'فشل',
}

function SearchUploadTaskRow({ task }: { task: UploadTask }) {
  const stage = UPLOAD_STAGE_LABELS[task.stage] || task.stage
  const color =
    task.state === 'failed'
      ? '#f5222d'
      : task.state === 'completed'
        ? '#52c41a'
        : GOLD

  return (
    <div className="search-upload-task">
      <div className="search-upload-task__head">
        <FilePdfOutlined style={{ color: GOLD }} />
        <span className="search-upload-task__title" title={task.title}>
          {task.title}
        </span>
        <Tag color={color} style={{ margin: 0, fontFamily: FONT }}>
          {stage}
        </Tag>
      </div>
      <Progress
        percent={task.progress}
        size="small"
        strokeColor={color}
        status={task.state === 'failed' ? 'exception' : undefined}
      />
      {task.error ? (
        <div className="search-upload-task__error">{task.error}</div>
      ) : null}
    </div>
  )
}

function formatFileSize(value?: number | string | null) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes <= 0) return 'حجم غير متوفر'
  if (bytes < 1024) return `${bytes} بايت`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} كيلوبايت`
  return `${(bytes / 1024 ** 2).toFixed(1)} ميغابايت`
}

function StoredFileJudgmentButton({
  file,
  onOpen,
  loading,
}: {
  file: MinioFile
  onOpen: (file: MinioFile) => void
  loading?: boolean
}) {
  if (!isJudgmentFile(file)) return null

  const label = file.summary_ready || file.analysis_status === 'completed'
    ? 'عرض الملخص'
    : file.analysis_status === 'pending' || file.analysis_status === 'running'
      ? 'متابعة الملخص'
      : file.analysis_status === 'failed'
        ? 'إعادة التلخيص'
        : 'تلخيص الحكم'

  return (
    <Button
      size="small"
      icon={loading ? <LoadingOutlined /> : <ReadOutlined />}
      loading={loading}
      onClick={() => onOpen(file)}
      style={{
        fontFamily: FONT,
        borderColor: 'rgba(201,168,76,.45)',
        color: GOLD,
      }}
    >
      {label}
    </Button>
  )
}

function StoredFileCard({
  file,
  onRename,
  onEditClassification,
  onJudgmentSummary,
  summarizingId,
}: {
  file: MinioFile
  onRename?: (file: MinioFile) => void
  onEditClassification?: (file: MinioFile) => void
  onJudgmentSummary?: (file: MinioFile) => void
  summarizingId?: string | null
}) {
  const status = DOCUMENT_STATUS_LABELS[file.status]
  const isPdf =
    file.content_type === 'application/pdf' ||
    file.file_name.toLowerCase().endsWith('.pdf')

  return (
    <article className="search-file-card">
      <StoredFileIdentity file={file} isPdf={isPdf} onRename={onRename} />
      <StoredFileTags file={file} status={status} onEditClassification={onEditClassification} />
      <StoredFileMeta file={file} />
      <div className="search-file-card__actions">
        <StoredFileJudgmentButton
          file={file}
          onOpen={onJudgmentSummary || (() => {})}
          loading={summarizingId === file.id}
        />
        <StoredFileViewButton file={file} block />
      </div>
    </article>
  )
}

function StoredFileListRow({
  file,
  onRename,
  onEditClassification,
  onJudgmentSummary,
  summarizingId,
}: {
  file: MinioFile
  onRename?: (file: MinioFile) => void
  onEditClassification?: (file: MinioFile) => void
  onJudgmentSummary?: (file: MinioFile) => void
  summarizingId?: string | null
}) {
  const status = DOCUMENT_STATUS_LABELS[file.status]
  const isPdf =
    file.content_type === 'application/pdf' ||
    file.file_name.toLowerCase().endsWith('.pdf')

  return (
    <article className="search-file-row">
      <div className="search-file-row__icon">
        {isPdf ? <FilePdfOutlined /> : <FileTextOutlined />}
      </div>
      <div className="search-file-row__main">
        <StoredFileIdentity file={file} isPdf={isPdf} onRename={onRename} compact list />
      </div>
      <div className="search-file-row__side">
        <div className="search-file-row__meta">
          <StoredFileMeta file={file} inline />
        </div>
        <div className="search-file-row__actions">
          {file.can_rename && onRename ? (
            <Tooltip title="إعادة تسمية">
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                className="search-file-card__rename"
                onClick={() => onRename(file)}
              />
            </Tooltip>
          ) : null}
          <StoredFileJudgmentButton
            file={file}
            onOpen={onJudgmentSummary || (() => {})}
            loading={summarizingId === file.id}
          />
          <StoredFileViewButton file={file} />
        </div>
        <div className="search-file-row__tags">
          <StoredFileTags file={file} status={status} onEditClassification={onEditClassification} />
        </div>
      </div>
    </article>
  )
}

function StoredFileIdentity({
  file,
  isPdf,
  onRename,
  compact,
  list,
}: {
  file: MinioFile
  isPdf: boolean
  onRename?: (file: MinioFile) => void
  compact?: boolean
  list?: boolean
}) {
  return (
    <div className={`search-file-card__header${compact ? ' search-file-card__header--compact' : ''}`}>
      {!compact && (
        <div className="search-file-card__icon">
          {isPdf ? <FilePdfOutlined /> : <FileTextOutlined />}
        </div>
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
          <Tooltip title={file.title_ar}>
            <h3 className={`search-file-card__title${list ? ' search-file-card__title--list' : ''}`}>
              {file.title_ar}
            </h3>
          </Tooltip>
          {file.can_rename && onRename && !compact ? (
            <Tooltip title="إعادة تسمية">
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                className="search-file-card__rename"
                onClick={() => onRename(file)}
              />
            </Tooltip>
          ) : null}
        </div>
        <div className="search-file-card__name" title={file.file_name}>
          {file.file_name}
        </div>
      </div>
    </div>
  )
}

function StoredFileTags({
  file,
  status,
  onEditClassification,
}: {
  file: MinioFile
  status?: { label: string; color: string }
  onEditClassification?: (file: MinioFile) => void
}) {
  const { familyLabel, classLabel, familyColor } = resolveClassificationLabels(
    file.legal_family,
    file.legal_class,
  )
  const canEdit = file.can_rename && onEditClassification

  return (
    <div className="search-file-card__tags">
      {classLabel ? (
        <Tooltip
          title={
            canEdit
              ? `${familyLabel} — انقر لتعديل التصنيف${file.classification_manual ? ' (مُعدّل يدوياً)' : ''}`
              : familyLabel
          }
        >
          <Tag
            style={{
              margin: 0,
              borderRadius: 12,
              background: `${familyColor}18`,
              borderColor: `${familyColor}45`,
              color: familyColor,
              fontFamily: FONT,
              cursor: canEdit ? 'pointer' : undefined,
            }}
            onClick={canEdit ? () => onEditClassification(file) : undefined}
          >
            {classLabel}
            {canEdit ? (
              <EditOutlined style={{ marginInlineStart: 4, fontSize: 10, opacity: 0.75 }} />
            ) : null}
          </Tag>
        </Tooltip>
      ) : canEdit ? (
        <Tooltip title="تعيين التصنيف القانوني">
          <Tag
            style={{
              margin: 0,
              borderRadius: 12,
              fontFamily: FONT,
              cursor: 'pointer',
              borderStyle: 'dashed',
            }}
            onClick={() => onEditClassification(file)}
          >
            <EditOutlined style={{ marginInlineEnd: 4, fontSize: 10 }} />
            تصنيف
          </Tag>
        </Tooltip>
      ) : (
        <CollectionTag collection={file.collection} size="small" />
      )}
      {status && (
        <Tag
          style={{
            margin: 0,
            borderRadius: 12,
            background: `${status.color}18`,
            borderColor: `${status.color}45`,
            color: status.color,
            fontFamily: FONT,
          }}
        >
          {status.label}
        </Tag>
      )}
    </div>
  )
}

function LegalClassificationGuide() {
  return (
    <Collapse
      ghost
      style={{ marginBottom: 12, background: 'transparent' }}
      items={[
        {
          key: 'taxonomy',
          label: (
            <span style={{ fontFamily: FONT, color: 'var(--color-text-secondary)', fontSize: 13 }}>
              دليل تصنيف الوثائق القانونية (سلطة / ممارسة)
            </span>
          ),
          children: (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, direction: 'rtl' }}>
              {LEGAL_CLASSIFICATION.map((family) => (
                <div key={family.id}>
                  <div
                    style={{
                      fontFamily: FONT,
                      fontWeight: 700,
                      color: 'var(--color-text-primary)',
                      marginBottom: 4,
                    }}
                  >
                    {family.label}
                  </div>
                  <div
                    style={{
                      fontFamily: FONT,
                      fontSize: 12,
                      color: 'var(--color-text-tertiary)',
                      marginBottom: 8,
                      lineHeight: 1.6,
                    }}
                  >
                    {family.description}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {family.classes.map((cls) => (
                      <Tag
                        key={cls.id}
                        style={{
                          margin: 0,
                          borderRadius: 10,
                          fontFamily: FONT,
                          fontSize: 11,
                        }}
                      >
                        {cls.label}
                      </Tag>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ),
        },
      ]}
    />
  )
}

function StoredFileMeta({
  file,
  inline,
}: {
  file: MinioFile
  inline?: boolean
}) {
  return (
    <div className={`search-file-card__meta${inline ? ' search-file-card__meta--inline' : ''}`}>
      <span><DatabaseOutlined /> {formatFileSize(file.file_size_bytes)}</span>
      <span><CalendarOutlined /> {dayjs(file.created_at).format('DD/MM/YYYY')}</span>
      {file.page_count ? <span>{file.page_count} صفحة</span> : null}
    </div>
  )
}

function StoredFileViewButton({
  file,
  block,
}: {
  file: MinioFile
  block?: boolean
}) {
  if (file.url) {
    const btn = (
      <Button
        type="primary"
        block={block}
        size={block ? 'middle' : 'small'}
        icon={<EyeOutlined />}
        href={file.url}
        target="_blank"
        rel="noopener noreferrer"
        style={{ fontFamily: FONT, color: '#000', fontWeight: 600 }}
      >
        {block ? 'عرض الملف' : null}
      </Button>
    )
    return block ? btn : <Tooltip title="عرض الملف">{btn}</Tooltip>
  }
  return (
    <Button block={block} size={block ? 'middle' : 'small'} disabled style={{ fontFamily: FONT }}>
      {block ? 'الملف غير متاح حالياً' : '—'}
    </Button>
  )
}

function ResultCard({
  result,
  onClick,
  isActive,
}: {
  result: SearchResult
  onClick: () => void
  isActive: boolean
}) {
  return (
    <div
      onClick={onClick}
      style={{
        background: isActive ? 'rgba(201,168,76,0.08)' : DARK_CARD,
        border: `1px solid ${isActive ? 'rgba(201,168,76,0.4)' : BORDER_COLOR}`,
        borderRadius: 12,
        padding: '14px 16px',
        cursor: 'pointer',
        transition: 'all 0.2s',
        direction: 'rtl',
      }}
      onMouseEnter={(e) => {
        if (!isActive) e.currentTarget.style.borderColor = 'rgba(201,168,76,0.25)'
      }}
      onMouseLeave={(e) => {
        if (!isActive) e.currentTarget.style.borderColor = BORDER_COLOR
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
        <FileTextOutlined style={{ color: GOLD, fontSize: 16, marginTop: 2, flexShrink: 0 }} />
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: 'var(--color-text-primary)',
              fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
              marginBottom: 6,
              lineHeight: 1.4,
            }}
          >
            {result.title_ar}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            <CollectionTag collection={result.collection} size="small" />
            {result.jurisdiction && (
              <span
                style={{
                  fontSize: 11,
                  color: 'var(--color-text-tertiary)',
                  fontFamily: "'Cairo', sans-serif",
                }}
              >
                {result.jurisdiction}
              </span>
            )}
            {result.date && (
              <span style={{ fontSize: 11, color: 'var(--color-text-quaternary)', fontFamily: "'Cairo', sans-serif" }}>
                {result.date}
              </span>
            )}
          </div>
          {result.snippet && (
            <div
              style={{
                fontSize: 13,
                color: 'var(--color-text-secondary)',
                fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
                lineHeight: 1.65,
                display: '-webkit-box',
                WebkitLineClamp: 3,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
              dangerouslySetInnerHTML={{ __html: result.snippet }}
            />
          )}
        </div>
      </div>
      {result.score !== undefined && (
        <div style={{ textAlign: 'left', fontSize: 11, color: 'var(--color-text-quaternary)' }}>
          {(result.score * 100).toFixed(0)}% تطابق
        </div>
      )}
    </div>
  )
}

function DetailPanel({ result, onClose }: { result: SearchResult; onClose: () => void }) {
  return (
    <div style={{ padding: '20px', direction: 'rtl', height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <Button
          type="text"
          icon={<CloseOutlined />}
          onClick={onClose}
          style={{ color: 'var(--color-text-secondary)' }}
        />
        <div style={{ flex: 1, textAlign: 'right' }}>
          <CollectionTag collection={result.collection} />
        </div>
      </div>

      <h2
        style={{
          fontSize: 20,
          fontWeight: 700,
          color: 'var(--color-text-primary)',
          fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
          marginBottom: 12,
          lineHeight: 1.5,
          textAlign: 'right',
        }}
      >
        {result.title_ar}
      </h2>

      {result.title_fr && (
        <div
          style={{
            fontSize: 14,
            color: 'var(--color-text-tertiary)',
            marginBottom: 12,
            fontFamily: "'Cairo', sans-serif",
            textAlign: 'right',
          }}
        >
          {result.title_fr}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {result.jurisdiction && (
          <Tag style={{ background: 'var(--color-surface-soft)', border: '1px solid var(--color-border-subtle)', color: 'var(--color-text-secondary)' }}>
            {result.jurisdiction}
          </Tag>
        )}
        {result.date && (
          <Tag style={{ background: 'var(--color-surface-soft)', border: '1px solid var(--color-border-subtle)', color: 'var(--color-text-secondary)' }}>
            {result.date}
          </Tag>
        )}
      </div>

      {result.url && (
        <a
          href={result.url}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            color: GOLD,
            fontSize: 13,
            marginBottom: 16,
            fontFamily: "'Cairo', sans-serif",
          }}
        >
          <LinkOutlined />
          عرض الوثيقة الأصلية
        </a>
      )}

      <Divider style={{ borderColor: BORDER_COLOR }} />

      <div
        style={{
          fontSize: 14,
          color: 'var(--color-text-secondary)',
          fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
          lineHeight: 1.8,
          whiteSpace: 'pre-wrap',
          textAlign: 'right',
        }}
        dangerouslySetInnerHTML={{ __html: result.snippet }}
      />
    </div>
  )
}

export function SearchPage() {
  const [query, setQuery] = useState('')
  const [collection, setCollection] = useState('')
  const [classificationPath, setClassificationPath] = useState<string[]>([])
  const legalFamily = classificationPath[0] || undefined
  const legalClass = classificationPath[1] || undefined
  const [mode, setMode] = useState<'hybrid' | 'semantic' | 'text'>('hybrid')
  const [page, setPage] = useState(1)
  const [filesPage, setFilesPage] = useState(1)
  const [selectedResult, setSelectedResult] = useState<SearchResult | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [renameDoc, setRenameDoc] = useState<RenamableDocument | null>(null)
  const [classifyDoc, setClassifyDoc] = useState<ClassifiableDocument | null>(null)
  const [fileView, setFileView] = useState<FileLibraryView>(() => {
    try {
      const saved = localStorage.getItem('lexia-search-file-view')
      return saved === 'list' ? 'list' : 'grid'
    } catch {
      return 'grid'
    }
  })

  const handleFileViewChange = (view: FileLibraryView) => {
    setFileView(view)
    try {
      localStorage.setItem('lexia-search-file-view', view)
    } catch {
      /* ignore */
    }
  }

  const { results, isLoading, total, suggestions, search, suggest } = useSearch()
  const filesQuery = useMinioFiles(
    collection,
    filesPage,
    FILES_PAGE_SIZE,
    legalFamily,
    legalClass,
  )
  const renameFile = useRenameSearchFile()
  const updateClassification = useUpdateDocumentClassification()
  const resetClassification = useResetDocumentClassification()
  const summarizeJudgment = useSummarizeSearchJudgment()
  const [summaryDocId, setSummaryDocId] = useState<string | null>(null)
  const [summaryReload, setSummaryReload] = useState(0)
  const [summarizingId, setSummarizingId] = useState<string | null>(null)
  const summaryStream = useSearchJudgmentSummary(summaryDocId, summaryReload)
  const {
    uploadFile,
    uploading,
    uploadError,
    activeTasks,
    tasks: searchUploadTasks,
  } = useSearchUpload()

  const prevActiveCount = useRef(0)

  useEffect(() => {
    setFilesPage(1)
  }, [collection, legalFamily, legalClass])

  useEffect(() => {
    if (prevActiveCount.current > 0 && activeTasks.length === 0) {
      filesQuery.refetch()
    }
    prevActiveCount.current = activeTasks.length
  }, [activeTasks.length, filesQuery.refetch])

  const handleUpload: UploadProps['beforeUpload'] = async (file) => {
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      message.error('يُقبل ملف PDF فقط')
      return Upload.LIST_IGNORE
    }
    try {
      await uploadFile(file)
      message.success('تم رفع الملف — المعالجة جارية عبر Redis')
    } catch (err: any) {
      message.error(err?.response?.data?.message || 'تعذّر رفع الملف')
    }
    return Upload.LIST_IGNORE
  }

  const handleSearch = useCallback(
    (q: string) => {
      setQuery(q)
      setPage(1)
      search({ q, collection, mode, page: 1, legalFamily, legalClass })
    },
    [collection, mode, search, legalFamily, legalClass]
  )

  const handleFilterChange = useCallback(
    (
      newCollection: string,
      newMode: 'hybrid' | 'semantic' | 'text',
      newClassificationPath: string[] = classificationPath,
    ) => {
      const fam = newClassificationPath[0] || undefined
      const cls = newClassificationPath[1] || undefined
      if (query) {
        search({
          q: query,
          collection: newCollection,
          mode: newMode,
          page: 1,
          legalFamily: fam,
          legalClass: cls,
        })
      }
    },
    [query, search, classificationPath]
  )

  const handleResultClick = (result: SearchResult) => {
    setSelectedResult(result)
    setDrawerOpen(true)
  }

  const openClassificationEditor = (file: MinioFile) => {
    setClassifyDoc({
      id: file.id,
      title_ar: file.title_ar,
      legal_family: file.legal_family,
      legal_class: file.legal_class,
      classification_manual: file.classification_manual,
    })
  }

  const handleJudgmentSummary = async (file: MinioFile) => {
    const hasAnalysis =
      file.summary_ready ||
      file.analysis_status === 'completed' ||
      file.analysis_status === 'pending' ||
      file.analysis_status === 'running'

    if (hasAnalysis) {
      setSummaryDocId(file.id)
      setSummaryReload((n) => n + 1)
      return
    }

    setSummarizingId(file.id)
    try {
      await summarizeJudgment.mutateAsync(file.id)
      setSummaryDocId(file.id)
      setSummaryReload((n) => n + 1)
    } catch (err: any) {
      message.error(err?.response?.data?.message || 'تعذّر بدء تلخيص الحكم')
    } finally {
      setSummarizingId(null)
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        direction: 'rtl',
        padding: '24px 20px',
        gap: 20,
        maxWidth: 1100,
        margin: '0 auto',
        width: '100%',
      }}
    >
      <style>{`
        .search-file-library {
          border: 1px solid ${BORDER_COLOR};
          border-radius: 18px;
          background:
            radial-gradient(circle at 100% 0%, rgba(201,168,76,.13), transparent 30%),
            ${DARK_CARD};
          padding: 18px;
        }
        .search-file-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 12px;
        }
        .search-file-card {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 12px;
          padding: 16px;
          border: 1px solid var(--color-border-subtle);
          border-radius: 14px;
          background: var(--color-bg-card);
          box-shadow: 0 8px 24px rgba(0,0,0,.05);
          transition: transform .18s ease, border-color .18s ease, box-shadow .18s ease;
        }
        .search-file-card:hover {
          transform: translateY(-2px);
          border-color: rgba(201,168,76,.5);
          box-shadow: 0 12px 30px rgba(0,0,0,.09);
        }
        .search-file-card__header {
          display: flex;
          align-items: flex-start;
          gap: 11px;
        }
        .search-file-card__icon {
          width: 40px;
          height: 48px;
          flex: 0 0 40px;
          display: grid;
          place-items: center;
          border: 1px solid rgba(201,168,76,.3);
          border-radius: 9px 9px 12px 12px;
          background: linear-gradient(145deg, rgba(201,168,76,.18), rgba(201,168,76,.04));
          color: ${GOLD};
          font-size: 21px;
        }
        .search-file-card__title {
          margin: 0 0 3px;
          color: var(--color-text-primary);
          font: 700 15px/1.5 ${FONT};
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          flex: 1;
          min-width: 0;
        }
        .search-file-card__rename {
          flex-shrink: 0;
          color: var(--color-text-tertiary) !important;
          padding-inline: 4px;
        }
        .search-file-card__rename:hover {
          color: ${GOLD} !important;
        }
        .search-file-card__name {
          color: var(--color-text-quaternary);
          font-size: 11px;
          direction: ltr;
          text-align: right;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .search-file-card__tags {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
        }
        .search-file-card__meta {
          min-height: 36px;
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
          color: var(--color-text-tertiary);
          font: 11px/1.4 ${FONT};
        }
        .search-file-card__meta span {
          display: inline-flex;
          align-items: center;
          gap: 4px;
        }
        .search-file-card__actions {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .search-file-card__meta--inline {
          min-height: 0;
          flex-wrap: nowrap;
          white-space: nowrap;
        }
        .search-file-card__header--compact {
          margin: 0;
        }
        .search-file-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .search-file-row {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 10px 12px;
          border: 1px solid var(--color-border-subtle);
          border-radius: 12px;
          background: var(--color-bg-card);
          transition: border-color .18s ease, box-shadow .18s ease;
        }
        .search-file-row:hover {
          border-color: rgba(201,168,76,.45);
          box-shadow: 0 4px 14px rgba(0,0,0,.05);
        }
        .search-file-row__icon {
          width: 36px;
          height: 36px;
          flex: 0 0 36px;
          display: grid;
          place-items: center;
          border: 1px solid rgba(201,168,76,.28);
          border-radius: 8px;
          background: rgba(201,168,76,.08);
          color: ${GOLD};
          font-size: 17px;
        }
        .search-file-row__main {
          flex: 1;
          min-width: 0;
        }
        .search-file-row__side {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-shrink: 0;
          margin-inline-start: auto;
        }
        .search-file-row__tags .search-file-card__tags {
          justify-content: flex-end;
          flex-wrap: nowrap;
        }
        .search-file-row__meta {
          flex-shrink: 0;
        }
        .search-file-row__actions {
          display: flex;
          align-items: center;
          gap: 4px;
          flex-shrink: 0;
        }
        .search-file-card__title--list {
          white-space: normal;
          overflow: visible;
          text-overflow: unset;
          line-height: 1.45;
        }
        .search-file-view-toggle .ant-segmented-item-label {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          font-family: ${FONT};
          font-size: 12px;
        }
        @media (max-width: 900px) {
          .search-file-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .search-file-row {
            flex-wrap: wrap;
            align-items: flex-start;
          }
          .search-file-row__main {
            flex: 1 1 calc(100% - 48px);
            order: 1;
          }
          .search-file-row__icon {
            order: 0;
          }
          .search-file-row__side {
            order: 2;
            width: 100%;
            margin-inline-start: 0;
            justify-content: space-between;
            flex-wrap: wrap;
            padding-top: 4px;
            border-top: 1px solid var(--color-border-subtle);
          }
        }
        @media (max-width: 620px) {
          .search-file-library { padding: 12px; }
          .search-file-grid { grid-template-columns: 1fr; }
        }
        .search-upload-zone {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
          margin-bottom: 14px;
          padding: 10px 12px;
          border: 1px solid var(--color-border-subtle);
          border-radius: 12px;
          background: var(--color-bg-elevated);
        }
        .search-upload-hint {
          font: 11.5px/1.4 ${FONT};
          color: var(--color-text-tertiary);
        }
        .search-upload-tasks {
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin-bottom: 14px;
        }
        .search-upload-task {
          padding: 10px 12px;
          border: 1px solid var(--color-border-subtle);
          border-radius: 12px;
          background: var(--color-bg-card);
        }
        .search-upload-task__head {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 8px;
        }
        .search-upload-task__title {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font: 600 13px/1.4 ${FONT};
          color: var(--color-text-primary);
          direction: ltr;
          text-align: right;
        }
        .search-upload-task__error {
          margin-top: 6px;
          color: #f5222d;
          font: 12px/1.5 ${FONT};
        }
      `}</style>

      {/* Search bar */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <AutoComplete
          value={query}
          options={suggestions.map((s) => ({ value: s, label: s }))}
          onSearch={(val) => {
            setQuery(val)
            suggest(val)
          }}
          onSelect={handleSearch}
          style={{ width: '100%' }}
        >
          <Input
            size="large"
            placeholder="ابحث في القوانين والأحكام المغربية..."
            prefix={isLoading ? <Spin size="small" /> : <SearchOutlined style={{ color: GOLD }} />}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              suggest(e.target.value)
            }}
            onPressEnter={() => handleSearch(query)}
            style={{
              background: DARK_CARD,
              border: `1px solid ${query ? 'rgba(201,168,76,0.5)' : BORDER_COLOR}`,
              borderRadius: 12,
              fontSize: 16,
              fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
              height: 52,
              direction: 'rtl',
              color: 'var(--color-text-primary)',
            }}
            allowClear
          />
        </AutoComplete>

        {/* Filters row */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <FilterOutlined style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />

          <Select
            value={collection}
            onChange={(val) => {
              setCollection(val)
              handleFilterChange(val, mode)
            }}
            options={COLLECTIONS}
            style={{ minWidth: 200 }}
            placeholder="جميع المجموعات"
          />

          <Cascader
            options={LEGAL_CLASSIFICATION_CASCADER_OPTIONS}
            value={(classificationPath.length ? classificationPath : undefined) as any}
            onChange={(val) => {
              const path = (val as string[]) || []
              setClassificationPath(path)
              handleFilterChange(collection, mode, path)
            }}
            changeOnSelect
            expandTrigger="hover"
            placeholder="تصنيف الوثائق القانونية"
            style={{ minWidth: 240 }}
            allowClear
          />

          <Segmented
            value={mode}
            onChange={(val) => {
              const m = val as 'hybrid' | 'semantic' | 'text'
              setMode(m)
              handleFilterChange(collection, m)
            }}
            options={[
              { label: 'هجين', value: 'hybrid' },
              { label: 'دلالي', value: 'semantic' },
              { label: 'نصي', value: 'text' },
            ]}
            style={{
              background: DARK_CARD,
              fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
            }}
          />

          {total > 0 && (
            <span
              style={{
                fontSize: 13,
                color: 'var(--color-text-tertiary)',
                fontFamily: "'Cairo', sans-serif",
                marginRight: 'auto',
              }}
            >
              {total} نتيجة
            </span>
          )}
        </div>
      </div>

      {/* Results */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {!query && (
          <section className="search-file-library">
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 14,
                marginBottom: 12,
                flexWrap: 'wrap',
              }}
            >
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <CloudServerOutlined style={{ color: GOLD, fontSize: 23, marginTop: 3 }} />
                <div>
                  <h2 style={{ margin: 0, color: 'var(--color-text-primary)', fontFamily: FONT, fontSize: 19 }}>
                    الملفات المتاحة
                  </h2>
                  <p style={{ margin: '2px 0 0', color: 'var(--color-text-tertiary)', fontFamily: FONT, fontSize: 12.5 }}>
                    الوثائق المخزنة في MinIO حسب صلاحيات حسابك
                  </p>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {!filesQuery.isLoading && (
                  <Tag
                    style={{
                      margin: 0,
                      borderRadius: 14,
                      paddingInline: 10,
                      color: GOLD,
                      borderColor: 'rgba(201,168,76,.35)',
                      background: 'rgba(201,168,76,.08)',
                      fontFamily: FONT,
                    }}
                  >
                    {filesQuery.data?.total || 0} ملف
                  </Tag>
                )}
                <Segmented
                  className="search-file-view-toggle"
                  size="small"
                  value={fileView}
                  onChange={(val) => handleFileViewChange(val as FileLibraryView)}
                  options={[
                    {
                      label: (
                        <>
                          <AppstoreOutlined />
                          بطاقات
                        </>
                      ),
                      value: 'grid',
                    },
                    {
                      label: (
                        <>
                          <UnorderedListOutlined />
                          قائمة
                        </>
                      ),
                      value: 'list',
                    },
                  ]}
                />
                <Upload
                  accept=".pdf,application/pdf"
                  showUploadList={false}
                  multiple={false}
                  disabled={uploading}
                  beforeUpload={handleUpload}
                >
                  <Button
                    type="primary"
                    size="small"
                    icon={uploading ? <LoadingOutlined /> : <UploadOutlined />}
                    loading={uploading}
                    style={{
                      background: GOLD,
                      borderColor: GOLD,
                      color: '#000',
                      fontWeight: 600,
                      fontFamily: FONT,
                    }}
                  >
                    رفع PDF
                  </Button>
                </Upload>
              </div>
            </div>

            <LegalClassificationGuide />

            <div className="search-upload-zone">
              <CloudUploadOutlined style={{ color: GOLD, fontSize: 18 }} />
              <span className="search-upload-hint">
                OCR + فهرسة عبر Redis — يظهر الملف في المكتبة بعد اكتمال المعالجة
              </span>
              {activeTasks.length > 0 && (
                <Tag icon={<SyncOutlined spin />} color="processing" style={{ marginInlineStart: 'auto', fontFamily: FONT }}>
                  {activeTasks.length} قيد التنفيذ
                </Tag>
              )}
            </div>

            {uploadError ? (
              <Alert
                type="error"
                showIcon
                message="تعذّر الرفع"
                description={uploadError.message}
                style={{ marginBottom: 16, fontFamily: FONT }}
              />
            ) : null}

            {searchUploadTasks.length > 0 && activeTasks.length > 0 && (
              <div className="search-upload-tasks">
                {searchUploadTasks.slice(0, 3).map((task) => (
                  <SearchUploadTaskRow key={task.id} task={task} />
                ))}
              </div>
            )}

            {filesQuery.isLoading ? (
              <div style={{ minHeight: 240, display: 'grid', placeItems: 'center' }}>
                <Spin size="large" />
              </div>
            ) : filesQuery.isError ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={<span style={{ fontFamily: FONT }}>تعذّر تحميل الملفات</span>}
              />
            ) : !filesQuery.data?.files.length ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={<span style={{ fontFamily: FONT }}>لا توجد ملفات في هذا التصنيف</span>}
              />
            ) : (
              <>
                {fileView === 'grid' ? (
                  <div className="search-file-grid">
                    {filesQuery.data.files.map((file) => (
                      <StoredFileCard
                        key={file.id}
                        file={file}
                        summarizingId={summarizingId}
                        onJudgmentSummary={handleJudgmentSummary}
                        onRename={(f) =>
                          setRenameDoc({
                            id: f.id,
                            title_ar: f.title_ar,
                            status: f.status,
                          })
                        }
                        onEditClassification={openClassificationEditor}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="search-file-list">
                    {filesQuery.data.files.map((file) => (
                      <StoredFileListRow
                        key={file.id}
                        file={file}
                        summarizingId={summarizingId}
                        onJudgmentSummary={handleJudgmentSummary}
                        onRename={(f) =>
                          setRenameDoc({
                            id: f.id,
                            title_ar: f.title_ar,
                            status: f.status,
                          })
                        }
                        onEditClassification={openClassificationEditor}
                      />
                    ))}
                  </div>
                )}
                {filesQuery.data.total > FILES_PAGE_SIZE && (
                  <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 18 }}>
                    <Pagination
                      current={filesPage}
                      total={filesQuery.data.total}
                      pageSize={FILES_PAGE_SIZE}
                      showSizeChanger={false}
                      onChange={setFilesPage}
                    />
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {query && !isLoading && results.length === 0 && (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <div style={{ direction: 'rtl', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>
                <div style={{ color: 'var(--color-text-secondary)', marginBottom: 8 }}>لا توجد نتائج لـ "{query}"</div>
                <div style={{ color: 'var(--color-text-quaternary)', fontSize: 13 }}>
                  حاول تغيير كلمات البحث أو تصفية المجموعات
                </div>
              </div>
            }
          />
        )}

        {results.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {results.map((result) => (
              <ResultCard
                key={result.id}
                result={result}
                onClick={() => handleResultClick(result)}
                isActive={selectedResult?.id === result.id}
              />
            ))}

            {total > 20 && (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '16px 0' }}>
                <Pagination
                  current={page}
                  total={total}
                  pageSize={20}
                  onChange={(p) => {
                    setPage(p)
                    search({ q: query, collection, mode, page: p, legalFamily, legalClass })
                  }}
                  showTotal={(t) => (
                    <span style={{ fontFamily: "'Cairo', sans-serif", color: 'var(--color-text-secondary)' }}>
                      {t} نتيجة
                    </span>
                  )}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Detail drawer */}
      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        placement="left"
        width={480}
        title={null}
        closable={false}
        styles={{
          body: { padding: 0, background: 'var(--color-bg-sidebar)' },
          mask: { background: 'var(--color-mask)' },
        }}
      >
        {selectedResult && (
          <DetailPanel result={selectedResult} onClose={() => setDrawerOpen(false)} />
        )}
      </Drawer>

      <RenameDocumentModal
        document={renameDoc}
        onClose={() => setRenameDoc(null)}
        onSave={async (documentId, titleAr) => {
          await renameFile.mutateAsync({ documentId, titleAr })
          message.success('تم تحديث اسم المستند')
          setRenameDoc(null)
        }}
        onSuggest={suggestDocumentTitle}
      />

      <EditLegalClassificationModal
        document={classifyDoc}
        onClose={() => setClassifyDoc(null)}
        onSave={async (documentId, legalFamily, legalClass) => {
          await updateClassification.mutateAsync({ documentId, legalFamily, legalClass })
        }}
        onReset={async (documentId) => {
          await resetClassification.mutateAsync(documentId)
        }}
      />

      <JudgmentSummaryDrawer
        documentId={summaryDocId}
        onClose={() => setSummaryDocId(null)}
        stream={summaryStream}
      />
    </div>
  )
}
