import React, { useEffect, useState } from 'react'
import { Modal, Cascader, Button, App as AntApp } from 'antd'
import { TEXT_TERTIARY } from '../constants'
import {
  LEGAL_CLASSIFICATION_CASCADER_OPTIONS,
  getLegalClassLabel,
  getLegalFamilyLabel,
} from '../legalClassification'

const FONT = "'Noto Naskh Arabic', 'Cairo', sans-serif"

export interface ClassifiableDocument {
  id: string
  title_ar: string
  legal_family?: string | null
  legal_class?: string | null
  classification_manual?: boolean
}

export function EditLegalClassificationModal({
  document,
  onClose,
  onSave,
  onReset,
}: {
  document: ClassifiableDocument | null
  onClose: () => void
  onSave: (documentId: string, legalFamily: string, legalClass: string) => Promise<void>
  onReset: (documentId: string) => Promise<void>
}) {
  const { message } = AntApp.useApp()
  const [path, setPath] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [resetting, setResetting] = useState(false)

  useEffect(() => {
    if (!document) {
      setPath([])
      return
    }
    if (document.legal_family && document.legal_class) {
      setPath([document.legal_family, document.legal_class])
    } else {
      setPath([])
    }
  }, [document])

  const handleOk = async () => {
    if (!document || path.length < 2) {
      message.warning('اختر التصنيف (العائلة ثم النوع)')
      return
    }
    setSaving(true)
    try {
      await onSave(document.id, path[0], path[1])
      message.success('تم تحديث التصنيف')
      onClose()
    } catch (err: any) {
      message.error(err?.response?.data?.message || 'تعذّر حفظ التصنيف')
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async () => {
    if (!document) return
    setResetting(true)
    try {
      await onReset(document.id)
      message.success('تمت إعادة التصنيف التلقائي')
      onClose()
    } catch (err: any) {
      message.error(err?.response?.data?.message || 'تعذّر إعادة التصنيف')
    } finally {
      setResetting(false)
    }
  }

  const currentLabel =
    document?.legal_class && document?.legal_family
      ? `${getLegalClassLabel(document.legal_class)} — ${getLegalFamilyLabel(document.legal_family)}`
      : null

  return (
    <Modal
      open={!!document}
      title={<span style={{ fontFamily: FONT }}>تعديل التصنيف القانوني</span>}
      okText="حفظ"
      cancelText="إلغاء"
      confirmLoading={saving}
      onCancel={onClose}
      onOk={handleOk}
      destroyOnClose
      footer={(_, { OkBtn, CancelBtn }) => (
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, direction: 'rtl' }}>
          <div>
            {document?.classification_manual ? (
              <Button
                type="link"
                danger
                loading={resetting}
                onClick={handleReset}
                style={{ fontFamily: FONT, paddingInline: 0 }}
              >
                إعادة التصنيف التلقائي
              </Button>
            ) : null}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <CancelBtn />
            <OkBtn />
          </div>
        </div>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, direction: 'rtl' }}>
        {document ? (
          <div style={{ fontFamily: FONT, fontSize: 13, color: TEXT_TERTIARY }}>
            {document.title_ar}
          </div>
        ) : null}
        {currentLabel ? (
          <div style={{ fontFamily: FONT, fontSize: 12, color: TEXT_TERTIARY }}>
            التصنيف الحالي: {currentLabel}
            {document?.classification_manual ? ' (مُعدّل يدوياً)' : ' (تلقائي)'}
          </div>
        ) : null}
        <Cascader
          options={LEGAL_CLASSIFICATION_CASCADER_OPTIONS}
          value={path.length ? (path as any) : undefined}
          onChange={(val) => setPath((val as string[]) || [])}
          expandTrigger="hover"
          placeholder="اختر العائلة ثم النوع الفرعي"
          style={{ width: '100%' }}
          displayRender={(labels) => labels.join(' › ')}
        />
      </div>
    </Modal>
  )
}
