import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Loader2, Gavel, Square, Wrench, Database, Trash2, Check, X, Sparkles, Zap, ShieldCheck, Eraser, PanelRightClose } from 'lucide-react';
import {
  listConversations,
  getConversation,
  deleteConversation,
  deleteAllConversations,
  judgeConversationStream,
  applyCte,
  type ConversationSummary,
  type ConversationDetail,
  type EnhanceEvent,
} from '@/lib/parquet_api';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import ResizableChatLayout from '@/components/features/ResizableChatLayout';
import MarkdownRenderer from '@/components/features/chat/MarkdownRenderer';
import { usePersistentState } from '@/hooks/usePersistentState';
import { cn } from '@/lib/utils';

interface CteExec {
  id: string;
  cteName: string;
  params?: Record<string, unknown>;
  status: 'running' | 'done' | 'error';
  columns?: string[];
  rows?: Record<string, unknown>[];
  rowCount?: number | null;
  sql?: string;
  error?: string;
  raw?: string;
}

export default function ConversationsView() {
  const [convos, setConvos] = useState<ConversationSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live CTE executions performed by the agent during a run, surfaced in the
  // main window for understanding/debugging (paired tool_start → tool_result).
  const [cteExecs, setCteExecs] = useState<CteExec[]>([]);
  const pendingRef = useRef<{ tool: string; id?: string }[]>([]);
  const execSeqRef = useRef(0);

  const handleJudgeEvent = (e: EnhanceEvent) => {
    const d = e.data as Record<string, any>;
    if (e.event === 'run_started') { setCteExecs([]); pendingRef.current = []; return; }
    if (e.event === 'tool_start') {
      const tool = String(d.tool || '');
      let id: string | undefined;
      if (/execute_cte$/.test(tool)) {
        const execId = `x${execSeqRef.current++}`;
        id = execId;
        const input = (d.input || {}) as Record<string, any>;
        const cteName = String(input.cte_name || '').trim() || (input.sql ? 'SQL ad-hoc' : '(cte)');
        setCteExecs((prev) => [...prev, { id: execId, cteName, params: input.parameters, status: 'running' }]);
      }
      pendingRef.current.push({ tool, id });
      return;
    }
    if (e.event === 'tool_result') {
      const pend = pendingRef.current.shift();
      if (!pend?.id) return;
      const content = String(d.content ?? '');
      let parsed: any = null;
      try { parsed = JSON.parse(content); } catch { /* not JSON */ }
      setCteExecs((prev) => prev.map((x) => x.id === pend.id ? {
        ...x,
        status: (d.is_error || parsed?.error) ? 'error' : 'done',
        columns: parsed?.columns,
        rows: parsed?.rows,
        rowCount: parsed?.row_count,
        sql: parsed?.sql,
        error: parsed?.error || (d.is_error ? content.slice(0, 400) : undefined),
        raw: content,
      } : x));
    }
  };

  const refresh = async () => {
    setLoadingList(true);
    setError(null);
    try {
      const r = await listConversations(200);
      setConvos(r.conversations || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingList(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const open = async (sid: string) => {
    setSelected(sid);
    setDetail(null);
    setCteExecs([]); pendingRef.current = [];
    setLoadingDetail(true);
    try {
      setDetail(await getConversation(sid));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingDetail(false);
    }
  };

  const removeOne = async (sid: string) => {
    if (!window.confirm(`Supprimer la conversation « ${sid} » ?`)) return;
    try {
      await deleteConversation(sid);
      if (selected === sid) {
        setSelected(null);
        setDetail(null);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const removeAll = async () => {
    if (!window.confirm(`Supprimer TOUTES les ${convos.length} conversations ? Action irréversible.`)) return;
    try {
      await deleteAllConversations();
      setSelected(null);
      setDetail(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex h-full w-full">
      {/* Conversation list */}
      <div className="flex w-72 flex-shrink-0 flex-col border-r border-border">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-sm font-semibold">Conversations ({convos.length})</span>
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" onClick={() => void refresh()} title="Rafraîchir">
              <RefreshCw className={cn('h-4 w-4', loadingList && 'animate-spin')} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void removeAll()}
              disabled={convos.length === 0}
              title="Tout supprimer"
              className="text-red-500 hover:text-red-600"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-2">
            {convos.map((c) => (
              <div
                key={c.session_id}
                onClick={() => void open(c.session_id)}
                className={cn(
                  'group relative cursor-pointer rounded-md px-3 py-2 transition-colors',
                  selected === c.session_id ? 'bg-primary/10' : 'hover:bg-muted',
                )}
              >
                <div className="truncate pr-6 text-sm font-medium">{c.last_query || c.session_id}</div>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <CteModeBadge mode={c.cte_mode} />
                  {(c.cte_names?.length ?? 0) > 0 && (
                    <span className="inline-flex items-center gap-1">
                      <Database className="h-3 w-3" />{c.cte_names!.length}
                    </span>
                  )}
                  <span className="ml-auto flex-shrink-0">{formatConvTime(c.updated_at)}</span>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); void removeOne(c.session_id); }}
                  title="Supprimer"
                  className="absolute right-1.5 top-1.5 rounded p-1 text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:bg-red-500/10 hover:text-red-500"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            {!loadingList && convos.length === 0 && (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">Aucune conversation</div>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Turns + judge (resizable) */}
      <ResizableChatLayout id="conversations">
        <div className="flex h-full min-w-0 flex-col overflow-hidden">
        <div className="border-b border-border px-4 py-2 text-sm font-semibold">
          {selected ? `Tours — ${selected}` : 'Sélectionnez une conversation'}
        </div>
        {error && (
          <div className="mx-4 mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">{error}</div>
        )}
        <ScrollArea className="flex-1">
          <div className="space-y-4 p-4">
            {loadingDetail && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> chargement…
              </div>
            )}

            {/* Live CTE executions by the agent (test findings) */}
            {cteExecs.length > 0 && (
              <div className="rounded-lg border border-sky-500/30 bg-sky-500/5">
                <div className="flex items-center gap-2 border-b border-sky-500/20 px-3 py-2 text-sm font-semibold text-sky-700">
                  <Sparkles className="h-4 w-4" /> Tests CTE de l'agent
                  <span className="ml-auto text-[11px] font-normal text-muted-foreground">{cteExecs.length} exécution(s)</span>
                </div>
                <div className="space-y-3 p-3">
                  {cteExecs.map((x) => <CteExecCard key={x.id} x={x} />)}
                </div>
              </div>
            )}

            {detail?.turns.map((t, i) => (
              <div key={i} className="rounded-lg border border-border">
                <div className="flex items-start gap-2 rounded-t-lg bg-primary/10 px-3 py-2 text-sm font-medium">
                  <span className="mt-0.5 text-xs text-muted-foreground">Q{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    {t.query || <span className="italic text-muted-foreground">(sans question)</span>}
                  </span>
                  <CteModeBadge mode={t.cte_mode} />
                </div>
                <div className="space-y-2 p-3">
                  {t.ctes.length === 0 && (
                    <div className="text-xs italic text-muted-foreground">Aucune CTE pour ce tour.</div>
                  )}
                  {t.ctes.map((c, j) => (
                    <div key={j}>
                      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-primary">
                        <Database className="h-3 w-3" /> {c.label?.split('\n')[0]?.slice(0, 60) || `CTE ${j + 1}`}
                      </div>
                      <pre className="max-h-40 overflow-auto rounded-md bg-muted px-2 py-1.5 text-[10px] leading-snug">{c.sql}</pre>
                      {t.results[j] && (
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          {t.results[j].error
                            ? <span className="text-red-500">erreur : {t.results[j].error}</span>
                            : <>→ {t.results[j].row_count ?? '?'} ligne(s) · colonnes : {(t.results[j].columns || []).join(', ') || '—'}</>}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {detail && detail.turns.length === 0 && (
              <div className="text-sm text-muted-foreground">Conversation vide.</div>
            )}
          </div>
        </ScrollArea>
      </div>

        {/* Judge panel */}
        <JudgePanel sessionId={selected} onStreamEvent={handleJudgeEvent} />
      </ResizableChatLayout>
    </div>
  );
}

const VERDICT_RE = /\bVERDICT\s*:?\s*(BONNE|A_AMELIORER|À_AMÉLIORER|MAUVAISE)/gi;
const PROPOSAL_RE = /```cte-proposal\s*([\s\S]*?)```/gi;

interface JItem { kind: 'assistant' | 'thinking' | 'tool' | 'tool_result' | 'result' | 'error' | 'info'; text: string; tool?: string; isError?: boolean }
interface CteProposal {
  action?: string; name: string; replaces?: string; description?: string;
  parameters?: string[]; depends_on?: string[]; sql: string;
}
type ApplyStatus = { state: 'idle' | 'applying' | 'applied' | 'rejected' | 'error'; message?: string };

/** Extract `cte-proposal` JSON blocks from the streamed text. */
function extractProposals(text: string): CteProposal[] {
  const out: CteProposal[] = [];
  for (const m of text.matchAll(PROPOSAL_RE)) {
    try {
      const obj = JSON.parse(m[1].trim());
      if (obj && obj.name && obj.sql) out.push(obj as CteProposal);
    } catch { /* incomplete block while streaming — skip */ }
  }
  return out;
}
const stripProposals = (text: string) =>
  text.replace(PROPOSAL_RE, '\n_📋 proposition de CTE ci-dessous_\n');

function JudgePanel({ sessionId, onStreamEvent, onCollapse }: { sessionId: string | null; onStreamEvent?: (e: EnhanceEvent) => void; onCollapse?: () => void }) {
  // Per-conversation history, persisted until explicitly deleted.
  const [items, setItems, clearItems] = usePersistentState<JItem[]>(sessionId ? `judge:${sessionId}` : null, []);
  const [applyStatus, setApplyStatus, clearApply] = usePersistentState<Record<string, ApplyStatus>>(sessionId ? `judge-apply:${sessionId}` : null, {});
  const [graphId, setGraphId, clearGraph] = usePersistentState<string>(sessionId ? `judge-graph:${sessionId}` : null, '');
  const [instructions, setInstructions] = useState('');
  const [running, setRunning] = useState(false);
  const [approvalMode, setApprovalMode] = useState<'auto' | 'manual'>('manual');
  const abortRef = useRef<null | (() => void)>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const clearHistory = () => { clearItems(); clearApply(); clearGraph(); };

  // On conversation switch: stop any run but KEEP history (persisted per session).
  useEffect(() => {
    abortRef.current?.();
    setRunning(false);
  }, [sessionId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [items, running]);

  // Tally verdicts + collect proposals from the full streamed text.
  const fullText = useMemo(
    () => items.filter((it) => it.kind === 'assistant' || it.kind === 'result').map((it) => it.text).join('\n'),
    [items],
  );
  const tally = { BONNE: 0, A_AMELIORER: 0, MAUVAISE: 0 };
  for (const m of fullText.matchAll(VERDICT_RE)) {
    const v = m[1].toUpperCase().replace('À_AMÉLIORER', 'A_AMELIORER');
    if (v.startsWith('BONNE')) tally.BONNE++;
    else if (v.startsWith('MAUVAISE')) tally.MAUVAISE++;
    else tally.A_AMELIORER++;
  }
  const proposals = useMemo(() => extractProposals(fullText), [fullText]);

  const push = (it: JItem) =>
    setItems((prev) => {
      if (it.kind === 'assistant' && prev.length && prev[prev.length - 1].kind === 'assistant') {
        const copy = prev.slice();
        copy[copy.length - 1] = { ...copy[copy.length - 1], text: copy[copy.length - 1].text + it.text };
        return copy;
      }
      return [...prev, it];
    });

  const onEvent = (e: EnhanceEvent) => {
    onStreamEvent?.(e); // mirror tool executions to the main window (CTE findings)
    const d = e.data as Record<string, any>;
    switch (e.event) {
      case 'run_started':
        if (d.graph_id) setGraphId(String(d.graph_id));
        push({ kind: 'info', text: `⚙️ Analyse de « ${d.session_id || 'dernière conversation'} »${d.graph_id ? ` · graphe ${d.graph_id}` : ''} · approbation ${d.approval_mode === 'auto' ? 'automatique' : 'manuelle'}` });
        break;
      case 'assistant_delta': if (d.text) push({ kind: 'assistant', text: String(d.text) }); break;
      case 'thinking': if (d.text) push({ kind: 'thinking', text: String(d.text) }); break;
      case 'tool_start': push({ kind: 'tool', tool: String(d.tool || ''), text: typeof d.input === 'object' ? JSON.stringify(d.input) : String(d.input ?? '') }); break;
      case 'tool_result': push({ kind: 'tool_result', text: String(d.content ?? ''), isError: Boolean(d.is_error) }); break;
      case 'result': push({ kind: 'result', text: String(d.result ?? ''), isError: Boolean(d.is_error) }); break;
      case 'error': push({ kind: 'error', text: `${d.message ?? 'Erreur'}${d.stderr ? `\n${d.stderr}` : ''}` }); break;
      default: break;
    }
  };

  const run = () => {
    if (!sessionId || running) return;
    // Keep prior history; mark a new analysis instead of wiping it.
    if (items.length) push({ kind: 'info', text: '──────── nouvelle analyse ────────' });
    setRunning(true);
    abortRef.current = judgeConversationStream(
      { session_id: sessionId, instructions: instructions.trim(), approval_mode: approvalMode },
      onEvent,
      (err) => { push({ kind: 'error', text: err.message }); setRunning(false); },
      () => { setRunning(false); abortRef.current = null; },
    );
  };

  const stop = () => { abortRef.current?.(); abortRef.current = null; setRunning(false); push({ kind: 'info', text: '⏹ Interrompu.' }); };

  const approve = async (p: CteProposal) => {
    setApplyStatus((s) => ({ ...s, [p.name]: { state: 'applying' } }));
    try {
      const res = await applyCte({
        name: p.name, sql: p.sql, description: p.description,
        parameters: p.parameters, depends_on: p.depends_on, graph_id: graphId,
      });
      setApplyStatus((s) => ({ ...s, [p.name]: { state: 'applied', message: `${res.replaced ? 'Remplacée' : 'Créée'} dans ${res.graph_id}` } }));
    } catch (err) {
      setApplyStatus((s) => ({ ...s, [p.name]: { state: 'error', message: err instanceof Error ? err.message : String(err) } }));
    }
  };
  const reject = (p: CteProposal) => setApplyStatus((s) => ({ ...s, [p.name]: { state: 'rejected' } }));

  return (
    <div className="flex h-full w-full min-w-0 flex-col border-l border-border bg-card">
      <div className="border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Gavel className="h-4 w-4 flex-shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate">Analyse &amp; amélioration des CTE</span>
          <div className="flex flex-shrink-0 items-center gap-0.5">
            {items.length > 0 && !running && (
              <Button variant="ghost" size="sm" className="h-7 px-1.5" onClick={clearHistory} title="Supprimer l'historique">
                <Eraser className="h-4 w-4" />
              </Button>
            )}
            {onCollapse && (
              <Button variant="ghost" size="sm" className="h-7 px-1.5" onClick={onCollapse} title="Réduire l'assistant">
                <PanelRightClose className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-[11px]">
          <Badge tone="good">✅ {tally.BONNE}</Badge>
          <Badge tone="warn">⚠️ {tally.A_AMELIORER}</Badge>
          <Badge tone="bad">❌ {tally.MAUVAISE}</Badge>
          {proposals.length > 0 && <span className="rounded bg-sky-500/15 px-1.5 py-0.5 font-medium text-sky-600">{proposals.length} propos.</span>}
          {graphId && <span className="ml-auto truncate text-muted-foreground" title={graphId}>graphe: {graphId}</span>}
        </div>
        {/* Approval mode toggle */}
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Approbation</span>
          <div className="flex flex-1 gap-1 rounded-md border border-border p-0.5">
            <button
              onClick={() => setApprovalMode('manual')}
              disabled={running}
              className={cn('flex flex-1 items-center justify-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50',
                approvalMode === 'manual' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted')}
            >
              <ShieldCheck className="h-3 w-3" /> Manuelle
            </button>
            <button
              onClick={() => setApprovalMode('auto')}
              disabled={running}
              className={cn('flex flex-1 items-center justify-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50',
                approvalMode === 'auto' ? 'bg-amber-500/15 text-amber-600' : 'text-muted-foreground hover:bg-muted')}
            >
              <Zap className="h-3 w-3" /> Automatique
            </button>
          </div>
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground">
          {approvalMode === 'auto'
            ? "L'agent applique directement les CTE améliorées (paramétrées)."
            : "L'agent propose des CTE améliorées ; vous approuvez chaque changement."}
        </p>
      </div>

      <ScrollArea className="sa-block flex-1">
        <div ref={scrollRef} className="min-w-0 max-w-full space-y-2 overflow-x-hidden p-3">
          {items.length === 0 && !running && (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">
              {sessionId ? "Lancez l'analyse : l'agent lit la conversation, juge chaque CTE et propose/applique des versions paramétrées." : 'Aucune conversation sélectionnée.'}
            </div>
          )}
          {items.map((it, i) => {
            if (it.kind === 'info') return <div key={i} className="break-words px-1 text-[11px] text-muted-foreground">{it.text}</div>;
            if (it.kind === 'thinking') return <div key={i} className="break-words px-1 text-[11px] italic text-muted-foreground/80">{it.text}</div>;
            if (it.kind === 'tool')
              return (
                <div key={i} className="flex min-w-0 items-center gap-1.5 rounded-md bg-primary/5 px-2 py-1 text-[11px] text-primary">
                  <Wrench className="h-3 w-3 flex-shrink-0" /><span className="flex-shrink-0 font-medium">{it.tool}</span>
                  <span className="min-w-0 truncate text-muted-foreground">{it.text}</span>
                </div>
              );
            if (it.kind === 'tool_result')
              return <pre key={i} className={cn('max-h-32 max-w-full overflow-y-auto whitespace-pre-wrap break-words rounded-md px-2 py-1 text-[10px] [overflow-wrap:anywhere]', it.isError ? 'bg-red-500/10 text-red-500' : 'bg-muted text-muted-foreground')}>{it.text}</pre>;
            return (
              <div key={i} className={cn('min-w-0 max-w-full overflow-hidden break-words rounded-lg px-3 py-2 text-sm', it.kind === 'result' ? (it.isError ? 'bg-red-500/10' : 'bg-primary/10') : it.kind === 'error' ? 'bg-red-500/10 text-red-500' : 'bg-muted')}>
                <MarkdownRenderer content={stripProposals(it.text)} />
              </div>
            );
          })}

          {/* CTE proposal cards (manual approval) */}
          {approvalMode === 'manual' && proposals.map((p, i) => (
            <ProposalCard key={`${p.name}-${i}`} p={p} status={applyStatus[p.name]} onApprove={() => approve(p)} onReject={() => reject(p)} />
          ))}

          {running && (
            <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> l'agent analyse…
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="space-y-2 border-t border-border p-2">
        <Textarea
          rows={2}
          value={instructions}
          disabled={!sessionId || running}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setInstructions(e.target.value)}
          placeholder={sessionId ? 'Consigne optionnelle (ex. « paramètre la CTE par année et catégorie »)…' : 'Sélectionnez une conversation'}
          className="resize-none text-sm"
        />
        {running ? (
          <Button size="sm" variant="outline" className="w-full" onClick={stop}>
            <Square className="mr-1.5 h-4 w-4" /> Arrêter
          </Button>
        ) : (
          <Button size="sm" className="w-full" onClick={run} disabled={!sessionId}>
            <Sparkles className="mr-1.5 h-4 w-4" /> Analyser &amp; améliorer
          </Button>
        )}
      </div>
    </div>
  );
}

function ProposalCard({ p, status, onApprove, onReject }: { p: CteProposal; status?: ApplyStatus; onApprove: () => void; onReject: () => void }) {
  const [open, setOpen] = useState(false);
  const st = status?.state ?? 'idle';
  return (
    <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-2.5 text-xs">
      <div className="flex items-center gap-1.5">
        <Sparkles className="h-3.5 w-3.5 text-sky-600" />
        <span className="font-semibold text-sky-700">{p.action === 'create' ? 'Nouvelle CTE' : 'Remplacer'}</span>
        <code className="truncate font-mono text-[11px] text-foreground">{p.name}</code>
      </div>
      {p.replaces && <div className="mt-0.5 text-[10px] text-muted-foreground">remplace <code className="font-mono">{p.replaces}</code></div>}
      {p.description && <div className="mt-1 text-muted-foreground">{p.description}</div>}
      {(p.parameters?.length ?? 0) > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {p.parameters!.map((par) => <span key={par} className="rounded bg-sky-500/15 px-1.5 py-0.5 font-mono text-[10px] text-sky-700">${par}</span>)}
        </div>
      )}
      <button onClick={() => setOpen((v) => !v)} className="mt-1 text-[10px] text-sky-600 hover:underline">{open ? 'Masquer le SQL' : 'Voir le SQL'}</button>
      {open && <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted px-2 py-1 text-[10px] text-muted-foreground">{p.sql}</pre>}

      <div className="mt-2 flex items-center gap-2">
        {st === 'applied' ? (
          <span className="flex items-center gap-1 text-[11px] font-medium text-emerald-600"><Check className="h-3.5 w-3.5" /> {status?.message || 'Appliquée'}</span>
        ) : st === 'rejected' ? (
          <span className="text-[11px] text-muted-foreground">Rejetée</span>
        ) : (
          <>
            <Button size="sm" className="h-7 px-2.5 text-[11px]" onClick={onApprove} disabled={st === 'applying'}>
              {st === 'applying' ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Check className="mr-1 h-3 w-3" />} Approuver
            </Button>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={onReject} disabled={st === 'applying'}>
              <X className="mr-1 h-3 w-3" /> Rejeter
            </Button>
            {st === 'error' && <span className="truncate text-[10px] text-red-500" title={status?.message}>{status?.message}</span>}
          </>
        )}
      </div>
    </div>
  );
}

function CteExecCard({ x }: { x: CteExec }) {
  const [showSql, setShowSql] = useState(false);
  const cols = x.columns || [];
  const rows = (x.rows || []).slice(0, 8);
  const paramEntries = Object.entries(x.params || {});
  return (
    <div className="rounded-md border border-border bg-background">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-2.5 py-1.5 text-[11px]">
        {x.status === 'running' ? <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-600" />
          : x.status === 'error' ? <X className="h-3.5 w-3.5 text-red-500" />
          : <Check className="h-3.5 w-3.5 text-emerald-600" />}
        <Database className="h-3 w-3 text-primary" />
        <code className="font-mono font-medium text-foreground">{x.cteName}</code>
        {paramEntries.map(([k, v]) => (
          <span key={k} className="rounded bg-sky-500/15 px-1.5 py-0.5 font-mono text-[10px] text-sky-700">${k}={String(v)}</span>
        ))}
        {x.status !== 'running' && x.rowCount != null && (
          <span className="ml-auto text-muted-foreground">{x.rowCount} ligne(s)</span>
        )}
      </div>
      <div className="p-2">
        {x.status === 'running' ? (
          <div className="text-[11px] text-muted-foreground">exécution…</div>
        ) : x.error ? (
          <div className="rounded bg-red-500/10 px-2 py-1 text-[11px] text-red-500">{x.error}</div>
        ) : cols.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[10px]">
              <thead className="bg-muted">
                <tr>{cols.map((c) => <th key={c} className="whitespace-nowrap px-2 py-1 font-semibold">{c}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r, ri) => (
                  <tr key={ri} className="border-t border-border">
                    {cols.map((c) => (
                      <td key={c} className="max-w-[14rem] truncate whitespace-nowrap px-2 py-0.5 text-muted-foreground">
                        {r[c] === null || r[c] === undefined ? '' : typeof r[c] === 'object' ? JSON.stringify(r[c]) : String(r[c])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {(x.rows?.length ?? 0) > rows.length && (
              <div className="px-2 pt-1 text-[10px] text-muted-foreground">… +{(x.rows!.length - rows.length)} ligne(s)</div>
            )}
          </div>
        ) : (
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-[10px] text-muted-foreground">{x.raw}</pre>
        )}
        {x.sql && (
          <>
            <button onClick={() => setShowSql((v) => !v)} className="mt-1 text-[10px] text-sky-600 hover:underline">
              {showSql ? 'Masquer le SQL' : 'Voir le SQL exécuté'}
            </button>
            {showSql && <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted px-2 py-1 text-[10px] text-muted-foreground">{x.sql}</pre>}
          </>
        )}
      </div>
    </div>
  );
}

function formatConvTime(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = Date.now();
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay
    ? d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function CteModeBadge({ mode }: { mode?: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    reused: { label: '♻️ CTE réutilisée', cls: 'bg-emerald-500/15 text-emerald-600' },
    generated: { label: '✨ CTE générée', cls: 'bg-sky-500/15 text-sky-600' },
    ran: { label: '🧪 SQL ad-hoc', cls: 'bg-amber-500/15 text-amber-600' },
    none: { label: '— sans CTE', cls: 'bg-muted text-muted-foreground' },
  };
  const m = map[mode || 'none'] || map.none;
  return <span className={cn('flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium', m.cls)}>{m.label}</span>;
}

function Badge({ tone, children }: { tone: 'good' | 'warn' | 'bad'; children: React.ReactNode }) {
  const cls = {
    good: 'bg-emerald-500/15 text-emerald-600',
    warn: 'bg-amber-500/15 text-amber-600',
    bad: 'bg-red-500/15 text-red-600',
  }[tone];
  return <span className={cn('rounded px-1.5 py-0.5 font-medium', cls)}>{children}</span>;
}
