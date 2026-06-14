import React, { useEffect, useMemo, useState } from 'react'
import { Drawer, Button, InputNumber, Space, Spin, Tag, Empty } from 'antd'
import {
  LeftOutlined,
  RightOutlined,
  FileTextOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import { GOLD, BORDER_SUBTLE } from '../../../shared/constants'
import {
  useDocumentPages,
  useDocumentPageUrl,
} from '../../../shared/hooks/useDocumentPages'

interface DocumentViewerProps {
  documentId: string | null
  filename?: string
  onClose: () => void
  /** API surface for page endpoints. Defaults to the admin endpoints. */
  basePath?: string
}

const STATUS_LABEL: Record<string, { color: string; label: string }> = {
  pending: { color: '#8c8c8c', label: 'في الانتظار' },
  running: { color: '#1677ff', label: 'جاري التحويل' },
  completed: { color: '#52c41a', label: 'جاهز' },
  failed: { color: '#f5222d', label: 'فشل' },
}

export function DocumentViewer({
  documentId,
  filename,
  onClose,
  basePath = '/admin/documents',
}: DocumentViewerProps) {
  const [page, setPage] = useState(1)
  const pagesQ = useDocumentPages(documentId, basePath)
  const urlQ = useDocumentPageUrl(documentId, documentId ? page : null, basePath)

  // Reset to page 1 each time a new document opens
  useEffect(() => {
    if (documentId) setPage(1)
  }, [documentId])

  const totalRendered = pagesQ.data?.pages.length || 0
  const totalExpected = pagesQ.data?.pageCount || totalRendered
  const status = pagesQ.data?.pagesStatus || 'pending'
  const isStreaming = status === 'pending' || status === 'running'
  const cfg = STATUS_LABEL[status] || STATUS_LABEL.pending

  const canPrev = page > 1
  const canNext = page < totalRendered

  const renderedSet = useMemo(
    () => new Set(pagesQ.data?.pages.map((p) => p.page_number) || []),
    [pagesQ.data],
  )

  const currentPageRendered = renderedSet.has(page)

  return (
    <Drawer
      open={!!documentId}
      onClose={onClose}
      width="min(1100px, 95vw)"
      title={
        <Space>
          <FileTextOutlined style={{ color: GOLD }} />
          <span style={{ fontFamily: "'Cairo', sans-serif", color: 'var(--color-text-primary)' }}>
            {filename || 'عرض الوثيقة'}
          </span>
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
          {isStreaming && <Spin size="small" />}
        </Space>
      }
      styles={{
        body: { background: 'var(--color-bg-base)', padding: 0 },
        header: {
          background: 'var(--color-bg-card)',
          borderBottom: `1px solid ${BORDER_SUBTLE}`,
        },
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          direction: 'rtl',
        }}
      >
        {/* Toolbar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            borderBottom: `1px solid ${BORDER_SUBTLE}`,
            background: 'var(--color-bg-card)',
          }}
        >
          <Space>
            <Button
              icon={<RightOutlined />}
              disabled={!canPrev}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            />
            <span
              style={{
                fontFamily: "'Cairo', sans-serif",
                color: 'var(--color-text-secondary)',
                fontSize: 13,
              }}
            >
              صفحة
            </span>
            <InputNumber
              min={1}
              max={Math.max(1, totalRendered)}
              value={page}
              onChange={(v) => v && setPage(v)}
              style={{ width: 70 }}
            />
            <span
              style={{
                fontFamily: "'Cairo', sans-serif",
                color: 'var(--color-text-tertiary)',
                fontSize: 13,
              }}
            >
              / {totalRendered}
              {isStreaming && totalExpected > totalRendered ? ` (~${totalExpected})` : ''}
            </span>
            <Button
              icon={<LeftOutlined />}
              disabled={!canNext}
              onClick={() => setPage((p) => Math.min(totalRendered, p + 1))}
            />
          </Space>
          <Space>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={() => pagesQ.refetch()}
              loading={pagesQ.isFetching}
            >
              تحديث
            </Button>
          </Space>
        </div>

        {/* Image area */}
        <div
          style={{
            flex: 1,
            overflow: 'auto',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            padding: 24,
            background: 'var(--color-bg-deep)',
          }}
        >
          {pagesQ.isLoading ? (
            <Spin />
          ) : !documentId ? null : totalRendered === 0 ? (
            <Empty
              description={
                <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>
                  {isStreaming ? 'جاري تحويل الصفحات…' : 'لا توجد صفحات'}
                </span>
              }
            />
          ) : !currentPageRendered ? (
            <Empty
              description={
                <span style={{ fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>
                  هذه الصفحة لم تُحوَّل بعد
                </span>
              }
            />
          ) : urlQ.isLoading ? (
            <Spin />
          ) : urlQ.data?.url ? (
            <img
              key={`${documentId}-${page}`}
              src={urlQ.data.url}
              alt={`Page ${page}`}
              style={{
                maxWidth: '100%',
                background: '#fff',
                boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
                borderRadius: 4,
              }}
            />
          ) : (
            <Empty />
          )}
        </div>

        {/* Thumbnail strip */}
        {totalRendered > 1 && (
          <div
            style={{
              display: 'flex',
              gap: 6,
              overflowX: 'auto',
              padding: '8px 12px',
              borderTop: `1px solid ${BORDER_SUBTLE}`,
              background: 'var(--color-bg-card)',
            }}
          >
            {pagesQ.data!.pages.map((p) => (
              <button
                key={p.page_number}
                onClick={() => setPage(p.page_number)}
                style={{
                  border:
                    p.page_number === page
                      ? `2px solid ${GOLD}`
                      : `1px solid ${BORDER_SUBTLE}`,
                  background:
                    p.page_number === page
                      ? 'var(--color-gold-tint)'
                      : 'transparent',
                  color:
                    p.page_number === page
                      ? GOLD
                      : 'var(--color-text-tertiary)',
                  borderRadius: 4,
                  padding: '4px 10px',
                  cursor: 'pointer',
                  fontFamily: "'Cairo', sans-serif",
                  fontSize: 12,
                  flexShrink: 0,
                }}
              >
                {p.page_number}
              </button>
            ))}
          </div>
        )}
      </div>
    </Drawer>
  )
}
