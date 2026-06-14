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
  FileUp,
  FileCheck2,
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  HardDrive,
  Database,
  Cog,
  FileText,
  RotateCcw,
  Columns3,
  ArrowRight,
  Sparkles,
  ToggleLeft,
  BarChart3,
} from "lucide-react";
import {
  uploadQvdSource,
  getQvdPipelineStatus,
  getColumnSchema,
  saveColumnSchema,
  launchCategoricalDistinct,
  getCategoricalDistinctStatus,
  type QvdPipelineStatus,
  type SaveColumnSchemaItem,
} from "@/lib/parquet_api";

// ── Types ─────────────────────────────────────────────────────────────

interface QvdPipelinePopupProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete?: (sourceId: string) => void;
}

type WizardStep = "upload" | "columns" | "distinct" | "done";
type Phase = "idle" | "uploading" | "running" | "completed" | "failed";

interface LogEntry {
  ts: string;
  step: string;
  message: string;
}

interface ColumnDraft {
  column_name: string;
  description: string;
  type: string;
  is_categorical: boolean;
}

// ══════════════════════════════════════════════════════════════════════
// Module-level store — survives unmount/remount
// ══════════════════════════════════════════════════════════════════════

interface PipelineState {
  jobId: string;
  phase: Phase;
  wizardStep: WizardStep;
  sourceId: string;
  filename: string;
  elapsed: number | null;
  error: string | null;
  logs: LogEntry[];
  results: Record<string, any> | null;
  columns: ColumnDraft[];
  distinctJobId: string | null;
  distinctPhase: "idle" | "running" | "success" | "failed";
  distinctError: string | null;
  // Live conversion progress mirrored from the backend job["progress"].
  // ``rowsDone`` / ``chunksDone`` drive the rich progress message; ``backendPhase``
  // is the granular pipeline phase (archiving|reading|writing|finalizing|…) and
  // is independent of ``phase`` which tracks the UI lifecycle.
  rowsDone: number;
  chunksDone: number;
  phaseMessage: string;
  backendPhase: string;
  lastLoggedChunks: number;
}

let pipelineState: PipelineState | null = null;
let storeVersion = 0;
const storeListeners = new Set<() => void>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

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

function pushLog(step: string, message: string) {
  if (!pipelineState) return;
  pipelineState.logs = [
    ...pipelineState.logs,
    { ts: new Date().toISOString(), step, message },
  ];
  notifyStore();
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling(jobId: string) {
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const st: QvdPipelineStatus = await getQvdPipelineStatus(jobId);
      if (!pipelineState || pipelineState.jobId !== jobId) {
        stopPolling();
        return;
      }

      pipelineState.elapsed = st.elapsed_seconds;

      // Sync live progress block before terminal-status branching so the UI
      // can keep rendering rows/chunks even on the last "running" tick.
      const progress = st.progress ?? null;
      if (progress) {
        pipelineState.rowsDone = progress.rows_done ?? pipelineState.rowsDone;
        pipelineState.chunksDone = progress.chunks_done ?? pipelineState.chunksDone;
        pipelineState.phaseMessage = progress.phase_message || pipelineState.phaseMessage;
        pipelineState.backendPhase = progress.phase || pipelineState.backendPhase;

        // Emit one log line per 5-chunk milestone (≈1M rows for 200k-row chunks).
        // Matches the backend's logging cadence so users tailing the journal see
        // progress without flooding it. Avoids "Conversion en cours…" silence
        // during the multi-minute parquet write phase.
        const chunks = pipelineState.chunksDone;
        const lastLogged = pipelineState.lastLoggedChunks;
        if (chunks > 0 && (chunks === 1 || chunks - lastLogged >= 5)) {
          pushLog(
            "converting",
            `Chunks ${chunks} — ${pipelineState.rowsDone.toLocaleString("fr-FR")} lignes écrites`,
          );
          pipelineState.lastLoggedChunks = chunks;
        }
      }

      if (st.status === "completed") {
        pipelineState.phase = "completed";
        pipelineState.results = st.results;
        pushLog("completed", `Conversion terminée — ${st.results?.row_count ?? "?"} lignes, ${st.results?.column_count ?? "?"} colonnes`);

        pipelineState.wizardStep = "columns";
        loadColumnsFromApi(pipelineState.sourceId);
        stopPolling();
      } else if (st.status === "failed") {
        pipelineState.phase = "failed";
        pipelineState.error = st.error || "Erreur inconnue";
        pushLog("failed", st.error || "Erreur inconnue");
        stopPolling();
      } else {
        if (pipelineState.phase !== "running") {
          pipelineState.phase = "running";
        }
      }
      notifyStore();
    } catch {
      // network blip — keep polling
    }
  }, 2_000);
}

