import React, { useState, useCallback } from 'react'
import {
  Input,
  Select,
  Segmented,
  Pagination,
  Empty,
  Spin,
  Tag,
  Drawer,
  Button,
  Divider,
  AutoComplete,
} from 'antd'
import {
  SearchOutlined,
  FileTextOutlined,
  CloseOutlined,
  FilterOutlined,
  LinkOutlined,
} from '@ant-design/icons'
import { useSearch, SearchResult } from '../../../shared/hooks/useSearch'
import { CollectionTag } from '../../../shared/components/CollectionTag'
import { GOLD, DARK, DARK_CARD, BORDER_COLOR, COLLECTION_COLORS, COLLECTION_LABELS } from '../../../shared/constants'

const COLLECTIONS = [
  { value: '', label: 'جميع المجموعات' },
  { value: 'legal_laws', label: 'القوانين التشريعية' },
  { value: 'judgments_commercial', label: 'الأحكام التجارية' },
  { value: 'judgments_civil', label: 'الأحكام المدنية' },
  { value: 'judgments_admin', label: 'الأحكام الإدارية' },
  { value: 'judgments_criminal', label: 'الأحكام الجنائية' },
  { value: 'judgments_family', label: 'أحكام الأسرة' },
  { value: 'judgments_social', label: 'الأحكام الاجتماعية' },
  { value: 'judgments_real_estate', label: 'الأحكام العقارية' },
  { value: 'judgments_constitutional', label: 'الأحكام الدستورية' },
  { value: 'user_documents', label: 'وثائقي' },
]

