import { useEffect, useRef, useSyncExternalStore } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
    FileSpreadsheet,
    FileCheck2,
    CheckCircle2,
    XCircle,
    Loader2,
    Clock,
    HardDrive,
    Cog,
    RotateCcw,
    AlertTriangle,
} from "lucide-react";
import {
    uploadXlsxSources,
    getXlsxPipelineStatus,
    type XlsxPipelineStatus,
    type XlsxFileEntry,
} from "@/lib/parquet_api";

interface XlsxPipelinePopupProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onComplete?: (sourceIds: string[]) => void;
}

type Phase = "idle" | "uploading" | "running" | "completed" | "partial" | "failed";

interface LogEntry {
    ts: string;
    step: string;
    message: string;
}

interface PipelineState {
    jobId: string;
    phase: Phase;
    filenames: string[];
    sourceIds: string[];
    files: XlsxFileEntry[];
    elapsed: number | null;
    error: string | null;
    logs: LogEntry[];
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

function startPolling(jobId: string, onComplete?: (sourceIds: string[]) => void) {
    stopPolling();
    pollTimer = setInterval(async () => {
        try {
            const st: XlsxPipelineStatus = await getXlsxPipelineStatus(jobId);
            if (!pipelineState || pipelineState.jobId !== jobId) {
                stopPolling();
                return;
            }

            pipelineState.elapsed = st.elapsed_seconds;
            pipelineState.files = st.files;

            const newlyCompleted = st.files.filter(
                (f) => f.status === "completed" &&
                       !pipelineState!.logs.some(
                           (l) => l.step === "completed" && l.message.includes(f.filename)
                       ),
            );
            for (const f of newlyCompleted) {
                pushLog(
                    "completed",
                    `${f.filename} → ${f.source_id} (${f.results?.row_count ?? "?"} lignes, ${f.results?.column_count ?? "?"} colonnes)`,
                );
            }

            const newlyFailed = st.files.filter(
                (f) => f.status === "failed" &&
                       !pipelineState!.logs.some(
                           (l) => l.step === "failed" && l.message.includes(f.filename)
                       ),
            );
            for (const f of newlyFailed) {
                pushLog("failed", `${f.filename}: ${f.error || "Erreur inconnue"}`);
            }

            if (st.status === "completed") {
                pipelineState.phase = "completed";
                pushLog(
                    "completed",
                    `Pipeline terminé — ${st.completed_files}/${st.total_files} fichier(s)`,
                );
                stopPolling();
                onComplete?.(st.files.map((f) => f.source_id));
            } else if (st.status === "partial") {
                pipelineState.phase = "partial";
                pushLog(
                    "completed",
                    `Pipeline partiellement terminé — ${st.completed_files}/${st.total_files} OK, ${st.failed_files} échec(s)`,
                );
                stopPolling();
                const okIds = st.files
                    .filter((f) => f.status === "completed")
                    .map((f) => f.source_id);
                if (okIds.length) onComplete?.(okIds);
            } else if (st.status === "failed") {
                pipelineState.phase = "failed";
                pipelineState.error = st.error || "Pipeline XLSX échoué";
                pushLog("failed", pipelineState.error);
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

export function launchXlsxPipeline(
    files: File[],
    onComplete?: (sourceIds: string[]) => void,
) {
    stopPolling();

    const filenames = files.map((f) => f.name);
    pipelineState = {
        jobId: "",
        phase: "uploading",
        filenames,
        sourceIds: [],
        files: [],
        elapsed: null,
        error: null,
        logs: [
            {
                ts: new Date().toISOString(),
                step: "uploading",
                message: `Upload de ${files.length} fichier(s) Excel : ${filenames.join(", ")}`,
            },
        ],
    };
    notifyStore();

    (async () => {
        try {
            const resp = await uploadXlsxSources(files);
            if (!pipelineState) return;
            pipelineState.jobId = resp.job_id;
            pipelineState.sourceIds = resp.source_ids;
            pipelineState.phase = "running";
            pushLog(
                "running",
                `Upload terminé — pipeline XLSX → Parquet en cours pour ${resp.file_count} fichier(s)`,
            );
            startPolling(resp.job_id, onComplete);
        } catch (err) {
            if (!pipelineState) return;
            pipelineState.phase = "failed";
            pipelineState.error = err instanceof Error ? err.message : String(err);
            pushLog("failed", pipelineState.error);
            notifyStore();
        }
    })();
}

export function isXlsxPipelineActive(): boolean {
    if (!pipelineState) return false;
    return pipelineState.phase === "uploading" || pipelineState.phase === "running";
}

export function resetXlsxPipeline() {
    stopPolling();
    pipelineState = null;
    notifyStore();
}

export default function XlsxPipelinePopup({
    open,
    onOpenChange,
    onComplete,
}: XlsxPipelinePopupProps) {
    useSyncExternalStore(subscribeStore, getStoreSnapshot);

    const state = pipelineState;
    const phase = state?.phase ?? "idle";
    const logs = state?.logs ?? [];
    const elapsed = state?.elapsed ?? null;
    const error = state?.error ?? null;
    const files = state?.files ?? [];
    const filenames = state?.filenames ?? [];
    const total = files.length || filenames.length;
    const completed = files.filter((f) => f.status === "completed").length;
    const failed = files.filter((f) => f.status === "failed").length;

    const logEndRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (open) logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [logs.length, open]);

    useEffect(() => {
        if (!open || !state || !onComplete) return;
        if (state.phase === "completed" || state.phase === "partial") {
            const okIds = state.files
                .filter((f) => f.status === "completed")
                .map((f) => f.source_id);
            if (okIds.length) onComplete(okIds);
        }
    }, [open, phase, onComplete]); // eslint-disable-line react-hooks/exhaustive-deps

    const overallPct = total === 0
        ? (phase === "uploading" ? 15 : 0)
        : phase === "uploading"
        ? 15
        : phase === "completed"
        ? 100
        : Math.min(15 + ((completed + failed) / total) * 85, 99);

    const handleClose = () => {
        onOpenChange(false);
    };

    const handleRetry = () => {
        resetXlsxPipeline();
        onOpenChange(false);
    };

    return (
        <Dialog open={open} onOpenChange={handleClose}>
            <DialogContent className="max-w-2xl bg-[#0a0f1a] border-[#1e293b] text-white p-0 overflow-hidden max-h-[90vh] flex flex-col">
                {/* ── Header ─────────────────────────────────────── */}
                <div className="bg-gradient-to-r from-[#0D7377]/30 via-[#0a0f1a] to-[#4f46e5]/20 px-6 pt-6 pb-4 border-b border-[#1e293b] flex-shrink-0">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-3 text-lg font-semibold text-white">
                            <div className="p-2 rounded-lg bg-[#0D7377]/20 border border-[#0D7377]/30">
                                <FileSpreadsheet className="w-5 h-5 text-[#0D7377]" />
                            </div>
                            Pipeline Excel
                        </DialogTitle>
                        <DialogDescription className="text-slate-400 text-sm mt-1">
                            {total} fichier(s) · {completed} terminé(s)
                            {failed > 0 ? ` · ${failed} échec(s)` : ""}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="grid grid-cols-3 gap-3 mt-4">
                        <StatCard
                            icon={<FileSpreadsheet className="w-3.5 h-3.5" />}
                            label="Fichiers"
                            value={`${completed}/${total || filenames.length}`}
                        />
                        <StatCard
                            icon={<Clock className="w-3.5 h-3.5" />}
                            label="Temps"
                            value={elapsed != null ? formatDuration(elapsed) : phase === "uploading" ? "Upload…" : "-"}
                        />
                        <StatCard
                            icon={<HardDrive className="w-3.5 h-3.5" />}
                            label="Statut"
                            value={
                                phase === "uploading"
                                    ? "Upload"
                                    : phase === "running"
                                    ? "Conversion"
                                    : phase === "completed"
                                    ? "Terminé"
                                    : phase === "partial"
                                    ? "Partiel"
                                    : phase === "failed"
                                    ? "Échec"
                                    : "-"
                            }
                        />
                    </div>
                </div>

                {/* ── Body ─────────────────────────────────────── */}
                <div className="flex-1 overflow-y-auto">
                    <div className="px-6 py-4 space-y-4">
                        <ProgressBar phase={phase} pctEstimate={overallPct} />

                        {/* Per-file list */}
                        <div className="bg-[#060a12] rounded-lg border border-[#1e293b]/60 max-h-72 overflow-y-auto scrollbar-thin scrollbar-thumb-slate-700">
                            <div className="divide-y divide-[#1e293b]/40">
                                {files.length === 0 && filenames.length > 0 && (
                                    filenames.map((name, i) => (
                                        <FileRow
                                            key={`pending-${i}-${name}`}
                                            name={name}
                                            status="pending"
                                            sourceId=""
                                            error={null}
                                            rows={null}
                                            cols={null}
                                        />
                                    ))
                                )}
                                {files.map((f, i) => (
                                    <FileRow
                                        key={`${i}-${f.filename}`}
                                        name={f.filename}
                                        status={f.status}
                                        sourceId={f.source_id}
                                        error={f.error}
                                        rows={f.results?.row_count ?? null}
                                        cols={f.results?.column_count ?? null}
                                    />
                                ))}
                            </div>
                        </div>

                        {/* Log */}
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
                                    {(phase === "uploading" || phase === "running") && (
                                        <motion.div
                                            initial={{ opacity: 0 }}
                                            animate={{ opacity: 1 }}
                                            className="flex items-center gap-2 text-xs text-slate-500 pt-1"
                                        >
                                            <Loader2 className="w-3 h-3 animate-spin" />
                                            {phase === "uploading" ? "Upload en cours…" : "Conversion en cours…"}
                                        </motion.div>
                                    )}
                                    <div ref={logEndRef} />
                                </div>
                            </div>
                        </details>
                    </div>
                </div>

                {/* Error banner */}
                <AnimatePresence>
                    {error && phase === "failed" && (
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

                {/* Footer */}
                <div className="px-6 pb-5 pt-2 flex justify-between gap-3 border-t border-[#1e293b] flex-shrink-0">
                    <div>
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
                    </div>

                    <div className="flex gap-3">
                        <Button
                            size="sm"
                            className={
                                phase === "completed"
                                    ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                                    : phase === "partial"
                                    ? "bg-amber-600 hover:bg-amber-700 text-white"
                                    : "bg-slate-700 hover:bg-slate-600 text-white"
                            }
                            onClick={handleClose}
                        >
                            {phase === "completed"
                                ? "Terminer"
                                : phase === "partial"
                                ? "Fermer (partiel)"
                                : phase === "uploading" || phase === "running"
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

function FileRow({
    name,
    status,
    sourceId,
    error,
    rows,
    cols,
}: {
    name: string;
    status: "pending" | "running" | "completed" | "failed";
    sourceId: string;
    error: string | null;
    rows: number | null;
    cols: number | null;
}) {
    const StatusIcon =
        status === "completed"
            ? CheckCircle2
            : status === "failed"
            ? XCircle
            : status === "running"
            ? Loader2
            : Clock;
    const color =
        status === "completed"
            ? "text-emerald-400"
            : status === "failed"
            ? "text-red-400"
            : status === "running"
            ? "text-cyan-400"
            : "text-slate-500";

    return (
        <div className="flex items-start justify-between gap-3 px-4 py-2.5">
            <div className="flex items-start gap-3 min-w-0">
                <StatusIcon
                    className={`w-4 h-4 mt-0.5 flex-shrink-0 ${color} ${status === "running" ? "animate-spin" : ""}`}
                />
                <div className="min-w-0">
                    <span className="text-sm text-white font-medium truncate block">{name}</span>
                    {sourceId && (
                        <span className="text-[10px] text-slate-500 font-mono truncate block">
                            {sourceId}
                        </span>
                    )}
                    {error && (
                        <span className="text-[11px] text-red-300 mt-0.5 flex items-center gap-1">
                            <AlertTriangle className="w-3 h-3" />
                            {error}
                        </span>
                    )}
                </div>
            </div>
            {status === "completed" && rows != null && cols != null && (
                <div className="text-right flex-shrink-0">
                    <span className="text-xs text-slate-300 tabular-nums">
                        {rows.toLocaleString("fr-FR")} l. × {cols} c.
                    </span>
                </div>
            )}
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
                        : phase === "partial"
                        ? "bg-amber-500"
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
    uploading: FileSpreadsheet,
    pending: Clock,
    running: Cog,
    completed: CheckCircle2,
    failed: XCircle,
};

const STEP_COLORS: Record<string, string> = {
    uploading: "text-blue-400",
    pending: "text-amber-400",
    running: "text-teal-400",
    completed: "text-emerald-400",
    failed: "text-red-400",
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

function formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds.toFixed(0)}s`;
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    if (m < 60) return `${m}m${s.toString().padStart(2, "0")}s`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return `${h}h${rm.toString().padStart(2, "0")}m`;
}
