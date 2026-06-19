import React from 'react'
import { Button, Tag } from 'antd'
import { FilePdfOutlined, ReadOutlined } from '@ant-design/icons'
import { GOLD, BORDER_COLOR } from '../constants'
import type { ParsedSrc } from '../chat/streamSrcParser'
import type { SourceCatalogEntry } from '../hooks/useChat'

const FONT = "'Noto Naskh Arabic', 'Cairo', sans-serif"

const DOC_TYPE_LABELS: Record<string, string> = {
  judgment: 'حكم / قرار',
  contract: 'عقد',
  other: 'مستند',
  correspondence: 'مراسلة',
  evidence: 'مستند إثبات',
}

export function ChatSrcCard({
  src,
  catalogEntry,
  onOpenSummary,
}: {
  src: ParsedSrc
  catalogEntry?: SourceCatalogEntry
  onOpenSummary?: (documentId: string) => void
}) {
  const title = src.title || catalogEntry?.title || catalogEntry?.fileName || 'مستند'
  const path = src.path || catalogEntry?.filePath || catalogEntry?.fileName || '—'
  const docType = src.type || catalogEntry?.docType || 'other'
  const typeLabel = DOC_TYPE_LABELS[docType] || docType
  const pdfUrl = catalogEntry?.url
  const documentId = src.id || catalogEntry?.id
  const canSummarize =
    documentId &&
    (docType === 'judgment' || catalogEntry?.hasSummary || catalogEntry?.docType === 'judgment')

  return (
    <div
      style={{
        margin: '10px 0',
        padding: '12px 14px',
        borderRadius: 12,
        border: `1px solid rgba(201,168,76,0.35)`,
        background: 'rgba(201,168,76,0.06)',
        direction: 'rtl',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <FilePdfOutlined style={{ color: GOLD, fontSize: 20, marginTop: 2, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              fontFamily: FONT,
              color: 'var(--color-text-primary)',
              marginBottom: 6,
              lineHeight: 1.5,
            }}
          >
            {title}
          </div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--color-text-tertiary)',
              fontFamily: FONT,
              marginBottom: 8,
              direction: 'ltr',
              textAlign: 'right',
              wordBreak: 'break-all',
            }}
          >
            {path}
          </div>
          <Tag
            style={{
              margin: 0,
              borderRadius: 8,
              fontFamily: FONT,
              fontSize: 11,
            }}
          >
            {typeLabel}
          </Tag>
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          marginTop: 12,
          justifyContent: 'flex-start',
        }}
      >
        {pdfUrl ? (
          <Button
            type="primary"
            size="small"
            icon={<FilePdfOutlined />}
            href={pdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontFamily: FONT,
              background: GOLD,
              borderColor: GOLD,
              color: '#000',
              fontWeight: 600,
            }}
          >
            فتح PDF
          </Button>
        ) : (
          <Button size="small" disabled style={{ fontFamily: FONT }}>
            PDF غير متاح
          </Button>
        )}
        {canSummarize && onOpenSummary ? (
          <Button
            size="small"
            icon={<ReadOutlined />}
            onClick={() => onOpenSummary(documentId!)}
            style={{
              fontFamily: FONT,
              borderColor: BORDER_COLOR,
              color: GOLD,
            }}
          >
            عرض الملخص
          </Button>
        ) : null}
      </div>
    </div>
  )
}
