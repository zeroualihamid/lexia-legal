import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Download,
  ExternalLink,
  FileJson,
  FileText,
  GitBranch,
  Image as ImageIcon,
  Layers,
  RefreshCw,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  legalGraphAssetUrl,
  listLegalGraphs,
  type LegalGraphArtifact,
  type LegalGraphDocument,
  type LegalGraphFile,
  type LegalGraphImage,
} from '@/lib/legal_graph_api';

const imagePreference = ['combined', 'graph', 'augmented', 'selection', 'discovery', 'reasoning'];

function formatNumber(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Non disponible';
  return new Intl.NumberFormat('fr-FR').format(value);
}

function formatBytes(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  if (value < 1024) return `${value} o`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} Ko`;
  return `${(value / 1024 / 1024).toFixed(1)} Mo`;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return 'Date inconnue';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function getSelectedDocuments(graph: LegalGraphArtifact | null): LegalGraphDocument[] {
  if (!graph) return [];
  return graph.summary.selected_documents || graph.summary.documents || [];
}

function getExcludedDocuments(graph: LegalGraphArtifact | null): LegalGraphDocument[] {
  if (!graph) return [];
  return graph.summary.excluded_documents || [];
}

function sortedEntries(record: Record<string, number> | undefined): [string, number][] {
  return Object.entries(record || {}).sort(([, a], [, b]) => b - a);
}

function statusLabel(status: string | null | undefined): string {
  if (!status) return 'Statut inconnu';
  if (status === 'no_reasoning_path') return 'Aucun chemin de raisonnement';
  if (status === 'success') return 'Chemin trouvé';
  if (status === 'ok') return 'Graphe prêt';
  return status.replaceAll('_', ' ');
}

function preferredImage(images: LegalGraphImage[]): LegalGraphImage | null {
  if (images.length === 0) return null;
  return [...images].sort((a, b) => {
    const aRank = imagePreference.indexOf(a.kind);
    const bRank = imagePreference.indexOf(b.kind);
    return (aRank === -1 ? 99 : aRank) - (bRank === -1 ? 99 : bRank);
  })[0];
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="shadow-sm">
      <CardContent className="p-4">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="mt-2 text-2xl font-semibold">{value}</div>
        {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

function KeyValueList({ title, entries }: { title: string; entries: [string, number][] }) {
  return (
    <div className="rounded-lg border border-border bg-background/60 p-3">
      <div className="mb-2 text-sm font-semibold">{title}</div>
      {entries.length === 0 ? (
        <div className="text-sm text-muted-foreground">Aucune donnée.</div>
      ) : (
        <div className="space-y-2">
          {entries.map(([key, value]) => (
            <div key={key} className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate text-muted-foreground">{key}</span>
              <span className="font-medium">{formatNumber(value)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DocumentList({
  title,
  documents,
  empty,
}: {
  title: string;
  documents: LegalGraphDocument[];
  empty: string;
}) {
  const visible = documents.slice(0, 8);
  return (
    <Card className="shadow-sm">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <FileText className="h-4 w-4" />
          {title}
        </CardTitle>
        <CardDescription>{documents.length} document(s)</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 p-4 pt-0">
        {visible.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            {empty}
          </div>
        ) : (
          visible.map((document, index) => (
            <div key={document.document_id || `${document.title || 'document'}-${index}`} className="rounded-lg border border-border bg-background/70 p-3">
              <div className="line-clamp-1 text-sm font-medium">{document.title || document.document_id || 'Document sans titre'}</div>
              <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                {document.collection && <span>{document.collection}</span>}
                {(document.qdrant_chunks || document.chunks) && (
                  <span>{formatNumber(document.qdrant_chunks || document.chunks)} chunks</span>
                )}
                {document.document_type && <span>type: {document.document_type}</span>}
                {document.minio_size && <span>{formatBytes(document.minio_size)}</span>}
              </div>
              {document.minio_path && (
                <div className="mt-1 line-clamp-1 text-xs text-muted-foreground">{document.minio_path}</div>
              )}
            </div>
          ))
        )}
        {documents.length > visible.length && (
          <div className="text-xs text-muted-foreground">
            {documents.length - visible.length} document(s) supplémentaire(s) non affiché(s).
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function fileIcon(file: LegalGraphFile) {
  if (file.kind === 'summary' || file.kind === 'json') return <FileJson className="h-4 w-4" />;
  if (file.kind === 'graphml' || file.kind === 'pickle') return <GitBranch className="h-4 w-4" />;
  return <Download className="h-4 w-4" />;
}

export default function LegalGraphsView() {
  const [graphs, setGraphs] = useState<LegalGraphArtifact[]>([]);
  const [selectedGraphId, setSelectedGraphId] = useState<string | null>(null);
  const [selectedImageByGraph, setSelectedImageByGraph] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadGraphs = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await listLegalGraphs();
      setGraphs(response.graphs);
      setSelectedGraphId((current) => {
        if (current && response.graphs.some((graph) => graph.id === current)) return current;
        return response.graphs[0]?.id || null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Impossible de charger les graphes juridiques.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadGraphs();
  }, []);

  const selectedGraph = useMemo(
    () => graphs.find((graph) => graph.id === selectedGraphId) || null,
    [graphs, selectedGraphId],
  );

  const selectedImage = useMemo(() => {
    if (!selectedGraph) return null;
    const savedFilename = selectedImageByGraph[selectedGraph.id];
    return selectedGraph.images.find((image) => image.filename === savedFilename) || preferredImage(selectedGraph.images);
  }, [selectedGraph, selectedImageByGraph]);

  const totals = useMemo(() => {
    return graphs.reduce(
      (acc, graph) => {
        acc.nodes += graph.stats.graph_nodes || 0;
        acc.edges += graph.stats.graph_edges || 0;
        acc.documents += graph.stats.document_count || 0;
        acc.reasoningEdges += graph.stats.reasoning_edge_count || 0;
        return acc;
      },
      { nodes: 0, edges: 0, documents: 0, reasoningEdges: 0 },
    );
  }, [graphs]);

  const selectedDocuments = getSelectedDocuments(selectedGraph);
  const excludedDocuments = getExcludedDocuments(selectedGraph);
  const edgeEntries = sortedEntries(selectedGraph?.stats.edge_counts);
  const layerEntries = sortedEntries(selectedGraph?.stats.layer_counts);
  const imageSrc =
    selectedGraph && selectedImage
      ? `${legalGraphAssetUrl(selectedImage.url)}?v=${encodeURIComponent(selectedImage.updated_at)}`
      : '';

  return (
    <div className="flex h-full w-full overflow-hidden bg-background">
      <div className="h-full min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1520px] flex-col gap-5 p-5 lg:p-6">
          <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-5 shadow-sm lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex items-center gap-2 text-sm font-medium text-primary">
                <GitBranch className="h-4 w-4" />
                Graphe de connaissance juridique
              </div>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">Graphes juridiques</h1>
              <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                Visualisation des graphes générés depuis Qdrant et MinIO: vues PNG, couches de découverte,
                couches de raisonnement, résumés et exports GraphML.
              </p>
            </div>
            <Button onClick={() => void loadGraphs()} disabled={loading} variant="outline">
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
              Rafraîchir
            </Button>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <StatCard label="Graphes" value={formatNumber(graphs.length)} />
            <StatCard label="Documents" value={formatNumber(totals.documents)} />
            <StatCard label="Noeuds" value={formatNumber(totals.nodes)} />
            <StatCard label="Arêtes" value={formatNumber(totals.edges)} />
            <StatCard label="Arêtes raisonnement" value={formatNumber(totals.reasoningEdges)} />
          </div>

          {error && (
            <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <div>{error}</div>
            </div>
          )}

          {loading && graphs.length === 0 ? (
            <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
              <div className="h-96 animate-pulse rounded-xl border border-border bg-muted/40" />
              <div className="h-[560px] animate-pulse rounded-xl border border-border bg-muted/40" />
            </div>
          ) : graphs.length === 0 ? (
            <Card className="shadow-sm">
              <CardContent className="flex min-h-[360px] flex-col items-center justify-center p-8 text-center">
                <ImageIcon className="h-10 w-10 text-muted-foreground" />
                <h2 className="mt-4 text-lg font-semibold">Aucun graphe juridique trouvé</h2>
                <p className="mt-2 max-w-xl text-sm text-muted-foreground">
                  Lancez le flux de génération de graphe juridique. Les artefacts doivent être écrits sous
                  <span className="font-mono"> data/legal_graph*</span> dans lexia-agent.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
              <aside className="space-y-3">
                <div className="text-sm font-semibold text-muted-foreground">Tous les graphes</div>
                {graphs.map((graph) => {
                  const isSelected = graph.id === selectedGraph?.id;
                  return (
                    <button
                      key={graph.id}
                      type="button"
                      onClick={() => setSelectedGraphId(graph.id)}
                      className={cn(
                        'w-full rounded-xl border p-4 text-left shadow-sm transition-colors',
                        isSelected
                          ? 'border-primary bg-primary/10 text-foreground'
                          : 'border-border bg-card hover:bg-muted/60',
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="line-clamp-1 text-sm font-semibold">{graph.name}</div>
                          <div className="mt-1 line-clamp-1 text-xs text-muted-foreground">{graph.directory}</div>
                        </div>
                        <Badge variant={isSelected ? 'default' : 'secondary'}>{graph.images.length} vues</Badge>
                      </div>
                      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                        <div className="rounded-md bg-background/80 p-2">
                          <div className="text-muted-foreground">Noeuds</div>
                          <div className="font-semibold">{formatNumber(graph.stats.graph_nodes)}</div>
                        </div>
                        <div className="rounded-md bg-background/80 p-2">
                          <div className="text-muted-foreground">Arêtes</div>
                          <div className="font-semibold">{formatNumber(graph.stats.graph_edges)}</div>
                        </div>
                        <div className="rounded-md bg-background/80 p-2">
                          <div className="text-muted-foreground">Docs</div>
                          <div className="font-semibold">{formatNumber(graph.stats.document_count)}</div>
                        </div>
                      </div>
                      <div className="mt-3 text-xs text-muted-foreground">{formatDate(graph.updated_at)}</div>
                    </button>
                  );
                })}
              </aside>

              <section className="min-w-0 space-y-5">
                {selectedGraph && (
                  <>
                    <Card className="shadow-sm">
                      <CardHeader className="gap-3 p-4 lg:flex-row lg:items-start lg:justify-between">
                        <div>
                          <CardTitle className="flex items-center gap-2 text-lg">
                            <Layers className="h-5 w-5 text-primary" />
                            {selectedGraph.name}
                          </CardTitle>
                          <CardDescription className="mt-1">
                            {selectedGraph.directory} - mis à jour {formatDate(selectedGraph.updated_at)}
                          </CardDescription>
                        </div>
                        <Badge
                          variant={selectedGraph.stats.graph_search_status === 'no_reasoning_path' ? 'outline' : 'secondary'}
                          className="w-fit"
                        >
                          {statusLabel(selectedGraph.stats.graph_search_status)}
                        </Badge>
                      </CardHeader>
                      <CardContent className="space-y-4 p-4 pt-0">
                        <div className="flex flex-wrap gap-2">
                          {selectedGraph.images.map((image) => (
                            <Button
                              key={image.filename}
                              type="button"
                              variant={selectedImage?.filename === image.filename ? 'default' : 'outline'}
                              size="sm"
                              onClick={() =>
                                setSelectedImageByGraph((current) => ({
                                  ...current,
                                  [selectedGraph.id]: image.filename,
                                }))
                              }
                            >
                              <ImageIcon className="h-4 w-4" />
                              {image.label}
                            </Button>
                          ))}
                        </div>

                        {selectedImage ? (
                          <div className="rounded-xl border border-border bg-muted/20 p-3">
                            <div className="mb-3 flex flex-col gap-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                              <div>
                                {selectedImage.filename} - {formatBytes(selectedImage.size_bytes)}
                              </div>
                              <a
                                href={legalGraphAssetUrl(selectedImage.url)}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-primary hover:underline"
                              >
                                Ouvrir l'image
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                            </div>
                            <div className="max-h-[72vh] overflow-auto rounded-lg bg-white p-3">
                              <img
                                src={imageSrc}
                                alt={`${selectedGraph.name} - ${selectedImage.label}`}
                                className="mx-auto max-w-full rounded object-contain"
                              />
                            </div>
                          </div>
                        ) : (
                          <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                            Ce graphe n'a pas encore d'image PNG.
                          </div>
                        )}

                        {selectedGraph.stats.graph_search_message && (
                          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
                            {selectedGraph.stats.graph_search_message}
                          </div>
                        )}
                      </CardContent>
                    </Card>

                    <div className="grid gap-5 lg:grid-cols-2">
                      <Card className="shadow-sm">
                        <CardHeader className="p-4 pb-2">
                          <CardTitle className="text-base">Statistiques du graphe</CardTitle>
                          <CardDescription>Collections, couches et types d'arêtes.</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-3 p-4 pt-0">
                          <div className="grid grid-cols-2 gap-2 text-sm">
                            <div className="rounded-lg bg-muted/50 p-3">
                              <div className="text-muted-foreground">Chunks</div>
                              <div className="font-semibold">{formatNumber(selectedGraph.stats.chunk_count)}</div>
                            </div>
                            <div className="rounded-lg bg-muted/50 p-3">
                              <div className="text-muted-foreground">Raisonnement</div>
                              <div className="font-semibold">{formatNumber(selectedGraph.stats.reasoning_edge_count)}</div>
                            </div>
                          </div>
                          <KeyValueList title="Couches" entries={layerEntries} />
                          <KeyValueList title="Types d'arêtes" entries={edgeEntries} />
                        </CardContent>
                      </Card>

                      <Card className="shadow-sm">
                        <CardHeader className="p-4 pb-2">
                          <CardTitle className="text-base">Exports disponibles</CardTitle>
                          <CardDescription>Images, résumé JSON, GraphML et pickle.</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-2 p-4 pt-0">
                          {selectedGraph.files.map((file) => (
                            <div key={file.filename} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/70 p-3">
                              <div className="flex min-w-0 items-center gap-2">
                                {fileIcon(file)}
                                <div className="min-w-0">
                                  <div className="line-clamp-1 text-sm font-medium">{file.filename}</div>
                                  <div className="text-xs text-muted-foreground">
                                    {file.kind} {formatBytes(file.size_bytes) && `- ${formatBytes(file.size_bytes)}`}
                                  </div>
                                </div>
                              </div>
                              <Button asChild variant="outline" size="sm">
                                <a href={legalGraphAssetUrl(file.url)} target="_blank" rel="noreferrer">
                                  <Download className="h-4 w-4" />
                                  Ouvrir
                                </a>
                              </Button>
                            </div>
                          ))}
                        </CardContent>
                      </Card>
                    </div>

                    <div className="grid gap-5 lg:grid-cols-2">
                      <DocumentList
                        title="Documents inclus"
                        documents={selectedDocuments}
                        empty="Aucun document source n'est déclaré dans le résumé."
                      />
                      <DocumentList
                        title="Documents exclus"
                        documents={excludedDocuments}
                        empty="Aucun document exclu n'est déclaré."
                      />
                    </div>
                  </>
                )}
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
