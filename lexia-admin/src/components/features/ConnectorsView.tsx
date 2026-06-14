import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Loader2, Save, Plug, CheckCircle2, XCircle } from 'lucide-react';
import {
  listConnectorProviders,
  getConnectorSettings,
  saveConnectorSettings,
  type ConnectorProvider,
  type ConnectorSettingsResponse,
} from '@/lib/parquet_api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import AgentChatPanel from '@/components/features/AgentChatPanel';
import ResizableChatLayout from '@/components/features/ResizableChatLayout';
import { cn } from '@/lib/utils';

export default function ConnectorsView() {
  const [providers, setProviders] = useState<ConnectorProvider[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [settings, setSettings] = useState<ConnectorSettingsResponse | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [sourceId, setSourceId] = useState('');
  const [description, setDescription] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoadingList(true);
    setError(null);
    try {
      const res = await listConnectorProviders();
      setProviders(res || []);
      if (res?.length && !active) void open(res[0].id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingList(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = async (providerId: string) => {
    setActive(providerId);
    setLoadingDetail(true);
    setError(null);
    setSavedMsg(null);
    try {
      const s = await getConnectorSettings(providerId);
      setSettings(s);
      setForm({ ...s.values });
      setSourceId(s.source_id || '');
      setEnabled(s.enabled);
      setDescription('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingDetail(false);
    }
  };

  const provider = providers.find((p) => p.id === active) || null;

  const save = async () => {
    if (!active) return;
    setSaving(true);
    setError(null);
    setSavedMsg(null);
    try {
      await saveConnectorSettings(active, {
        values: form,
        enabled,
        source_id: sourceId.trim() || undefined,
        description: description.trim() || undefined,
      });
      setSavedMsg('Configuration enregistrée.');
      await open(active);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full w-full">
      {/* Provider list */}
      <div className="flex w-60 flex-shrink-0 flex-col border-r border-border">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-sm font-semibold">Connecteurs ({providers.length})</span>
          <Button variant="ghost" size="sm" onClick={() => void refresh()} title="Rafraîchir">
            <RefreshCw className={cn('h-4 w-4', loadingList && 'animate-spin')} />
          </Button>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-2">
            {providers.map((p) => (
              <button
                key={p.id}
                onClick={() => void open(p.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors',
                  active === p.id ? 'bg-primary/10 text-primary' : 'hover:bg-muted',
                )}
              >
                <Plug className="h-3.5 w-3.5 flex-shrink-0 opacity-60" />
                <span className="min-w-0">
                  <span className="block truncate font-medium">{p.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">{p.source_type}</span>
                </span>
              </button>
            ))}
            {!loadingList && providers.length === 0 && (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">Aucun connecteur</div>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Settings form + assistant (resizable) */}
      <ResizableChatLayout id="connectors">
        <div className="flex h-full min-w-0 flex-col overflow-hidden">
        {provider ? (
          <>
            <div className="flex items-center justify-between border-b border-border px-4 py-2">
              <span className="truncate text-sm font-semibold">{provider.label}</span>
              <Button size="sm" onClick={() => void save()} disabled={saving || loadingDetail}>
                {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
                Enregistrer
              </Button>
            </div>

            {error && (
              <div className="mx-4 mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">
                {error}
              </div>
            )}
            {savedMsg && (
              <div className="mx-4 mt-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-500">
                {savedMsg}
              </div>
            )}

            <ScrollArea className="flex-1">
              <div className="space-y-4 p-4">
                {/* State inspector */}
                {settings && (
                  <div className="flex flex-wrap gap-2 text-[11px]">
                    <StateChip ok={settings.configured} label="Configuré" />
                    <StateChip ok={settings.source_exists} label="Source existe" />
                    <StateChip ok={settings.registered} label="Enregistré" />
                    <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                      {settings.tables_count} table(s)
                    </span>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  {provider.fields.map((f) => (
                    <Field key={f.key} label={f.label}>
                      <Input
                        type={f.secret ? 'password' : 'text'}
                        value={form[f.key] ?? ''}
                        placeholder={f.default}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [f.key]: e.target.value })}
                        autoComplete="off"
                      />
                    </Field>
                  ))}
                </div>

                <div className="grid grid-cols-2 gap-3 border-t border-border pt-3">
                  <Field label="Source ID">
                    <Input
                      value={sourceId}
                      placeholder={provider.default_source_id}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSourceId(e.target.value)}
                    />
                  </Field>
                  <Field label="Description (optionnel)">
                    <Input value={description} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDescription(e.target.value)} />
                  </Field>
                </div>

                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input type="checkbox" checked={enabled} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEnabled(e.target.checked)} />
                  Activé (inclus dans les chargeurs)
                </label>
              </div>
            </ScrollArea>
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Sélectionnez un connecteur à gauche.
          </div>
        )}
      </div>

      {/* Right-side assistant */}
      <AgentChatPanel
        scope="connectors"
        title="Assistant Connecteurs"
        subtitle="Configurer et diagnostiquer les connexions."
        placeholder={provider ? `Question sur ${provider.label}…` : 'Question sur les connecteurs…'}
        getContext={() =>
          provider
            ? `Connecteur : ${provider.label} (type ${provider.source_type}, source_id ${sourceId || provider.default_source_id})\n` +
              (settings ? `État : configuré=${settings.configured}, source_exists=${settings.source_exists}, registered=${settings.registered}, tables=${settings.tables_count}` : '')
            : ''
        }
        suggestions={[
          'Que signifie « source existe » mais « non enregistré » ?',
          'Quels champs sont requis pour ce connecteur ?',
          'Pourquoi ma source ne se rafraîchit-elle pas ?',
        ]}
      />
      </ResizableChatLayout>
    </div>
  );
}

function StateChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={cn(
        'flex items-center gap-1 rounded-full px-2 py-0.5',
        ok ? 'bg-emerald-500/10 text-emerald-500' : 'bg-muted text-muted-foreground',
      )}
    >
      {ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
      {label}
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}
