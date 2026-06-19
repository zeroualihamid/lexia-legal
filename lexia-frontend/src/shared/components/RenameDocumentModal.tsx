import React, { useEffect, useState } from 'react'
import { Modal, Input, Button, App as AntApp } from 'antd'
import { LoadingOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { TEXT_TERTIARY } from '../constants'

const FONT = "'Noto Naskh Arabic', 'Cairo', sans-serif"

export interface RenamableDocument {
  id: string
  title_ar: string
  status: string
}

export function RenameDocumentModal({
  document,
  onClose,
  onSave,
  onSuggest,
}: {
  document: RenamableDocument | null
  onClose: () => void
  onSave: (documentId: string, titleAr: string) => Promise<void>
  onSuggest: (documentId: string) => Promise<string>
}) {
  const { message } = AntApp.useApp()
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)
  const [suggesting, setSuggesting] = useState(false)

  useEffect(() => {
    if (document) setTitle(document.title_ar || '')
  }, [document])

  const handleSuggest = async () => {
    if (!document) return
    setSuggesting(true)
    try {
      const suggested = await onSuggest(document.id)
      setTitle(suggested)
      message.success('تم اقتراح اسم بالذكاء الاصطناعي')
    } catch (err: any) {
      message.error(err?.response?.data?.message || 'تعذّر اقتراح اسم')
    } finally {
      setSuggesting(false)
    }
  }

  const handleOk = async () => {
    const trimmed = title.trim()
    if (!document || !trimmed) {
      message.warning('أدخل اسماً للمستند')
      return
    }
    setSaving(true)
    try {
      await onSave(document.id, trimmed)
    } catch (err: any) {
      message.error(err?.response?.data?.message || 'تعذّر حفظ الاسم')
    } finally {
      setSaving(false)
    }
  }

  const canSuggest =
    document?.status === 'ready' || document?.status === 'published'

  return (
    <Modal
      open={!!document}
      title={<span style={{ fontFamily: FONT }}>إعادة تسمية المستند</span>}
      okText="حفظ"
      cancelText="إلغاء"
      confirmLoading={saving}
      onCancel={onClose}
      onOk={handleOk}
      destroyOnClose
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, direction: 'rtl' }}>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="اسم المستند"
          maxLength={255}
          style={{ fontFamily: FONT }}
          onPressEnter={handleOk}
        />
        <Button
          type="default"
          icon={suggesting ? <LoadingOutlined /> : <ThunderboltOutlined />}
          loading={suggesting}
          disabled={!canSuggest}
          onClick={handleSuggest}
          style={{ alignSelf: 'flex-start', fontFamily: FONT }}
        >
          اقتراح بالذكاء الاصطناعي
        </Button>
        {!canSuggest && (
          <span style={{ fontFamily: FONT, fontSize: 12, color: TEXT_TERTIARY }}>
            يتطلب الاقتراح الذكي اكتمال معالجة المستند (استخراج النص)
          </span>
        )}
        {canSuggest && (
          <span style={{ fontFamily: FONT, fontSize: 12, color: TEXT_TERTIARY }}>
            يقرأ النموذج أول مقاطع الوثيقة ويقترح عنواناً عربياً مناسباً
          </span>
        )}
      </div>
    </Modal>
  )
}
