import React, { useMemo, useState } from 'react'
import {
  App,
  Upload,
  Button,
  Card,
  Table,
  Tag,
  Drawer,
  Space,
  Tooltip,
  Spin,
  Segmented,
} from 'antd'
import {
  InboxOutlined,
  ThunderboltOutlined,
  EyeOutlined,
  ReloadOutlined,
  FileSearchOutlined,
  FilePdfOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { GOLD, BORDER_COLOR, BORDER_SUBTLE } from '../../../shared/constants'
import { useAuthStore } from '../../../shared/store/authStore'
import {
  useJudgmentAnalysisList,
  useJudgmentAnalysisOne,
  useCreateJudgmentAnalysis,
  useRerunJudgmentAnalysis,
  useJudgmentAnalysisStream,
  AnalysisStatus,
} from '../../../shared/hooks/useJudgmentAnalysis'
import { AnalysisViewer } from './AnalysisViewer'

const { Dragger } = Upload

const STATUS_CONFIG: Record<AnalysisStatus, { color: string; label: string }> = {
  pending: { color: '#8c8c8c', label: 'في الانتظار' },
  running: { color: '#1677ff', label: 'قيد التحليل' },
  completed: { color: '#52c41a', label: 'مكتمل' },
  failed: { color: '#f5222d', label: 'فشل' },
}

function StatusTag({ status }: { status: AnalysisStatus }) {
  const cfg = STATUS_CONFIG[status]
  return (
    <Tag
      style={{
        background: `${cfg.color}20`,
        border: `1px solid ${cfg.color}40`,
        color: cfg.color,
        borderRadius: 12,
        fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
        fontSize: 12,
      }}
    >
      {cfg.label}
    </Tag>
  )
}

function PdfPreview({ analysisId }: { analysisId: string | null }) {
  const token = useAuthStore((s) => s.token)
  const pdfUrl = useMemo(() => {
    if (!analysisId) return null
    const params = new URLSearchParams(token ? { token } : {})
    return `/api/admin/judgment-analysis/${analysisId}/pdf${
      params.toString() ? `?${params.toString()}` : ''
    }`
  }, [analysisId, token])

  if (!pdfUrl) {
    return (
      <div style={{ color: 'var(--color-text-tertiary)', fontFamily: "'Cairo', sans-serif" }}>
        لا يوجد ملف PDF محدد
      </div>
    )
  }

  return (
    <div
      style={{
        background: 'var(--color-bg-elevated)',
        border: `1px solid ${BORDER_SUBTLE}`,
        borderRadius: 12,
        overflow: 'hidden',
        minHeight: 620,
      }}
    >
      <div
        style={{
          height: 44,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '0 14px',
          borderBottom: `1px solid ${BORDER_SUBTLE}`,
          background: 'var(--color-bg-card)',
        }}
      >
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            color: GOLD,
            fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
            fontWeight: 700,
          }}
        >
          <FilePdfOutlined />
          الملف الأصلي
        </span>
        <Button
          size="small"
          type="link"
          href={pdfUrl}
          target="_blank"
          rel="noreferrer"
          style={{ color: GOLD, fontFamily: "'Cairo', sans-serif" }}
        >
          فتح في نافذة جديدة
        </Button>
      </div>
      <iframe
        title="Original judgment PDF"
        src={pdfUrl}
        style={{
          width: '100%',
          height: 'calc(100vh - 220px)',
          minHeight: 576,
          border: 0,
          background: '#fff',
          display: 'block',
        }}
      />
    </div>
  )
}

