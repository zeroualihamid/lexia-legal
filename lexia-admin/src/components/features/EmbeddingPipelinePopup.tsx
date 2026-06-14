import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Database,
  FileText,
  Brain,
  Sparkles,
  Layers,
  BookOpen,
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  Zap,
  Hash,
  ChevronDown,
  RotateCcw,
  Play,
  AlertTriangle,
  Cpu,
  PenLine,
} from "lucide-react";
import {
  startEmbeddingAgent,
  streamEmbeddingEvents,
  lookupEmbeddingAgent,
  type EmbeddingEvent,
} from "@/lib/parquet_api";

// ── Step icon mapping ─────────────────────────────────────────────────

const STEP_ICONS: Record<string, React.ElementType> = {
  resolve: Database,
  load_dto: FileText,
  filter: Layers,
  load_data: Database,
  distinct: Hash,
  reasoning: Brain,
  definitions: BookOpen,
  definitions_batch: PenLine,
  embed: Cpu,
  write: Sparkles,
  done: CheckCircle2,
  failed: XCircle,
  warning: AlertTriangle,
  summary: CheckCircle2,
  error: XCircle,
};

const STEP_COLORS: Record<string, string> = {
  resolve: "text-blue-400",
  load_dto: "text-indigo-400",
  filter: "text-violet-400",
  load_data: "text-cyan-400",
  distinct: "text-teal-400",
  reasoning: "text-purple-400",
  definitions: "text-amber-400",
  definitions_batch: "text-orange-400",
  embed: "text-emerald-400",
  write: "text-pink-400",
  done: "text-emerald-400",
  failed: "text-red-400",
  warning: "text-yellow-400",
  summary: "text-emerald-400",
  error: "text-red-400",
};

// ── Types ─────────────────────────────────────────────────────────────

interface EmbeddingPipelinePopupProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceId: string;
  tableId?: string;
  categoricalColumns: string[];
  onComplete?: () => void;
}

type Phase = "idle" | "running" | "completed" | "failed";

// ══════════════════════════════════════════════════════════════════════
// Module-level job store — survives component unmount/remount
// ══════════════════════════════════════════════════════════════════════

interface JobState {
  jobId: string;
  phase: Phase;
  events: EmbeddingEvent[];
  currentColumn: string | null;
  colIndex: number;
  totalColumns: number;
  elapsed: number | null;
  error: string | null;
  summary: Record<string, number> | null;
}

const jobStore = new Map<string, JobState>();
const sseCleanup = new Map<string, () => void>();
let storeVersion = 0;
const storeListeners = new Set<() => void>();

function notifyStore() {
  storeVersion++;
  storeListeners.forEach((fn) => fn());
}

function getStoreSnapshot() {
  return storeVersion;
}

function subscribeStore(cb: () => void) {
  storeListeners.add(cb);
  return () => storeListeners.delete(cb);
}

function storeKey(sourceId: string, tableId?: string) {
  return `${sourceId}__${tableId || "_"}`;
}

function getJob(sourceId: string, tableId?: string): JobState | undefined {
  return jobStore.get(storeKey(sourceId, tableId));
}

function setJob(sourceId: string, tableId: string | undefined, state: JobState) {
  jobStore.set(storeKey(sourceId, tableId), state);
  notifyStore();
}

function updateJob(sourceId: string, tableId: string | undefined, patch: Partial<JobState>) {
  const key = storeKey(sourceId, tableId);
  const existing = jobStore.get(key);
  if (existing) {
    Object.assign(existing, patch);
    notifyStore();
  }
}

function applyEvent(sourceId: string, tableId: string | undefined, evt: EmbeddingEvent) {
  const key = storeKey(sourceId, tableId);
  const job = jobStore.get(key);
  if (!job) return;

  job.events = [...job.events, evt];

  if (evt.column) job.currentColumn = evt.column;
  if (evt.col_index != null) job.colIndex = evt.col_index;
  if (evt.total_columns != null) job.totalColumns = evt.total_columns;
  if (evt.elapsed != null) job.elapsed = evt.elapsed;
  if (evt.error) job.error = evt.error;

  if (evt.step === "summary") {
    job.phase = evt.status === "completed" ? "completed" : "failed";
    if (evt.elapsed != null) job.elapsed = evt.elapsed;
    if (evt.summary) job.summary = evt.summary;
  }

  notifyStore();
}