async function loadColumnsFromApi(sourceId: string) {
  try {
    const schema = await getColumnSchema(sourceId);
    if (!pipelineState) return;
    pipelineState.columns = (schema.columns || []).map((col: any) => ({
      column_name: col.column_name,
      description: col.description || "",
      type: col.type || "string",
      is_categorical: Boolean(col.is_categorical),
    }));
    pushLog("columns", `${pipelineState.columns.length} colonnes détectées — configurez les colonnes catégorielles`);
    notifyStore();
  } catch (err) {
    pushLog("columns", `Erreur chargement colonnes: ${err instanceof Error ? err.message : String(err)}`);
    notifyStore();
  }
}

export function launchQvdPipeline(file: File) {
  stopPolling();

  pipelineState = {
    jobId: "",
    phase: "uploading",
    wizardStep: "upload",
    sourceId: "",
    filename: file.name,
    elapsed: null,
    error: null,
    logs: [{ ts: new Date().toISOString(), step: "uploading", message: `Upload de ${file.name}…` }],
    results: null,
    columns: [],
    distinctJobId: null,
    distinctPhase: "idle",
    distinctError: null,
    rowsDone: 0,
    chunksDone: 0,
    phaseMessage: "En attente",
    backendPhase: "pending",
    lastLoggedChunks: 0,
  };
  notifyStore();

  (async () => {
    try {
      const resp = await uploadQvdSource(file);
      if (!pipelineState) return;
      pipelineState.jobId = resp.job_id;
      pipelineState.sourceId = resp.source_id;
      pipelineState.phase = "running";
      pushLog("running", `Upload terminé — conversion QVD → Parquet en cours…`);
      startPolling(resp.job_id);
    } catch (err) {
      if (!pipelineState) return;
      pipelineState.phase = "failed";
      pipelineState.error = err instanceof Error ? err.message : String(err);
      pushLog("failed", pipelineState.error);
      notifyStore();
    }
  })();
}

export function getPipelineSourceId(): string | null {
  return pipelineState?.sourceId || null;
}

export function isPipelineActive(): boolean {
  if (!pipelineState) return false;
  if (pipelineState.phase === "uploading" || pipelineState.phase === "running") return true;
  if (pipelineState.distinctPhase === "running") return true;
  return false;
}

// ══════════════════════════════════════════════════════════════════════
// Component
// ══════════════════════════════════════════════════════════════════════

