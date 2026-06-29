import React, { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Empty,
  Image,
  List,
  Progress,
  Row,
  Segmented,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd'
import {
  BranchesOutlined,
  DownloadOutlined,
  FileImageOutlined,
  FileTextOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
  ApartmentOutlined,
} from '@ant-design/icons'
import { useAdminUi } from '../locale/useAdminI18n'
import { useAuthStore } from '../../../shared/store/authStore'
import { resolveAdminApiToken } from '../../../shared/auth/adminSession'
import { BORDER_COLOR, BORDER_SUBTLE, GOLD } from '../../../shared/constants'
import { LegalGraphExplorerPanel } from './LegalGraphExplorerPanel'

type LegalGraphDocument = {
  collection?: string
  document_id?: string
  title?: string
  qdrant_chunks?: number
  chunks?: number
  minio_path?: string
  minio_size?: number
  document_type?: string
}

type LegalGraphSummary = {
  [key: string]: unknown
  source_collections?: string[]
  selected_collection?: string
  selected_documents?: LegalGraphDocument[]
  documents?: LegalGraphDocument[]
  excluded_documents?: LegalGraphDocument[]
  reasoning_path?: string[]
}

type LegalGraphStats = {
  document_count?: number | null
  chunk_count?: number | null
  graph_nodes?: number | null
  graph_edges?: number | null
  reasoning_edge_count?: number | null
  edge_counts: Record<string, number>
  layer_counts: Record<string, number>
  graph_search_status?: string | null
  graph_search_method?: string | null
  graph_search_message?: string | null
}

type LegalGraphImage = {
  filename: string
  kind: string
  label: string
  url: string
  size_bytes: number
  updated_at: string
}

type LegalGraphFile = {
  filename: string
  kind: string
  url: string
  size_bytes: number
  updated_at: string
}

type LegalGraphArtifact = {
  id: string
  name: string
  directory: string
  updated_at: string
  images: LegalGraphImage[]
  files: LegalGraphFile[]
  stats: LegalGraphStats
  summary: LegalGraphSummary
}

type LegalGraphListResponse = {
  graphs: LegalGraphArtifact[]
  count: number
  data_root: string
}

type LegalGraphBuildJobStatus = {
  job_id: string
  status: 'queued' | 'running' | 'completed' | 'failed' | string
  progress: number
  phase: string
  message: string
  current_file?: string | null
  processed_documents: number
  total_documents: number
  retrieved_chunks: number
  upserted_nodes: number
  skipped_nodes: number
  connected_edges: number
  graph?: LegalGraphArtifact | null
  error?: string | null
  started_at: string
  updated_at: string
  completed_at?: string | null
}

const IMAGE_ORDER = ['combined', 'graph', 'augmented', 'selection', 'discovery', 'reasoning']
const BUILD_POLL_INTERVAL_MS = 1200

function graphApiBase() {
  return (import.meta.env.VITE_API_URL || '/api').replace(/\/+$/, '')
}

function graphUrl(path: string) {
  if (/^https?:\/\//i.test(path)) return path
  if (path.startsWith('/api/')) return path
  if (path.startsWith('/legal-graphs/')) return `${graphApiBase()}/admin${path}`
  const normalized = path.startsWith('/') ? path : `/${path}`
  return `${graphApiBase()}${normalized}`
}

// <img>/<a> loads can't send an Authorization header, so the ADMIN-guarded image
// and download routes reject them. The KeycloakGuard also accepts the JWT via a
// `?token=` query param — append it here so browser-initiated GETs are authorized.
function withAuth(url: string, token: string | null) {
  if (!token) return url
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
}

function formatNumber(value?: number | null) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return new Intl.NumberFormat('fr-FR').format(value)
}

function formatBytes(value?: number | null) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  if (value < 1024) return `${value} o`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} Ko`
  return `${(value / 1024 / 1024).toFixed(1)} Mo`
}

function formatDate(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function preferredImage(images: LegalGraphImage[]) {
  return [...images].sort((a, b) => {
    const ai = IMAGE_ORDER.indexOf(a.kind)
    const bi = IMAGE_ORDER.indexOf(b.kind)
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
  })[0] || null
}

function statusLabel(status?: string | null) {
  if (!status) return 'Statut inconnu'
  if (status === 'no_reasoning_path') return 'Aucun chemin de raisonnement'
  if (status === 'success') return 'Chemin trouvé'
  return status.replace(/_/g, ' ')
}

function entries(record: Record<string, number>) {
  return Object.entries(record || {}).sort(([, a], [, b]) => b - a)
}

function requestErrorMessage(status: number, detail: string, routeMissingMessage: string) {
  if (status === 404) return routeMissingMessage
  return detail || `HTTP ${status}`
}

async function responseError(res: Response, routeMissingMessage: string) {
  const text = await res.text()
  let detail = text
  try {
    const data = text ? JSON.parse(text) : null
    if (typeof data?.detail === 'string') detail = data.detail
    else if (typeof data?.message === 'string') detail = data.message
    else if (Array.isArray(data?.message)) detail = data.message.join(', ')
  } catch {
    detail = text
  }
  return requestErrorMessage(res.status, detail, routeMissingMessage)
}

async function fetchLegalGraphs(token: string | null, routeMissingMessage: string): Promise<LegalGraphListResponse> {
  const res = await fetch(graphUrl('/admin/legal-graphs'), {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  })
  if (!res.ok) {
    throw new Error(await responseError(res, routeMissingMessage))
  }
  return res.json()
}

async function startLegalGraphBuild(token: string | null, routeMissingMessage: string): Promise<LegalGraphBuildJobStatus> {
  const res = await fetch(graphUrl('/admin/legal-graphs/build-jobs'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      query: 'jurisprudence marocaine jugement motifs décision faits procédure',
      top_k: 100,
      judgments_only: true,
      cross_case: false,
    }),
  })
  if (!res.ok) {
    throw new Error(await responseError(res, routeMissingMessage))
  }
  return res.json()
}

async function fetchBuildJob(token: string | null, routeMissingMessage: string, jobId: string): Promise<LegalGraphBuildJobStatus> {
  const res = await fetch(graphUrl(`/admin/legal-graphs/build-jobs/${encodeURIComponent(jobId)}`), {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  })
  if (!res.ok) {
    throw new Error(await responseError(res, routeMissingMessage))
  }
  return res.json()
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function StatCard({ title, value }: { title: string; value: string }) {
  return (
    <Card variant="outlined" style={{ borderColor: BORDER_COLOR, height: '100%' }}>
      <Statistic title={title} value={value} valueStyle={{ color: 'var(--color-text-primary)' }} />
    </Card>
  )
}

function buildProgressKind(status?: string) {
  if (status === 'failed') return 'exception'
  if (status === 'completed') return 'success'
  return 'active'
}

export function LegalGraphsPage() {
  const { message } = AntApp.useApp()
  const { t, font, pageStyle, h1Style, mutedStyle, titleStyle, cellStyle, tableStyle } = useAdminUi()
  const storeToken = useAuthStore((s) => s.token)
  const token = resolveAdminApiToken(storeToken)
  const copy = t.legalGraphs
  const [graphs, setGraphs] = useState<LegalGraphArtifact[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedImageName, setSelectedImageName] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [building, setBuilding] = useState(false)
  const [buildStatus, setBuildStatus] = useState<LegalGraphBuildJobStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [detailTab, setDetailTab] = useState<'visualisation' | 'explorer'>('visualisation')

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchLegalGraphs(token, copy.routeMissing)
      setGraphs(data.graphs)
      setSelectedId((current) => {
        if (current && data.graphs.some((g) => g.id === current)) return current
        return data.graphs[0]?.id || null
      })
      setSelectedImageName(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : copy.loadError)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  const handleBuild = async () => {
    setBuilding(true)
    setError(null)
    setBuildStatus(null)
    try {
      let latest = await startLegalGraphBuild(token, copy.routeMissing)
      setBuildStatus(latest)

      while (latest.status === 'queued' || latest.status === 'running') {
        await delay(BUILD_POLL_INTERVAL_MS)
        latest = await fetchBuildJob(token, copy.routeMissing, latest.job_id)
        setBuildStatus(latest)
      }

      if (latest.status !== 'completed') {
        throw new Error(latest.error || latest.message || copy.buildError)
      }

      message.success(copy.buildSuccess)
      await load()
      if (latest.graph?.id) setSelectedId(latest.graph.id)
      setSelectedImageName(null)
    } catch (err) {
      const text = err instanceof Error ? err.message : copy.buildError
      setError(text)
      message.error(text)
    } finally {
      setBuilding(false)
    }
  }

  const selectedGraph = useMemo(
    () => graphs.find((g) => g.id === selectedId) || null,
    [graphs, selectedId],
  )

  const selectedImage = useMemo(() => {
    if (!selectedGraph) return null
    return selectedGraph.images.find((img) => img.filename === selectedImageName) || preferredImage(selectedGraph.images)
  }, [selectedGraph, selectedImageName])

  const totals = useMemo(() => {
    return graphs.reduce(
      (acc, graph) => ({
        docs: acc.docs + (graph.stats.document_count || 0),
        nodes: acc.nodes + (graph.stats.graph_nodes || 0),
        edges: acc.edges + (graph.stats.graph_edges || 0),
        reasoning: acc.reasoning + (graph.stats.reasoning_edge_count || 0),
      }),
      { docs: 0, nodes: 0, edges: 0, reasoning: 0 },
    )
  }, [graphs])

  const documents = selectedGraph?.summary.selected_documents || selectedGraph?.summary.documents || []
  const excludedDocuments = selectedGraph?.summary.excluded_documents || []
  const imageOptions = (selectedGraph?.images || []).map((img) => ({
    label: img.label,
    value: img.filename,
  }))

  const selectedHasPickle = Boolean(
    selectedGraph?.files.some((file) => file.kind === 'pickle' || file.filename.endsWith('.pkl')),
  )

  return (
    <div style={pageStyle}>
      <Space direction="vertical" size={18} style={{ width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start' }}>
          <div>
            <h1 style={h1Style}>{copy.title}</h1>
            <Typography.Paragraph style={{ ...mutedStyle, marginTop: 8, maxWidth: 820 }}>
              {copy.subtitle}
            </Typography.Paragraph>
          </div>
          <Space wrap>
            <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
              {t.common.refresh}
            </Button>
            <Button type="primary" icon={<ThunderboltOutlined />} onClick={() => void handleBuild()} loading={building}>
              {building ? copy.building : copy.buildGraph}
            </Button>
          </Space>
        </div>

        {error && <Alert type="error" showIcon message={copy.loadError} description={error} />}

        {buildStatus && (
          <Card
            variant="outlined"
            style={{
              borderColor: buildStatus.status === 'failed' ? 'var(--color-error)' : GOLD,
              background:
                buildStatus.status === 'completed'
                  ? 'linear-gradient(135deg, rgba(82, 196, 26, 0.08), rgba(255, 255, 255, 0.96))'
                  : 'linear-gradient(135deg, var(--color-gold-tint), rgba(255, 255, 255, 0.96))',
              boxShadow: '0 18px 45px rgba(170, 132, 44, 0.12)',
            }}
          >
            <Space direction="vertical" size={14} style={{ width: '100%' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start' }}>
                <div>
                  <Typography.Text style={{ ...mutedStyle, textTransform: 'uppercase', letterSpacing: 1.4, fontSize: 11 }}>
                    {copy.buildProgress}
                  </Typography.Text>
                  <Typography.Title level={4} style={{ ...titleStyle, margin: '4px 0 0', fontFamily: font }}>
                    {buildStatus.message || copy.building}
                  </Typography.Title>
                </div>
                <Tag color={buildStatus.status === 'failed' ? 'red' : buildStatus.status === 'completed' ? 'green' : 'gold'}>
                  {copy.phase}: {buildStatus.phase}
                </Tag>
              </div>

              <Progress
                percent={Math.max(0, Math.min(100, Math.round(buildStatus.progress || 0)))}
                status={buildProgressKind(buildStatus.status) as 'active' | 'success' | 'exception'}
                strokeColor={buildStatus.status === 'failed' ? 'var(--color-error)' : GOLD}
              />

              <div
                style={{
                  border: `1px solid ${BORDER_SUBTLE}`,
                  borderRadius: 14,
                  padding: 14,
                  background: 'rgba(255, 255, 255, 0.72)',
                }}
              >
                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                  <Typography.Text style={{ ...mutedStyle, fontSize: 12 }}>{copy.currentJudgment}</Typography.Text>
                  <Typography.Text
                    strong
                    style={{
                      ...cellStyle,
                      fontSize: 15,
                      direction: 'ltr',
                      display: 'block',
                      wordBreak: 'break-word',
                    }}
                  >
                    {buildStatus.current_file || copy.waitingJudgment}
                  </Typography.Text>
                </Space>
              </div>

              <Space wrap size={[8, 8]}>
                <Tag color="blue">
                  {copy.processedJudgments}: {formatNumber(buildStatus.processed_documents)} / {formatNumber(buildStatus.total_documents)}
                </Tag>
                <Tag>{copy.retrievedChunks}: {formatNumber(buildStatus.retrieved_chunks)}</Tag>
                <Tag>{copy.upsertedNodes}: {formatNumber(buildStatus.upserted_nodes)}</Tag>
                <Tag>{copy.connectedEdges}: {formatNumber(buildStatus.connected_edges)}</Tag>
                <Tag>{copy.jobId}: {buildStatus.job_id.slice(0, 8)}</Tag>
              </Space>

              {buildStatus.error && <Alert type="error" showIcon message={copy.buildError} description={buildStatus.error} />}
            </Space>
          </Card>
        )}

        <Row gutter={[16, 16]}>
          <Col xs={24} md={12} xl={6}><StatCard title={copy.graphs} value={formatNumber(graphs.length)} /></Col>
          <Col xs={24} md={12} xl={6}><StatCard title={copy.documents} value={formatNumber(totals.docs)} /></Col>
          <Col xs={24} md={12} xl={6}><StatCard title={copy.nodes} value={formatNumber(totals.nodes)} /></Col>
          <Col xs={24} md={12} xl={6}><StatCard title={copy.edges} value={formatNumber(totals.edges)} /></Col>
        </Row>

        {loading && graphs.length === 0 ? (
          <Card variant="outlined" style={{ borderColor: BORDER_COLOR, minHeight: 360 }}>
            <Spin />
          </Card>
        ) : graphs.length === 0 ? (
          <Card variant="outlined" style={{ borderColor: BORDER_COLOR }}>
            <Empty description={copy.empty} />
          </Card>
        ) : (
          <Row gutter={[16, 16]}>
            <Col xs={24} xl={7}>
              <Card title={<span style={titleStyle}>{copy.allGraphs}</span>} variant="outlined" style={{ borderColor: BORDER_COLOR }}>
                <List
                  dataSource={graphs}
                  split
                  renderItem={(graph) => {
                    const active = graph.id === selectedGraph?.id
                    return (
                      <List.Item
                        onClick={() => {
                          setSelectedId(graph.id)
                          setSelectedImageName(null)
                        }}
                        style={{
                          cursor: 'pointer',
                          padding: 12,
                          borderRadius: 10,
                          border: active ? `1px solid ${GOLD}` : `1px solid transparent`,
                          background: active ? 'var(--color-gold-tint)' : 'transparent',
                          marginBottom: 8,
                        }}
                      >
                        <List.Item.Meta
                          avatar={<BranchesOutlined style={{ color: active ? GOLD : 'var(--color-text-tertiary)', fontSize: 20 }} />}
                          title={<span style={{ ...titleStyle, fontSize: 13 }}>{graph.name}</span>}
                          description={
                            <Space direction="vertical" size={4}>
                              <span style={mutedStyle}>{graph.directory}</span>
                              <Space wrap size={6}>
                                <Tag>{formatNumber(graph.stats.graph_nodes)} {copy.nodes}</Tag>
                                <Tag>{formatNumber(graph.stats.graph_edges)} {copy.edges}</Tag>
                                <Tag>{graph.images.length} PNG</Tag>
                              </Space>
                            </Space>
                          }
                        />
                      </List.Item>
                    )
                  }}
                />
              </Card>
            </Col>

            <Col xs={24} xl={17}>
              {selectedGraph && (
                <Space direction="vertical" size={16} style={{ width: '100%' }}>
                  <Segmented
                    value={detailTab}
                    onChange={(value) => setDetailTab(value as 'visualisation' | 'explorer')}
                    options={[
                      { label: copy.tabVisualization, value: 'visualisation', icon: <FileImageOutlined /> },
                      {
                        label: copy.tabExplorer,
                        value: 'explorer',
                        icon: <ApartmentOutlined />,
                        disabled: !selectedHasPickle,
                      },
                    ]}
                  />

                  {detailTab === 'explorer' ? (
                    <LegalGraphExplorerPanel
                      graphId={selectedGraph.id}
                      hasPickle={selectedHasPickle}
                      token={token}
                      graphUrl={graphUrl}
                      routeMissingMessage={copy.routeMissing}
                      copy={copy.explorer}
                      styles={{ titleStyle, mutedStyle, cellStyle }}
                    />
                  ) : (
                    <>
                  <Card
                    variant="outlined"
                    style={{ borderColor: BORDER_COLOR }}
                    title={<span style={titleStyle}>{selectedGraph.name}</span>}
                    extra={<Tag color={selectedGraph.stats.graph_search_status === 'no_reasoning_path' ? 'warning' : 'green'}>{statusLabel(selectedGraph.stats.graph_search_status)}</Tag>}
                  >
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                      {imageOptions.length > 0 && (
                        <Segmented
                          value={selectedImage?.filename}
                          options={imageOptions}
                          onChange={(value) => setSelectedImageName(String(value))}
                        />
                      )}

                      {selectedImage ? (
                        <div
                          style={{
                            border: `1px solid ${BORDER_SUBTLE}`,
                            borderRadius: 12,
                            padding: 12,
                            background: '#fff',
                            overflow: 'auto',
                          }}
                        >
                          <Image
                            src={withAuth(`${graphUrl(selectedImage.url)}?v=${encodeURIComponent(selectedImage.updated_at)}`, token)}
                            alt={`${selectedGraph.name} - ${selectedImage.label}`}
                            style={{ maxWidth: '100%' }}
                            preview={{ src: withAuth(graphUrl(selectedImage.url), token) }}
                          />
                        </div>
                      ) : (
                        <Empty image={<FileImageOutlined style={{ fontSize: 42, color: GOLD }} />} description={copy.noImage} />
                      )}

                      {selectedGraph.stats.graph_search_message && (
                        <Alert type="warning" showIcon message={selectedGraph.stats.graph_search_message} />
                      )}
                    </Space>
                  </Card>

                  <Row gutter={[16, 16]}>
                    <Col xs={24} lg={12}>
                      <Card title={<span style={titleStyle}>{copy.stats}</span>} variant="outlined" style={{ borderColor: BORDER_COLOR }}>
                        <Space direction="vertical" size={10} style={{ width: '100%' }}>
                          <Space wrap>
                            <Tag color="blue">{copy.chunks}: {formatNumber(selectedGraph.stats.chunk_count)}</Tag>
                            <Tag color="gold">{copy.reasoningEdges}: {formatNumber(selectedGraph.stats.reasoning_edge_count)}</Tag>
                          </Space>
                          <Typography.Text style={mutedStyle}>{copy.layers}</Typography.Text>
                          <Space wrap>
                            {entries(selectedGraph.stats.layer_counts).map(([key, value]) => (
                              <Tag key={key}>{key}: {formatNumber(value)}</Tag>
                            ))}
                          </Space>
                          <Typography.Text style={mutedStyle}>{copy.edgeTypes}</Typography.Text>
                          <Space wrap>
                            {entries(selectedGraph.stats.edge_counts).map(([key, value]) => (
                              <Tag key={key}>{key}: {formatNumber(value)}</Tag>
                            ))}
                          </Space>
                        </Space>
                      </Card>
                    </Col>

                    <Col xs={24} lg={12}>
                      <Card title={<span style={titleStyle}>{copy.exports}</span>} variant="outlined" style={{ borderColor: BORDER_COLOR }}>
                        <List
                          size="small"
                          dataSource={selectedGraph.files}
                          renderItem={(file) => (
                            <List.Item
                              actions={[
                                <Button
                                  key="open"
                                  size="small"
                                  href={withAuth(graphUrl(file.url), token)}
                                  target="_blank"
                                  icon={<DownloadOutlined />}
                                >
                                  {copy.open}
                                </Button>,
                              ]}
                            >
                              <List.Item.Meta
                                avatar={<FileTextOutlined style={{ color: GOLD }} />}
                                title={<span style={cellStyle}>{file.filename}</span>}
                                description={<span style={mutedStyle}>{file.kind} {formatBytes(file.size_bytes)}</span>}
                              />
                            </List.Item>
                          )}
                        />
                      </Card>
                    </Col>
                  </Row>

                  <Card title={<span style={titleStyle}>{copy.includedDocuments}</span>} variant="outlined" style={{ borderColor: BORDER_COLOR }}>
                    <Table
                      size="small"
                      rowKey={(row, index) => row.document_id || `${row.title}-${index}`}
                      dataSource={documents}
                      pagination={{ pageSize: 6 }}
                      style={tableStyle}
                      columns={[
                        { title: t.common.title, dataIndex: 'title', render: (value) => <span style={cellStyle}>{value || '—'}</span> },
                        { title: t.common.collection, dataIndex: 'collection', render: (value) => <Tag>{value || '—'}</Tag> },
                        { title: 'Chunks', dataIndex: 'qdrant_chunks', render: (_, row) => <span style={cellStyle}>{formatNumber(row.qdrant_chunks || row.chunks)}</span> },
                        { title: 'MinIO', dataIndex: 'minio_path', render: (value) => <Typography.Text style={mutedStyle} ellipsis>{value || '—'}</Typography.Text> },
                      ]}
                    />
                  </Card>

                  {excludedDocuments.length > 0 && (
                    <Card title={<span style={titleStyle}>{copy.excludedDocuments}</span>} variant="outlined" style={{ borderColor: BORDER_COLOR }}>
                      <Table
                        size="small"
                        rowKey={(row, index) => row.document_id || `${row.title}-${index}`}
                        dataSource={excludedDocuments}
                        pagination={false}
                        style={tableStyle}
                        columns={[
                          { title: t.common.title, dataIndex: 'title', render: (value) => <span style={cellStyle}>{value || '—'}</span> },
                          { title: t.common.status, dataIndex: 'document_type', render: (value) => <Tag color="orange">{value || '—'}</Tag> },
                          { title: 'Chunks', dataIndex: 'chunks', render: (value) => <span style={cellStyle}>{formatNumber(value)}</span> },
                        ]}
                      />
                    </Card>
                  )}
                    </>
                  )}
                </Space>
              )}
            </Col>
          </Row>
        )}
      </Space>
    </div>
  )
}
