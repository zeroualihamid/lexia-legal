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
import { useAdminUi } from '../locale/useAdminI18n'

const { Dragger } = Upload

const STATUS_COLORS: Record<AnalysisStatus, string> = {
  pending: '#8c8c8c',
  running: '#1677ff',
  completed: '#52c41a',
  failed: '#f5222d',
}

function StatusTag({
  status,
  label,
  font,
}: {
  status: AnalysisStatus
  label: string
  font: string
}) {
  const color = STATUS_COLORS[status]
  return (
    <Tag
      style={{
        background: `${color}20`,
        border: `1px solid ${color}40`,
        color,
        borderRadius: 12,
        fontFamily: font,
        fontSize: 12,
      }}
    >
      {label}
    </Tag>
  )
}

function PdfPreview({
  analysisId,
  noPdfLabel,
  viewPdfLabel,
  openLabel,
  font,
}: {
  analysisId: string | null
  noPdfLabel: string
  viewPdfLabel: string
  openLabel: string
  font: string
}) {
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
      <div style={{ color: 'var(--color-text-tertiary)', fontFamily: font }}>
        {noPdfLabel}
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
            fontFamily: font,
            fontWeight: 700,
          }}
        >
          <FilePdfOutlined />
          {viewPdfLabel}
        </span>
        <Button
          size="small"
          type="link"
          href={pdfUrl}
          target="_blank"
          rel="noreferrer"
          style={{ color: GOLD, fontFamily: font }}
        >
          {openLabel}
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
  const {
    t,
    font,
    pageStyle,
    h1Style,
    titleStyle,
    labelStyle,
    cellStyle,
    mutedStyle,
    tableStyle,
  } = useAdminUi()
  const j = t.judgment

  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [drawerId, setDrawerId] = useState<string | null>(null)
  const [drawerView, setDrawerView] = useState<'analysis' | 'pdf' | 'split'>('split')

  const list = useJudgmentAnalysisList()
  const create = useCreateJudgmentAnalysis()
  const rerun = useRerunJudgmentAnalysis()

  const stream = useJudgmentAnalysisStream(activeId)
  const drawerOne = useJudgmentAnalysisOne(drawerId)

  const statusLabel = (status: AnalysisStatus) => j.status[status]

  const handleAnalyze = async () => {
    if (!pendingFile) {
      message.warning(j.noPdf)
      return
    }
    try {
      const { analysisId } = await create.mutateAsync(pendingFile)
      setActiveId(analysisId)
      message.success(j.status.running)
      setPendingFile(null)
    } catch (err: any) {
      message.error(err?.response?.data?.message || err?.message || t.common.error)
    }
  }

  const handleRerun = async (id: string) => {
    try {
      const { analysisId } = await rerun.mutateAsync(id)
      setActiveId(analysisId)
      message.success(j.rerun)
    } catch (err: any) {
      message.error(err?.message || t.common.error)
    }
  }

  const columns = useMemo(
    () => [
      {
        title: <span style={labelStyle}>{j.columns.filename}</span>,
        dataIndex: 'filename',
        key: 'filename',
        render: (v: string) => (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <FileSearchOutlined style={{ color: GOLD }} />
            <span style={{ ...cellStyle, fontSize: 13 }}>{v}</span>
          </span>
        ),
      },
      {
        title: <span style={labelStyle}>{j.columns.status}</span>,
        dataIndex: 'status',
        key: 'status',
        render: (v: AnalysisStatus) => (
          <StatusTag status={v} label={statusLabel(v)} font={font} />
        ),
      },
      {
        title: <span style={labelStyle}>{j.columns.createdAt}</span>,
        dataIndex: 'created_at',
        key: 'created_at',
        render: (v: string) => (
          <span style={{ ...mutedStyle, fontSize: 12 }}>
            {dayjs(v).format('DD/MM/YYYY HH:mm')}
          </span>
        ),
      },
      {
        title: <span style={labelStyle}>{j.columns.actions}</span>,
        key: 'actions',
        render: (_: any, record: any) => (
          <Space>
            <Tooltip title={t.common.view}>
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
            <Tooltip title={j.viewPdf}>
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
            <Tooltip title={t.common.live}>
              <Button
                type="text"
                size="small"
                icon={<ThunderboltOutlined />}
                style={{ color: GOLD }}
                onClick={() => setActiveId(record.id)}
                disabled={record.status === 'failed'}
              />
            </Tooltip>
            <Tooltip title={j.rerun}>
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
    [j, t.common, font, labelStyle, cellStyle, mutedStyle, rerun.isPending],
  )

  const isStreaming = stream.status === 'pending' || stream.status === 'running'

  return (
    <div style={pageStyle}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 20,
        }}
      >
        <h1 style={h1Style}>{j.title}</h1>
        <span style={{ ...mutedStyle, fontSize: 12 }}>{j.subtitle}</span>
      </div>

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
              fontFamily: font,
              color: 'var(--color-text-secondary)',
            }}
          >
            {j.dragHint}
          </p>
          <p
            className="ant-upload-hint"
            style={{
              fontFamily: font,
              color: 'var(--color-text-quaternary)',
              fontSize: 12,
            }}
          >
            {j.dragSubhint}
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
              fontFamily: font,
              fontWeight: 700,
            }}
          >
            {j.analyze}
          </Button>
        </div>
      </Card>

      {activeId && (
        <Card
          title={
            <Space>
              <span style={titleStyle}>{j.liveResult}</span>
              {stream.status !== 'idle' && (
                <StatusTag
                  status={stream.status as AnalysisStatus}
                  label={statusLabel(stream.status as AnalysisStatus)}
                  font={font}
                />
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
              {t.common.close}
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
                fontFamily: font,
                fontSize: 13,
              }}
            >
              {stream.error}
            </div>
          )}
          <AnalysisViewer markdown={stream.markdown} />
        </Card>
      )}

      <Card
        title={<span style={titleStyle}>{j.pastAnalyses}</span>}
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
          style={tableStyle}
          locale={{
            emptyText: <span style={{ fontFamily: font }}>{j.empty}</span>,
          }}
        />
      </Card>

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
            <span style={{ ...cellStyle, color: 'var(--color-text-primary)' }}>
              {drawerOne.data?.filename || j.filename}
            </span>
            {drawerOne.data && (
              <StatusTag
                status={drawerOne.data.status}
                label={statusLabel(drawerOne.data.status)}
                font={font}
              />
            )}
          </Space>
        }
        extra={
          <Segmented
            size="small"
            value={drawerView}
            onChange={(value) => setDrawerView(value as 'analysis' | 'pdf' | 'split')}
            options={[
              { label: j.viewAnalysis, value: 'analysis' },
              { label: j.viewPdf, value: 'pdf' },
              { label: j.viewSplit, value: 'split' },
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
          <div style={{ color: '#f5222d', fontFamily: font }}>
            {drawerOne.data.error_message}
          </div>
        ) : drawerView === 'pdf' ? (
          <PdfPreview
            analysisId={drawerId}
            noPdfLabel={j.noPdf}
            viewPdfLabel={j.viewPdf}
            openLabel={j.open}
            font={font}
          />
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
            <PdfPreview
              analysisId={drawerId}
              noPdfLabel={j.noPdf}
              viewPdfLabel={j.viewPdf}
              openLabel={j.open}
              font={font}
            />
            <AnalysisViewer markdown={drawerOne.data?.markdown_result || ''} />
          </div>
        )}
      </Drawer>
    </div>
  )
}