export function JudgmentAnalysisPage() {
  const { message } = App.useApp()
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [drawerId, setDrawerId] = useState<string | null>(null)
  const [drawerView, setDrawerView] = useState<'analysis' | 'pdf' | 'split'>('split')

  const list = useJudgmentAnalysisList()
  const create = useCreateJudgmentAnalysis()
  const rerun = useRerunJudgmentAnalysis()

  const stream = useJudgmentAnalysisStream(activeId)
  const drawerOne = useJudgmentAnalysisOne(drawerId)

  const handleAnalyze = async () => {
    if (!pendingFile) {
      message.warning('اختر ملف PDF أولاً')
      return
    }
    try {
      const { analysisId } = await create.mutateAsync(pendingFile)
      setActiveId(analysisId)
      message.success('بدأ التحليل')
      setPendingFile(null)
    } catch (err: any) {
      message.error(err?.response?.data?.message || err?.message || 'فشل الإرسال')
    }
  }

  const handleRerun = async (id: string) => {
    try {
      const { analysisId } = await rerun.mutateAsync(id)
      setActiveId(analysisId)
      message.success('تم إعادة التشغيل')
    } catch (err: any) {
      message.error(err?.message || 'فشل')
    }
  }

  const columns = useMemo(
    () => [
      {
        title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الملف</span>,
        dataIndex: 'filename',
        key: 'filename',
        render: (v: string) => (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <FileSearchOutlined style={{ color: GOLD }} />
            <span style={{ fontFamily: "'Cairo', sans-serif", fontSize: 13 }}>{v}</span>
          </span>
        ),
      },
      {
        title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الحالة</span>,
        dataIndex: 'status',
        key: 'status',
        render: (v: AnalysisStatus) => <StatusTag status={v} />,
      },
      {
        title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>التاريخ</span>,
        dataIndex: 'created_at',
        key: 'created_at',
        render: (v: string) => (
          <span style={{ fontFamily: "'Cairo', sans-serif", color: 'var(--color-text-tertiary)', fontSize: 12 }}>
            {dayjs(v).format('DD/MM/YYYY HH:mm')}
          </span>
        ),
      },
      {
        title: <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>الإجراءات</span>,
        key: 'actions',
        render: (_: any, record: any) => (
          <Space>
            <Tooltip title="عرض">
              <Button
                type="text"
                size="small"
                icon={<EyeOutlined />}
                style={{ color: GOLD }}
                onClick={() => {
                  setDrawerView('split')
                  setDrawerId(record.id)
                }}
              />
            </Tooltip>
            <Tooltip title="عرض ملف PDF الأصلي">
              <Button
                type="text"
                size="small"
                icon={<FilePdfOutlined />}
                style={{ color: '#f5222d' }}
                onClick={() => {
                  setDrawerView('pdf')
                  setDrawerId(record.id)
                }}
              />
            </Tooltip>
            <Tooltip title="متابعة مباشرة">
              <Button
                type="text"
                size="small"
                icon={<ThunderboltOutlined />}
                style={{ color: GOLD }}
                onClick={() => setActiveId(record.id)}
                disabled={record.status === 'failed'}
              />
            </Tooltip>
            <Tooltip title="إعادة التشغيل">
              <Button
                type="text"
                size="small"
                icon={<ReloadOutlined />}
                style={{ color: GOLD }}
                loading={rerun.isPending}
                onClick={() => handleRerun(record.id)}
              />
            </Tooltip>
          </Space>
        ),
      },
    ],
    [rerun.isPending],
  )

  const isStreaming = stream.status === 'pending' || stream.status === 'running'

  return (
    <div style={{ direction: 'rtl' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 20,
        }}
      >
        <h1
          style={{
            fontSize: 22,
            fontWeight: 700,
            color: 'var(--color-text-primary)',
            fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
            margin: 0,
          }}
        >
          تحليل الأحكام
        </h1>
        <span
          style={{
            color: 'var(--color-text-tertiary)',
            fontFamily: "'Cairo', sans-serif",
            fontSize: 12,
          }}
        >
          Analyse de jugement — Claude Code CLI
        </span>
      </div>

      {/* Upload + CTA */}
      <Card
        style={{
          background: 'var(--color-bg-card)',
          border: `1px solid ${BORDER_COLOR}`,
          marginBottom: 16,
        }}
        styles={{ body: { padding: 16 } }}
      >
        <Dragger
          name="file"
          accept=".pdf"
          multiple={false}
          maxCount={1}
          beforeUpload={(file) => {
            setPendingFile(file as File)
            return false
          }}
          onRemove={() => {
            setPendingFile(null)
          }}
          fileList={
            pendingFile
              ? [
                  {
                    uid: '-1',
                    name: pendingFile.name,
                    status: 'done',
                    size: pendingFile.size,
                  } as any,
                ]
              : []
          }
          style={{
            background: 'var(--color-surface-faint)',
            borderColor: BORDER_COLOR,
          }}
        >
          <p className="ant-upload-drag-icon">
            <InboxOutlined style={{ color: GOLD }} />
          </p>
          <p
            className="ant-upload-text"
            style={{
              fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
              color: 'var(--color-text-secondary)',
            }}
          >
            اسحب ملف الحكم (PDF) هنا أو انقر للاختيار
          </p>
          <p
            className="ant-upload-hint"
            style={{
              fontFamily: "'Cairo', sans-serif",
              color: 'var(--color-text-quaternary)',
              fontSize: 12,
            }}
          >
            Le fichier sera analysé par Claude Code CLI selon le plan en 8 sections (français).
          </p>
        </Dragger>

        <div style={{ display: 'flex', justifyContent: 'flex-start', marginTop: 16 }}>
          <Button
            type="primary"
            size="large"
            icon={<ThunderboltOutlined />}
            loading={create.isPending}
            disabled={!pendingFile || isStreaming}
            onClick={handleAnalyze}
            style={{
              background: GOLD,
              borderColor: GOLD,
              color: '#000',
              fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
              fontWeight: 700,
            }}
          >
            تحليل الحكم بالذكاء الاصطناعي
          </Button>
        </div>
      </Card>

      {/* Live result */}
      {activeId && (
        <Card
          title={
            <Space>
              <span
                style={{
                  fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
                  color: 'var(--color-text-primary)',
                }}
              >
                النتيجة المباشرة
              </span>
              {stream.status !== 'idle' && (
                <StatusTag status={stream.status as AnalysisStatus} />
              )}
              {isStreaming && <Spin size="small" />}
            </Space>
          }
          extra={
            <Button
              size="small"
              type="text"
              onClick={() => setActiveId(null)}
              style={{ color: 'var(--color-text-tertiary)' }}
            >
              إغلاق
            </Button>
          }
          style={{
            background: 'var(--color-bg-card)',
            border: `1px solid ${BORDER_COLOR}`,
            marginBottom: 16,
          }}
          styles={{ body: { padding: 16 } }}
        >
          {stream.error && (
            <div
              style={{
                color: '#f5222d',
                marginBottom: 12,
                fontFamily: "'Cairo', sans-serif",
                fontSize: 13,
              }}
            >
              {stream.error}
            </div>
          )}
          <AnalysisViewer markdown={stream.markdown} />
        </Card>
      )}

      {/* History */}
      <Card
        title={
          <span
            style={{
              fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
              color: 'var(--color-text-primary)',
            }}
          >
            التحليلات السابقة
          </span>
        }
        style={{
          background: 'var(--color-bg-card)',
          border: `1px solid ${BORDER_COLOR}`,
        }}
        styles={{ body: { padding: 0 } }}
      >
        <Table
          rowKey="id"
          dataSource={list.data || []}
          columns={columns as any}
          loading={list.isLoading}
          pagination={{ pageSize: 10 }}
          style={{ direction: 'rtl' }}
          locale={{
            emptyText: (
              <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>
                لا توجد تحليلات بعد
              </span>
            ),
          }}
        />
      </Card>

      {/* Past analysis viewer */}
      <Drawer
        open={!!drawerId}
        onClose={() => {
          setDrawerId(null)
          setDrawerView('split')
        }}
        width="min(1440px, 96vw)"
        title={
          <Space>
            <FileSearchOutlined style={{ color: GOLD }} />
            <span
              style={{
                fontFamily: "'Cairo', sans-serif",
                color: 'var(--color-text-primary)',
              }}
            >
              {drawerOne.data?.filename || 'Analyse'}
            </span>
            {drawerOne.data && <StatusTag status={drawerOne.data.status} />}
          </Space>
        }
        extra={
          <Segmented
            size="small"
            value={drawerView}
            onChange={(value) => setDrawerView(value as 'analysis' | 'pdf' | 'split')}
            options={[
              { label: 'التحليل', value: 'analysis' },
              { label: 'PDF', value: 'pdf' },
              { label: 'مزدوج', value: 'split' },
            ]}
          />
        }
        styles={{
          body: { background: 'var(--color-bg-base)', padding: 16 },
          header: {
            background: 'var(--color-bg-card)',
            borderBottom: `1px solid ${BORDER_SUBTLE}`,
          },
        }}
      >
        {drawerOne.isLoading ? (
          <Spin />
        ) : drawerOne.data?.error_message ? (
          <div style={{ color: '#f5222d', fontFamily: "'Cairo', sans-serif" }}>
            {drawerOne.data.error_message}
          </div>
        ) : drawerView === 'pdf' ? (
          <PdfPreview analysisId={drawerId} />
        ) : drawerView === 'analysis' ? (
          <AnalysisViewer markdown={drawerOne.data?.markdown_result || ''} />
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))',
              gap: 16,
              alignItems: 'start',
            }}
          >
            <PdfPreview analysisId={drawerId} />
            <AnalysisViewer markdown={drawerOne.data?.markdown_result || ''} />
          </div>
        )}
      </Drawer>
    </div>
  )
}
