import { useEffect, useMemo, useState } from 'react';
import { FileText, Loader2, RefreshCw, Search, User } from 'lucide-react';
import { listAdminDocuments, type AdminDocument } from '@/lib/documents_api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  processing: { label: 'En traitement', className: 'bg-blue-500/15 text-blue-400' },
  pending_review: { label: 'En attente', className: 'bg-amber-500/15 text-amber-400' },
  published: { label: 'Publié', className: 'bg-emerald-500/15 text-emerald-400' },
  rejected: { label: 'Rejeté', className: 'bg-red-500/15 text-red-400' },
  archived: { label: 'Archivé', className: 'bg-muted text-muted-foreground' },
};

const COLLECTION_LABELS: Record<string, string> = {
  legal_laws: 'Textes législatifs',
  judgments_commercial: 'Jugements commerciaux',
  judgments_civil: 'Jugements civils',
  judgments_admin: 'Jugements administratifs',
  judgments_criminal: 'Jugements pénaux',
  judgments_family: 'Jugements familiaux',
  judgments_social: 'Jugements sociaux',
  judgments_real_estate: 'Jugements immobiliers',
  judgments_constitutional: 'Jugements constitutionnels',
  user_documents: 'Documents utilisateurs',
};

function docTitle(doc: AdminDocument): string {
  return doc.title_fr?.trim() || doc.title_ar?.trim() || 'Sans titre';
}

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('fr-FR', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export default function DocumentsView() {
  const [documents, setDocuments] = useState<AdminDocument[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await listAdminDocuments({ limit: 500 });
      setDocuments(rows);
      if (rows.length && !selectedId) setSelectedId(rows[0].id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Impossible de charger les documents');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return documents;
    return documents.filter((d) => {
      const title = docTitle(d).toLowerCase();
      const uploader = (d.uploaded_by || '').toLowerCase();
      return title.includes(q) || uploader.includes(q) || d.collection.includes(q);
    });
  }, [documents, query]);

  const selected = documents.find((d) => d.id === selectedId) || null;

  return (
    <div className="flex h-full overflow-hidden bg-background">
      {/* Menu latéral — liste des documents */}
      <aside className="flex w-80 min-w-[18rem] flex-shrink-0 flex-col border-r border-border bg-card">
        <div className="border-b border-border p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-foreground">Documents</h2>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => void refresh()} title="Actualiser">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </Button>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Rechercher un document ou un utilisateur…"
              className="pl-8"
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {filtered.length} document{filtered.length !== 1 ? 's' : ''}
          </p>
        </div>

        <ScrollArea className="flex-1">
          {error && (
            <p className="p-3 text-sm text-red-500">{error}</p>
          )}
          {!error && !loading && filtered.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">Aucun document trouvé.</p>
          )}
          <ul className="p-2 space-y-1">
            {filtered.map((doc) => {
              const status = STATUS_LABELS[doc.status] || {
                label: doc.status,
                className: 'bg-muted text-muted-foreground',
              };
              return (
                <li key={doc.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(doc.id)}
                    className={cn(
                      'w-full rounded-lg border px-3 py-2.5 text-left transition-colors',
                      selectedId === doc.id
                        ? 'border-primary/40 bg-primary/10'
                        : 'border-transparent hover:bg-muted/60',
                    )}
                  >
                    <div className="flex items-start gap-2">
                      <FileText className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">{docTitle(doc)}</p>
                        <p className="mt-1 flex items-center gap-1 truncate text-xs text-muted-foreground">
                          <User className="h-3 w-3 flex-shrink-0" />
                          {doc.uploaded_by || '—'}
                        </p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline" className={cn('text-[10px] font-normal', status.className)}>
                            {status.label}
                          </Badge>
                          <span className="text-[10px] text-muted-foreground">{formatDate(doc.created_at)}</span>
                        </div>
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      </aside>

      {/* Détail du document sélectionné */}
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Sélectionnez un document dans la liste.
          </div>
        ) : (
          <div className="flex-1 overflow-auto p-6">
            <div className="mx-auto max-w-3xl space-y-6">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Document sélectionné
                </p>
                <h1 className="mt-1 text-2xl font-semibold text-foreground">{docTitle(selected)}</h1>
                {selected.title_fr && selected.title_ar && (
                  <p className="mt-1 text-sm text-muted-foreground" dir="rtl">
                    {selected.title_ar}
                  </p>
                )}
              </div>

              <dl className="grid gap-4 rounded-xl border border-border bg-card p-4 sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-muted-foreground">Déposé par</dt>
                  <dd className="mt-0.5 text-sm font-medium">{selected.uploaded_by || '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">E-mail</dt>
                  <dd className="mt-0.5 text-sm font-medium">{selected.uploaded_by_email || '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Collection</dt>
                  <dd className="mt-0.5 text-sm font-medium">
                    {COLLECTION_LABELS[selected.collection] || selected.collection}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Statut</dt>
                  <dd className="mt-0.5 text-sm font-medium">
                    {STATUS_LABELS[selected.status]?.label || selected.status}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Visibilité</dt>
                  <dd className="mt-0.5 text-sm font-medium">{selected.visibility}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Date de dépôt</dt>
                  <dd className="mt-0.5 text-sm font-medium">{formatDate(selected.created_at)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Pages</dt>
                  <dd className="mt-0.5 text-sm font-medium">{selected.page_count ?? '—'}</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-xs text-muted-foreground">Identifiant</dt>
                  <dd className="mt-0.5 break-all font-mono text-xs text-muted-foreground">{selected.id}</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-xs text-muted-foreground">Fichier</dt>
                  <dd className="mt-0.5 break-all font-mono text-xs text-muted-foreground">
                    {selected.minio_bucket}/{selected.minio_key}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
