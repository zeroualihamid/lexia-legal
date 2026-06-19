import React, { useMemo } from 'react'
import { parseMessageWithSrc } from '../chat/streamSrcParser'
import { ChatSrcCard } from './ChatSrcCard'
import type { SourceCatalogEntry } from '../hooks/useChat'

export function ChatStreamContent({
  content,
  sourceCatalog,
  onOpenSummary,
  className,
  style,
}: {
  content: string
  sourceCatalog?: Record<string, SourceCatalogEntry>
  onOpenSummary?: (documentId: string) => void
  className?: string
  style?: React.CSSProperties
}) {
  const segments = useMemo(() => {
    const parsed = parseMessageWithSrc(content)
    if (!sourceCatalog || Object.keys(sourceCatalog).length === 0) {
      return parsed
    }
    const allowed = new Set(Object.keys(sourceCatalog))
    return parsed.filter(
      (seg) =>
        seg.kind === 'text' ||
        (!!seg.src.id && allowed.has(seg.src.id)),
    )
  }, [content, sourceCatalog])

  return (
    <div className={className} style={style}>
      {segments.map((seg, i) =>
        seg.kind === 'text' ? (
          <span key={`t-${i}`} style={{ whiteSpace: 'pre-wrap' }}>
            {seg.text}
          </span>
        ) : (
          <ChatSrcCard
            key={`s-${i}-${seg.src.id || seg.src.path || i}`}
            src={seg.src}
            catalogEntry={
              seg.src.id && sourceCatalog ? sourceCatalog[seg.src.id] : undefined
            }
            onOpenSummary={onOpenSummary}
          />
        ),
      )}
    </div>
  )
}
