import React, { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Alert,
  Button,
  Empty,
  Input,
  Progress,
  Segmented,
  Spin,
  Tag,
  Tooltip,
} from 'antd'
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  EyeOutlined,
  FileDoneOutlined,
  FilePdfOutlined,
  FolderOpenOutlined,
  LoadingOutlined,
  SearchOutlined,
  SyncOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import { DocumentViewer } from '../../admin/documents/DocumentViewer'
import { useUploadTasks, UploadTask } from '../../../shared/hooks/useTasks'
import {
  DOCUMENT_TYPE_LABELS,
  GOLD,
  GOLD_TINT,
  TEXT_PRIMARY,
  TEXT_SECONDARY,
  TEXT_TERTIARY,
} from '../../../shared/constants'

dayjs.extend(relativeTime)

const FONT = "'Noto Naskh Arabic', 'Cairo', sans-serif"

const STAGE_LABELS: Record<string, string> = {
  queued: 'في قائمة Redis',
  preparing: 'تهيئة الملف',
  ocr: 'استخراج النص والتعرّف الضوئي',
  indexing: 'الفهرسة وتجهيز البحث',
  finalizing: 'إنهاء المعالجة',
  summary_queued: 'ملخص الحكم في قائمة الانتظار',
  summarizing: 'إعداد الملخص القانوني',
  completed: 'اكتملت المهمة',
  failed: 'فشلت المهمة',
}

const STATE_CONFIG = {
  queued: {
    label: 'في الانتظار',
    color: '#1677ff',
    icon: <ClockCircleOutlined />,
  },
  running: {
    label: 'قيد التنفيذ',
    color: GOLD,
    icon: <LoadingOutlined spin />,
  },
  completed: {
    label: 'مكتملة',
    color: '#52c41a',
    icon: <CheckCircleOutlined />,
  },
  failed: {
    label: 'فشلت',
    color: '#f5222d',
    icon: <CloseCircleOutlined />,
  },
}

type TaskFilter = 'all' | 'active' | 'judgments' | 'documents' | 'failed'

function matchesFilter(task: UploadTask, filter: TaskFilter): boolean {
  if (filter === 'active') {
    return task.state === 'queued' || task.state === 'running'
  }
  if (filter === 'judgments') return task.documentType === 'judgment'
  if (filter === 'documents') return task.documentType !== 'judgment'
  if (filter === 'failed') return task.state === 'failed'
  return true
}

function Metric({
  label,
  value,
  accent,
}: {
  label: string
  value: number
  accent: string
}) {
  return (
    <div className="task-metric">
      <span className="task-metric-value" style={{ color: accent }}>
        {value}
      </span>
      <span className="task-metric-label">{label}</span>
    </div>
  )
}

