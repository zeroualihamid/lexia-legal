import { useEffect, useRef, useState } from 'react';
import { Sparkles, Send, Square, Loader2, Wrench, Eraser, X, PanelRightClose, CircleHelp, Check } from 'lucide-react';
import { chatAgentStream, type EnhanceEvent } from '@/lib/parquet_api';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import MarkdownRenderer from '@/components/features/chat/MarkdownRenderer';
import { usePersistentState } from '@/hooks/usePersistentState';
import { cn } from '@/lib/utils';

interface AskOption {
  label: string;
  description?: string;
}

interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskOption[];
}

interface TranscriptItem {
  kind: 'assistant' | 'thinking' | 'tool' | 'tool_result' | 'result' | 'error' | 'info' | 'ask';
  text: string;
  tool?: string;
  isError?: boolean;
  /** Structured questions from the agent's AskUserQuestion call (human-in-the-loop). */
  ask?: AskQuestion[];
  /** Set once the admin answered this question card (disables it). */
  answered?: boolean;
}

interface Turn {
  user: string;
  items: TranscriptItem[];
  running: boolean;
}

export interface AgentChatPanelProps {
  /** Steers the backend system prompt: data | connectors | prompts | cte | general. */
  scope: string;
  title?: string;
  subtitle?: string;
  placeholder?: string;
  /** Returns the current section context (selected source/template/…) sent with each message. */
  getContext?: () => string;
  /** Suggested prompts shown when the chat is empty. */
  suggestions?: string[];
  className?: string;
  /** When provided, renders a close affordance in the header (drawer/slide-over use). */
  onClose?: () => void;
  /** When provided, renders a collapse button in the header (injected by ResizableChatLayout). */
  onCollapse?: () => void;
  /** CTE graph the user is viewing — binds the agent to THIS graph + its source. */
  graphId?: string | null;
  /** Persistent-history key; defaults to `scope` (pass one per section when several sections share a scope). */
  historyKey?: string;
  /** Called when a chat run finishes (success or error) — e.g. to refresh section data the agent may have changed. */
  onTurnEnd?: () => void;
}

/** Parse the AskUserQuestion tool input into renderable questions (null if malformed). */
function parseAskQuestions(input: unknown): AskQuestion[] | null {
  const raw = (input as { questions?: unknown })?.questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions: AskQuestion[] = [];
  for (const q of raw as Record<string, any>[]) {
    const options = Array.isArray(q?.options)
      ? q.options
          .map((o: Record<string, any>) => ({ label: String(o?.label ?? ''), description: o?.description ? String(o.description) : undefined }))
          .filter((o: AskOption) => o.label)
      : [];
    if (!q?.question || options.length === 0) continue;
    questions.push({
      question: String(q.question),
      header: q.header ? String(q.header) : undefined,
      multiSelect: Boolean(q.multiSelect),
      options,
    });
  }
  return questions.length ? questions : null;
}

/**
 * Interactive human-in-the-loop card for an AskUserQuestion call. Headless
 * Claude runs get an empty tool answer, so the admin answers HERE: the choice
 * is sent as the next chat message (the agent resumes with history context).
 */
