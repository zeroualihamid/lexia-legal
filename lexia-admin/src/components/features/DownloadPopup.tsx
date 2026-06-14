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
  PlugZap,
  Hash,
  Download,
  ShieldCheck,
  FileCheck2,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Loader2,
  Brain,
  Clock,
  Zap,
  HardDrive,
  ChevronDown,
  RotateCcw,
  Play,
} from "lucide-react";
import {
  startDownloadAgent,
  streamDownloadEvents,
  lookupDownloadAgent,
  type DownloadEvent,
} from "@/lib/parquet_api";

// ── Step icon mapping ─────────────────────────────────────────────────

const STEP_ICONS: Record<string, React.ElementType> = {
  resolve: Database,
  connect: PlugZap,
  connect_error: XCircle,
  count: Hash,
  count_warning: Hash,
  download: Download,
  progress: Download,
  download_complete: CheckCircle2,
  download_error: XCircle,
  verify: ShieldCheck,
  verify_fail: XCircle,
  metadata: FileCheck2,
  done: CheckCircle2,
  failed: XCircle,
  reasoning: Brain,
  summary: CheckCircle2,
  error: XCircle,
  resume_check: RotateCcw,
  resume_found: RotateCcw,
  resume_copy: RotateCcw,
  partial_save: FileCheck2,
  checkpoint: FileCheck2,
  merge: FileCheck2,
  wait: Loader2,
};

const STEP_COLORS: Record<string, string> = {
  resolve: "text-blue-400",
  connect: "text-cyan-400",
  connect_error: "text-red-400",
  count: "text-violet-400",
  count_warning: "text-amber-400",
  download: "text-teal-400",
  progress: "text-teal-400",
  download_complete: "text-emerald-400",
  download_error: "text-red-400",
  verify: "text-amber-400",
  verify_fail: "text-red-400",
  metadata: "text-indigo-400",
  done: "text-emerald-400",
  failed: "text-red-400",
  reasoning: "text-purple-400",
  summary: "text-emerald-400",
  error: "text-red-400",
  resume_check: "text-orange-400",
  resume_found: "text-orange-400",
  resume_copy: "text-orange-400",
  partial_save: "text-amber-400",
  checkpoint: "text-green-400",
  merge: "text-indigo-400",
  wait: "text-yellow-400",
};

// ── Types ─────────────────────────────────────────────────────────────

interface DownloadPopupProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceId: string;
  tableId: string;
  onComplete?: () => void;
}

type Phase = "idle" | "running" | "completed" | "failed";

// ══════════════════════════════════════════════════════════════════════
// Module-level job store — survives component unmount/remount
// ══════════════════════════════════════════════════════════════════════