export function TasksPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const tasksQ = useUploadTasks()
  const [query, setQuery] = useState('')
  const [viewer, setViewer] = useState<{
    id: string
    title: string
  } | null>(null)

  const rawFilter = params.get('filter') as TaskFilter | null
  const filter: TaskFilter = [
    'active',
    'judgments',
    'documents',
    'failed',
  ].includes(rawFilter || '')
    ? (rawFilter as TaskFilter)
    : 'all'

  const tasks = tasksQ.data || []
  const counts = useMemo(
    () => ({
      active: tasks.filter(
        (task) => task.state === 'queued' || task.state === 'running',
      ).length,
      completed: tasks.filter((task) => task.state === 'completed').length,
      failed: tasks.filter((task) => task.state === 'failed').length,
      total: tasks.length,
    }),
    [tasks],
  )

  const visibleTasks = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('ar')
    return tasks.filter((task) => {
      if (!matchesFilter(task, filter)) return false
      if (!normalized) return true
      return (
        task.title?.toLocaleLowerCase('ar').includes(normalized) ||
        task.caseTitle?.toLocaleLowerCase('ar').includes(normalized) ||
        DOCUMENT_TYPE_LABELS[task.documentType || '']
          ?.toLocaleLowerCase('ar')
          .includes(normalized)
      )
    })
  }, [filter, query, tasks])

  return (
    <div className="tasks-page">
      <style>{`
        .tasks-page {
          width: 100%;
          max-width: 1180px;
          margin: 0 auto;
          padding: 28px 24px 48px;
          direction: rtl;
          font-family: ${FONT};
        }
        .tasks-hero {
          position: relative;
          overflow: hidden;
          display: grid;
          grid-template-columns: minmax(0, 1.4fr) minmax(320px, .6fr);
          gap: 30px;
          padding: 28px 30px;
          border: 1px solid var(--color-gold-border);
          border-radius: 22px;
          background:
            linear-gradient(135deg, var(--color-bg-card) 0%, var(--color-bg-elevated) 100%);
          box-shadow: 0 18px 55px rgba(0,0,0,.08);
        }
        .tasks-hero::after {
          content: '';
          position: absolute;
          inset-inline-end: -90px;
          top: -130px;
          width: 340px;
          height: 340px;
          border-radius: 50%;
          border: 70px solid ${GOLD_TINT};
          pointer-events: none;
        }
        .tasks-kicker {
          color: ${GOLD};
          font-size: 12px;
          letter-spacing: 1.8px;
          font-weight: 700;
          margin-bottom: 8px;
        }
        .tasks-title {
          margin: 0;
          color: ${TEXT_PRIMARY};
          font-size: clamp(26px, 4vw, 42px);
          line-height: 1.2;
        }
        .tasks-subtitle {
          max-width: 650px;
          margin: 10px 0 0;
          color: ${TEXT_SECONDARY};
          font-size: 14px;
          line-height: 1.9;
        }
        .task-metrics {
          position: relative;
          z-index: 1;
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 10px;
          align-content: center;
        }
        .task-metric {
          min-height: 92px;
          display: flex;
          flex-direction: column;
          justify-content: center;
          padding: 15px 18px;
          border: 1px solid var(--color-border-subtle);
          border-radius: 16px;
          background: color-mix(in srgb, var(--color-bg-card) 90%, transparent);
          backdrop-filter: blur(12px);
        }
        .task-metric-value {
          font-family: Georgia, 'Times New Roman', serif;
          font-size: 29px;
          line-height: 1;
          font-weight: 700;
        }
        .task-metric-label {
          margin-top: 7px;
          color: ${TEXT_TERTIARY};
          font-size: 12px;
        }
        .tasks-toolbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin: 24px 0 14px;
          flex-wrap: wrap;
        }
        .task-list {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .task-row {
          display: grid;
          grid-template-columns: 48px minmax(0, 1.4fr) minmax(180px, .75fr) 145px auto;
          align-items: center;
          gap: 16px;
          min-height: 92px;
          padding: 16px 18px;
          border: 1px solid var(--color-border-subtle);
          border-radius: 16px;
          background: var(--color-bg-card);
          transition: transform .18s ease, border-color .18s ease, box-shadow .18s ease;
        }
        .task-row:hover {
          transform: translateY(-1px);
          border-color: var(--color-gold-border);
          box-shadow: 0 10px 30px rgba(0,0,0,.06);
        }
        .task-file-icon {
          width: 46px;
          height: 52px;
          display: grid;
          place-items: center;
          border: 1px solid var(--color-gold-border);
          border-radius: 8px 14px 8px 8px;
          background: var(--color-gold-tint);
          color: ${GOLD};
          font-size: 20px;
        }
        .task-title {
          overflow: hidden;
          color: ${TEXT_PRIMARY};
          font-size: 14px;
          font-weight: 700;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .task-meta {
          display: flex;
          align-items: center;
          gap: 7px;
          margin-top: 6px;
          color: ${TEXT_TERTIARY};
          font-size: 11px;
          flex-wrap: wrap;
        }
        .task-progress-label {
          display: flex;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 5px;
          color: ${TEXT_SECONDARY};
          font-size: 11px;
        }
        @media (max-width: 900px) {
          .tasks-hero { grid-template-columns: 1fr; }
          .task-row {
            grid-template-columns: 44px minmax(0, 1fr) auto;
          }
          .task-progress { grid-column: 2 / -1; }
          .task-updated { display: none; }
        }
        @media (max-width: 620px) {
          .tasks-page { padding: 18px 12px 32px; }
          .tasks-hero { padding: 22px 18px; }
          .task-row { gap: 10px; padding: 14px 12px; }
          .task-state-label { display: none; }
        }
      `}</style>

      <section className="tasks-hero">
        <div style={{ position: 'relative', zIndex: 1 }}>
          <div className="tasks-kicker">LEXIA · REDIS TASKS</div>
          <h1 className="tasks-title">مركز المهام القانونية</h1>
          <p className="tasks-subtitle">
            تابع رفع الوثائق، واستخراج النصوص، والفهرسة، وتحليل الأحكام من
            قائمة واحدة. تستمر كل مهمة في Redis حتى تصل إلى نتيجة نهائية.
          </p>
        </div>
        <div className="task-metrics">
          <Metric label="قيد التنفيذ" value={counts.active} accent={GOLD} />
          <Metric label="مكتملة" value={counts.completed} accent="#52c41a" />
          <Metric label="فشلت" value={counts.failed} accent="#f5222d" />
          <Metric label="إجمالي المهام" value={counts.total} accent={TEXT_PRIMARY} />
        </div>
      </section>

      <div className="tasks-toolbar">
        <Segmented
          value={filter}
          onChange={(value) => {
            const next = value as TaskFilter
            setParams(next === 'all' ? {} : { filter: next })
          }}
          options={[
            { value: 'all', label: 'الكل' },
            { value: 'active', label: `النشطة (${counts.active})` },
            { value: 'judgments', label: 'الأحكام' },
            { value: 'documents', label: 'الوثائق' },
            { value: 'failed', label: 'المتعثرة' },
          ]}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <Input
            allowClear
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            prefix={<SearchOutlined style={{ color: TEXT_TERTIARY }} />}
            placeholder="بحث في المهام..."
            style={{ width: 240, fontFamily: FONT }}
          />
          <Tooltip title="تحديث">
            <Button
              icon={<SyncOutlined />}
              loading={tasksQ.isFetching}
              onClick={() => tasksQ.refetch()}
            />
          </Tooltip>
        </div>
      </div>

      {tasksQ.isError && (
        <Alert
          type="error"
          showIcon
          message="تعذّر تحميل قائمة المهام"
          style={{ marginBottom: 12, fontFamily: FONT }}
        />
      )}

      {tasksQ.isLoading ? (
        <div style={{ padding: 70, textAlign: 'center' }}>
          <Spin size="large" />
        </div>
      ) : visibleTasks.length === 0 ? (
        <div
          style={{
            padding: 60,
            border: '1px dashed var(--color-border)',
            borderRadius: 18,
            background: 'var(--color-bg-card)',
          }}
        >
          <Empty
            description={
              <span style={{ fontFamily: FONT, color: TEXT_TERTIARY }}>
                لا توجد مهام مطابقة
              </span>
            }
          />
        </div>
      ) : (
        <div className="task-list">
          {visibleTasks.map((task) => {
            const state = STATE_CONFIG[task.state]
            return (
              <article className="task-row" key={task.id}>
                <div className="task-file-icon">
                  {task.documentType === 'judgment' ? (
                    <FileDoneOutlined />
                  ) : (
                    <FilePdfOutlined />
                  )}
                </div>

                <div style={{ minWidth: 0 }}>
                  <div className="task-title">{task.title}</div>
                  <div className="task-meta">
                    <span>
                      {DOCUMENT_TYPE_LABELS[task.documentType || ''] ||
                        'وثيقة قانونية'}
                    </span>
                    <span>·</span>
                    <span>{task.origin === 'chat' ? 'المحادثة' : 'ملف قضية'}</span>
                    {task.caseTitle && (
                      <>
                        <span>·</span>
                        <span>{task.caseTitle}</span>
                      </>
                    )}
                    {task.pageCount ? (
                      <>
                        <span>·</span>
                        <span>{task.pageCount} صفحة</span>
                      </>
                    ) : null}
                  </div>
                  {task.error && (
                    <Tooltip title={task.error}>
                      <div
                        style={{
                          color: '#f5222d',
                          fontSize: 11,
                          marginTop: 5,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {task.error}
                      </div>
                    </Tooltip>
                  )}
                </div>

                <div className="task-progress">
                  <div className="task-progress-label">
                    <span>{STAGE_LABELS[task.stage] || task.stage}</span>
                    <span>{task.progress}%</span>
                  </div>
                  <Progress
                    percent={task.progress}
                    showInfo={false}
                    size="small"
                    status={
                      task.state === 'failed'
                        ? 'exception'
                        : task.state === 'completed'
                          ? 'success'
                          : 'active'
                    }
                  />
                </div>

                <div className="task-updated">
                  <div style={{ color: TEXT_SECONDARY, fontSize: 12 }}>
                    {dayjs(task.updatedAt).fromNow()}
                  </div>
                  <div
                    style={{
                      color: TEXT_TERTIARY,
                      fontSize: 10,
                      marginTop: 3,
                      direction: 'ltr',
                      textAlign: 'right',
                    }}
                  >
                    {dayjs(task.createdAt).format('DD/MM/YYYY HH:mm')}
                  </div>
                </div>

                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                    gap: 6,
                  }}
                >
                  <Tag
                    icon={state.icon}
                    style={{
                      margin: 0,
                      color: state.color,
                      borderColor: `${state.color}55`,
                      background: `${state.color}12`,
                      fontFamily: FONT,
                    }}
                  >
                    <span className="task-state-label">{state.label}</span>
                  </Tag>
                  {task.caseId && (
                    <Tooltip title="فتح القضية">
                      <Button
                        type="text"
                        icon={<FolderOpenOutlined />}
                        onClick={() => navigate(`/cases/${task.caseId}`)}
                      />
                    </Tooltip>
                  )}
                  {task.progress > 0 && (
                    <Tooltip title="عرض الوثيقة">
                      <Button
                        type="text"
                        icon={<EyeOutlined />}
                        onClick={() =>
                          setViewer({
                            id: task.documentId,
                            title: task.title,
                          })
                        }
                      />
                    </Tooltip>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}

      <DocumentViewer
        documentId={viewer?.id || null}
        filename={viewer?.title}
        basePath="/documents"
        onClose={() => setViewer(null)}
      />
    </div>
  )
}
