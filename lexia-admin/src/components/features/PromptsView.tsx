import { useCallback, useEffect, useMemo, useState } from 'react';
import { Save, RefreshCw, Loader2, Sparkles, FileText } from 'lucide-react';
import {
  listPromptTemplates,
  getPromptTemplate,
  updatePromptTemplate,
  improvePromptTemplate,
  type PromptTemplate,
} from '@/lib/parquet_api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import AgentChatPanel from '@/components/features/AgentChatPanel';
import ResizableChatLayout from '@/components/features/ResizableChatLayout';
import { cn } from '@/lib/utils';

interface EditorState {
  category: string;
  name: string;
  content: string;
  original: string;
}

const QUICK_IMPROVE = [
  'Rends-le plus concis',
  'Ajoute des exemples',
  'Clarifie les instructions',
  'Renforce le format de sortie',
];

export default function PromptsView() {
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [category, setCategory] = useState<string>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [improving, setImproving] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoadingList(true);
    setError(null);
    try {
      const res = await listPromptTemplates();
      setTemplates(res.templates || []);
      setCategories(res.categories || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(
    () => (category === 'all' ? templates : templates.filter((t) => t.category === category)),
    [templates, category],
  );

  const open = async (t: PromptTemplate) => {
    const key = `${t.category}/${t.name}`;
    setSelected(key);
    setLoadingDetail(true);
    setError(null);
    try {
      const d = await getPromptTemplate(t.category, t.name);
      setEditor({ category: d.category, name: d.name, content: d.content, original: d.content });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingDetail(false);
    }
  };

  const save = async () => {
    if (!editor) return;
    setSaving(true);
    setError(null);
    try {
      await updatePromptTemplate(editor.category, editor.name, editor.content);
      setEditor({ ...editor, original: editor.content });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const improve = async (extra?: string) => {
    if (!editor) return;
    setImproving(true);
    setError(null);
    try {
      const ins = [instruction.trim(), extra?.trim()].filter(Boolean).join('. ');
      const res = await improvePromptTemplate(editor.content, ins);
      if (res.improved) setEditor({ ...editor, content: res.improved });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImproving(false);
    }
  };

  const dirty = editor && editor.content !== editor.original;

  return (
    <div className="flex h-full w-full">
      {/* List */}
      <div className="flex w-64 flex-shrink-0 flex-col border-r border-border">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-sm font-semibold">Prompts ({templates.length})</span>
          <Button variant="ghost" size="sm" onClick={() => void refresh()} title="Rafraîchir">
            <RefreshCw className={cn('h-4 w-4', loadingList && 'animate-spin')} />
          </Button>
        </div>
        <div className="flex flex-wrap gap-1 border-b border-border px-2 py-2">
          {['all', ...categories].map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={cn(
                'rounded-full px-2 py-0.5 text-[11px] transition-colors',
                category === c ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/70',
              )}
            >
              {c === 'all' ? 'Tous' : c}
            </button>
          ))}
        </div>
        <ScrollArea className="flex-1">
          <div className="p-2">
            {filtered.map((t) => {
              const key = `${t.category}/${t.name}`;
              return (
                <button
                  key={key}
                  onClick={() => void open(t)}
                  className={cn(
                    'flex w-full items-start gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors',
                    selected === key ? 'bg-primary/10 text-primary' : 'hover:bg-muted',
                  )}
                >
                  <FileText className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 opacity-60" />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{t.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{t.category}</span>
                  </span>
                </button>
              );
            })}
            {!loadingList && filtered.length === 0 && (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">Aucun template</div>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Editor + assistant (resizable) */}
      <ResizableChatLayout id="prompts">
        <div className="flex h-full min-w-0 flex-col overflow-hidden">
        {editor ? (
          <>
            <div className="flex items-center justify-between border-b border-border px-4 py-2">
              <span className="truncate text-sm font-semibold">
                {editor.category} / {editor.name}
                {dirty && <span className="ml-2 text-xs text-amber-500">• modifié</span>}
              </span>
              <Button size="sm" onClick={() => void save()} disabled={saving || !dirty}>
                {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
                Enregistrer
              </Button>
            </div>

            {error && (
              <div className="mx-4 mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">
                {error}
              </div>
            )}

            <div className="flex min-h-0 flex-1 flex-col p-4">
              <Textarea
                value={editor.content}
                disabled={loadingDetail}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setEditor({ ...editor, content: e.target.value })}
                className="min-h-0 flex-1 resize-none font-mono text-xs"
              />
              <div className="mt-3 space-y-2 rounded-md border border-border bg-card p-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                  <Sparkles className="h-3.5 w-3.5 text-primary" /> Améliorer avec l'IA
                </div>
                <div className="flex gap-2">
                  <Input
                    value={instruction}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInstruction(e.target.value)}
                    placeholder="Comment l'améliorer ? (optionnel)"
                    className="text-sm"
                  />
                  <Button size="sm" variant="outline" onClick={() => void improve()} disabled={improving}>
                    {improving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Améliorer'}
                  </Button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {QUICK_IMPROVE.map((q) => (
                    <button
                      key={q}
                      onClick={() => void improve(q)}
                      disabled={improving}
                      className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/70 disabled:opacity-50"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Sélectionnez un template de prompt à gauche.
          </div>
        )}
      </div>

      {/* Right-side assistant */}
      <AgentChatPanel
        scope="prompts"
        title="Assistant Prompts"
        subtitle="Rédiger, clarifier et améliorer les templates."
        placeholder={editor ? `Question sur « ${editor.name} »…` : 'Question sur les prompts…'}
        getContext={() =>
          editor
            ? `Template sélectionné : ${editor.category}/${editor.name}\nContenu actuel :\n${editor.content.slice(0, 4000)}`
            : ''
        }
        suggestions={[
          'Quelles variables ce template attend-il ?',
          'Comment rendre ce prompt plus robuste ?',
          'Propose une version plus concise.',
        ]}
      />
      </ResizableChatLayout>
    </div>
  );
}