interface JobState {
  jobId: string;
  phase: Phase;
  events: DownloadEvent[];
  rowsDownloaded: number;
  totalRows: number | null;
  pct: number | null;
  rate: number | null;
  elapsed: number | null;
  error: string | null;
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

function storeKey(sourceId: string, tableId: string) {
  return `${sourceId}__${tableId}`;
}

function getJob(sourceId: string, tableId: string): JobState | undefined {
  return jobStore.get(storeKey(sourceId, tableId));
}

function setJob(sourceId: string, tableId: string, state: JobState) {
  jobStore.set(storeKey(sourceId, tableId), state);
  notifyStore();
}

function updateJob(sourceId: string, tableId: string, patch: Partial<JobState>) {
  const key = storeKey(sourceId, tableId);
  const existing = jobStore.get(key);
  if (existing) {
    Object.assign(existing, patch);
    notifyStore();
  }
}

function applyEvent(sourceId: string, tableId: string, evt: DownloadEvent) {
  const key = storeKey(sourceId, tableId);
  const job = jobStore.get(key);
  if (!job) return;

  job.events = [...job.events, evt];

  if (evt.rows_downloaded != null) job.rowsDownloaded = evt.rows_downloaded;
  if (evt.total_rows != null) job.totalRows = evt.total_rows;
  if (evt.pct != null) job.pct = evt.pct;
  if (evt.rate != null) job.rate = evt.rate;
  if (evt.elapsed != null) job.elapsed = evt.elapsed;
  if (evt.error) job.error = evt.error;

  if (evt.step === "summary") {
    job.phase = evt.status === "completed" ? "completed" : "failed";
    if (evt.row_count != null) job.rowsDownloaded = evt.row_count;
    if (evt.elapsed != null) job.elapsed = evt.elapsed;
  }

  notifyStore();
}

function connectSSE(sourceId: string, tableId: string, jobId: string) {
  const key = storeKey(sourceId, tableId);

  // Clean up any existing SSE for this key
  sseCleanup.get(key)?.();

  const cancel = streamDownloadEvents(
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

export default function DownloadPopup({
  open,
  onOpenChange,
  sourceId,
  tableId,
  onComplete,
}: DownloadPopupProps) {
  // Subscribe to the module-level store
  useSyncExternalStore(subscribeStore, getStoreSnapshot);

  const job = getJob(sourceId, tableId);
  const phase = job?.phase ?? "idle";
  const events = job?.events ?? [];
  const rowsDownloaded = job?.rowsDownloaded ?? 0;
  const totalRows = job?.totalRows ?? null;
  const pct = job?.pct ?? null;
  const rate = job?.rate ?? null;
  const elapsed = job?.elapsed ?? null;
  const error = job?.error ?? null;

  const [showAllEvents, setShowAllEvents] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom of log
  useEffect(() => {
    if (open) logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length, open]);

  // On open: check for existing job from backend if nothing in store
  useEffect(() => {
    if (!open) return;
    if (job && job.phase !== "idle") return; // Already have state

    let cancelled = false;
    (async () => {
      try {
        const lookup = await lookupDownloadAgent(sourceId, tableId);
        if (cancelled) return;

        if (lookup.job_id && lookup.status) {
          // Restore from backend
          const restoredPhase: Phase =
            lookup.status === "running" ? "running"
            : lookup.status === "completed" ? "completed"
            : lookup.status === "failed" ? "failed"
            : "idle";

          const lastEvt = lookup.events?.[lookup.events.length - 1];
          setJob(sourceId, tableId, {
            jobId: lookup.job_id,
            phase: restoredPhase,
            events: lookup.events ?? [],
            rowsDownloaded: lookup.row_count ?? 0,
            totalRows: lookup.total_rows ?? null,
            pct: lastEvt?.pct ?? null,
            rate: lastEvt?.rate ?? null,
            elapsed: lookup.elapsed_seconds ?? null,
            error: lookup.error ?? null,
          });

          // If still running, reconnect SSE
          if (restoredPhase === "running") {
            connectSSE(sourceId, tableId, lookup.job_id);
          }
          return;
        }
      } catch {
        // Lookup failed — just start fresh
      }

      if (cancelled) return;
      // No existing job → auto-start
      startDownload(sourceId, tableId, true);
    })();

    return () => { cancelled = true; };
  }, [open, sourceId, tableId]);

  const startDownload = useCallback(async (
    sid: string,
    tid: string,
    resume: boolean,
  ) => {
    setJob(sid, tid, {
      jobId: "",
      phase: "running",
      events: [],
      rowsDownloaded: 0,
      totalRows: null,
      pct: null,
      rate: null,
      elapsed: null,
      error: null,
    });

    try {
      const resp = await startDownloadAgent(sid, tid, false, resume);
      updateJob(sid, tid, { jobId: resp.job_id });
      connectSSE(sid, tid, resp.job_id);
    } catch (err) {
      updateJob(sid, tid, {
        phase: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  const handleRetry = useCallback(() => {
    startDownload(sourceId, tableId, true); // resume=true to continue from partial
  }, [sourceId, tableId, startDownload]);

  const handleFreshStart = useCallback(() => {
    startDownload(sourceId, tableId, false); // resume=false for fresh
  }, [sourceId, tableId, startDownload]);

  const handleClose = () => {
    // DON'T cancel SSE — let it run in the background
    if (phase === "completed") onComplete?.();
    onOpenChange(false);
  };

  // Filtered events for log display
  const displayEvents = showAllEvents
    ? events
    : events.filter((e) => e.step !== "progress");
  const latestProgress = [...events].reverse().find((e) => e.step === "progress");
  const progressCount = events.filter((e) => e.step === "progress").length;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl bg-[#0a0f1a] border-[#1e293b] text-white p-0 overflow-hidden">
        {/* ── Header ───────────────────────────────────────────── */}
        <div className="bg-gradient-to-r from-[#0D7377]/30 via-[#0a0f1a] to-[#4f46e5]/20 px-6 pt-6 pb-4 border-b border-[#1e293b]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3 text-lg font-semibold text-white">
              <div className="p-2 rounded-lg bg-[#0D7377]/20 border border-[#0D7377]/30">
                <Brain className="w-5 h-5 text-[#0D7377]" />
              </div>
              Agent de Téléchargement
              <PhaseIndicator phase={phase} />
            </DialogTitle>
            <DialogDescription className="text-slate-400 text-sm mt-1">
              {sourceId} / {tableId}
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
                  : "bg-gradient-to-r from-[#0D7377] to-cyan-400"
              }`}
              initial={{ width: "0%" }}
              animate={{
                width: pct != null ? `${Math.min(pct, 100)}%` : phase === "completed" ? "100%" : "5%",
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
            icon={<HardDrive className="w-3.5 h-3.5" />}
            label="Lignes"
            value={
              rowsDownloaded > 0
                ? `${(rowsDownloaded / 1000).toFixed(0)}K`
                : "-"
            }
            sub={totalRows ? `/ ${(totalRows / 1_000_000).toFixed(1)}M` : ""}
          />
          <StatCard
            icon={<Zap className="w-3.5 h-3.5" />}
            label="Vitesse"
            value={rate ? `${(rate / 1000).toFixed(1)}K/s` : "-"}
          />
          <StatCard
            icon={<Clock className="w-3.5 h-3.5" />}
            label="Temps"
            value={elapsed ? formatDuration(elapsed) : "-"}
          />
          <StatCard
            icon={<ShieldCheck className="w-3.5 h-3.5" />}
            label="Progression"
            value={pct != null ? `${pct.toFixed(1)}%` : "-"}
          />
        </div>

        {/* ── Reasoning log ────────────────────────────────────── */}
        <div className="px-6 pt-4 pb-2">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
              Raisonnement de l'agent
            </span>
            {progressCount > 0 && !showAllEvents && (
              <button
                onClick={() => setShowAllEvents(true)}
                className="text-xs text-slate-500 hover:text-slate-300 flex items-center gap-1 transition-colors"
              >
                +{progressCount} batch logs
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
                {!showAllEvents && latestProgress && phase === "running" && (
                  <EventRow key="latest-progress" event={latestProgress} highlight />
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

        {/* ── Footer ───────────────────────────────────────────── */}
        <div className="px-6 pb-5 pt-2 flex justify-end gap-3">
          {phase === "failed" && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="border-slate-600 text-slate-300 hover:bg-slate-800 hover:text-white"
                onClick={handleFreshStart}
              >
                <Play className="w-3.5 h-3.5 mr-1.5" />
                Recommencer
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="border-orange-600/50 text-orange-300 hover:bg-orange-900/30 hover:text-orange-200"
                onClick={handleRetry}
              >
                <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
                Reprendre
              </Button>
            </>
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
    running: { color: "bg-cyan-500 animate-pulse", label: "En cours" },
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

function EventRow({ event, highlight }: { event: DownloadEvent; highlight?: boolean }) {
  const Icon = STEP_ICONS[event.step] || Download;
  const color = STEP_COLORS[event.step] || "text-slate-400";

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.15 }}
      className={`flex items-start gap-2.5 text-xs leading-relaxed ${
        highlight ? "bg-[#0D7377]/10 -mx-1.5 px-1.5 py-1 rounded" : ""
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
