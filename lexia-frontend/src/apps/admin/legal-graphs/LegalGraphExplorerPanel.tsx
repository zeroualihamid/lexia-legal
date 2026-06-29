import React, { memo, useCallback, useEffect, useMemo, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Alert, Button, Card, Col, Empty, Row, Space, Spin, Tag, Typography } from 'antd'
import { ApartmentOutlined, NodeIndexOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { BORDER_COLOR, BORDER_SUBTLE, GOLD } from '../../../shared/constants'

type LegalGraphExplorePreset = {
  id: string
  label: string
  question: string
  intent: string
  section_types: string[]
}

type LegalGraphReactFlowNode = {
  id: string
  type: string
  position: { x: number; y: number }
  data: {
    label: string
    section_type: string
    section_title?: string
    text_preview: string
    color: string
    isSeed?: boolean
    isOnPath?: boolean
  }
}

type LegalGraphExploreQueryResponse = {
  preset_id?: string | null
  query: string
  seeds: string[]
  node_ids: string[]
  edge_ids: string[]
  graph: { nodes: LegalGraphReactFlowNode[]; edges: Array<{ id: string; source: string; target: string; label?: string }> }
  stats: Record<string, unknown>
  truncated: boolean
  message: string
}

type LegalGraphExplorePathResponse = {
  node_id: string
  goal_node_id?: string | null
  path_node_ids: string[]
  path_steps: Array<Record<string, unknown>>
  highlighted_edge_ids: string[]
  graph: LegalGraphExploreQueryResponse['graph']
  search_method: string
  status: string
  summary: string
  key_steps: string[]
  confidence_score: number
  message: string
  suggested_action: string
}

interface LegalGraphNodeData extends Record<string, unknown> {
  label: string
  section_type: string
  section_title?: string
  document_title?: string
  document_type?: string
  text_preview: string
  color: string
  isSeed?: boolean
  isOnPath?: boolean
}

type ExplorerCopy = {
  presetsTitle: string
  presetsSubtitle: string
  interactiveTitle: string
  interactiveSubtitle: string
  selectPreset: string
  noPickle: string
  resultTitle: string
  summaryTitle: string
  confidence: string
  pathFound: string
  nodes: string
  edges: string
  truncated: string
  loadPresetsError: string
  queryError: string
  pathError: string
}

type StyleBundle = {
  titleStyle: React.CSSProperties
  mutedStyle: React.CSSProperties
  cellStyle: React.CSSProperties
}

function LegalGraphNodeCard({ data, selected }: NodeProps<Node<LegalGraphNodeData>>) {
  const border = data.isOnPath
    ? `2px solid ${GOLD}`
    : data.isSeed
      ? '2px solid var(--color-primary)'
      : selected
        ? '2px solid var(--color-primary)'
        : `1px solid ${BORDER_COLOR}`

  return (
    <div
      style={{
        width: 220,
        borderRadius: 12,
        border,
        padding: 12,
        background: data.color,
        boxShadow: data.isOnPath ? '0 8px 24px rgba(170, 132, 44, 0.25)' : '0 2px 8px rgba(0,0,0,0.06)',
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: GOLD }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
        <span style={{ fontWeight: 600, fontSize: 12 }}>{data.label}</span>
        {data.isSeed && <Tag color="gold">seed</Tag>}
      </div>
      {data.section_title && (
        <Typography.Text type="secondary" ellipsis style={{ display: 'block', fontSize: 10, marginBottom: 4 }}>
          {data.section_title}
        </Typography.Text>
      )}
      {data.document_title && (
        <Typography.Text type="secondary" ellipsis style={{ display: 'block', fontSize: 10, marginBottom: 4 }}>
          {data.document_title}
        </Typography.Text>
      )}
      <Typography.Paragraph
        style={{ margin: 0, fontSize: 11, lineHeight: 1.45, color: 'var(--color-text-primary)' }}
        ellipsis={{ rows: 4 }}
      >
        {data.text_preview}
      </Typography.Paragraph>
      <Handle type="source" position={Position.Right} style={{ background: GOLD }} />
    </div>
  )
}

const nodeTypes = { legalGraphNode: memo(LegalGraphNodeCard) }

function toFlowNodes(nodes: LegalGraphReactFlowNode[]): Node<LegalGraphNodeData>[] {
  return nodes.map((node) => ({
    id: node.id,
    type: node.type || 'legalGraphNode',
    position: node.position,
    data: node.data as LegalGraphNodeData,
  }))
}

function toFlowEdges(
  edges: LegalGraphExploreQueryResponse['graph']['edges'],
  pathEdgeIds?: Set<string>,
): Edge[] {
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    animated: pathEdgeIds?.has(edge.id),
    style: pathEdgeIds?.has(edge.id)
      ? { stroke: GOLD, strokeWidth: 2.5 }
      : { stroke: '#2563eb', strokeWidth: 1.5 },
    labelStyle: { fill: '#374151', fontSize: 10 },
    markerEnd: { type: MarkerType.ArrowClosed, color: pathEdgeIds?.has(edge.id) ? GOLD : '#2563eb' },
  }))
}

