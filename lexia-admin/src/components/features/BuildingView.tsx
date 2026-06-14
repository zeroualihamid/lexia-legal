import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import AgentChatPanel from '@/components/features/AgentChatPanel';
import ResizableChatLayout from '@/components/features/ResizableChatLayout';
import { cn } from '@/lib/utils';

/**
 * Cross-Tower building management sections. Each section shows the live
 * Postgres data (ct_* tables via the brikz-backend REST API, same-origin) and
 * a Claude Code chat (scope "building") whose `building_*` MCP tools write to
 * the same database — the table refreshes after every chat turn.
 */

export type BuildingSectionId =
  | 'tenant_experience'
  | 'badges'
  | 'parking'
  | 'preneurs'
  | 'boh'
  | 'maintenance'
  | 'prestataires';

interface ColumnDef {
  key: string;
  label: string;
}

interface SectionConfig {
  label: string;
  eyebrow: string;
  /** Backend list endpoint (same-origin, proxied to brikz-backend). */
  endpoint: string;
  /** Resource name understood by the agent's building_* tools. */
  resource: string;
  columns: ColumnDef[];
  suggestions: string[];
  chatSubtitle: string;
}

const SECTIONS: Record<BuildingSectionId, SectionConfig> = {
  tenant_experience: {
    label: 'Tenant experience',
    eyebrow: 'Immeuble',
    endpoint: '/api/tenants',
    resource: 'tenants',
    columns: [
      { key: 'name', label: 'Locataire' },
      { key: 'floor', label: 'Étage' },
      { key: 'contactEmail', label: 'Contact' },
      { key: 'employees', label: 'Effectif' },
    ],
    suggestions: [
      'Ajoute un locataire « Acme Conseil » au 12e étage, contact ops@acme.fr, 40 employés.',
      'Quels locataires ont le plus de badges actifs ?',
      'Mets à jour l’email de contact d’un locataire.',
    ],
    chatSubtitle: 'Locataires de l’immeuble — créer, modifier, analyser.',
  },
  badges: {
    label: 'Badges',
    eyebrow: 'Tenant experience',
    endpoint: '/api/badges',
    resource: 'badges',
    columns: [
      { key: 'holder', label: 'Titulaire' },
      { key: 'tenant', label: 'Locataire' },
      { key: 'type', label: 'Type' },
      { key: 'status', label: 'Statut' },
      { key: 'requestedAt', label: 'Demandé le' },
      { key: 'validUntil', label: 'Valide jusqu’au' },
    ],
    suggestions: [
      'Crée un badge permanent pour Marie Dupont chez le premier locataire de la liste.',
      'Liste les badges en attente et active-les.',
      'Combien de badges actifs par locataire ?',
    ],
    chatSubtitle: 'Demandes et statuts de badges d’accès.',
  },
  parking: {
    label: 'Parking visiteurs',
    eyebrow: 'Tenant experience',
    endpoint: '/api/parking/reservations',
    resource: 'parking_reservations',
    columns: [
      { key: 'spotNumber', label: 'Place' },
      { key: 'visitorName', label: 'Visiteur' },
      { key: 'tenant', label: 'Locataire' },
      { key: 'startTime', label: 'Début' },
      { key: 'endTime', label: 'Fin' },
      { key: 'status', label: 'Statut' },
      { key: 'penalty', label: 'Pénalité (€)' },
    ],
    suggestions: [
      'Réserve une place demain 9h–12h pour un visiteur d’un locataire.',
      'Quelles réservations sont en dépassement (overstay) ?',
      'Quelles places avec borne de recharge sont libres maintenant ?',
    ],
    chatSubtitle: 'Réservations et disponibilité du parking visiteurs.',
  },
  preneurs: {
    label: 'Espace preneur',
    eyebrow: 'Tenant experience',
    endpoint: '/api/visitors',
    resource: 'visitors',
    columns: [
      { key: 'name', label: 'Visiteur' },
      { key: 'company', label: 'Société' },
      { key: 'tenant', label: 'Locataire' },
      { key: 'expectedAt', label: 'Attendu le' },
      { key: 'status', label: 'Statut' },
    ],
    suggestions: [
      'Annonce un visiteur pour demain 10h chez un locataire (nom + société).',
      'Fais le check-in du prochain visiteur attendu.',
      'Liste les visiteurs attendus aujourd’hui.',
    ],
    chatSubtitle: 'Visiteurs annoncés par les preneurs — check-in / check-out.',
  },
  boh: {
    label: 'Back of house',
    eyebrow: 'Back of house',
    endpoint: '/api/boh',
    resource: 'boh',
    columns: [
      { key: 'name', label: 'Élément' },
      { key: 'category', label: 'Catégorie' },
      { key: 'location', label: 'Localisation' },
      { key: 'status', label: 'Statut' },
      { key: 'lastServiceAt', label: 'Dernier entretien' },
      { key: 'nextServiceAt', label: 'Prochain entretien' },
    ],
    suggestions: [
      'Ajoute un élément CVC « CTA toiture nord » en toiture, statut opérationnel.',
      'Quels éléments BOH sont en panne ou en maintenance ?',
      'Planifie le prochain entretien de l’ascenseur n°2 le mois prochain.',
    ],
    chatSubtitle: 'Équipements techniques : CVC, ascenseurs, quais, locaux…',
  },
  maintenance: {
    label: 'Maintenance & OT',
    eyebrow: 'Back of house',
    endpoint: '/api/tickets',
    resource: 'tickets',
    columns: [
      { key: 'reference', label: 'Réf' },
      { key: 'title', label: 'Titre' },
      { key: 'tenant', label: 'Locataire' },
      { key: 'category', label: 'Catégorie' },
      { key: 'priority', label: 'Priorité' },
      { key: 'status', label: 'Statut' },
      { key: 'slaStatus', label: 'SLA' },
      { key: 'assignee', label: 'Assigné à' },
    ],
    suggestions: [
      'Crée un ticket priorité haute : fuite d’eau au niveau -1, local technique.',
      'Quels tickets ont un SLA dépassé ? Résume-les.',
      'Passe un ticket ouvert en « in_progress » et assigne-le à un prestataire.',
    ],
    chatSubtitle: 'Tickets et ordres de travail — création, suivi, SLA.',
  },
  prestataires: {
    label: 'Prestataires',
    eyebrow: 'Back of house',
    endpoint: '/api/providers',
    resource: 'providers',
    columns: [
      { key: 'name', label: 'Prestataire' },
      { key: 'service', label: 'Service' },
      { key: 'sla', label: 'SLA (%)' },
      { key: 'status', label: 'Statut' },
    ],
    suggestions: [
      'Ajoute un prestataire « NetPro » pour le nettoyage, SLA 95 %.',
      'Quel est le SLA moyen par service ?',
      'Liste les prestataires actifs et leurs services.',
    ],
    chatSubtitle: 'Prestataires FM : contrats, services et SLA.',
  },
};

