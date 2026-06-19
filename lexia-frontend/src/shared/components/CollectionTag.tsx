import React from 'react'
import { COLLECTION_COLORS, COLLECTION_LABELS } from '../constants'

interface CollectionTagProps {
  collection: string
  size?: 'small' | 'default'
  label?: string
  fontFamily?: string
}

export function CollectionTag({ collection, size = 'default', label, fontFamily }: CollectionTagProps) {
  const color = COLLECTION_COLORS[collection] || '#8c8c8c'
  const displayLabel = label ?? COLLECTION_LABELS[collection] ?? collection

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: size === 'small' ? '1px 8px' : '2px 10px',
        borderRadius: 12,
        fontSize: size === 'small' ? 11 : 12,
        fontWeight: 500,
        color: color,
        background: `${color}20`,
        border: `1px solid ${color}40`,
        whiteSpace: 'nowrap',
        fontFamily: fontFamily || "'Noto Naskh Arabic', 'Cairo', sans-serif",
      }}
    >
      {displayLabel}
    </span>
  )
}