export default function QvdPipelinePopup({
  open,
  onOpenChange,
  onComplete,
}: QvdPipelinePopupProps) {
  useSyncExternalStore(subscribeStore, getStoreSnapshot);

  const state = pipelineState;
  const phase = state?.phase ?? "idle";
  const wizardStep = state?.wizardStep ?? "upload";
  const logs = state?.logs ?? [];
  const elapsed = state?.elapsed ?? null;
  const error = state?.error ?? null;
  const filename = state?.filename ?? "";
  const sourceId = state?.sourceId ?? "";
  const columns = state?.columns ?? [];
  const distinctPhase = state?.distinctPhase ?? "idle";
  const distinctError = state?.distinctError ?? null;
  const rowsDone = state?.rowsDone ?? 0;
  const chunksDone = state?.chunksDone ?? 0;
  const backendPhase = state?.backendPhase ?? "pending";
  const phaseMessage = state?.phaseMessage ?? "";

  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs.length, open]);

  const categoricalColumns = columns.filter((c) => c.is_categorical);

  const handleToggleCategorical = (columnName: string) => {
    if (!pipelineState) return;
    pipelineState.columns = pipelineState.columns.map((c) =>
      c.column_name === columnName ? { ...c, is_categorical: !c.is_categorical } : c
    );
    notifyStore();
  };

  const handleSaveAndContinue = async () => {
    if (!pipelineState || !sourceId) return;

    try {
      const items: SaveColumnSchemaItem[] = pipelineState.columns.map((c) => ({
        column_name: c.column_name,
        description: c.description,
        type: c.type,
        is_categorical: c.is_categorical,
      }));
      await saveColumnSchema(sourceId, null, items);
      pushLog("columns", "Configuration des colonnes sauvegardée");

      if (categoricalColumns.length > 0) {
        pipelineState.wizardStep = "distinct";
        pushLog("distinct", `${categoricalColumns.length} colonne(s) catégorielle(s) sélectionnée(s) — prêt pour la génération`);
      } else {
        pipelineState.wizardStep = "done";
        pushLog("completed", "Configuration terminée — aucune colonne catégorielle");
      }
      notifyStore();
    } catch (err) {
      pushLog("failed", `Erreur sauvegarde: ${err instanceof Error ? err.message : String(err)}`);
      notifyStore();
    }
  };

  const handleGenerateDistinct = async (selectedColumns?: string[]) => {
    if (!pipelineState || !sourceId) return;

    const colsToGenerate = selectedColumns || categoricalColumns.map((c) => c.column_name);
    if (!colsToGenerate.length) return;

    try {
      pipelineState.distinctPhase = "running";
      pipelineState.distinctError = null;
      pushLog("distinct", `Génération des valeurs distinctes pour: ${colsToGenerate.join(", ")}`);
      notifyStore();

      const { job_id } = await launchCategoricalDistinct(sourceId, colsToGenerate);
      pipelineState.distinctJobId = job_id;
      notifyStore();

      const poll = setInterval(async () => {
        try {
          const st = await getCategoricalDistinctStatus(job_id);
          if (!pipelineState || pipelineState.distinctJobId !== job_id) {
            clearInterval(poll);
            return;
          }

          if (st.status === "success") {
            pipelineState.distinctPhase = "success";
            const summaryText = st.summary
              ? Object.entries(st.summary).map(([k, v]) => `${k}: ${v}`).join(", ")
              : "";
            pushLog("completed", `Valeurs distinctes générées${summaryText ? ` (${summaryText})` : ""}`);
            pipelineState.wizardStep = "done";
            clearInterval(poll);
            notifyStore();
          } else if (st.status === "failed") {
            pipelineState.distinctPhase = "failed";
            pipelineState.distinctError = st.error || "Erreur inconnue";
            pushLog("failed", `Erreur: ${st.error || "Erreur inconnue"}`);
            clearInterval(poll);
            notifyStore();
          }
        } catch {
          // network blip
        }
      }, 3_000);
    } catch (err) {
      pipelineState.distinctPhase = "failed";
      pipelineState.distinctError = err instanceof Error ? err.message : String(err);
      pushLog("failed", pipelineState.distinctError);
      notifyStore();
    }
  };

  const handleSkipDistinct = () => {
    if (!pipelineState) return;
    pipelineState.wizardStep = "done";
    pushLog("completed", "Génération des valeurs distinctes ignorée");
    notifyStore();
  };

  const handleClose = () => {
    if (wizardStep === "done" && sourceId) onComplete?.(sourceId);
    if (phase === "completed" && wizardStep === "upload") {
      // completed upload but user closing before column config — still trigger onComplete
    }
    onOpenChange(false);
  };

  const handleRetry = useCallback(() => {
    stopPolling();
    pipelineState = null;
    notifyStore();
    onOpenChange(false);
  }, [onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl bg-[#0a0f1a] border-[#1e293b] text-white p-0 overflow-hidden max-h-[90vh] flex flex-col">
        {/* ── Header ───────────────────────────────────────────── */}
        <div className="bg-gradient-to-r from-[#0D7377]/30 via-[#0a0f1a] to-[#4f46e5]/20 px-6 pt-6 pb-4 border-b border-[#1e293b] flex-shrink-0">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3 text-lg font-semibold text-white">
              <div className="p-2 rounded-lg bg-[#0D7377]/20 border border-[#0D7377]/30">
                <FileText className="w-5 h-5 text-[#0D7377]" />
              </div>
              Pipeline QVD
            </DialogTitle>
            <DialogDescription className="text-slate-400 text-sm mt-1">
              {filename}{sourceId ? ` → ${sourceId}` : ""}
            </DialogDescription>
          </DialogHeader>

          {/* ── Wizard steps indicator ──────────────────────────── */}
          <div className="flex items-center gap-2 mt-4">
            <StepBadge
              step={1}
              label="Upload"
              active={wizardStep === "upload"}
              done={wizardStep !== "upload"}
              error={wizardStep === "upload" && phase === "failed"}
            />
            <ArrowRight className="w-3.5 h-3.5 text-slate-600 flex-shrink-0" />
            <StepBadge
              step={2}
              label="Colonnes"
              active={wizardStep === "columns"}
              done={wizardStep === "distinct" || wizardStep === "done"}
            />
            <ArrowRight className="w-3.5 h-3.5 text-slate-600 flex-shrink-0" />
            <StepBadge
              step={3}
              label="Distinct"
              active={wizardStep === "distinct"}
              done={wizardStep === "done"}
              error={wizardStep === "distinct" && distinctPhase === "failed"}
            />
          </div>
        </div>

        {/* ── Body — scrollable ─────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto">
          {/* ── Step 1: Upload progress ───────────────────────── */}
          {wizardStep === "upload" && (
            <div className="px-6 py-4 space-y-4">
              <ProgressBar
                phase={phase}
                pctEstimate={
                  phase === "completed" ? 100
                    : phase === "failed" ? 0
                    : phase === "uploading" ? 15
                    // Once we have real chunk progress, bias the bar toward
                    // chunks (each chunk ≈ 200k rows). 30 chunks ≈ 6M rows
                    // ≈ a typical large QVD; cap at 95% until completion.
                    : chunksDone > 0
                      ? Math.min(20 + chunksDone * 2.5, 95)
                      : elapsed != null ? Math.min(15 + (elapsed / 60) * 80, 95)
                      : 20
                }
              />

              {/* Live progress line — the backend updates this every chunk.
                  Without it, a 500MB QVD shows "Conversion en cours…" for
                  several minutes with no visible activity. */}
              {phase === "running" && (
                <div className="rounded-lg bg-[#0f1629] border border-[#1e293b]/60 px-3 py-2 text-xs text-slate-300 flex items-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 text-cyan-400 animate-spin flex-shrink-0" />
                  <span className="truncate">
                    {phaseMessage || (
                      chunksDone > 0
                        ? `Conversion en cours — ${rowsDone.toLocaleString("fr-FR")} lignes, ${chunksDone} chunks`
                        : "Conversion en cours — lecture du QVD…"
                    )}
                  </span>
                </div>
              )}

              <div className="grid grid-cols-3 gap-3">
                <StatCard icon={<FileUp className="w-3.5 h-3.5" />} label="Fichier" value={truncFilename(filename)} />
                <StatCard icon={<Clock className="w-3.5 h-3.5" />} label="Temps" value={elapsed != null ? formatDuration(elapsed) : phase === "uploading" ? "Upload…" : "-"} />
                <StatCard
                  icon={<HardDrive className="w-3.5 h-3.5" />}
                  label="Statut"
                  value={
                    phase === "uploading" ? "Upload"
                      : phase === "completed" ? "Terminé"
                      : phase === "failed" ? "Échec"
                      : phase === "running"
                        ? (backendPhase === "archiving" ? "Archivage"
                           : backendPhase === "reading" ? "Lecture"
                           : backendPhase === "writing" ? "Écriture"
                           : backendPhase === "finalizing" ? "Finalisation"
                           : "Conversion")
                        : "-"
                  }
                />
              </div>
            </div>
          )}

          {/* ── Step 2: Column configuration ─────────────────── */}
          {wizardStep === "columns" && (
            <div className="px-6 py-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                    <Columns3 className="w-4 h-4 text-[#0D7377]" />
                    Configurer les colonnes catégorielles
                  </h3>
                  <p className="text-xs text-slate-400 mt-1">
                    Activez les colonnes qui contiennent des valeurs catégorielles (ex: nationalité, ville, type…)
                  </p>
                </div>
                <span className="text-xs text-[#0D7377] font-medium px-2 py-1 rounded-full border border-[#0D7377]/30 bg-[#0D7377]/10">
                  {categoricalColumns.length} sélectionnée{categoricalColumns.length !== 1 ? "s" : ""}
                </span>
              </div>

              <div className="bg-[#060a12] rounded-lg border border-[#1e293b]/60 max-h-64 overflow-y-auto scrollbar-thin scrollbar-thumb-slate-700">
                <div className="divide-y divide-[#1e293b]/40">
                  {columns.map((col) => (
                    <div
                      key={col.column_name}
                      className="flex items-center justify-between px-4 py-2.5 hover:bg-[#0f1629]/50 transition-colors cursor-pointer"
                      onClick={() => handleToggleCategorical(col.column_name)}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${col.is_categorical ? "bg-[#0D7377]" : "bg-slate-600"}`} />
                        <div className="min-w-0">
                          <span className="text-sm text-white font-medium truncate block">{col.column_name}</span>
                          <span className="text-[10px] text-slate-500">{col.type}</span>
                        </div>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleToggleCategorical(col.column_name); }}
                        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                          col.is_categorical ? "bg-[#0D7377]" : "bg-slate-600"
                        }`}
                      >
                        <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                          col.is_categorical ? "translate-x-[18px]" : "translate-x-[3px]"
                        }`} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ── Step 3: Distinct generation ───────────────────── */}
          {wizardStep === "distinct" && (
            <div className="px-6 py-4 space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  <BarChart3 className="w-4 h-4 text-[#0D7377]" />
                  Génération des valeurs distinctes
                </h3>
                <p className="text-xs text-slate-400 mt-1">
                  Générer les valeurs distinctes, définitions et embeddings pour les colonnes catégorielles sélectionnées.
                </p>
              </div>

              {distinctPhase === "running" && (
                <ProgressBar phase="running" pctEstimate={50} />
              )}

              <div className="bg-[#060a12] rounded-lg border border-[#1e293b]/60 p-4 space-y-2">
                {categoricalColumns.map((col) => (
                  <div key={col.column_name} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-[#0D7377]" />
                      <span className="text-sm text-white">{col.column_name}</span>
                    </div>
                    {distinctPhase === "idle" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs text-[#0D7377] hover:text-[#0D7377] hover:bg-[#0D7377]/10 h-7 px-2"
                        onClick={() => handleGenerateDistinct([col.column_name])}
                      >
                        <Sparkles className="w-3 h-3 mr-1" />
                        Seul
                      </Button>
                    )}
                    {distinctPhase === "running" && (
                      <Loader2 className="w-3.5 h-3.5 text-cyan-400 animate-spin" />
                    )}
                    {distinctPhase === "success" && (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    )}
                  </div>
                ))}
              </div>

              {distinctError && (
                <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-3">
                  <p className="text-sm text-red-300 font-medium flex items-center gap-2">
                    <XCircle className="w-4 h-4 flex-shrink-0" />
                    {distinctError}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* ── Step done ─────────────────────────────────────── */}
          {wizardStep === "done" && (
            <div className="px-6 py-8 flex flex-col items-center gap-4">
              <div className="p-4 rounded-full bg-emerald-500/10 border border-emerald-500/20">
                <CheckCircle2 className="w-10 h-10 text-emerald-400" />
              </div>
              <div className="text-center">
                <h3 className="text-lg font-semibold text-white">Pipeline terminé</h3>
                <p className="text-sm text-slate-400 mt-1">
                  La source <span className="text-white font-medium">{sourceId}</span> est prête.
                  {categoricalColumns.length > 0 && distinctPhase === "success"
                    ? ` ${categoricalColumns.length} colonne(s) avec valeurs distinctes.`
                    : " Vous pouvez configurer les embeddings dans l'onglet Studio."}
                </p>
              </div>
            </div>
          )}

          {/* ── Log ──────────────────────────────────────────── */}
          <div className="px-6 pb-2">
            <details className="group">
              <summary className="flex items-center gap-2 text-xs font-medium text-slate-500 uppercase tracking-wider cursor-pointer hover:text-slate-400 transition-colors py-2">
                <Cog className="w-3 h-3 group-open:animate-spin" />
                Journal ({logs.length})
              </summary>
              <div className="bg-[#060a12] rounded-lg border border-[#1e293b]/60 max-h-40 overflow-y-auto scrollbar-thin scrollbar-thumb-slate-700 mb-2">
                <div className="p-3 space-y-1.5">
                  <AnimatePresence mode="popLayout">
                    {logs.map((entry, i) => (
                      <LogRow key={i} entry={entry} />
                    ))}
                  </AnimatePresence>
                  {(phase === "uploading" || phase === "running") && wizardStep === "upload" && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="flex items-center gap-2 text-xs text-slate-500 pt-1"
                    >
                      <Loader2 className="w-3 h-3 animate-spin" />
                      {phase === "uploading"
                        ? "Upload en cours…"
                        : (phaseMessage
                          || (chunksDone > 0
                            ? `Conversion en cours — ${rowsDone.toLocaleString("fr-FR")} lignes, ${chunksDone} chunks`
                            : "Conversion en cours…"))}
                    </motion.div>
                  )}
                  <div ref={logEndRef} />
                </div>
              </div>
            </details>
          </div>
        </div>

        {/* ── Error banner ─────────────────────────────────────── */}
        <AnimatePresence>
          {error && phase === "failed" && wizardStep === "upload" && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="mx-6 mb-2 rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-3 flex-shrink-0"
            >
              <p className="text-sm text-red-300 font-medium flex items-center gap-2">
                <XCircle className="w-4 h-4 flex-shrink-0" />
                {error}
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Footer ───────────────────────────────────────────── */}
        <div className="px-6 pb-5 pt-2 flex justify-between gap-3 border-t border-[#1e293b] flex-shrink-0">
          <div>
            {phase === "failed" && wizardStep === "upload" && (
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
          </div>

          <div className="flex gap-3">
            {wizardStep === "columns" && (
              <Button
                size="sm"
                className="bg-[#0D7377] hover:bg-[#0D7377]/80 text-white"
                onClick={handleSaveAndContinue}
              >
                <ToggleLeft className="w-3.5 h-3.5 mr-1.5" />
                Sauvegarder & Continuer
              </Button>
            )}

            {wizardStep === "distinct" && distinctPhase === "idle" && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="border-slate-600 text-slate-400 hover:bg-slate-700/30"
                  onClick={handleSkipDistinct}
                >
                  Ignorer
                </Button>
                <Button
                  size="sm"
                  className="bg-[#0D7377] hover:bg-[#0D7377]/80 text-white"
                  onClick={() => handleGenerateDistinct()}
                >
                  <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                  Générer tout ({categoricalColumns.length})
                </Button>
              </>
            )}

            {wizardStep === "distinct" && distinctPhase === "failed" && (
              <Button
                size="sm"
                className="bg-orange-600 hover:bg-orange-700 text-white"
                onClick={() => handleGenerateDistinct()}
              >
                <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
                Réessayer
              </Button>
            )}

            <Button
              size="sm"
              className={
                wizardStep === "done"
                  ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                  : "bg-slate-700 hover:bg-slate-600 text-white"
              }
              onClick={handleClose}
            >
              {wizardStep === "done"
                ? "Terminer"
                : (phase === "uploading" || phase === "running") && wizardStep === "upload"
                ? "Masquer"
                : "Fermer"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Sub-components ────────────────────────────────────────────────────

function StepBadge({
  step,
  label,
  active,
  done,
  error,
}: {
  step: number;
  label: string;
  active: boolean;
  done: boolean;
  error?: boolean;
}) {
  const bg = error
    ? "bg-red-500/20 border-red-500/40 text-red-300"
    : active
    ? "bg-[#0D7377]/20 border-[#0D7377]/40 text-[#0D7377]"
    : done
    ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
    : "bg-slate-800/50 border-slate-700 text-slate-500";

  return (
    <div className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${bg}`}>
      {done && !active ? (
        <CheckCircle2 className="w-3 h-3" />
      ) : error ? (
        <XCircle className="w-3 h-3" />
      ) : (
        <span className="w-3.5 h-3.5 rounded-full border border-current flex items-center justify-center text-[9px] font-bold">
          {step}
        </span>
      )}
      {label}
    </div>
  );
}

function ProgressBar({ phase, pctEstimate }: { phase: string; pctEstimate: number }) {
  return (
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
        animate={{ width: `${pctEstimate}%` }}
        transition={{ duration: 0.6, ease: "easeOut" }}
      />
      {(phase === "uploading" || phase === "running") && (
        <motion.div
          className="absolute inset-y-0 left-0 w-full bg-gradient-to-r from-transparent via-white/10 to-transparent"
          animate={{ x: ["-100%", "100%"] }}
          transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
        />
      )}
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="bg-[#0f1629] rounded-lg border border-[#1e293b]/60 px-3 py-2">
      <div className="flex items-center gap-1.5 text-slate-500 mb-1">
        {icon}
        <span className="text-[10px] uppercase tracking-wider font-medium">{label}</span>
      </div>
      <div className="text-sm font-semibold text-white leading-none truncate">
        {value}
      </div>
    </div>
  );
}

const STEP_ICONS: Record<string, React.ElementType> = {
  uploading: FileUp,
  pending: Clock,
  running: Cog,
  converting: Database,
  completed: CheckCircle2,
  failed: XCircle,
  columns: Columns3,
  distinct: BarChart3,
};

const STEP_COLORS: Record<string, string> = {
  uploading: "text-blue-400",
  pending: "text-amber-400",
  running: "text-teal-400",
  converting: "text-cyan-400",
  completed: "text-emerald-400",
  failed: "text-red-400",
  columns: "text-purple-400",
  distinct: "text-orange-400",
};

function LogRow({ entry }: { entry: LogEntry }) {
  const Icon = STEP_ICONS[entry.step] || FileCheck2;
  const color = STEP_COLORS[entry.step] || "text-slate-400";

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.15 }}
      className="flex items-start gap-2.5 text-xs leading-relaxed"
    >
      <Icon className={`w-3.5 h-3.5 mt-0.5 flex-shrink-0 ${color}`} />
      <span className="text-slate-300 break-all">{entry.message}</span>
      {entry.ts && (
        <span className="ml-auto text-[10px] text-slate-600 flex-shrink-0 tabular-nums">
          {new Date(entry.ts).toLocaleTimeString("fr-FR", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}
        </span>
      )}
    </motion.div>
  );
}

function truncFilename(name: string): string {
  return name.length > 20 ? name.slice(0, 18) + "…" : name || "-";
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
