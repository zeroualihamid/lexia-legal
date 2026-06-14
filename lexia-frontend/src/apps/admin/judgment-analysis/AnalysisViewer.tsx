import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { GOLD, BORDER_SUBTLE } from '../../../shared/constants'

export function AnalysisViewer({ markdown }: { markdown: string }) {
  if (!markdown) {
    return (
      <div
        style={{
          color: 'var(--color-text-tertiary)',
          fontFamily: "'Cairo', sans-serif",
          fontSize: 13,
          padding: 16,
        }}
      >
        En attente du résultat…
      </div>
    )
  }

  return (
    <div
      dir="ltr"
      style={{
        background: 'var(--color-bg-elevated)',
        border: `1px solid ${BORDER_SUBTLE}`,
        borderRadius: 8,
        padding: '20px 24px',
        color: 'var(--color-text-primary)',
        fontFamily: "'Cairo', system-ui, sans-serif",
        fontSize: 14,
        lineHeight: 1.7,
        maxHeight: '60vh',
        overflow: 'auto',
      }}
      className="judgment-analysis-md"
    >
      <style>{`
        .judgment-analysis-md h1,
        .judgment-analysis-md h2,
        .judgment-analysis-md h3 {
          color: ${GOLD};
          margin-top: 1.4em;
          margin-bottom: 0.6em;
        }
        .judgment-analysis-md h1 { font-size: 1.4em; }
        .judgment-analysis-md h2 { font-size: 1.2em; }
        .judgment-analysis-md h3 { font-size: 1.05em; }
        .judgment-analysis-md table {
          border-collapse: collapse;
          margin: 0.8em 0;
          width: 100%;
        }
        .judgment-analysis-md th,
        .judgment-analysis-md td {
          border: 1px solid ${BORDER_SUBTLE};
          padding: 6px 10px;
          text-align: left;
        }
        .judgment-analysis-md th {
          background: var(--color-bg-card);
          color: ${GOLD};
        }
        .judgment-analysis-md ul,
        .judgment-analysis-md ol {
          padding-inline-start: 24px;
        }
        .judgment-analysis-md code {
          background: var(--color-bg-card);
          padding: 1px 4px;
          border-radius: 3px;
          font-size: 0.92em;
        }
        .judgment-analysis-md strong {
          color: ${GOLD};
        }
      `}</style>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
    </div>
  )
}
