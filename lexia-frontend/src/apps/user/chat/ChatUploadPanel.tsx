import React, { useState } from 'react'
import {
  Drawer,
  Modal,
  Select,
  Input,
  Button,
  Tag,
  Spin,
  Empty,
  App as AntApp,
} from 'antd'
import { useQueryClient } from '@tanstack/react-query'
import {
  FileTextOutlined,
  LoadingOutlined,
  CheckCircleOutlined,
  CloseOutlined,
  FileSearchOutlined,
  FilePdfOutlined,
  FolderAddOutlined,
  MessageOutlined,
} from '@ant-design/icons'
import { AnalysisViewer } from '../../admin/judgment-analysis/AnalysisViewer'
import {
  ChatUploadItem,
  useChatUploadSummaryStream,
  useMyJudgments,
  chatUploadPdfUrl,
} from '../../../shared/hooks/useChatUpload'
import { useCases } from '../../../shared/hooks/useCases'
import { GOLD } from '../../../shared/constants'

const ARABIC_FONT = "'Noto Naskh Arabic', 'Cairo', sans-serif"

type LinkFn = (
  id: string,
  payload: { caseId?: string; newCase?: { title: string; clientName?: string } },
) => Promise<{ caseId: string; caseTitle: string }>

function statusText(item: ChatUploadItem): { label: string; spinning: boolean } {
  if (item.status === 'failed')
    return { label: item.errorMessage || 'فشل المعالجة', spinning: false }
  if (item.status === 'processing')
    return { label: 'جارٍ التحليل والتصنيف...', spinning: true }
  if (item.isJudgment) {
    if (item.analysisStatus === 'completed')
      return { label: 'حكم قضائي — الملخص جاهز', spinning: false }
    if (item.analysisStatus === 'failed')
      return { label: 'حكم قضائي — تعذّر إنشاء الملخص', spinning: false }
    return { label: 'حكم قضائي — جارٍ إعداد الملخص...', spinning: true }
  }
  return { label: 'تمت الإضافة — جاهز للمحادثة', spinning: false }
}

function ItemActions({
  item,
  onSummary,
  onLink,
  onAsk,
  compact,
}: {
  item: ChatUploadItem
  onSummary: (id: string) => void
  onLink: (item: ChatUploadItem) => void
  onAsk?: (item: ChatUploadItem) => void
  compact?: boolean
}) {
  const ready = item.status === 'ready' || item.status === 'published'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, flexWrap: 'wrap' }}>
      {ready && (
        <Button
          size="small"
          icon={<FilePdfOutlined />}
          onClick={() => window.open(chatUploadPdfUrl(item.id), '_blank')}
          style={{ fontFamily: ARABIC_FONT }}
        >
          {compact ? '' : 'الملف'}
        </Button>
      )}
      {item.isJudgment && item.summaryReady && (
        <Button
          size="small"
          icon={<FileSearchOutlined />}
          onClick={() => onSummary(item.id)}
          style={{ fontFamily: ARABIC_FONT }}
        >
          {compact ? '' : 'الملخص'}
        </Button>
      )}
      {onAsk && ready && (
        <Button
          size="small"
          icon={<MessageOutlined />}
          onClick={() => onAsk(item)}
          style={{ fontFamily: ARABIC_FONT }}
        >
          {compact ? '' : 'محادثة'}
        </Button>
      )}
      {item.isJudgment && !item.caseId && item.status !== 'failed' ? (
        <Button
          size="small"
          type="primary"
          icon={<FolderAddOutlined />}
          onClick={() => onLink(item)}
          style={{
            fontFamily: ARABIC_FONT,
            background: GOLD,
            borderColor: 'transparent',
            color: '#000',
          }}
        >
          {compact ? '' : 'ربط بقضية'}
        </Button>
      ) : item.caseId ? (
        <Tag color="gold" style={{ fontFamily: ARABIC_FONT, marginInlineEnd: 0 }}>
          مرتبط بقضية
        </Tag>
      ) : null}
    </div>
  )
}