function parseFetchError(status: number, text: string, routeMissingMessage: string): string {
  if (status === 404) return routeMissingMessage
  try {
    const data = text ? JSON.parse(text) : null
    if (typeof data?.message === 'string') return data.message
    if (typeof data?.detail === 'string') return data.detail
  } catch {
    /* keep raw text */
  }
  return text || `HTTP ${status}`
}

async function fetchPresets(
  graphUrl: (path: string) => string,
  token: string | null,
  routeMissingMessage: string,
): Promise<LegalGraphExplorePreset[]> {
  const res = await fetch(graphUrl('/admin/legal-graphs/explore/presets'), {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(parseFetchError(res.status, text, routeMissingMessage))
  }
  const data = await res.json()
  return data.presets || []
}

async function fetchQuery(
  graphUrl: (path: string) => string,
  token: string | null,
  routeMissingMessage: string,
  graphId: string,
  presetId: string,
): Promise<LegalGraphExploreQueryResponse> {
  const res = await fetch(graphUrl(`/admin/legal-graphs/${encodeURIComponent(graphId)}/explore/query`), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ preset_id: presetId, depth: 3 }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(parseFetchError(res.status, text, routeMissingMessage))
  }
  return res.json()
}

async function fetchPath(
  graphUrl: (path: string) => string,
  token: string | null,
  routeMissingMessage: string,
  graphId: string,
  nodeId: string,
  query?: string,
): Promise<LegalGraphExplorePathResponse> {
  const res = await fetch(graphUrl(`/admin/legal-graphs/${encodeURIComponent(graphId)}/explore/path`), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ node_id: nodeId, query }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(parseFetchError(res.status, text, routeMissingMessage))
  }
  return res.json()
}