function ResultCard({
  result,
  onClick,
  isActive,
}: {
  result: SearchResult
  onClick: () => void
  isActive: boolean
}) {
  return (
    <div
      onClick={onClick}
      style={{
        background: isActive ? 'rgba(201,168,76,0.08)' : DARK_CARD,
        border: `1px solid ${isActive ? 'rgba(201,168,76,0.4)' : BORDER_COLOR}`,
        borderRadius: 12,
        padding: '14px 16px',
        cursor: 'pointer',
        transition: 'all 0.2s',
        direction: 'rtl',
      }}
      onMouseEnter={(e) => {
        if (!isActive) e.currentTarget.style.borderColor = 'rgba(201,168,76,0.25)'
      }}
      onMouseLeave={(e) => {
        if (!isActive) e.currentTarget.style.borderColor = BORDER_COLOR
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
        <FileTextOutlined style={{ color: GOLD, fontSize: 16, marginTop: 2, flexShrink: 0 }} />
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: 'var(--color-text-primary)',
              fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
              marginBottom: 6,
              lineHeight: 1.4,
            }}
          >
            {result.title_ar}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            <CollectionTag collection={result.collection} size="small" />
            {result.jurisdiction && (
              <span
                style={{
                  fontSize: 11,
                  color: 'var(--color-text-tertiary)',
                  fontFamily: "'Cairo', sans-serif",
                }}
              >
                {result.jurisdiction}
              </span>
            )}
            {result.date && (
              <span style={{ fontSize: 11, color: 'var(--color-text-quaternary)', fontFamily: "'Cairo', sans-serif" }}>
                {result.date}
              </span>
            )}
          </div>
          {result.snippet && (
            <div
              style={{
                fontSize: 13,
                color: 'var(--color-text-secondary)',
                fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
                lineHeight: 1.65,
                display: '-webkit-box',
                WebkitLineClamp: 3,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
              dangerouslySetInnerHTML={{ __html: result.snippet }}
            />
          )}
        </div>
      </div>
      {result.score !== undefined && (
        <div style={{ textAlign: 'left', fontSize: 11, color: 'var(--color-text-quaternary)' }}>
          {(result.score * 100).toFixed(0)}% تطابق
        </div>
      )}
    </div>
  )
}

function DetailPanel({ result, onClose }: { result: SearchResult; onClose: () => void }) {
  return (
    <div style={{ padding: '20px', direction: 'rtl', height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <Button
          type="text"
          icon={<CloseOutlined />}
          onClick={onClose}
          style={{ color: 'var(--color-text-secondary)' }}
        />
        <div style={{ flex: 1, textAlign: 'right' }}>
          <CollectionTag collection={result.collection} />
        </div>
      </div>

      <h2
        style={{
          fontSize: 20,
          fontWeight: 700,
          color: 'var(--color-text-primary)',
          fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
          marginBottom: 12,
          lineHeight: 1.5,
          textAlign: 'right',
        }}
      >
        {result.title_ar}
      </h2>

      {result.title_fr && (
        <div
          style={{
            fontSize: 14,
            color: 'var(--color-text-tertiary)',
            marginBottom: 12,
            fontFamily: "'Cairo', sans-serif",
            textAlign: 'right',
          }}
        >
          {result.title_fr}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {result.jurisdiction && (
          <Tag style={{ background: 'var(--color-surface-soft)', border: '1px solid var(--color-border-subtle)', color: 'var(--color-text-secondary)' }}>
            {result.jurisdiction}
          </Tag>
        )}
        {result.date && (
          <Tag style={{ background: 'var(--color-surface-soft)', border: '1px solid var(--color-border-subtle)', color: 'var(--color-text-secondary)' }}>
            {result.date}
          </Tag>
        )}
      </div>

      {result.url && (
        <a
          href={result.url}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            color: GOLD,
            fontSize: 13,
            marginBottom: 16,
            fontFamily: "'Cairo', sans-serif",
          }}
        >
          <LinkOutlined />
          عرض الوثيقة الأصلية
        </a>
      )}

      <Divider style={{ borderColor: BORDER_COLOR }} />

      <div
        style={{
          fontSize: 14,
          color: 'var(--color-text-secondary)',
          fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
          lineHeight: 1.8,
          whiteSpace: 'pre-wrap',
          textAlign: 'right',
        }}
        dangerouslySetInnerHTML={{ __html: result.snippet }}
      />
    </div>
  )
}

export function SearchPage() {
  const [query, setQuery] = useState('')
  const [collection, setCollection] = useState('')
  const [mode, setMode] = useState<'hybrid' | 'semantic' | 'text'>('hybrid')
  const [page, setPage] = useState(1)
  const [selectedResult, setSelectedResult] = useState<SearchResult | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const { results, isLoading, total, suggestions, search, suggest } = useSearch()

  const handleSearch = useCallback(
    (q: string) => {
      setQuery(q)
      setPage(1)
      search({ q, collection, mode, page: 1 })
    },
    [collection, mode, search]
  )

  const handleFilterChange = useCallback(
    (newCollection: string, newMode: 'hybrid' | 'semantic' | 'text') => {
      if (query) search({ q: query, collection: newCollection, mode: newMode, page: 1 })
    },
    [query, search]
  )

  const handleResultClick = (result: SearchResult) => {
    setSelectedResult(result)
    setDrawerOpen(true)
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        direction: 'rtl',
        padding: '24px 20px',
        gap: 20,
        maxWidth: 1100,
        margin: '0 auto',
        width: '100%',
      }}
    >
      {/* Search bar */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <AutoComplete
          value={query}
          options={suggestions.map((s) => ({ value: s, label: s }))}
          onSearch={(val) => {
            setQuery(val)
            suggest(val)
          }}
          onSelect={handleSearch}
          style={{ width: '100%' }}
        >
          <Input
            size="large"
            placeholder="ابحث في القوانين والأحكام المغربية..."
            prefix={isLoading ? <Spin size="small" /> : <SearchOutlined style={{ color: GOLD }} />}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              suggest(e.target.value)
            }}
            onPressEnter={() => handleSearch(query)}
            style={{
              background: DARK_CARD,
              border: `1px solid ${query ? 'rgba(201,168,76,0.5)' : BORDER_COLOR}`,
              borderRadius: 12,
              fontSize: 16,
              fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
              height: 52,
              direction: 'rtl',
              color: 'var(--color-text-primary)',
            }}
            allowClear
          />
        </AutoComplete>

        {/* Filters row */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <FilterOutlined style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />

          <Select
            value={collection}
            onChange={(val) => {
              setCollection(val)
              handleFilterChange(val, mode)
            }}
            options={COLLECTIONS}
            style={{ minWidth: 200 }}
            placeholder="جميع المجموعات"
          />

          <Segmented
            value={mode}
            onChange={(val) => {
              const m = val as 'hybrid' | 'semantic' | 'text'
              setMode(m)
              handleFilterChange(collection, m)
            }}
            options={[
              { label: 'هجين', value: 'hybrid' },
              { label: 'دلالي', value: 'semantic' },
              { label: 'نصي', value: 'text' },
            ]}
            style={{
              background: DARK_CARD,
              fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
            }}
          />

          {total > 0 && (
            <span
              style={{
                fontSize: 13,
                color: 'var(--color-text-tertiary)',
                fontFamily: "'Cairo', sans-serif",
                marginRight: 'auto',
              }}
            >
              {total} نتيجة
            </span>
          )}
        </div>
      </div>

      {/* Results */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {!query && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: 300,
              gap: 12,
            }}
          >
            <SearchOutlined style={{ fontSize: 48, color: 'var(--color-border-subtle)' }} />
            <div
              style={{
                fontSize: 15,
                color: 'var(--color-text-quaternary)',
                fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif",
              }}
            >
              ابحث في أكثر من 50,000 وثيقة قانونية مغربية
            </div>
          </div>
        )}

        {query && !isLoading && results.length === 0 && (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <div style={{ direction: 'rtl', fontFamily: "'Noto Naskh Arabic', 'Cairo', sans-serif" }}>
                <div style={{ color: 'var(--color-text-secondary)', marginBottom: 8 }}>لا توجد نتائج لـ "{query}"</div>
                <div style={{ color: 'var(--color-text-quaternary)', fontSize: 13 }}>
                  حاول تغيير كلمات البحث أو تصفية المجموعات
                </div>
              </div>
            }
          />
        )}

        {results.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {results.map((result) => (
              <ResultCard
                key={result.id}
                result={result}
                onClick={() => handleResultClick(result)}
                isActive={selectedResult?.id === result.id}
              />
            ))}

            {total > 20 && (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '16px 0' }}>
                <Pagination
                  current={page}
                  total={total}
                  pageSize={20}
                  onChange={(p) => {
                    setPage(p)
                    search({ q: query, collection, mode, page: p })
                  }}
                  showTotal={(t) => (
                    <span style={{ fontFamily: "'Cairo', sans-serif", color: 'var(--color-text-secondary)' }}>
                      {t} نتيجة
                    </span>
                  )}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Detail drawer */}
      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        placement="left"
        width={480}
        title={null}
        closable={false}
        styles={{
          body: { padding: 0, background: 'var(--color-bg-sidebar)' },
          mask: { background: 'var(--color-mask)' },
        }}
      >
        {selectedResult && (
          <DetailPanel result={selectedResult} onClose={() => setDrawerOpen(false)} />
        )}
      </Drawer>
    </div>
  )
}