function AskQuestionCard({
  questions,
  disabled,
  onAnswer,
}: {
  questions: AskQuestion[];
  disabled: boolean;
  onAnswer: (text: string) => void;
}) {
  const [selected, setSelected] = useState<Record<number, string[]>>({});

  const toggle = (qi: number, label: string, multi: boolean) => {
    if (disabled) return;
    if (questions.length === 1 && !multi) {
      // Single question, single choice — answer in one click.
      onAnswer(`${questions[0].header || questions[0].question} : ${label}`);
      return;
    }
    setSelected((prev) => {
      const cur = prev[qi] || [];
      const next = multi
        ? cur.includes(label)
          ? cur.filter((l) => l !== label)
          : [...cur, label]
        : [label];
      return { ...prev, [qi]: next };
    });
  };

  const complete = questions.every((_, qi) => (selected[qi] || []).length > 0);
  const submit = () => {
    if (!complete || disabled) return;
    onAnswer(
      questions
        .map((q, qi) => `${q.header || q.question} : ${(selected[qi] || []).join(', ')}`)
        .join('\n'),
    );
  };

  return (
    <div className={cn('space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3', disabled && 'opacity-70')}>
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary">
        <CircleHelp className="h-3.5 w-3.5" /> L'agent a besoin d'une précision
      </div>
      {questions.map((q, qi) => (
        <div key={qi} className="space-y-1.5">
          <div className="text-sm font-medium">{q.question}</div>
          <div className="flex flex-wrap gap-1.5">
            {q.options.map((o) => {
              const isSel = (selected[qi] || []).includes(o.label);
              return (
                <button
                  key={o.label}
                  type="button"
                  disabled={disabled}
                  onClick={() => toggle(qi, o.label, Boolean(q.multiSelect))}
                  title={o.description}
                  className={cn(
                    'rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors',
                    isSel
                      ? 'border-primary bg-primary/15 text-primary'
                      : 'border-border bg-background text-foreground/80 hover:bg-muted',
                    disabled && 'cursor-not-allowed',
                  )}
                >
                  <span className="font-medium">{o.label}</span>
                  {o.description && (
                    <span className="ml-1.5 text-[10px] text-muted-foreground">{o.description}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {(questions.length > 1 || questions.some((q) => q.multiSelect)) && (
        <Button size="sm" className="w-full" disabled={disabled || !complete} onClick={submit}>
          <Check className="mr-1.5 h-4 w-4" /> Envoyer la réponse
        </Button>
      )}
      <div className="text-[10px] text-muted-foreground">
        Vous pouvez aussi répondre librement dans le champ de message ci-dessous.
      </div>
    </div>
  );
}

/** Compact transcript of recent turns, fed back as continuity context (stateless CLI runs). */
function historyContext(turns: Turn[]): string {
  const recent = turns.slice(-3);
  if (!recent.length) return '';
  const lines = recent.map((t) => {
    const answer = [...t.items].reverse().find((i) => i.kind === 'result' || i.kind === 'assistant');
    const a = answer ? answer.text.slice(0, 600) : '';
    return `Q: ${t.user}\nR: ${a}`;
  });
  return `Échanges précédents (résumé) :\n${lines.join('\n---\n')}`;
}

export default function AgentChatPanel({
  scope,
  title = 'Assistant Claude',
  subtitle,
  placeholder = 'Posez une question…',
  getContext,
  suggestions = [],
  className,
  onClose,
  onCollapse,
  graphId,
  historyKey,
  onTurnEnd,
}: AgentChatPanelProps) {
  const storageId = historyKey || scope;
  const [turns, setTurns, clearTurns] = usePersistentState<Turn[]>(storageId ? `chat:${storageId}` : null, []);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const abortRef = useRef<null | (() => void)>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns, running]);

  useEffect(() => () => abortRef.current?.(), []);

  const appendItem = (it: TranscriptItem) =>
    setTurns((prev) => {
      if (!prev.length) return prev;
      const copy = prev.slice();
      const last = { ...copy[copy.length - 1] };
      const items = last.items.slice();
      const tail = items[items.length - 1];
      // Coalesce consecutive assistant deltas into one bubble.
      if (it.kind === 'assistant' && tail?.kind === 'assistant') {
        items[items.length - 1] = { ...tail, text: tail.text + it.text };
      } else if (it.kind === 'tool_result' && tail?.kind === 'ask') {
        // AskUserQuestion returns an empty answer in headless mode — noise.
        return prev;
      } else if (
        it.kind === 'result' &&
        !it.isError &&
        tail &&
        (tail.kind === 'ask' || (tail.kind === 'assistant' && tail.text.trim() === it.text.trim()))
      ) {
        // The final result often repeats the last assistant bubble verbatim;
        // after a question card, keep the card as the visual conclusion.
        return prev;
      } else {
        items.push(it);
      }
      last.items = items;
      copy[copy.length - 1] = last;
      return copy;
    });

  const finishTurn = () =>
    setTurns((prev) => {
      if (!prev.length) return prev;
      const copy = prev.slice();
      copy[copy.length - 1] = { ...copy[copy.length - 1], running: false };
      return copy;
    });

  const handleEvent = (e: EnhanceEvent) => {
    const d = e.data as Record<string, any>;
    switch (e.event) {
      case 'assistant_delta':
        if (d.text) appendItem({ kind: 'assistant', text: String(d.text) });
        break;
      case 'thinking':
        if (d.text) appendItem({ kind: 'thinking', text: String(d.text) });
        break;
      case 'tool_start': {
        const tool = String(d.tool || '');
        const questions = tool === 'AskUserQuestion' ? parseAskQuestions(d.input) : null;
        if (questions) {
          appendItem({ kind: 'ask', text: '', ask: questions });
        } else {
          appendItem({ kind: 'tool', tool, text: typeof d.input === 'object' ? JSON.stringify(d.input) : String(d.input ?? '') });
        }
        break;
      }
      case 'tool_result':
        appendItem({ kind: 'tool_result', text: String(d.content ?? ''), isError: Boolean(d.is_error) });
        break;
      case 'result':
        appendItem({ kind: 'result', text: String(d.result ?? ''), isError: Boolean(d.is_error) });
        break;
      case 'error':
        appendItem({ kind: 'error', text: `${d.message ?? 'Erreur'}${d.stderr ? `\n${d.stderr}` : ''}` });
        break;
      default:
        break; // run_started, claude_system, heartbeat, done
    }
  };

  const send = (text: string) => {
    const msg = text.trim();
    if (!msg || running) return;
    const ctxParts = [getContext?.() || '', historyContext(turns)].filter(Boolean);
    setTurns((prev) => [...prev, { user: msg, items: [], running: true }]);
    setInput('');
    setRunning(true);
    abortRef.current = chatAgentStream(
      { message: msg, scope, context: ctxParts.join('\n\n'), graph_id: graphId || undefined },
      handleEvent,
      (err) => {
        appendItem({ kind: 'error', text: err.message });
        finishTurn();
        setRunning(false);
        abortRef.current = null;
        onTurnEnd?.();
      },
      () => {
        finishTurn();
        setRunning(false);
        abortRef.current = null;
        onTurnEnd?.();
      },
    );
  };

  const stop = () => {
    abortRef.current?.();
    abortRef.current = null;
    appendItem({ kind: 'info', text: '⏹ Interrompu.' });
    finishTurn();
    setRunning(false);
  };

  /** Answer a question card: mark it answered, then send the choice as the next message. */
  const answerAsk = (ti: number, ii: number, text: string) => {
    setTurns((prev) => {
      const copy = prev.slice();
      const turn = { ...copy[ti] };
      const items = turn.items.slice();
      if (items[ii]?.kind === 'ask') items[ii] = { ...items[ii], answered: true };
      turn.items = items;
      copy[ti] = turn;
      return copy;
    });
    send(text);
  };

  return (
    <div className={cn('flex h-full w-full min-w-0 flex-col border-l border-border bg-card', className)}>
      <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            <Sparkles className="h-4 w-4 flex-shrink-0 text-primary" />
            <span className="truncate">{title}</span>
          </div>
          {subtitle && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{subtitle}</p>}
        </div>
        <div className="flex flex-shrink-0 items-center gap-0.5">
          {turns.length > 0 && !running && (
            <Button variant="ghost" size="sm" onClick={clearTurns} title="Supprimer l'historique">
              <Eraser className="h-4 w-4" />
            </Button>
          )}
          {onClose && (
            <Button variant="ghost" size="sm" onClick={onClose} title="Fermer">
              <X className="h-4 w-4" />
            </Button>
          )}
          {onCollapse && (
            <Button variant="ghost" size="sm" onClick={onCollapse} title="Réduire l'assistant">
              <PanelRightClose className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      <ScrollArea className="sa-block flex-1">
        <div ref={scrollRef} className="min-w-0 max-w-full space-y-3 overflow-x-hidden p-3">
          {turns.length === 0 && (
            <div className="space-y-3 px-1 py-4">
              <div className="text-center text-xs text-muted-foreground">
                Discutez avec l'agent à propos de cette section.
              </div>
              {suggestions.length > 0 && (
                <div className="space-y-1.5">
                  {suggestions.map((s, i) => (
                    <button
                      key={i}
                      onClick={() => send(s)}
                      className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-left text-[11px] text-foreground/80 transition-colors hover:bg-muted"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {turns.map((turn, ti) => (
            <div key={ti} className="min-w-0 space-y-2">
              <div className="ml-6 min-w-0 break-words rounded-lg bg-primary/10 px-3 py-2 text-sm text-foreground [overflow-wrap:anywhere]">{turn.user}</div>
              {turn.items.map((it, i) => {
                if (it.kind === 'ask' && it.ask)
                  return (
                    <AskQuestionCard
                      key={i}
                      questions={it.ask}
                      disabled={Boolean(it.answered) || running || ti !== turns.length - 1}
                      onAnswer={(text) => answerAsk(ti, i, text)}
                    />
                  );
                if (it.kind === 'info')
                  return <div key={i} className="px-1 text-[11px] text-muted-foreground break-words">{it.text}</div>;
                if (it.kind === 'thinking')
                  return <div key={i} className="px-1 text-[11px] italic text-muted-foreground/80 break-words">{it.text}</div>;
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
                  <div key={i} className={cn('min-w-0 max-w-full overflow-hidden break-words rounded-lg px-3 py-2 text-sm', it.kind === 'result' ? (it.isError ? 'bg-red-500/10' : 'bg-muted') : it.kind === 'error' ? 'bg-red-500/10 text-red-500' : 'bg-muted')}>
                    <MarkdownRenderer content={it.text} />
                  </div>
                );
              })}
              {turn.running && turn.items.length === 0 && (
                <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> l'agent réfléchit…
                </div>
              )}
            </div>
          ))}
        </div>
      </ScrollArea>

      <div className="space-y-2 border-t border-border p-2">
        <Textarea
          rows={2}
          value={input}
          disabled={running}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setInput(e.target.value)}
          onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
          placeholder={placeholder}
          className="resize-none text-sm"
        />
        {running ? (
          <Button size="sm" variant="outline" className="w-full" onClick={stop}>
            <Square className="mr-1.5 h-4 w-4" /> Arrêter
          </Button>
        ) : (
          <Button size="sm" className="w-full" onClick={() => send(input)} disabled={!input.trim()}>
            <Send className="mr-1.5 h-4 w-4" /> Envoyer
          </Button>
        )}
      </div>
    </div>
  );
}