const STATUS_TONE: Record<string, string> = {
  active: 'good', confirmed: 'good', operational: 'good', checked_in: 'good', resolved: 'good', closed: 'good', ok: 'good', on_track: 'good',
  pending: 'warn', expected: 'warn', in_progress: 'warn', maintenance: 'warn', at_risk: 'warn', open: 'warn',
  breached: 'bad', overstay: 'bad', down: 'bad', blocked: 'bad', cancelled: 'bad', no_show: 'bad', suspended: 'bad', expired: 'bad',
};

function StatusChip({ value }: { value: string }) {
  const tone = STATUS_TONE[value] || 'neutral';
  return (
    <span
      className={cn(
        'inline-block rounded-full px-2 py-0.5 text-[11px] font-medium',
        tone === 'good' && 'bg-emerald-500/15 text-emerald-500',
        tone === 'warn' && 'bg-amber-500/15 text-amber-500',
        tone === 'bad' && 'bg-red-500/15 text-red-500',
        tone === 'neutral' && 'bg-muted text-muted-foreground',
      )}
    >
      {value.replace(/_/g, ' ')}
    </span>
  );
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T/;

function formatCell(key: string, value: unknown): ReactNode {
  if (value === null || value === undefined || value === '') return <span className="text-muted-foreground">—</span>;
  if (key === 'tenant') {
    const t = value as { name?: string };
    return t?.name || <span className="text-muted-foreground">—</span>;
  }
  if (key === 'status' || key === 'slaStatus') return <StatusChip value={String(value)} />;
  if (typeof value === 'string' && ISO_DATE.test(value)) {
    const d = new Date(value);
    return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  if (typeof value === 'boolean') return value ? 'Oui' : 'Non';
  return String(value);
}

export default function BuildingView({ section }: { section: BuildingSectionId }) {
  const cfg = SECTIONS[section];
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const resp = await fetch(cfg.endpoint, { headers: { Accept: 'application/json' } });
      if (!resp.ok) throw new Error(`${resp.status} ${await resp.text()}`);
      const data = await resp.json();
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [cfg.endpoint]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex h-full w-full overflow-hidden">
      <ResizableChatLayout id={`building-${section}`}>
        <div className="flex h-full min-w-0 flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <div className="min-w-0">
              <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{cfg.eyebrow}</div>
              <div className="truncate text-sm font-semibold">{cfg.label}</div>
            </div>
            <div className="flex flex-shrink-0 items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {loading ? '…' : `${rows.length} enregistrement${rows.length > 1 ? 's' : ''}`}
              </span>
              <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading} title="Rafraîchir">
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          <ScrollArea className="sa-block flex-1">
            <div className="min-w-0 p-3">
              {error && (
                <div className="mb-3 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-500">
                  Erreur de chargement : {error}
                </div>
              )}
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    {cfg.columns.map((c) => (
                      <th key={c.key} className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={String(row.id ?? i)} className="border-b border-border/50 hover:bg-muted/40">
                      {cfg.columns.map((c) => (
                        <td key={c.key} className="px-2 py-1.5 align-top">
                          {formatCell(c.key, row[c.key])}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {!loading && !error && rows.length === 0 && (
                    <tr>
                      <td colSpan={cfg.columns.length} className="px-2 py-8 text-center text-xs text-muted-foreground">
                        Aucune donnée — demandez à l’assistant d’en créer.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </ScrollArea>
        </div>

        <AgentChatPanel
          scope="building"
          historyKey={`building-${section}`}
          title={`Assistant ${cfg.label}`}
          subtitle={cfg.chatSubtitle}
          placeholder="Ex. ajoute, modifie, liste…"
          getContext={() =>
            `Section admin « ${cfg.label} » (${cfg.eyebrow}). Ressource principale des outils building_* : ` +
            `« ${cfg.resource} ». ${rows.length} enregistrements actuellement affichés. ` +
            'Toute création/modification est visible immédiatement dans le tableau de la section.'
          }
          suggestions={cfg.suggestions}
          onTurnEnd={() => void load()}
        />
      </ResizableChatLayout>
    </div>
  );
}
