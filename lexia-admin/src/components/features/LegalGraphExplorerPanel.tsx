import { memo, useCallback, useEffect, useMemo, useState } from 'react';
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
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { AlertTriangle, Loader2, Route, Sparkles } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  exploreLegalGraphPath,
  exploreLegalGraphQuery,
  listLegalGraphPresets,
  type LegalGraphExplorePathResponse,
  type LegalGraphExplorePreset,
  type LegalGraphExploreQueryResponse,
  type LegalGraphReactFlowNode,
} from '@/lib/legal_graph_api';

interface LegalGraphNodeData extends Record<string, unknown> {
  label: string;
  section_type: string;
  section_title?: string;
  text_preview: string;
  color: string;
  isSeed?: boolean;
  isOnPath?: boolean;
}

function LegalGraphNodeCard({ data, selected }: NodeProps<Node<LegalGraphNodeData>>) {
  return (
    <div
      className={cn(
        'w-[220px] rounded-xl border-2 bg-card p-3 text-xs shadow-sm transition-shadow',
        data.isOnPath && 'border-amber-500 shadow-md ring-2 ring-amber-200',
        data.isSeed && !data.isOnPath && 'border-primary',
        selected && !data.isOnPath && 'border-primary shadow-md',
        !selected && !data.isOnPath && !data.isSeed && 'border-border',
      )}
      style={{ backgroundColor: data.color }}
    >
      <Handle type="target" position={Position.Left} className="!bg-primary" />
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-semibold text-foreground">{data.label}</span>
        {data.isSeed && (
          <Badge variant="secondary" className="text-[10px]">
            seed
          </Badge>
        )}
      </div>
      {data.section_title && (
        <div className="mb-1 line-clamp-1 text-[10px] text-muted-foreground">{data.section_title}</div>
      )}
      <p className="line-clamp-4 text-[11px] leading-relaxed text-foreground/90">{data.text_preview}</p>
      <Handle type="source" position={Position.Right} className="!bg-primary" />
    </div>
  );
}

const nodeTypes = { legalGraphNode: memo(LegalGraphNodeCard) };

function toFlowNodes(nodes: LegalGraphReactFlowNode[]): Node<LegalGraphNodeData>[] {
  return nodes.map((node) => ({
    id: node.id,
    type: node.type || 'legalGraphNode',
    position: node.position,
    data: node.data as LegalGraphNodeData,
  }));
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
      ? { stroke: '#d97706', strokeWidth: 2.5 }
      : { stroke: '#2563eb', strokeWidth: 1.5 },
    labelStyle: { fill: '#374151', fontSize: 10 },
    markerEnd: { type: MarkerType.ArrowClosed, color: pathEdgeIds?.has(edge.id) ? '#d97706' : '#2563eb' },
  }));
}

interface LegalGraphExplorerPanelProps {
  graphId: string;
  hasPickle: boolean;
}