export function ChatUploadCards({
  items,
  onLink,
  onDismiss,
  onAsk,
}: {
  items: ChatUploadItem[]
  onLink: LinkFn
  onDismiss: (id: string) => void
  onAsk?: (item: ChatUploadItem) => void
}) {
  const [summaryId, setSummaryId] = useState<string | null>(null)
  const [linkItem, setLinkItem] = useState<ChatUploadItem | null>(null)

  if (items.length === 0) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, direction: 'rtl' }}>
      {items.map((item) => {
        const st = statusText(item)
        return (
          <div
            key={item.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              background: 'var(--color-bg-card)',
              border: '1px solid var(--color-border)',
              borderRadius: 14,
              padding: '12px 14px',
              maxWidth: 620,
            }}
          >
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: 10,
                background: 'var(--color-gold-tint)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: GOLD,
                fontSize: 18,
                flexShrink: 0,
              }}
            >
              <FileTextOutlined />
            </div>

            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontFamily: ARABIC_FONT,
                  fontSize: 14,
                  fontWeight: 600,
                  color: 'var(--color-text-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {item.filename}
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontFamily: ARABIC_FONT,
                  fontSize: 12,
                  color:
                    item.status === 'failed'
                      ? '#ff4d4f'
                      : 'var(--color-text-tertiary)',
                  marginTop: 2,
                }}
              >
                {st.spinning ? (
                  <Spin indicator={<LoadingOutlined style={{ fontSize: 11, color: GOLD }} spin />} />
                ) : item.status === 'failed' ? null : (
                  <CheckCircleOutlined style={{ color: GOLD, fontSize: 12 }} />
                )}
                <span>{st.label}</span>
              </div>
            </div>

            <ItemActions
              item={item}
              onSummary={setSummaryId}
              onLink={setLinkItem}
              onAsk={onAsk}
            />
            <Button
              type="text"
              size="small"
              icon={<CloseOutlined style={{ fontSize: 12 }} />}
              onClick={() => onDismiss(item.id)}
            />
          </div>
        )
      })}

      <SummaryDrawer id={summaryId} onClose={() => setSummaryId(null)} />
      <LinkCaseModal item={linkItem} onClose={() => setLinkItem(null)} onLink={onLink} />
    </div>
  )
}

/** A Finder-like list of every judgment the user has uploaded (only theirs). */
export function JudgmentsManagerDrawer({
  open,
  onClose,
  onLink,
  onAsk,
}: {
  open: boolean
  onClose: () => void
  onLink: LinkFn
  onAsk?: (item: ChatUploadItem) => void
}) {
  const { data, isLoading } = useMyJudgments(open)
  const [summaryId, setSummaryId] = useState<string | null>(null)
  const [linkItem, setLinkItem] = useState<ChatUploadItem | null>(null)

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={680}
      title={<span style={{ fontFamily: ARABIC_FONT }}>أحكامي المرفوعة</span>}
      styles={{ body: { padding: 16, direction: 'rtl' } }}
    >
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin />
        </div>
      ) : !data || data.length === 0 ? (
        <Empty
          description={
            <span style={{ fontFamily: ARABIC_FONT }}>
              لم ترفع أي حكم بعد. أرفق ملف حكم في المحادثة ليظهر هنا.
            </span>
          }
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {data.map((item) => {
            const st = statusText(item)
            return (
              <div
                key={item.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  background: 'var(--color-bg-card)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 12,
                  padding: '10px 12px',
                }}
              >
                <FilePdfOutlined style={{ color: GOLD, fontSize: 20, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: ARABIC_FONT,
                      fontSize: 13,
                      fontWeight: 600,
                      color: 'var(--color-text-primary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {item.filename}
                  </div>
                  <div
                    style={{
                      fontFamily: ARABIC_FONT,
                      fontSize: 11,
                      color: 'var(--color-text-tertiary)',
                      marginTop: 2,
                    }}
                  >
                    {st.label}
                  </div>
                </div>
                <ItemActions
                  item={item}
                  onSummary={setSummaryId}
                  onLink={setLinkItem}
                  onAsk={(it) => {
                    onAsk?.(it)
                    onClose()
                  }}
                  compact
                />
              </div>
            )
          })}
        </div>
      )}

      <SummaryDrawer id={summaryId} onClose={() => setSummaryId(null)} />
      <LinkCaseModal item={linkItem} onClose={() => setLinkItem(null)} onLink={onLink} />
    </Drawer>
  )
}

function SummaryDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const stream = useChatUploadSummaryStream(id)
  return (
    <Drawer
      open={!!id}
      onClose={onClose}
      width={760}
      title={<span style={{ fontFamily: ARABIC_FONT }}>ملخص الحكم القضائي</span>}
      styles={{ body: { padding: 16 } }}
    >
      {stream.status === 'failed' ? (
        <div style={{ color: '#ff4d4f', fontFamily: ARABIC_FONT }}>
          تعذّر إنشاء الملخص: {stream.error}
        </div>
      ) : (
        <>
          {(stream.status === 'pending' || stream.status === 'running') &&
            !stream.markdown && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  color: 'var(--color-text-tertiary)',
                  fontFamily: ARABIC_FONT,
                  marginBottom: 12,
                }}
              >
                <Spin indicator={<LoadingOutlined style={{ color: GOLD }} spin />} />
                جارٍ إعداد التحليل القانوني المنظم (بالفرنسية والعربية)...
              </div>
            )}
          <AnalysisViewer markdown={stream.markdown} />
        </>
      )}
    </Drawer>
  )
}

function LinkCaseModal({
  item,
  onClose,
  onLink,
}: {
  item: ChatUploadItem | null
  onClose: () => void
  onLink: LinkFn
}) {
  const { message } = AntApp.useApp()
  const qc = useQueryClient()
  const { data: cases } = useCases(!!item)
  const [mode, setMode] = useState<'existing' | 'new'>('existing')
  const [caseId, setCaseId] = useState<string | undefined>(undefined)
  const [title, setTitle] = useState('')
  const [client, setClient] = useState('')
  const [saving, setSaving] = useState(false)

  const reset = () => {
    setMode('existing')
    setCaseId(undefined)
    setTitle('')
    setClient('')
  }

  const submit = async () => {
    if (!item) return
    if (mode === 'existing' && !caseId) {
      message.warning('اختر قضية')
      return
    }
    if (mode === 'new' && !title.trim()) {
      message.warning('أدخل عنوان القضية')
      return
    }
    setSaving(true)
    try {
      const res = await onLink(
        item.id,
        mode === 'existing'
          ? { caseId }
          : { newCase: { title: title.trim(), clientName: client.trim() || undefined } },
      )
      message.success(`تم ربط الحكم بقضية «${res.caseTitle}»`)
      qc.invalidateQueries({ queryKey: ['my-judgments'] })
      qc.invalidateQueries({ queryKey: ['cases'] })
      qc.invalidateQueries({ queryKey: ['case-documents'] })
      reset()
      onClose()
    } catch (err: any) {
      message.error(err?.response?.data?.message || 'تعذّر ربط الحكم بالقضية')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={!!item}
      onCancel={() => {
        reset()
        onClose()
      }}
      onOk={submit}
      confirmLoading={saving}
      okText="ربط"
      cancelText="إلغاء"
      title={<span style={{ fontFamily: ARABIC_FONT }}>ربط الحكم بقضية</span>}
      okButtonProps={{ style: { background: GOLD, borderColor: 'transparent', color: '#000' } }}
    >
      <div style={{ direction: 'rtl', fontFamily: ARABIC_FONT, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Select
          value={mode}
          onChange={(v) => setMode(v)}
          options={[
            { value: 'existing', label: 'ربط بقضية موجودة' },
            { value: 'new', label: 'إنشاء قضية جديدة' },
          ]}
        />
        {mode === 'existing' ? (
          <Select
            showSearch
            placeholder="اختر القضية"
            value={caseId}
            onChange={(v) => setCaseId(v)}
            optionFilterProp="label"
            options={(cases || []).map((c) => ({ value: c.id, label: c.title }))}
            notFoundContent={<span style={{ fontFamily: ARABIC_FONT }}>لا توجد قضايا</span>}
          />
        ) : (
          <>
            <Input
              placeholder="عنوان القضية"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <Input
              placeholder="اسم الموكل (اختياري)"
              value={client}
              onChange={(e) => setClient(e.target.value)}
            />
          </>
        )}
      </div>
    </Modal>
  )
}
