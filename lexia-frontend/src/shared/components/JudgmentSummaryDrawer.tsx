import React from 'react'
import { Drawer, Spin } from 'antd'
import { LoadingOutlined } from '@ant-design/icons'
import { AnalysisViewer } from '../../apps/admin/judgment-analysis/AnalysisViewer'
import { SummaryStreamState } from '../hooks/useJudgmentSummary'
import { GOLD, TEXT_TERTIARY } from '../constants'

const FONT = "'Noto Naskh Arabic', 'Cairo', sans-serif"

export function JudgmentSummaryDrawer({
  documentId,
  onClose,
  stream,
  title = 'ملخص الحكم القضائي',
  loadingText = 'جارٍ إعداد التحليل القانوني المنظم (بالفرنسية والعربية)...',
  failedPrefix = 'تعذّر إنشاء الملخص',
  font = FONT,
}: {
  documentId: string | null
  onClose: () => void
  stream: SummaryStreamState
  title?: string
  loadingText?: string
  failedPrefix?: string
  font?: string
}) {
  return (
    <Drawer
      open={!!documentId}
      onClose={onClose}
      width={760}
      title={<span style={{ fontFamily: font }}>{title}</span>}
      styles={{
        content: {
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
        },
        body: {
          padding: 16,
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        },
      }}
    >
      {stream.status === 'failed' ? (
        <div style={{ color: '#ff4d4f', fontFamily: font }}>
          {failedPrefix}: {stream.error}
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          {(stream.status === 'pending' || stream.status === 'running') && !stream.markdown && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                color: TEXT_TERTIARY,
                fontFamily: font,
                flexShrink: 0,
              }}
            >
              <Spin indicator={<LoadingOutlined style={{ color: GOLD }} spin />} />
              {loadingText}
            </div>
          )}
          <AnalysisViewer markdown={stream.markdown} fillHeight />
        </div>
      )}
    </Drawer>
  )
}
