import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Save, Trash2, RefreshCw, Loader2, Sparkles, Play, Square, Wrench, Eraser, PanelRightClose } from 'lucide-react';
import {
  listSkills,
  getSkill,
  createSkill,
  updateSkill,
  deleteSkill,
  listSkillDtos,
  enhanceSkillStream,
  type SkillSummary,
  type SkillDto,
  type EnhanceEvent,
} from '@/lib/parquet_api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import ResizableChatLayout from '@/components/features/ResizableChatLayout';
import MarkdownRenderer from '@/components/features/chat/MarkdownRenderer';
import { usePersistentState } from '@/hooks/usePersistentState';
import { cn } from '@/lib/utils';

interface EditorState {
  directory_name: string;
  name: string;
  description: string;
  aliases: string;
  content_body: string;
  dto: string;
  isNew: boolean;
}

const EMPTY: EditorState = {
  directory_name: '',
  name: '',
  description: '',
  aliases: '',
  content_body: '',
  dto: '',
  isNew: true,
};

const parseAliases = (raw: string): string[] =>
  raw.split(/[\n,]/).map((a) => a.trim()).filter(Boolean);

export default function SkillsView() {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [dtos, setDtos] = useState<SkillDto[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoadingList(true);
    setError(null);
    try {
      const res = await listSkills();
      setSkills(res.skills || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    listSkillDtos().then((r) => setDtos(r.dtos || [])).catch(() => {});
  }, [refresh]);

  const openSkill = async (dir: string) => {
    setSelected(dir);
    setError(null);
    try {
      const d = await getSkill(dir);
      setEditor({
        directory_name: d.directory_name,
        name: d.name || '',
        description: d.description || '',
        aliases: (d.aliases || []).join('\n'),
        content_body: d.content_body || '',
        dto: d.dto || '',
        isNew: false,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const newSkill = () => {
    setSelected(null);
    setEditor({ ...EMPTY });
  };

  const save = async () => {
    if (!editor) return;
    setSaving(true);
    setError(null);
    try {
      const aliases = parseAliases(editor.aliases);
      if (editor.isNew) {
        if (!editor.directory_name.trim()) throw new Error('directory_name requis');
        await createSkill({
          directory_name: editor.directory_name.trim(),
          name: editor.name,
          description: editor.description,
          content_body: editor.content_body,
          aliases,
          dto: editor.dto,
        });
      } else {
        await updateSkill(editor.directory_name, {
          name: editor.name,
          description: editor.description,
          content_body: editor.content_body,
          aliases,
          dto: editor.dto,
        });
      }
      await refresh();
      await openSkill(editor.directory_name.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!editor || editor.isNew) return;
    if (!window.confirm(`Supprimer le skill « ${editor.directory_name} » ?`)) return;
    setSaving(true);
    setError(null);
    try {
      await deleteSkill(editor.directory_name);
      setEditor(null);
      setSelected(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full w-full">
      {/* List */}
      <div className="flex w-64 flex-shrink-0 flex-col border-r border-border">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-sm font-semibold">Skills ({skills.length})</span>
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" onClick={() => void refresh()} title="Rafraîchir">
              <RefreshCw className={cn('h-4 w-4', loadingList && 'animate-spin')} />
            </Button>
            <Button variant="ghost" size="sm" onClick={newSkill} title="Nouveau skill">
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-2">
            {skills.map((s) => (
              <button
                key={s.directory_name}
                onClick={() => void openSkill(s.directory_name)}
                className={cn(
                  'w-full rounded-md px-3 py-2 text-left text-sm transition-colors',
                  selected === s.directory_name ? 'bg-primary/10 text-primary' : 'hover:bg-muted',
                )}
              >
                <div className="truncate font-medium">{s.name || s.directory_name}</div>
                <div className="truncate text-xs text-muted-foreground">{s.directory_name}</div>
              </button>
            ))}
            {!loadingList && skills.length === 0 && (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">Aucun skill</div>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Editor + Refine (resizable, collapsible) */}
      <ResizableChatLayout id="skills">
        <div className="flex h-full min-w-0 flex-col overflow-hidden">
        {editor ? (
          <>
            <div className="flex items-center justify-between border-b border-border px-4 py-2">
              <span className="truncate text-sm font-semibold">
                {editor.isNew ? 'Nouveau skill' : editor.directory_name}
              </span>
              <div className="flex gap-2">
                {!editor.isNew && (
                  <Button variant="outline" size="sm" onClick={() => void remove()} disabled={saving}>
                    <Trash2 className="mr-1.5 h-4 w-4" /> Supprimer
                  </Button>
                )}
                <Button size="sm" onClick={() => void save()} disabled={saving}>
                  {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
                  Enregistrer
                </Button>
              </div>
            </div>

            {error && (
              <div className="mx-4 mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">
                {error}
              </div>
            )}

            <ScrollArea className="flex-1">
              <div className="space-y-4 p-4">
                {editor.isNew && (
                  <Field label="directory_name (identifiant dossier)">
                    <Input
                      value={editor.directory_name}
                      onChange={(e) => setEditor({ ...editor, directory_name: e.target.value })}
                      placeholder="mon_skill"
                    />
                  </Field>
                )}
                <Field label="Nom">
                  <Input value={editor.name} onChange={(e) => setEditor({ ...editor, name: e.target.value })} />
                </Field>
                <Field label="Classe DTO (source de données liée)">
                  <select
                    value={editor.dto}
                    onChange={(e) => setEditor({ ...editor, dto: e.target.value })}
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="">— Aucune —</option>
                    {dtos.map((d) => (
                      <option key={d.directory_name} value={d.directory_name}>
                        {d.directory_name}
                        {d.slug && d.slug !== d.directory_name ? ` (${d.slug})` : ''}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Description">
                  <Textarea
                    rows={2}
                    value={editor.description}
                    onChange={(e) => setEditor({ ...editor, description: e.target.value })}
                  />
                </Field>
                <Field label="Alias (un par ligne)">
                  <Textarea
                    rows={3}
                    value={editor.aliases}
                    onChange={(e) => setEditor({ ...editor, aliases: e.target.value })}
                  />
                </Field>
                <Field label="Contenu (Markdown)">
                  <Textarea
                    rows={16}
                    className="font-mono text-xs"
                    value={editor.content_body}
                    onChange={(e) => setEditor({ ...editor, content_body: e.target.value })}
                  />
                </Field>
              </div>
            </ScrollArea>
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Sélectionnez un skill ou créez-en un nouveau.
          </div>
        )}
          </div>

        {/* Right-side Claude Code refine panel (resizable, collapsible) */}
        <RefinePanel
          editor={editor}
          onComplete={() => {
            if (editor && !editor.isNew) void openSkill(editor.directory_name);
          }}
        />
      </ResizableChatLayout>
    </div>
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

interface TranscriptItem {
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'tool_result' | 'result' | 'error' | 'info';
  text: string;
  tool?: string;
  isError?: boolean;
}

function RefinePanel({
  editor,
  onComplete,
  onCollapse,
}: {
  editor: EditorState | null;
  onComplete: () => void;
  onCollapse?: () => void;
}) {
  const skillKey = editor?.directory_name ?? '__none__';
  const [items, setItems, clearItems] = usePersistentState<TranscriptItem[]>(
    editor ? `skill-refine:${skillKey}` : null,
    [],
  );
  const [instructions, setInstructions] = useState('');
  const [running, setRunning] = useState(false);
  const abortRef = useRef<null | (() => void)>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // On skill switch: stop any run but KEEP history (persisted per skill, reloaded
  // by usePersistentState). Do not wipe the transcript on navigation.
  useEffect(() => {
    abortRef.current?.();
    setRunning(false);
  }, [skillKey]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [items, running]);

  const push = (it: TranscriptItem) =>
    setItems((prev) => {
      // Coalesce consecutive assistant text deltas into one bubble.
      if (it.kind === 'assistant' && prev.length && prev[prev.length - 1].kind === 'assistant') {
        const copy = prev.slice();
        copy[copy.length - 1] = { ...copy[copy.length - 1], text: copy[copy.length - 1].text + it.text };
        return copy;
      }
      return [...prev, it];
    });

  const handleEvent = (e: EnhanceEvent) => {
    const d = e.data as Record<string, any>;
    switch (e.event) {
      case 'run_started':
        push({ kind: 'info', text: `▶ Analyse de « ${d.skill} » (DTO ${d.dto || '—'}, graphe ${d.graph_id})` });
        break;
      case 'assistant_delta':
        if (d.text) push({ kind: 'assistant', text: String(d.text) });
        break;
      case 'thinking':
        if (d.text) push({ kind: 'thinking', text: String(d.text) });
        break;
      case 'tool_start':
        push({ kind: 'tool', tool: String(d.tool || ''), text: typeof d.input === 'object' ? JSON.stringify(d.input) : String(d.input ?? '') });
        break;
      case 'tool_result':
        push({ kind: 'tool_result', text: String(d.content ?? ''), isError: Boolean(d.is_error) });
        break;
      case 'result':
        push({ kind: 'result', text: String(d.result ?? ''), isError: Boolean(d.is_error) });
        break;
      case 'error':
        push({ kind: 'error', text: `${d.message ?? 'Erreur'}${d.stderr ? `\n${d.stderr}` : ''}` });
        break;
      default:
        break; // claude_system, heartbeat, done
    }
  };

  const run = () => {
    if (!editor || running) return;
    const trimmed = instructions.trim();
    // Keep prior history; mark a new analysis instead of wiping it.
    if (items.length) push({ kind: 'info', text: '──────── nouvelle analyse ────────' });
    // Show what the user asked, exactly like a chat turn. With no explicit
    // instructions the agent does a general enhancement, so surface that intent.
    push({
      kind: 'user',
      text:
        trimmed ||
        `Améliore le skill « ${editor.name || editor.directory_name} »`
          + (editor.dto ? ` à partir de la DTO « ${editor.dto} ».` : '.'),
    });
    setInstructions('');
    setRunning(true);
    abortRef.current = enhanceSkillStream(
      {
        skill_directory_name: editor.directory_name,
        instructions: trimmed,
        dto: editor.dto || undefined,
        max_questions: 5,
      },
      handleEvent,
      (err) => {
        push({ kind: 'error', text: err.message });
        setRunning(false);
      },
      () => {
        setRunning(false);
        abortRef.current = null;
        onComplete();
      },
    );
  };

  const stop = () => {
    abortRef.current?.();
    abortRef.current = null;
    setRunning(false);
    push({ kind: 'info', text: '⏹ Interrompu.' });
  };

  return (
    <div className="flex h-full w-full min-w-0 flex-col border-l border-border bg-card">
      <div className="border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="h-4 w-4 flex-shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate">Claude Code — affiner le skill</span>
          <div className="flex flex-shrink-0 items-center gap-0.5">
            {items.length > 0 && !running && (
              <Button variant="ghost" size="sm" className="h-7 px-1.5" onClick={clearItems} title="Supprimer l'historique">
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
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {editor?.dto
            ? `Décrivez un problème de réponse à corriger (l'agent répare la CTE + le SKILL.md) ou des axes/KPI à ajouter. DTO « ${editor.dto} ».`
            : 'Astuce : liez une classe DTO pour ancrer la correction/refonte sur le schéma réel.'}
        </p>
      </div>

      <ScrollArea className="sa-block flex-1">
        <div ref={scrollRef} className="min-w-0 max-w-full space-y-2 overflow-x-hidden p-3">
          {items.length === 0 && !running && (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">
              {editor
                ? "Décrivez un problème de réponse à corriger, ou un axe/KPI à ajouter, puis lancez. L'agent corrige la CTE fautive ET le SKILL.md."
                : 'Sélectionnez un skill à gauche.'}
            </div>
          )}
          {items.map((it, i) => {
            if (it.kind === 'user')
              return (
                <div key={i} className="ml-5 min-w-0 space-y-1">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-primary/70">Vous</div>
                  <div className="min-w-0 max-w-full break-words rounded-lg border border-primary/30 bg-primary/15 px-3 py-2 text-sm font-medium text-foreground [overflow-wrap:anywhere]">
                    {it.text}
                  </div>
                </div>
              );
            if (it.kind === 'info')
              return <div key={i} className="min-w-0 break-words px-1 text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{it.text}</div>;
            if (it.kind === 'thinking')
              return <div key={i} className="min-w-0 break-words px-1 text-[11px] italic text-muted-foreground/80 [overflow-wrap:anywhere]">{it.text}</div>;
            if (it.kind === 'tool')
              return (
                <div key={i} className="flex min-w-0 items-center gap-1.5 rounded-md bg-primary/5 px-2 py-1 text-[11px] text-primary">
                  <Wrench className="h-3 w-3 flex-shrink-0" />
                  <span className="flex-shrink-0 font-medium">{it.tool}</span>
                  <span className="min-w-0 truncate text-muted-foreground">{it.text}</span>
                </div>
              );
            if (it.kind === 'tool_result')
              return (
                <pre key={i} className={cn('max-h-32 max-w-full overflow-y-auto whitespace-pre-wrap break-words rounded-md px-2 py-1 text-[10px] [overflow-wrap:anywhere]', it.isError ? 'bg-red-500/10 text-red-500' : 'bg-muted text-muted-foreground')}>
                  {it.text}
                </pre>
              );
            return (
              <div key={i} className={cn('min-w-0 max-w-full overflow-hidden break-words rounded-lg px-3 py-2 text-sm', it.kind === 'result' ? (it.isError ? 'bg-red-500/10' : 'bg-primary/10') : it.kind === 'error' ? 'bg-red-500/10 text-red-500' : 'bg-muted')}>
                <MarkdownRenderer content={it.text} />
              </div>
            );
          })}
          {running && (
            <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> l'agent travaille…
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="space-y-2 border-t border-border p-2">
        <Textarea
          rows={2}
          value={instructions}
          disabled={!editor || running}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder={editor ? 'Décrire un problème de réponse à corriger, ou un axe/KPI à ajouter…' : 'Sélectionnez un skill'}
          className="resize-none text-sm"
        />
        {running ? (
          <Button size="sm" variant="outline" className="w-full" onClick={stop}>
            <Square className="mr-1.5 h-4 w-4" /> Arrêter
          </Button>
        ) : (
          <Button size="sm" className="w-full" onClick={run} disabled={!editor}>
            <Play className="mr-1.5 h-4 w-4" /> Lancer l'agent
          </Button>
        )}
      </div>
    </div>
  );
}