function connectSSE(sourceId: string, tableId: string | undefined, jobId: string) {
  const key = storeKey(sourceId, tableId);
  sseCleanup.get(key)?.();

  const cancel = streamEmbeddingEvents(
    jobId,
    (evt) => applyEvent(sourceId, tableId, evt),
    () => {
      const job = getJob(sourceId, tableId);
      if (job?.phase === "running") {
        updateJob(sourceId, tableId, { phase: "completed" });
      }
      sseCleanup.delete(key);
    },
    (err) => {
      updateJob(sourceId, tableId, { phase: "failed", error: err.message });
      sseCleanup.delete(key);
    },
  );

  sseCleanup.set(key, cancel);
}

// ══════════════════════════════════════════════════════════════════════
// Component
// ══════════════════════════════════════════════════════════════════════

export default function EmbeddingPipelinePopup({
  open,
  onOpenChange,
  sourceId,
  tableId,
  categoricalColumns,
  onComplete,
}: EmbeddingPipelinePopupProps) {
  useSyncExternalStore(subscribeStore, getStoreSnapshot);

  const job = getJob(sourceId, tableId);
  const phase = job?.phase ?? "idle";
  const events = job?.events ?? [];
  const currentColumn = job?.currentColumn ?? null;
  const colIndex = job?.colIndex ?? 0;
  const totalColumns = job?.totalColumns ?? categoricalColumns.length;
  const elapsed = job?.elapsed ?? null;
  const error = job?.error ?? null;
  const summary = job?.summary ?? null;

  const [showAllEvents, setShowAllEvents] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length, open]);

  // On open: check for an existing running/completed job to reconnect, but do NOT auto-start
  useEffect(() => {
    if (!open) return;
    if (job && job.phase !== "idle") return;

    let cancelled = false;
    (async () => {
      try {
        const lookup = await lookupEmbeddingAgent(sourceId, tableId);
        if (cancelled) return;

        if (lookup.job_id && lookup.status) {
          const restoredPhase: Phase =
            lookup.status === "running" ? "running"
            : lookup.status === "completed" ? "completed"
            : lookup.status === "failed" ? "failed"
            : "idle";

          setJob(sourceId, tableId, {
            jobId: lookup.job_id,
            phase: restoredPhase,
            events: lookup.events ?? [],
            currentColumn: lookup.last_event?.column ?? null,
            colIndex: lookup.last_event?.col_index ?? 0,
            totalColumns: lookup.last_event?.total_columns ?? categoricalColumns.length,
            elapsed: lookup.elapsed_seconds ?? null,
            error: lookup.error ?? null,
            summary: lookup.summary ?? null,
          });

          if (restoredPhase === "running") {
            connectSSE(sourceId, tableId, lookup.job_id);
          }
        }
      } catch {
        // Lookup failed — stay idle
      }
    })();

    return () => { cancelled = true; };
  }, [open, sourceId, tableId]);

  const startPipeline = useCallback(async (
    sid: string,
    tid: string | undefined,
    catCols: string[],
  ) => {
    setJob(sid, tid, {
      jobId: "",
      phase: "running",
      events: [],
      currentColumn: null,
      colIndex: 0,
      totalColumns: catCols.length,
      elapsed: null,
      error: null,
      summary: null,
    });

    try {
      const resp = await startEmbeddingAgent(sid, catCols, tid);
      updateJob(sid, tid, { jobId: resp.job_id });
      connectSSE(sid, tid, resp.job_id);
    } catch (err) {
      updateJob(sid, tid, {
        phase: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  const handleStart = useCallback(() => {
    startPipeline(sourceId, tableId, categoricalColumns);
  }, [sourceId, tableId, categoricalColumns, startPipeline]);

  const handleRetry = handleStart;

  const handleClose = () => {
    if (phase === "completed") onComplete?.();
    onOpenChange(false);
  };

  const batchEvents = events.filter((e) => e.step === "definitions_batch");
  const displayEvents = showAllEvents
    ? events
    : events.filter((e) => e.step !== "definitions_batch");
  const latestBatch = [...batchEvents].reverse()[0];

  const pct = totalColumns > 0 && colIndex > 0
    ? Math.min(Math.round((colIndex / totalColumns) * 100), 100)
    : phase === "completed" ? 100 : 0;

  const totalDistinct = summary
    ? Object.values(summary).reduce((a, b) => a + b, 0)
    : null;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl bg-[#0a0f1a] border-[#1e293b] text-white p-0 overflow-hidden">
        {/* ── Header ───────────────────────────────────────────── */}
        <div className="bg-gradient-to-r from-[#E8725A]/20 via-[#0a0f1a] to-[#7c3aed]/20 px-6 pt-6 pb-4 border-b border-[#1e293b]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3 text-lg font-semibold text-white">
              <div className="p-2 rounded-lg bg-[#E8725A]/20 border border-[#E8725A]/30">
                <Sparkles className="w-5 h-5 text-[#E8725A]" />
              </div>
              Agent d'Embeddings
              <PhaseIndicator phase={phase} />
            </DialogTitle>
            <DialogDescription className="text-slate-400 text-sm mt-1">
              {sourceId}{tableId ? ` / ${tableId}` : ""} — {categoricalColumns.length} colonne{categoricalColumns.length > 1 ? "s" : ""} catégorielle{categoricalColumns.length > 1 ? "s" : ""}
            </DialogDescription>
          </DialogHeader>
        </div>

        {/* ── Progress bar ─────────────────────────────────────── */}
        <div className="px-6 pt-4">
          <div className="relative h-2.5 bg-[#1e293b] rounded-full overflow-hidden">
            <motion.div
              className={`absolute inset-y-0 left-0 rounded-full ${
                phase === "failed"
                  ? "bg-red-500"
                  : phase === "completed"
                  ? "bg-emerald-500"
                  : "bg-gradient-to-r from-[#E8725A] to-amber-400"
              }`}
              initial={{ width: "0%" }}
              animate={{
                width: phase === "completed" ? "100%" : `${Math.max(pct, phase === "running" ? 3 : 0)}%`,
              }}
              transition={{ duration: 0.4, ease: "easeOut" }}
            />
            {phase === "running" && (
              <motion.div
                className="absolute inset-y-0 left-0 w-full bg-gradient-to-r from-transparent via-white/10 to-transparent"
                animate={{ x: ["-100%", "100%"] }}
                transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
              />
            )}
          </div>
        </div>

        {/* ── Stats row ────────────────────────────────────────── */}
        <div className="px-6 pt-3 grid grid-cols-4 gap-3">
          <StatCard
            icon={<Layers className="w-3.5 h-3.5" />}
            label="Colonnes"
            value={colIndex > 0 ? `${colIndex}` : "-"}
            sub={`/ ${totalColumns}`}
          />
          <StatCard
            icon={<Hash className="w-3.5 h-3.5" />}
            label="Distincts"
            value={totalDistinct != null ? `${totalDistinct.toLocaleString("fr-FR")}` : "-"}
          />
          <StatCard
            icon={<Clock className="w-3.5 h-3.5" />}
            label="Temps"
            value={elapsed != null ? formatDuration(elapsed) : "-"}
          />
          <StatCard
            icon={<Zap className="w-3.5 h-3.5" />}
            label="Progression"
            value={pct > 0 ? `${pct}%` : "-"}
          />
        </div>

        {/* ── Current column indicator ─────────────────────────── */}
        {phase === "running" && currentColumn && (
          <div className="px-6 pt-3">
            <div className="flex items-center gap-2 bg-[#0f1629] rounded-lg border border-[#1e293b]/60 px-3 py-2">
              <Loader2 className="w-3.5 h-3.5 text-[#E8725A] animate-spin" />
              <span className="text-xs text-slate-400">Colonne en cours :</span>
              <span className="text-xs font-semibold text-white">{currentColumn}</span>
            </div>
          </div>
        )}

        {/* ── Reasoning log ────────────────────────────────────── */}
        <div className="px-6 pt-4 pb-2">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
              Raisonnement de l'agent
            </span>
            {batchEvents.length > 0 && !showAllEvents && (
              <button
                onClick={() => setShowAllEvents(true)}
                className="text-xs text-slate-500 hover:text-slate-300 flex items-center gap-1 transition-colors"
              >
                +{batchEvents.length} lots LLM
                <ChevronDown className="w-3 h-3" />
              </button>
            )}
            {showAllEvents && (
              <button
                onClick={() => setShowAllEvents(false)}
                className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
              >
                Compact
              </button>
            )}
          </div>

          <div className="bg-[#060a12] rounded-lg border border-[#1e293b]/60 max-h-64 overflow-y-auto scrollbar-thin scrollbar-thumb-slate-700">
            <div className="p-3 space-y-1.5">
              <AnimatePresence mode="popLayout">
                {displayEvents.map((evt, i) => (
                  <EventRow key={i} event={evt} />
                ))}
                {!showAllEvents && latestBatch && phase === "running" && (
                  <EventRow key="latest-batch" event={latestBatch} highlight />
                )}
              </AnimatePresence>

              {phase === "running" && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex items-center gap-2 text-xs text-slate-500 pt-1"
                >
                  <Loader2 className="w-3 h-3 animate-spin" />
                  En cours...
                </motion.div>
              )}
              <div ref={logEndRef} />
            </div>
          </div>
        </div>

        {/* ── Summary banner ───────────────────────────────────── */}
        <AnimatePresence>
          {phase === "completed" && summary && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="mx-6 mb-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-4 py-3"
            >
              <p className="text-sm text-emerald-300 font-medium flex items-center gap-2 mb-2">
                <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                Pipeline terminé avec succès
              </p>
              <div className="flex flex-wrap gap-2">
                {Object.entries(summary).map(([col, count]) => (
                  <span
                    key={col}
                    className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-0.5 text-[10px] font-medium text-emerald-300"
                  >
                    {col}: {count}
                  </span>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Error banner ─────────────────────────────────────── */}
        <AnimatePresence>
          {error && phase === "failed" && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="mx-6 mb-2 rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-3"
            >
              <p className="text-sm text-red-300 font-medium flex items-center gap-2">
                <XCircle className="w-4 h-4 flex-shrink-0" />
                {error}
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Idle: columns preview + start button ─────────────── */}
        {phase === "idle" && (
          <div className="px-6 pb-2">
            <div className="bg-[#0f1629] rounded-lg border border-[#1e293b]/60 p-4">
              <p className="text-xs font-medium text-slate-400 uppercase tracking-wider mb-3">
                Colonnes catégorielles à traiter
              </p>
              <div className="flex flex-wrap gap-2">
                {categoricalColumns.map((col) => (
                  <span
                    key={col}
                    className="inline-flex items-center rounded-full bg-[#E8725A]/10 border border-[#E8725A]/20 px-2.5 py-1 text-[11px] font-medium text-[#E8725A]"
                  >
                    {col}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Footer ───────────────────────────────────────────── */}
        <div className="px-6 pb-5 pt-2 flex justify-end gap-3">
          {phase === "idle" && (
            <Button
              size="sm"
              className="bg-[#E8725A] hover:bg-[#D4613D] text-white"
              onClick={handleStart}
            >
              <Sparkles className="w-3.5 h-3.5 mr-1.5" />
              Démarrer le pipeline
            </Button>
          )}
          {phase === "completed" && (
            <Button
              variant="outline"
              size="sm"
              className="border-[#E8725A]/50 text-[#E8725A] hover:bg-[#E8725A]/10 hover:text-[#D4613D]"
              onClick={handleStart}
            >
              <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
              Relancer
            </Button>
          )}
          {phase === "failed" && (
            <Button
              variant="outline"
              size="sm"
              className="border-orange-600/50 text-orange-300 hover:bg-orange-900/30 hover:text-orange-200"
              onClick={handleRetry}
            >
              <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
              Réessayer
            </Button>
          )}
          <Button
            size="sm"
            className={
              phase === "completed"
                ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                : "bg-slate-700 hover:bg-slate-600 text-white"
            }
            onClick={handleClose}
          >
            {phase === "completed"
              ? "Fermer"
              : phase === "running"
              ? "Masquer"
              : "Fermer"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Sub-components ────────────────────────────────────────────────────

function PhaseIndicator({ phase }: { phase: Phase }) {
  const config = {
    idle: { color: "bg-slate-500", label: "" },
    running: { color: "bg-[#E8725A] animate-pulse", label: "En cours" },
    completed: { color: "bg-emerald-500", label: "Terminé" },
    failed: { color: "bg-red-500", label: "Échec" },
  }[phase];

  if (!config.label) return null;

  return (
    <span className="ml-auto flex items-center gap-1.5 text-xs font-medium text-slate-400">
      <span className={`w-2 h-2 rounded-full ${config.color}`} />
      {config.label}
    </span>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="bg-[#0f1629] rounded-lg border border-[#1e293b]/60 px-3 py-2">
      <div className="flex items-center gap-1.5 text-slate-500 mb-1">
        {icon}
        <span className="text-[10px] uppercase tracking-wider font-medium">{label}</span>
      </div>
      <div className="text-sm font-semibold text-white leading-none">
        {value}
        {sub && <span className="text-xs text-slate-500 font-normal ml-1">{sub}</span>}
      </div>
    </div>
  );
}

function EventRow({ event, highlight }: { event: EmbeddingEvent; highlight?: boolean }) {
  const Icon = STEP_ICONS[event.step] || Sparkles;
  const color = STEP_COLORS[event.step] || "text-slate-400";

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.15 }}
      className={`flex items-start gap-2.5 text-xs leading-relaxed ${
        highlight ? "bg-[#E8725A]/10 -mx-1.5 px-1.5 py-1 rounded" : ""
      }`}
    >
      <Icon className={`w-3.5 h-3.5 mt-0.5 flex-shrink-0 ${color}`} />
      <span className="text-slate-300 break-all">{event.message}</span>
      {event.ts && (
        <span className="ml-auto text-[10px] text-slate-600 flex-shrink-0 tabular-nums">
          {new Date(event.ts).toLocaleTimeString("fr-FR", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}
        </span>
      )}
    </motion.div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m}m${s.toString().padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${rm.toString().padStart(2, "0")}m`;
}