function ExplorerInner({ graphId, hasPickle }: LegalGraphExplorerPanelProps) {
  const [presets, setPresets] = useState<LegalGraphExplorePreset[]>([]);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [activeQuery, setActiveQuery] = useState<string>('');
  const [queryResult, setQueryResult] = useState<LegalGraphExploreQueryResponse | null>(null);
  const [pathResult, setPathResult] = useState<LegalGraphExplorePathResponse | null>(null);
  const [loadingPresets, setLoadingPresets] = useState(true);
  const [loadingQuery, setLoadingQuery] = useState(false);
  const [loadingPath, setLoadingPath] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<LegalGraphNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoadingPresets(true);
      try {
        const response = await listLegalGraphPresets();
        if (!cancelled) setPresets(response.presets);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Impossible de charger les exemples.');
      } finally {
        if (!cancelled) setLoadingPresets(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const pathEdgeIds = useMemo(
    () => new Set(pathResult?.highlighted_edge_ids || []),
    [pathResult?.highlighted_edge_ids],
  );

  const applyGraph = useCallback(
    (graph: LegalGraphExploreQueryResponse['graph']) => {
      setNodes(toFlowNodes(graph.nodes));
      setEdges(toFlowEdges(graph.edges, pathEdgeIds.size > 0 ? pathEdgeIds : undefined));
    },
    [pathEdgeIds, setEdges, setNodes],
  );

  const runPresetQuery = useCallback(
    async (preset: LegalGraphExplorePreset) => {
      if (!hasPickle) return;
      setLoadingQuery(true);
      setError(null);
      setPathResult(null);
      setActivePresetId(preset.id);
      setActiveQuery(preset.question);
      try {
        const result = await exploreLegalGraphQuery(graphId, { preset_id: preset.id, depth: 3 });
        setQueryResult(result);
        applyGraph(result.graph);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Échec de la requête graphe.');
      } finally {
        setLoadingQuery(false);
      }
    },
    [applyGraph, graphId, hasPickle],
  );

  const onNodeClick = useCallback(
    async (_event: React.MouseEvent, node: Node<LegalGraphNodeData>) => {
      if (!hasPickle) return;
      setLoadingPath(true);
      setError(null);
      try {
        const result = await exploreLegalGraphPath(graphId, {
          node_id: node.id,
          query: activeQuery || undefined,
        });
        setPathResult(result);
        applyGraph(result.graph);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Échec du calcul du chemin.');
      } finally {
        setLoadingPath(false);
      }
    },
    [activeQuery, applyGraph, graphId, hasPickle],
  );

  if (!hasPickle) {
    return (
      <Card className="shadow-sm">
        <CardContent className="p-6 text-sm text-muted-foreground">
          Ce graphe ne contient pas de fichier pickle. Générez ou importez un graphe avec{' '}
          <span className="font-mono">legal_graph.pkl</span> pour utiliser l&apos;explorateur.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
      <div className="space-y-3">
        <Card className="shadow-sm">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-primary" />
              Exemples de requêtes
            </CardTitle>
            <CardDescription>
              Comment ce jugement raisonne-t-il ? Cliquez une question pour afficher nœuds et arêtes de raisonnement.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 p-4 pt-0">
            {loadingPresets ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Chargement…
              </div>
            ) : (
              presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  disabled={loadingQuery}
                  onClick={() => void runPresetQuery(preset)}
                  className={cn(
                    'w-full rounded-lg border p-3 text-left text-sm transition-colors',
                    activePresetId === preset.id
                      ? 'border-primary bg-primary/10'
                      : 'border-border bg-background hover:bg-muted/60',
                  )}
                >
                  <div className="font-medium">{preset.label}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{preset.question}</div>
                  <div className="mt-2 text-[10px] uppercase tracking-wide text-muted-foreground">{preset.intent}</div>
                </button>
              ))
            )}
          </CardContent>
        </Card>

        {(queryResult || pathResult) && (
          <Card className="shadow-sm">
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-base">Résultat</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 p-4 pt-0 text-sm">
              {queryResult && (
                <div className="text-muted-foreground">
                  {queryResult.node_ids.length} nœud(s) · {queryResult.edge_ids.length} arête(s)
                  {queryResult.truncated && ' · tronqué'}
                </div>
              )}
              {pathResult && (
                <>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant={pathResult.status === 'ok' ? 'default' : 'outline'}>
                      {pathResult.status === 'ok' ? 'Chemin trouvé' : pathResult.status}
                    </Badge>
                    <Badge variant="secondary">{pathResult.search_method}</Badge>
                  </div>
                  {pathResult.message && (
                    <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-900 dark:text-amber-100">
                      {pathResult.message}
                      {pathResult.suggested_action && (
                        <div className="mt-1 text-muted-foreground">{pathResult.suggested_action}</div>
                      )}
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        )}

        {pathResult?.summary && (
          <Card className="shadow-sm border-amber-500/30">
            <CardHeader className="p-4 pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Route className="h-4 w-4 text-amber-600" />
                Synthèse du raisonnement
              </CardTitle>
              {pathResult.confidence_score > 0 && (
                <CardDescription>
                  Confiance {Math.round(pathResult.confidence_score * 100)}%
                </CardDescription>
              )}
            </CardHeader>
            <CardContent className="space-y-2 p-4 pt-0">
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{pathResult.summary}</p>
              {pathResult.key_steps.length > 0 && (
                <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                  {pathResult.key_steps.slice(0, 6).map((step, index) => (
                    <li key={`${index}-${step.slice(0, 24)}`}>{step}</li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      <Card className="min-h-[520px] shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between gap-3 p-4 pb-2">
          <div>
            <CardTitle className="text-base">Graphe interactif</CardTitle>
            <CardDescription>
              Cliquez un nœud pour lancer A* vers la décision et générer une synthèse.
            </CardDescription>
          </div>
          {(loadingQuery || loadingPath) && <Loader2 className="h-5 w-5 animate-spin text-primary" />}
        </CardHeader>
        <CardContent className="h-[560px] p-2 pt-0">
          {error && (
            <div className="mb-2 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              {error}
            </div>
          )}
          {nodes.length === 0 ? (
            <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
              Sélectionnez une question d&apos;exemple pour afficher le sous-graphe.
            </div>
          ) : (
            <div className="h-full rounded-lg border border-border bg-muted/20">
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
        </CardContent>
      </Card>
    </div>
  );
}

export default function LegalGraphExplorerPanel(props: LegalGraphExplorerPanelProps) {
  return (
    <ReactFlowProvider>
      <ExplorerInner {...props} />
    </ReactFlowProvider>
  );
}