function ExplorerInner({
  graphId,
  hasPickle,
  token,
  graphUrl,
  routeMissingMessage,
  copy,
  styles,
}: {
  graphId: string
  hasPickle: boolean
  token: string | null
  graphUrl: (path: string) => string
  routeMissingMessage: string
  copy: ExplorerCopy
  styles: StyleBundle
}) {
  const [presets, setPresets] = useState<LegalGraphExplorePreset[]>([])
  const [activePresetId, setActivePresetId] = useState<string | null>(null)
  const [activeQuery, setActiveQuery] = useState('')
  const [queryResult, setQueryResult] = useState<LegalGraphExploreQueryResponse | null>(null)
  const [pathResult, setPathResult] = useState<LegalGraphExplorePathResponse | null>(null)
  const [loadingPresets, setLoadingPresets] = useState(true)
  const [loadingQuery, setLoadingQuery] = useState(false)
  const [loadingPath, setLoadingPath] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<LegalGraphNodeData>>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoadingPresets(true)
      try {
        const items = await fetchPresets(graphUrl, token, routeMissingMessage)
        if (!cancelled) setPresets(items)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : copy.loadPresetsError)
      } finally {
        if (!cancelled) setLoadingPresets(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [copy.loadPresetsError, graphUrl, routeMissingMessage, token])

  const pathEdgeIds = useMemo(
    () => new Set(pathResult?.highlighted_edge_ids || []),
    [pathResult?.highlighted_edge_ids],
  )

  const applyGraph = useCallback(
    (graph: LegalGraphExploreQueryResponse['graph']) => {
      setNodes(toFlowNodes(graph.nodes))
      setEdges(toFlowEdges(graph.edges, pathEdgeIds.size > 0 ? pathEdgeIds : undefined))
    },
    [pathEdgeIds, setEdges, setNodes],
  )

  const runPresetQuery = useCallback(
    async (preset: LegalGraphExplorePreset) => {
      if (!hasPickle) return
      setLoadingQuery(true)
      setError(null)
      setPathResult(null)
      setActivePresetId(preset.id)
      setActiveQuery(preset.question)
      try {
        const result = await fetchQuery(graphUrl, token, routeMissingMessage, graphId, preset.id)
        setQueryResult(result)
        applyGraph(result.graph)
      } catch (err) {
        setError(err instanceof Error ? err.message : copy.queryError)
      } finally {
        setLoadingQuery(false)
      }
    },
    [applyGraph, copy.queryError, graphId, graphUrl, hasPickle, routeMissingMessage, token],
  )

  const onNodeClick = useCallback(
    async (_event: React.MouseEvent, node: Node<LegalGraphNodeData>) => {
      if (!hasPickle) return
      setLoadingPath(true)
      setError(null)
      try {
        const result = await fetchPath(graphUrl, token, routeMissingMessage, graphId, node.id, activeQuery || undefined)
        setPathResult(result)
        applyGraph(result.graph)
      } catch (err) {
        setError(err instanceof Error ? err.message : copy.pathError)
      } finally {
        setLoadingPath(false)
      }
    },
    [activeQuery, applyGraph, copy.pathError, graphId, graphUrl, hasPickle, routeMissingMessage, token],
  )

  if (!hasPickle) {
    return (
      <Alert type="warning" showIcon message={copy.noPickle} />
    )
  }

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={8}>
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Card
            title={<span style={styles.titleStyle}><ThunderboltOutlined style={{ color: GOLD, marginInlineEnd: 8 }} />{copy.presetsTitle}</span>}
            variant="outlined"
            style={{ borderColor: BORDER_COLOR }}
          >
            <Typography.Paragraph style={{ ...styles.mutedStyle, marginBottom: 12 }}>{copy.presetsSubtitle}</Typography.Paragraph>
            {loadingPresets ? (
              <Spin />
            ) : (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {presets.map((preset) => (
                  <Button
                    key={preset.id}
                    block
                    type={activePresetId === preset.id ? 'primary' : 'default'}
                    loading={loadingQuery && activePresetId === preset.id}
                    onClick={() => void runPresetQuery(preset)}
                    style={{
                      height: 'auto',
                      textAlign: 'start',
                      padding: '10px 12px',
                      whiteSpace: 'normal',
                    }}
                  >
                    <div>
                      <div style={{ ...styles.cellStyle, fontWeight: 600 }}>{preset.label}</div>
                      <div style={{ ...styles.mutedStyle, fontSize: 12, marginTop: 4 }}>{preset.question}</div>
                    </div>
                  </Button>
                ))}
              </Space>
            )}
          </Card>

          {(queryResult || pathResult) && (
            <Card title={<span style={styles.titleStyle}>{copy.resultTitle}</span>} variant="outlined" style={{ borderColor: BORDER_COLOR }}>
              {queryResult && (
                <Typography.Text style={styles.mutedStyle}>
                  {queryResult.node_ids.length} {copy.nodes} · {queryResult.edge_ids.length} {copy.edges}
                  {queryResult.truncated ? ` · ${copy.truncated}` : ''}
                </Typography.Text>
              )}
              {pathResult && (
                <Space direction="vertical" size={8} style={{ width: '100%', marginTop: 8 }}>
                  <Space wrap>
                    <Tag color={pathResult.status === 'ok' ? 'green' : 'orange'}>
                      {pathResult.status === 'ok' ? copy.pathFound : pathResult.status}
                    </Tag>
                    <Tag>{pathResult.search_method}</Tag>
                  </Space>
                  {pathResult.message && <Alert type="warning" showIcon message={pathResult.message} description={pathResult.suggested_action} />}
                </Space>
              )}
            </Card>
          )}

          {pathResult?.summary && (
            <Card
              title={<span style={styles.titleStyle}><NodeIndexOutlined style={{ color: GOLD, marginInlineEnd: 8 }} />{copy.summaryTitle}</span>}
              variant="outlined"
              style={{ borderColor: GOLD, background: 'linear-gradient(135deg, var(--color-gold-tint), rgba(255,255,255,0.96))' }}
            >
              {pathResult.confidence_score > 0 && (
                <Typography.Text style={styles.mutedStyle}>
                  {copy.confidence}: {Math.round(pathResult.confidence_score * 100)}%
                </Typography.Text>
              )}
              <Typography.Paragraph style={{ ...styles.cellStyle, marginTop: 8, whiteSpace: 'pre-wrap' }}>
                {pathResult.summary}
              </Typography.Paragraph>
              {pathResult.key_steps.length > 0 && (
                <ul style={{ margin: '8px 0 0', paddingInlineStart: 18, ...styles.mutedStyle, fontSize: 12 }}>
                  {pathResult.key_steps.slice(0, 6).map((step, index) => (
                    <li key={`${index}-${step.slice(0, 20)}`}>{step}</li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </Space>
      </Col>

      <Col xs={24} xl={16}>
        <Card
          title={<span style={styles.titleStyle}><ApartmentOutlined style={{ color: GOLD, marginInlineEnd: 8 }} />{copy.interactiveTitle}</span>}
          variant="outlined"
          style={{ borderColor: BORDER_COLOR, minHeight: 560 }}
          extra={(loadingQuery || loadingPath) && <Spin size="small" />}
        >
          <Typography.Paragraph style={{ ...styles.mutedStyle, marginBottom: 12 }}>{copy.interactiveSubtitle}</Typography.Paragraph>
          {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
          {!error && queryResult?.message && nodes.length === 0 && (
            <Alert type="info" showIcon message={queryResult.message} style={{ marginBottom: 12 }} />
          )}
          {nodes.length === 0 ? (
            <Empty description={copy.selectPreset} />
          ) : (
            <div style={{ height: 520, border: `1px solid ${BORDER_SUBTLE}`, borderRadius: 12, background: 'rgba(255,255,255,0.6)' }}>
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeClick={onNodeClick}
                nodeTypes={nodeTypes}
                fitView
                minZoom={0.2}
                maxZoom={1.5}
              >
                <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
                <MiniMap pannable zoomable />
                <Controls showInteractive={false} />
              </ReactFlow>
            </div>
          )}
        </Card>
      </Col>
    </Row>
  )
}

export function LegalGraphExplorerPanel(props: {
  graphId: string
  hasPickle: boolean
  token: string | null
  graphUrl: (path: string) => string
  routeMissingMessage: string
  copy: ExplorerCopy
  styles: StyleBundle
}) {
  return (
    <ReactFlowProvider>
      <ExplorerInner {...props} />
    </ReactFlowProvider>
  )
}
