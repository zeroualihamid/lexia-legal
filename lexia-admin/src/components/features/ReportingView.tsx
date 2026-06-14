import React from "react";
import { motion } from "framer-motion";
import {
    ChevronRight,
    Send,
    Sparkles,
    PlayCircle,
    Wand2,
    Loader2,
    AlertTriangle,
    CheckCircle2,
    RefreshCw,
    Settings2,
    PenLine,
    BookOpen,
    ListChecks,
    Code2,
    ChevronDown,
    Eye,
    Boxes,
    Play,
    Sliders,
    Database,
    Save,
    RotateCcw,
    FileText,
    Printer,
    Plus,
    Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
    listReportTemplates,
    getReportDefinitions,
    getReportTokens,
    startReportBootstrap,
    seedReportDefinitionsSkeleton,
    renderReportSync,
    startReportEditAgent,
    streamReportEvents,
    getReportBootstrapStatus,
    getReportEditAgentStatus,
    previewReportBlock,
    getReportBlockSqlSource,
    generateInsuranceProductionCte,
    type ReportTemplateInfo,
    type ReportDefinitions,
    type ReportBlockDefinition,
    type ReportBlockSubCte,
    type ReportBlockKind,
    type ReportTokens,
    type ReportTokenBlock,
    type ReportEvent,
    type RenderResult,
    type BlockPreviewResult,
    type BlockSqlSourceResult,
    type GenerateInsuranceCteResponse,
    type ParquetFileEntry,
    saveReportBlockCte,
    saveReportTemplateHtml,
    updateReportTemplateParameters,
    upsertReportBlock,
    type ReportTemplateParameter,
} from "@/lib/reporting_api";
import { mergeReportingTemplateAssets } from "@/lib/reportingCssFallback";

type ReportingViewProps = {
    onClose: () => void;
    isAgentWorkspace?: boolean;
    initialTemplateId?: string | null;
};

type Tab = "definitions" | "chat" | "render";

type ChatMessage =
    | { kind: "user"; content: string }
    | { kind: "assistant"; content: string }
    | { kind: "tool"; tool: string; status: string; preview?: string }
    | { kind: "thinking"; content: string }
    | { kind: "error"; content: string };


const KIND_BADGE_STYLES: Record<string, string> = {
    scalar:      "border-blue-200 bg-blue-50 text-blue-700",
    section:     "border-emerald-200 bg-emerald-50 text-emerald-700",
    condition:   "border-violet-200 bg-violet-50 text-violet-700",
    narrative:   "border-amber-200 bg-amber-50 text-amber-700",
    chart_array: "border-rose-200 bg-rose-50 text-rose-700",
    mixed:       "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700",
    empty:       "border-zinc-200 bg-zinc-50 text-zinc-500",
};

const STATUS_BADGE_STYLES: Record<string, string> = {
    live:       "border-emerald-200 bg-emerald-50 text-emerald-700",
    validated:  "border-blue-200 bg-blue-50 text-blue-700",
    draft:      "border-amber-200 bg-amber-50 text-amber-700",
    invalid:    "border-red-200 bg-red-50 text-red-700",
    deprecated: "border-zinc-200 bg-zinc-50 text-zinc-500 line-through",
    skeleton:   "border-dashed border-zinc-300 bg-zinc-50 text-zinc-500",
};


/**
 * Synthetic block used in the merged list when a tagged ``data-block``
 * has no entry yet in ``definitions.yaml``.  Carries
 * ``status: "skeleton"`` so :class:`BlockCard` can render the
 * "(non défini — utiliser l'agent)" placeholder instead of a SQL
 * block.
 *
 * ``_scan`` carries the scanner-side metadata (inner DSL inventory,
 * line, html excerpt) so the card can render the contextual badges
 * and the visual preview can locate the block in the source HTML.
 */
type MergedBlock = ReportBlockDefinition & {
    _isSkeleton?: boolean;
    _scan?: ReportTokenBlock;
};

type AgentHandoffIntent = "definition" | "layout";

type VisualCandidatePayload = {
    action?: "add" | "revoke";
    candidateKey?: number;
    blockId?: string;
    tagName?: string;
    outerHtml?: string;
    className?: string;
    id?: string;
    textPreview?: string;
};

function normalizeSnakeCaseSegment(value: string): string {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
}

function buildUniqueDataBlockName(
    payload: VisualCandidatePayload,
    existingNames: Iterable<string>,
): string {
    const existing = new Set(Array.from(existingNames));
    const classTokens = String(payload.className || "")
        .split(/\s+/)
        .map(normalizeSnakeCaseSegment)
        .filter((token) => token && !token.startsWith("qclick_"));
    const textTokens = String(payload.textPreview || "")
        .split(/\s+/)
        .map(normalizeSnakeCaseSegment)
        .filter(Boolean);
    let base = normalizeSnakeCaseSegment(String(payload.id || ""));
    if (!base) base = classTokens.slice(0, 2).join("_");
    if (!base) base = textTokens.slice(0, 4).join("_");
    if (!base) base = "new_block";
    if (!/^[a-z_]/.test(base)) {
        base = `block_${base}`;
    }
    let candidate = base;
    let index = 2;
    while (existing.has(candidate)) {
        candidate = `${base}_${index}`;
        index += 1;
    }
    return candidate;
}

function insertDataBlockAttribute(
    rawHtml: string,
    candidateKey: number,
    blockName: string,
): string | null {
    const divRe = /<div\b([^>]*)>/gi;
    let match: RegExpExecArray | null;
    let currentKey = 0;
    while ((match = divRe.exec(rawHtml)) !== null) {
        const full = match[0];
        const attrs = match[1] || "";
        if (/\bdata-block\s*=/.test(attrs)) continue;
        if (currentKey !== candidateKey) {
            currentKey += 1;
            continue;
        }
        const insertion = ` data-block="${blockName}"`;
        const patched = full.replace(/^<div\b/i, `<div${insertion}`);
        return rawHtml.slice(0, match.index) + patched + rawHtml.slice(match.index + full.length);
    }
    return null;
}

function revokeDataBlockAttribute(
    rawHtml: string,
    blockName: string,
): string | null {
    if (!blockName) return null;
    const escaped = blockName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const tagRe = new RegExp(
        `<([A-Za-z][A-Za-z0-9-]*)([^>]*?)\\sdata-block\\s*=\\s*"${escaped}"([^>]*)>`,
        "i",
    );
    const match = tagRe.exec(rawHtml);
    if (!match) return null;
    const [full, tag, beforeAttrs, afterAttrs] = match;
    const mergedAttrs = `${beforeAttrs}${afterAttrs}`
        .replace(/\s{2,}/g, " ")
        .replace(/\s+$/, "");
    const patched = `<${tag}${mergedAttrs}>`;
    return rawHtml.slice(0, match.index) + patched + rawHtml.slice(match.index + full.length);
}


function inferKind(scan: ReportTokenBlock | undefined): ReportBlockKind {
    return (scan?.kind as ReportBlockKind | undefined) ?? "empty";
}


/* ── Shared parameter pool ────────────────────────────────────────────────
 *
 * Every block's CTE may reference ``$params`` (either inline or via an
 * ``{{include: …}}`` file).  Rather than asking the user to retype the
 * same ``client_name`` / ``period`` / ``year`` for each block, we keep
 * a single pool keyed by canonical (lower-cased) param name and pass
 * it down to every ``BlockCard``.  Values persist per-template in
 * ``localStorage`` so a refresh doesn't wipe them.
 */

const _PARAM_RE = /\$([A-Za-z_][A-Za-z0-9_]*)/g;

function extractDollarParams(sql: string | undefined | null): string[] {
    if (!sql) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = _PARAM_RE.exec(sql)) !== null) {
        const name = m[1].toLowerCase();
        if (!seen.has(name)) {
            seen.add(name);
            out.push(name);
        }
    }
    return out;
}


function _escapeHtmlText(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/**
 * Replace ``{{TOKEN}}`` placeholders with values from the shared pool
 * (keys lower-case: ``report_title`` → ``{{REPORT_TITLE}}``).  Only
 * non-empty trimmed values replace; others keep the placeholder.  Used
 * for HTML previews so the layout reflects what the user typed under
 * Paramètres.
 */
function applyTemplateScalarSubstitutions(
    html: string,
    params: Record<string, string> | undefined | null,
): string {
    if (!html) return html;
    if (!params || Object.keys(params).length === 0) return html;
    const lowered: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) {
        if (v != null) lowered[String(k).toLowerCase()] = String(v);
    }
    return html.replace(
        /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g,
        (full, token: string) => {
            const key = String(token).toLowerCase();
            const raw = (lowered[key] ?? "").trim();
            if (!raw) return full;
            return _escapeHtmlText(raw);
        },
    );
}

function useResolvedBlockSqlSource(
    templateId: string | undefined,
    blockId: string,
    subBlockId: string | null | undefined,
    enabled: boolean,
) {
    const [result, setResult] = React.useState<BlockSqlSourceResult | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        let cancelled = false;
        if (!enabled || !templateId || !blockId) {
            setResult(null);
            setLoading(false);
            setError(null);
            return;
        }
        setLoading(true);
        setError(null);
        getReportBlockSqlSource(templateId, blockId, subBlockId)
            .then((data) => {
                if (cancelled) return;
                setResult(data);
            })
            .catch((err: any) => {
                if (cancelled) return;
                setError(String(err?.detail ?? err?.message ?? err));
                setResult(null);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [templateId, blockId, subBlockId, enabled]);

    return { result, loading, error };
}

const ResolvedCteMeta: React.FC<{
    cteName?: string | null;
    sourcePath?: string | null;
}> = ({ cteName, sourcePath }) => {
    if (!cteName && !sourcePath) return null;
    return (
        <div className="mt-2 grid gap-2 md:grid-cols-2">
            {cteName && (
                <div className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-sky-700">
                        Nom de la CTE
                    </p>
                    <code className="mt-1 block break-words font-semibold">
                        {cteName}
                    </code>
                </div>
            )}
            {sourcePath && (
                <div className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-sky-700">
                        Chemin
                    </p>
                    <code className="mt-1 block break-words font-semibold">
                        {sourcePath}
                    </code>
                </div>
            )}
        </div>
    );
}

function _paramStorageKey(templateId: string | undefined): string | null {
    return templateId ? `reporting:globalparams:${templateId}` : null;
}

/**
 * Read a JSON object from ``localStorage`` synchronously.
 *
 * Used to initialise React state so the subsequent persist effect never
 * runs with a stale ``{}`` on first mount — that used to overwrite the
 * saved pool when switching tabs (DefinitionsPane unmount → remount).
 */
function _readLocalStorageRecord(key: string | null): Record<string, string> {
    if (!key) return {};
    try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, string>;
        }
        return {};
    } catch {
        return {};
    }
}

function useSharedParameterPool(templateId: string | undefined) {
    const [values, setValues] = React.useState<Record<string, string>>(() =>
        _readLocalStorageRecord(_paramStorageKey(templateId)),
    );

    React.useEffect(() => {
        setValues(_readLocalStorageRecord(_paramStorageKey(templateId)));
    }, [templateId]);

    React.useEffect(() => {
        const key = _paramStorageKey(templateId);
        if (!key) return;
        try {
            window.localStorage.setItem(key, JSON.stringify(values));
        } catch {
            /* localStorage is best-effort; quota errors are not fatal. */
        }
    }, [templateId, values]);

    const setOne = React.useCallback((name: string, value: string) => {
        setValues((prev) => ({ ...prev, [name.toLowerCase()]: value }));
    }, []);

    const clearOne = React.useCallback((name: string) => {
        setValues((prev) => {
            const next = { ...prev };
            delete next[name.toLowerCase()];
            return next;
        });
    }, []);

    return { values, setValues, setOne, clearOne };
}


/* ── Parquet source selection ─────────────────────────────────────────────
 *
 * Each ``definitions.sources[*].name`` (typically ``ledger``) needs a
 * parquet file to be turned into a DuckDB view at preview / render
 * time.  The backend auto-discovers files under ``data/parquet/`` and
 * the user picks one via the ``ParquetSourcePanel``.  Selections are
 * persisted per template in ``localStorage`` and forwarded to every
 * block preview as ``parquet_paths``.
 */

function _parquetStorageKey(templateId: string | undefined): string | null {
    return templateId ? `reporting:parquetpaths:${templateId}` : null;
}

function useParquetSourceSelection(templateId: string | undefined) {
    const [paths, setPaths] = React.useState<Record<string, string>>(() =>
        _readLocalStorageRecord(_parquetStorageKey(templateId)),
    );

    React.useEffect(() => {
        setPaths(_readLocalStorageRecord(_parquetStorageKey(templateId)));
    }, [templateId]);

    React.useEffect(() => {
        const key = _parquetStorageKey(templateId);
        if (!key) return;
        try {
            window.localStorage.setItem(key, JSON.stringify(paths));
        } catch {
            /* localStorage is best-effort; quota errors are not fatal. */
        }
    }, [templateId, paths]);

    const setOne = React.useCallback((source: string, path: string) => {
        setPaths((prev) => {
            const next = { ...prev };
            if (path) next[source] = path;
            else delete next[source];
            return next;
        });
    }, []);

    return { paths, setOne, setAll: setPaths };
}


/**
 * Merge tagged template blocks (from ``ReportTokens.tokens.blocks``)
 * with the YAML block list.  Tagged blocks that have no YAML entry
 * surface as ``skeleton`` placeholders ready to be drafted by the
 * agent, while YAML entries whose ``data-block`` marker has been
 * removed from the template are appended at the bottom marked
 * ``deprecated`` (kept for history / restoration).
 */
function mergeBlocks(
    tokens: ReportTokens | null,
    definitions: ReportDefinitions | null,
): MergedBlock[] {
    const byId: Record<string, ReportBlockDefinition> = {};
    for (const b of definitions?.blocks ?? []) byId[b.id] = b;

    const scanned = tokens?.tokens?.blocks ?? [];
    const merged: MergedBlock[] = [];
    const seen = new Set<string>();

    for (const scan of scanned) {
        seen.add(scan.name);
        const live = byId[scan.name];
        if (live) {
            merged.push({ ...live, _scan: scan });
        } else {
            merged.push({
                id:   scan.name,
                kind: inferKind(scan),
                goal: "(bloc scanné — pas encore défini)",
                tokens: [
                    ...scan.inner_scalars,
                    ...scan.inner_sections,
                    ...scan.inner_conditions,
                    ...scan.inner_narratives.map((n) => `NARRATIVE:${n}`),
                    ...scan.inner_chart_arrays,
                ],
                depends_on: [],
                sql:        "",
                status:     "skeleton",
                _isSkeleton: true,
                _scan:      scan,
            });
        }
    }

    for (const b of definitions?.blocks ?? []) {
        if (!seen.has(b.id)) merged.push(b);
    }
    return merged;
}


/* ─────────────────────────────────────────────────────────────────────────
 * Component
 * ──────────────────────────────────────────────────────────────────────── */

const ReportingView: React.FC<ReportingViewProps> = ({
    onClose,
    isAgentWorkspace = true,
    initialTemplateId = null,
}) => {
    const [templates, setTemplates] = React.useState<ReportTemplateInfo[]>([]);
    const [selectedId, setSelectedId] = React.useState<string | null>(initialTemplateId);
    const [definitions, setDefinitions] = React.useState<ReportDefinitions | null>(null);
    const [tokens, setTokens] = React.useState<ReportTokens | null>(null);
    const [tokensLoading, setTokensLoading] = React.useState(false);
    const [activeTab, setActiveTab] = React.useState<Tab>("chat");
    const [loadingDefs, setLoadingDefs] = React.useState(false);
    const [globalError, setGlobalError] = React.useState<string | null>(null);

    // ── Bootstrap state ──────────────────────────────────────────────────
    const [bootstrapJobId, setBootstrapJobId] = React.useState<string | null>(null);
    const [bootstrapEvents, setBootstrapEvents] = React.useState<ReportEvent[]>([]);
    const [bootstrapPhase, setBootstrapPhase] = React.useState<"idle" | "running" | "completed" | "failed">("idle");
    const bootstrapUnsub = React.useRef<(() => void) | null>(null);
    /** Prevents duplicate auto-seed while staying on the same template after a failed run. */
    const autoSeedAttemptedRef = React.useRef<string | null>(null);

    // ── Render state ─────────────────────────────────────────────────────
    const [renderResult, setRenderResult] = React.useState<RenderResult | null>(null);
    const [rendering, setRendering] = React.useState(false);
    const [renderError, setRenderError] = React.useState<string | null>(null);
    const [renderParams, setRenderParams] = React.useState("{}");

    // ── Edit-agent (chat) state ──────────────────────────────────────────
    const [chatMessages, setChatMessages] = React.useState<ChatMessage[]>([]);
    const [chatInput, setChatInput] = React.useState("");
    const [chatJobId, setChatJobId] = React.useState<string | null>(null);
    const [chatPhase, setChatPhase] = React.useState<"idle" | "running" | "completed" | "failed">("idle");
    const chatUnsub = React.useRef<(() => void) | null>(null);
    const chatScrollRef = React.useRef<HTMLDivElement | null>(null);
    /** Block opened via « Modifier avec l'agent » — shown next to chat (prompt + SQL). */
    const [agentFocusBlock, setAgentFocusBlock] = React.useState<MergedBlock | null>(null);
    const [agentFocusIntent, setAgentFocusIntent] = React.useState<AgentHandoffIntent>("layout");

    /** Shared ``$param`` / Paramètres pool — lifted so chat-tab HTML previews see the same values. */
    const globalParams = useSharedParameterPool(selectedId ?? undefined);

    /** Shared parquet source selection (one path per ``definitions.sources[*].name``).
     *
     *  Lifted to the parent so the user's selection in the
     *  ``ParquetSourcePanel`` (Définitions tab) flows directly into
     *  ``handleRender`` (Rendu HTML tab) — clicking « Lancer le rendu »
     *  regenerates the report against the parquet files the user just
     *  picked, instead of relying on the backend's auto-detection. */
    const parquetSelection = useParquetSourceSelection(selectedId ?? undefined);

    /* ── Initial load ───────────────────────────────────────────────── */
    React.useEffect(() => {
        if (initialTemplateId) {
            setSelectedId(initialTemplateId);
        }
    }, [initialTemplateId]);

    React.useEffect(() => {
        listReportTemplates()
            .then((items) => {
                setTemplates(items);
                if (items.length > 0) {
                    setSelectedId((prev) => {
                        if (initialTemplateId && items.some((item) => item.template_id === initialTemplateId)) {
                            return initialTemplateId;
                        }
                        if (prev && items.some((item) => item.template_id === prev)) {
                            return prev;
                        }
                        return items[0].template_id;
                    });
                }
            })
            .catch((e) => setGlobalError(`Impossible de charger les templates : ${e}`));
        return () => {
            bootstrapUnsub.current?.();
            chatUnsub.current?.();
        };
    }, [initialTemplateId]);

    /* ── Reload definitions when template changes ─────────────────────── */
    const reloadDefinitions = React.useCallback(async () => {
        if (!selectedId) return;
        setLoadingDefs(true);
        try {
            const d = await getReportDefinitions(selectedId);
            setDefinitions(d);
        } catch (e: any) {
            const msg = String(e?.message ?? e);
            if (msg.includes("404")) {
                setDefinitions(null);
            } else {
                setGlobalError(`Erreur de chargement des définitions : ${msg}`);
            }
        } finally {
            setLoadingDefs(false);
        }
    }, [selectedId]);

    /* ── Load the scanned token inventory (no-LLM, free) ──────────────── */
    const loadTokens = React.useCallback(async () => {
        if (!selectedId) return;
        setTokensLoading(true);
        try {
            const t = await getReportTokens(selectedId);
            setTokens(t);
        } catch (e: any) {
            setGlobalError(`Impossible de scanner le template : ${String(e?.message ?? e)}`);
        } finally {
            setTokensLoading(false);
        }
    }, [selectedId]);

    React.useEffect(() => {
        setDefinitions(null);
        setTokens(null);
        setRenderResult(null);
        setChatMessages([]);
        setBootstrapEvents([]);
        setBootstrapPhase("idle");
        setBootstrapJobId(null);
        setChatJobId(null);
        setChatPhase("idle");
        setAgentFocusBlock(null);
        autoSeedAttemptedRef.current = null;
        bootstrapUnsub.current?.();
        chatUnsub.current?.();
        if (selectedId) {
            reloadDefinitions();
            loadTokens();
        }
    }, [selectedId, reloadDefinitions, loadTokens]);

    React.useEffect(() => {
        const params = definitions?.parameters ?? [];
        if (params.length === 0) return;
        globalParams.setValues((prev) => {
            let changed = false;
            const next = { ...prev };
            for (const p of params) {
                const pid = String(p?.id || "").trim().toLowerCase();
                if (!pid) continue;
                const current = String(next[pid] ?? "").trim();
                if (current !== "") continue;
                if (p?.default === undefined || p?.default === null) continue;
                next[pid] = String(p.default);
                changed = true;
            }
            return changed ? next : prev;
        });
    }, [definitions?.parameters, globalParams.setValues]);

    /** Shared SSE pipeline for LLM bootstrap (one draft per ``data-block`` region → ``definitions.yaml``). */
    const runBootstrapStream = React.useCallback(() => {
        if (!selectedId) return;
        setBootstrapEvents([]);
        setBootstrapPhase("running");
        bootstrapUnsub.current?.();
        void (async () => {
            try {
                const { job_id } = await startReportBootstrap(selectedId);
                setBootstrapJobId(job_id);
                bootstrapUnsub.current = streamReportEvents(
                    "bootstrap",
                    job_id,
                    (evt) => {
                        setBootstrapEvents((prev) => [...prev, evt]);
                        if (evt.step === "summary") {
                            setBootstrapPhase(
                                evt.status === "completed" ? "completed" : "failed",
                            );
                            void listReportTemplates().then(setTemplates);
                            reloadDefinitions();
                            loadTokens();
                        }
                    },
                    () => {
                        void getReportBootstrapStatus(job_id).then((st) => {
                            setBootstrapPhase(
                                st.status === "completed" ? "completed" : "failed",
                            );
                        });
                    },
                    (err) => {
                        setBootstrapPhase("failed");
                        setBootstrapEvents((prev) => [
                            ...prev,
                            { step: "error", message: String(err) },
                        ]);
                    },
                );
            } catch (e: any) {
                setBootstrapPhase("failed");
                setBootstrapEvents((prev) => [
                    ...prev,
                    { step: "error", message: String(e?.message ?? e) },
                ]);
            }
        })();
    }, [selectedId, reloadDefinitions, loadTokens]);

    /* When opening a template without definitions.yaml, create skeleton file only (scan HTML, no LLM). */
    React.useEffect(() => {
        if (!selectedId) return;
        const t = templates.find((x) => x.template_id === selectedId);
        if (!t || t.has_definitions) return;
        if (autoSeedAttemptedRef.current === selectedId) return;

        autoSeedAttemptedRef.current = selectedId;
        void (async () => {
            try {
                await seedReportDefinitionsSkeleton(selectedId);
                void listReportTemplates().then(setTemplates);
                reloadDefinitions();
                loadTokens();
            } catch (e: any) {
                const msg = String(e?.message ?? e);
                if (msg.includes("409")) {
                    void listReportTemplates().then(setTemplates);
                    reloadDefinitions();
                    loadTokens();
                    return;
                }
                setGlobalError(`Impossible de créer definitions.yaml : ${msg}`);
                autoSeedAttemptedRef.current = null;
            }
        })();
    }, [selectedId, templates, reloadDefinitions, loadTokens]);

    /* ── Auto-scroll chat ─────────────────────────────────────────────── */
    React.useEffect(() => {
        chatScrollRef.current?.scrollTo({
            top: chatScrollRef.current.scrollHeight,
            behavior: "smooth",
        });
    }, [chatMessages.length]);

    /* ── Bootstrap (LLM-heavy — manual path gated behind a confirm dialog) ─ */
    const handleBootstrap = async () => {
        if (!selectedId) return;

        const blockCount = tokens?.tokens?.blocks?.length ?? 0;
        const ok = window.confirm(
            blockCount > 0
                ? `La génération des CTE va lancer ~${blockCount} appels LLM ` +
                  `(≈ ${Math.max(1, Math.round(blockCount / 8))}–` +
                  `${Math.max(2, Math.round(blockCount / 4))} minutes). ` +
                  `Chaque bloc \`data-block\` recevra une logique CTE draftée. Continuer ?`
                : "La génération va créer une définition et une logique CTE draftée pour " +
                  "chaque bloc tagué \`data-block\`. Continuer ?",
        );
        if (!ok) return;

        runBootstrapStream();
    };

    /* ── Render ───────────────────────────────────────────────────────── */
    const handleRender = async () => {
        if (!selectedId) return;
        setRendering(true);
        setRenderError(null);
        setRenderResult(null);
        let parameters: Record<string, any> = {};
        try {
            parameters = renderParams.trim() ? JSON.parse(renderParams) : {};
        } catch (e) {
            setRendering(false);
            setRenderError(`Paramètres invalides (JSON) : ${e}`);
            return;
        }
        // Forward the parquet sources the user picked in the « Source de
        // données » panel — empty entries are stripped so the backend
        // still falls back to its period-aware auto-discovery for any
        // source the user left unbound.
        const parquet_paths: Record<string, string> = {};
        for (const [src, p] of Object.entries(parquetSelection.paths || {})) {
            if (typeof p === "string" && p.trim() !== "") parquet_paths[src] = p;
        }
        try {
            const result = await renderReportSync(selectedId, {
                parameters,
                parquet_paths,
            });
            setRenderResult(result);
        } catch (e: any) {
            setRenderError(String(e?.message ?? e));
        } finally {
            setRendering(false);
        }
    };

    /* ── Per-block hand-off: switch to chat tab + pre-fill the input ──
     *
     * We don't auto-send the message: the user can tweak the wording
     * (e.g. specify the format or the parameters) before letting the
     * agent execute.  The corresponding ``set_block_definition`` /
     * ``propose_block_definition`` tool calls handle the actual write.
     */
    const handleDefineWithAgent = (
        b: MergedBlock,
        intent: AgentHandoffIntent = "definition",
    ) => {
        const isSkeleton = b._isSkeleton || (!b.sql && !b.cte_ref);
        setAgentFocusBlock(b);
        setAgentFocusIntent(intent);
        setActiveTab("chat");
        const tokensList = (b.tokens && b.tokens.length > 0)
            ? `Jetons internes : ${b.tokens.join(", ")}.`
            : "";
        if (intent === "layout") {
            setChatInput(
                `Je veux modifier la mise en page HTML du bloc \`${b.id}\` ` +
                `(kind=${b.kind}). ${tokensList} ` +
                `Analyse d'abord le fragment avec get_block_html, puis mets à jour ` +
                `report-template.html avec apply_template_html_patch. ` +
                `Conserve les autres blocs intacts et, si de nouvelles zones ` +
                `data-block sont ajoutées, lance rescan_template.`,
            );
            return;
        }
        setChatInput(
            isSkeleton
                ? `Définis le bloc \`${b.id}\` (kind=${b.kind}). ${tokensList} ` +
                  `Réutilise un CTE de la bibliothèque (cte_ref) ou écris-en un ` +
                  `nouveau via {{include: …}} de la lib comptable, puis ` +
                  `appelle set_block_definition.`
                : `Modifie le bloc \`${b.id}\` (kind=${b.kind}). ${tokensList} ` +
                  `Décris ce qu'il doit calculer puis utilise ` +
                  `propose_block_definition et set_block_definition.`,
        );
    };

    const handleSuggestDataBlock = React.useCallback(async (payload: VisualCandidatePayload) => {
        if (!selectedId || !tokens?.template_html) return;
        setGlobalError(null);
        try {
            if (payload.action === "revoke") {
                const blockName = String(payload.blockId || "").trim();
                if (!blockName) {
                    setGlobalError("Impossible d’identifier le data-block à révoquer.");
                    return;
                }
                const patchedHtml = revokeDataBlockAttribute(tokens.template_html, blockName);
                if (!patchedHtml) {
                    setGlobalError("Le data-block à révoquer n’a pas été retrouvé dans report-template.html.");
                    return;
                }
                await saveReportTemplateHtml(selectedId, patchedHtml);
                await Promise.all([reloadDefinitions(), loadTokens()]);
                setAgentFocusBlock((prev) => (prev?.id === blockName ? null : prev));
                setChatMessages((prev) => [
                    ...prev,
                    {
                        kind: "assistant",
                        content:
                            `Le marquage data-block \`${blockName}\` a été retiré du HTML. ` +
                            `La définition reste conservée dans l’historique tant que vous ne la supprimez pas explicitement.`,
                    },
                ]);
                return;
            }

            const candidateKey = payload.candidateKey;
            if (!Number.isInteger(candidateKey)) {
                setGlobalError("Impossible d’identifier le div à marquer dans le HTML source.");
                return;
            }

            const existingNames = new Set<string>([
                ...(tokens.tokens.blocks || []).map((block) => block.name),
                ...(definitions?.blocks || []).map((block) => block.id),
            ]);
            const blockName = buildUniqueDataBlockName(payload, existingNames);
            const patchedHtml = insertDataBlockAttribute(tokens.template_html, candidateKey, blockName);
            if (!patchedHtml) {
                setGlobalError("Le div survolé n’a pas pu être retrouvé dans report-template.html.");
                return;
            }

            await saveReportTemplateHtml(selectedId, patchedHtml);
            await Promise.all([reloadDefinitions(), loadTokens()]);
            setAgentFocusBlock(null);
            setAgentFocusIntent("layout");
            setActiveTab("chat");
            setChatInput(
                `Le bloc \`${blockName}\` vient d’être ajouté et enregistré dans report-template.html. ` +
                `Définis maintenant sa logique métier et sa CTE.`,
            );
            setChatMessages((prev) => [
                ...prev,
                {
                    kind: "assistant",
                    content:
                        `Le div a été marqué en data-block et enregistré sous \`${blockName}\`. ` +
                        `Vous pouvez maintenant décrire ce que ce bloc doit calculer.`,
                },
            ]);
        } catch (e: unknown) {
            setGlobalError(`Impossible d’enregistrer le nouveau data-block : ${String(e instanceof Error ? e.message : e)}`);
        }
    }, [selectedId, tokens, definitions, reloadDefinitions, loadTokens]);

    /* ── Chat / edit-agent ────────────────────────────────────────────── */
    const handleSendMessage = async () => {
        if (!selectedId || !chatInput.trim() || chatPhase === "running") return;
        const userQuery = chatInput.trim();
        setChatInput("");
        setChatMessages((prev) => [...prev, { kind: "user", content: userQuery }]);
        setChatPhase("running");
        chatUnsub.current?.();
        try {
            const { job_id } = await startReportEditAgent(selectedId, {
                query: userQuery,
                max_iterations: 10,
            });
            setChatJobId(job_id);
            chatUnsub.current = streamReportEvents(
                "edit-agent", job_id,
                (evt) => {
                    if (evt.step === "thinking" && evt.message) {
                        setChatMessages((prev) => [
                            ...prev,
                            { kind: "thinking", content: evt.message },
                        ]);
                    } else if (evt.step === "tool_start" && evt.tool) {
                        setChatMessages((prev) => [
                            ...prev,
                            { kind: "tool", tool: evt.tool, status: "running" },
                        ]);
                    } else if (evt.step === "tool_result" && evt.tool) {
                        setChatMessages((prev) => [
                            ...prev,
                            {
                                kind: "tool",
                                tool: evt.tool,
                                status: evt.status || "ok",
                                preview: evt.preview,
                            },
                        ]);
                    } else if (evt.step === "summary") {
                        const ok = evt.status === "completed";
                        const text =
                            evt.result?.response ||
                            (ok ? "Action terminée." : evt.error || "L'agent a échoué.");
                        setChatMessages((prev) => [
                            ...prev,
                            { kind: ok ? "assistant" : "error", content: text },
                        ]);
                        setChatPhase(ok ? "completed" : "failed");
                        reloadDefinitions();
                        loadTokens();
                    }
                },
                () => {
                    getReportEditAgentStatus(job_id).then((st) => {
                        setChatPhase(st.status === "completed" ? "completed" : "failed");
                    });
                },
                (err) => {
                    setChatMessages((prev) => [
                        ...prev,
                        { kind: "error", content: `Connexion SSE perdue : ${err}` },
                    ]);
                    setChatPhase("failed");
                },
            );
        } catch (e: any) {
            setChatMessages((prev) => [
                ...prev,
                { kind: "error", content: String(e?.message ?? e) },
            ]);
            setChatPhase("failed");
        }
    };

    /* ── Derived ──────────────────────────────────────────────────────── */
    const selectedTemplate = templates.find((t) => t.template_id === selectedId);
    const liveBlockCount =
        definitions?.blocks?.filter((b) => !b.deprecated).length ?? 0;
    const mergedBlocks = React.useMemo(
        () => mergeBlocks(tokens, definitions),
        [tokens, definitions],
    );
    const skeletonCount = mergedBlocks.filter((b) => b._isSkeleton).length;

    React.useEffect(() => {
        if (!agentFocusBlock) return;
        const refreshed = mergedBlocks.find((b) => b.id === agentFocusBlock.id);
        if (refreshed && refreshed !== agentFocusBlock) {
            setAgentFocusBlock(refreshed);
        }
    }, [mergedBlocks, agentFocusBlock]);

    const handleTabChange = React.useCallback((t: Tab) => {
        if (t !== "chat") setAgentFocusBlock(null);
        setActiveTab(t);
    }, []);

    /* ────────────────────────────────────────────────────────────────── */

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className={cn(
                "absolute inset-0 z-50",
                isAgentWorkspace ? "settings-warm-bg" : "bg-background",
            )}
        >
            <div className="h-full overflow-y-auto overflow-x-hidden">
                <div className="min-h-full w-full pb-12 pt-4 md:pb-16 md:pt-8 lg:pb-20">
                    <div className="border border-[#E8E6E1] bg-white/90 p-5 shadow-[0_30px_80px_rgba(15,23,42,0.06)] backdrop-blur md:p-6 xl:rounded-[30px]">

                        {/* Header */}
                        <div className="border-b border-[#E8E6E1] pb-4">
                            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                                <div className="flex min-w-0 flex-wrap items-center gap-3">
                                    <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#A09E99]">
                                        Reporting · backend live
                                    </p>
                                    {selectedTemplate && (
                                        <div className="inline-flex items-center gap-2 rounded-full border border-[#E8E6E1] bg-[#F8F7F4] px-3 py-1.5">
                                            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                                                Rapport actif
                                            </span>
                                            <span className="font-mono text-sm font-semibold text-[#0D7377]">
                                                {selectedTemplate.template_id}
                                            </span>
                                            <span className="text-xs text-[#A09E99]">
                                                v{selectedTemplate.version}
                                            </span>
                                        </div>
                                    )}
                                </div>

                                <div className="flex w-full flex-wrap items-center justify-end gap-3 xl:w-auto">
                                    <Button
                                        variant="ghost"
                                        className="rounded-xl border border-[#E8E6E1] bg-[#F8F7F4] px-4 text-sm font-medium text-[#2B2B2B] hover:bg-white"
                                        onClick={onClose}
                                    >
                                        Retour au chat
                                    </Button>
                                </div>
                            </div>

                            {activeTab === "chat" && (
                                <div className="mt-3 flex flex-wrap gap-2">
                                    <span className="rounded-full border border-[#0D7377]/20 bg-[#0D7377]/5 px-3 py-1 text-[11px] font-semibold text-[#0D7377]">
                                        {agentFocusBlock ? "Mode bloc ciblé" : "Mode template complet"}
                                    </span>
                                    <span className="rounded-full border border-[#E8E6E1] bg-white px-3 py-1 text-[11px] font-semibold text-[#6B6966]">
                                        {agentFocusIntent === "layout" ? "Conversation orientée HTML" : "Conversation orientée bloc"}
                                    </span>
                                </div>
                            )}

                        </div>

                        {globalError && (
                            <div className="mt-4 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                                <AlertTriangle className="h-4 w-4 shrink-0" />
                                {globalError}
                            </div>
                        )}

                        <div className="mt-6">
                            <section className="space-y-5">
                                <Toolbar
                                    activeTab={activeTab}
                                    onTabChange={handleTabChange}
                                    template={selectedTemplate}
                                    blockCount={liveBlockCount}
                                />

                                {activeTab === "definitions" && (
                                    <DefinitionsPane
                                        loading={loadingDefs}
                                        tokensLoading={tokensLoading}
                                        template={selectedTemplate}
                                        definitions={definitions}
                                        tokens={tokens}
                                        mergedBlocks={mergedBlocks}
                                        skeletonCount={skeletonCount}
                                        bootstrapPhase={bootstrapPhase}
                                        bootstrapEvents={bootstrapEvents}
                                        onBootstrap={handleBootstrap}
                                        onListBlocks={loadTokens}
                                        onReload={() => {
                                            reloadDefinitions();
                                            loadTokens();
                                        }}
                                        onDefineWithAgent={handleDefineWithAgent}
                                        paramValues={globalParams.values}
                                        onParamChange={globalParams.setOne}
                                        onParamClear={globalParams.clearOne}
                                        parquetSelection={parquetSelection}
                                    />
                                )}

                                {activeTab === "chat" && (
                                    <div className="grid items-start gap-5 xl:min-h-[calc(100dvh-11.5rem)] xl:grid-cols-[minmax(0,1fr)_380px] xl:items-stretch 2xl:grid-cols-[minmax(0,1fr)_400px]">
                                        <div className="min-w-0 space-y-4 xl:flex xl:min-h-0 xl:flex-col">
                                            <div className="min-w-0 space-y-4 xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
                                                {agentFocusBlock && tokens && tokens.template_html ? (
                                                    <>
                                                        <FocusedBlockHtmlPreview
                                                            block={agentFocusBlock}
                                                            tokens={tokens}
                                                            definitions={definitions}
                                                            onDefineWithAgent={handleDefineWithAgent}
                                                            onSuggestDataBlock={handleSuggestDataBlock}
                                                            paramValues={globalParams.values}
                                                            onBackToTemplate={() => setAgentFocusBlock(null)}
                                                            focusIntent={agentFocusIntent}
                                                            templateId={selectedId ?? ""}
                                                            onBlockSaved={() => {
                                                                reloadDefinitions();
                                                                loadTokens();
                                                            }}
                                                            parquetPaths={parquetSelection.paths}
                                                        />
                                                    </>
                                                ) : tokens?.template_html ? (
                                                    <>
                                                        <TemplatePreview
                                                            html={tokens.template_html}
                                                            tokens={tokens}
                                                            definitions={definitions}
                                                            onDefineWithAgent={handleDefineWithAgent}
                                                            onSuggestDataBlock={handleSuggestDataBlock}
                                                            paramValues={globalParams.values}
                                                        />
                                                    </>
                                                ) : !tokensLoading && selectedId ? (
                                                    <div className="rounded-[24px] border border-dashed border-[#E8E6E1] bg-[#FCFBF8] px-5 py-4 text-sm text-[#6B6966]">
                                                        <span className="font-semibold text-[#2B2B2B]">
                                                            Aperçu HTML indisponible
                                                        </span>
                                                        <span className="ml-1">
                                                            — ouvrez l&apos;onglet <strong>Définitions</strong> puis
                                                            cliquez <strong>Lister les blocs</strong> pour charger le
                                                            template, puis revenez ici.
                                                        </span>
                                                    </div>
                                                ) : null}
                                            </div>
                                        </div>

                                        <div className="min-w-0 xl:sticky xl:top-4 xl:self-start">
                                            <ChatPane
                                                template={selectedTemplate}
                                                messages={chatMessages}
                                                chatInput={chatInput}
                                                onInputChange={setChatInput}
                                                onSend={handleSendMessage}
                                                scrollRef={chatScrollRef}
                                                phase={chatPhase}
                                            />
                                        </div>
                                    </div>
                                )}

                                {activeTab === "render" && (
                                    <RenderPane
                                        template={selectedTemplate}
                                        definitions={definitions}
                                        params={renderParams}
                                        onParamsChange={setRenderParams}
                                        rendering={rendering}
                                        result={renderResult}
                                        error={renderError}
                                        onRender={handleRender}
                                        onBootstrap={() => {
                                            setActiveTab("definitions");
                                            handleBootstrap();
                                        }}
                                        bootstrapPhase={bootstrapPhase}
                                        parquetSelection={parquetSelection.paths}
                                    />
                                )}
                            </section>
                        </div>
                    </div>
                </div>
            </div>
        </motion.div>
    );
};


/* ─────────────────────────────────────────────────────────────────────────
 * Sub-components (kept inside the file for cohesion)
 * ──────────────────────────────────────────────────────────────────────── */

const Toolbar: React.FC<{
    activeTab: Tab;
    onTabChange: (t: Tab) => void;
    template: ReportTemplateInfo | undefined;
    blockCount: number;
    compact?: boolean;
    showSummary?: boolean;
}> = ({ activeTab, onTabChange, template, blockCount, compact = false, showSummary = true }) => {
    const tabs: Array<{ id: Tab; label: string; icon: React.ElementType }> = [
        { id: "definitions", label: "Définitions", icon: BookOpen },
        { id: "chat",        label: "Agent éditeur", icon: PenLine },
        { id: "render",      label: "Rendu HTML", icon: PlayCircle },
    ];
    return (
        <div className={cn(
            "flex flex-wrap items-center justify-between gap-3 rounded-[28px] border border-[#E8E6E1] bg-white",
            compact ? "px-3 py-2" : "px-4 py-3",
        )}>
            {showSummary ? (
                <div className="text-sm">
                    {template ? (
                        <>
                            <span className="font-semibold text-[#2B2B2B]">{template.template_id}</span>
                            <span className="ml-2 text-[#A09E99]">
                                v{template.version} · {blockCount} bloc(s) actif(s)
                            </span>
                        </>
                    ) : (
                        <span className="text-[#A09E99]">Aucun rapport actif</span>
                    )}
                </div>
            ) : <div />}
            <div className="flex flex-wrap items-center gap-2">
                {tabs.map((t) => {
                    const Icon = t.icon;
                    const active = activeTab === t.id;
                    return (
                        <button
                            key={t.id}
                            type="button"
                            onClick={() => onTabChange(t.id)}
                            className={cn(
                                "inline-flex items-center gap-2 rounded-xl border text-xs font-semibold transition-all",
                                compact ? "px-2.5 py-1.5" : "px-3 py-1.5",
                                active
                                    ? "border-[#0D7377] bg-[#0D7377] text-white shadow-[0_8px_20px_rgba(13,115,119,0.2)]"
                                    : "border-[#E8E6E1] bg-[#F8F7F4] text-[#2B2B2B] hover:bg-white",
                            )}
                        >
                            <Icon className="h-3.5 w-3.5" />
                            {t.label}
                        </button>
                    );
                })}
            </div>
        </div>
    );
};


const DefinitionsPane: React.FC<{
    loading: boolean;
    tokensLoading: boolean;
    template: ReportTemplateInfo | undefined;
    definitions: ReportDefinitions | null;
    tokens: ReportTokens | null;
    mergedBlocks: MergedBlock[];
    skeletonCount: number;
    bootstrapPhase: "idle" | "running" | "completed" | "failed";
    bootstrapEvents: ReportEvent[];
    onBootstrap: () => void;
    onListBlocks: () => void;
    onReload: () => void;
    onDefineWithAgent: (b: MergedBlock, intent?: AgentHandoffIntent) => void;
    /** Lifted from :class:`ReportingView` — same map as chat-tab HTML previews. */
    paramValues: Record<string, string>;
    onParamChange: (name: string, value: string) => void;
    onParamClear: (name: string) => void;
    /** Lifted from :class:`ReportingView` so « Lancer le rendu » (Rendu HTML)
     *  uses the same selection the user just made here. */
    parquetSelection: ReturnType<typeof useParquetSourceSelection>;
}> = ({
    loading, tokensLoading, template, definitions, tokens, mergedBlocks,
    skeletonCount, bootstrapPhase, bootstrapEvents,
    onBootstrap, onListBlocks, onReload, onDefineWithAgent,
    paramValues, onParamChange, onParamClear,
    parquetSelection,
}) => {
    const blockCount = tokens?.tokens?.blocks?.length ?? 0;
    const orphanCount = tokens?.tokens?.orphans?.length ?? 0;
    const detectedParamNames = React.useMemo(() => {
        const set = new Set<string>();
        for (const p of definitions?.parameters ?? []) {
            const id = String(p?.id || "").trim().toLowerCase();
            if (id) set.add(id);
        }
        for (const block of mergedBlocks) {
            for (const name of extractDollarParams(block.sql || "")) {
                set.add(name);
            }
            for (const sub of block.ctes ?? []) {
                for (const name of extractDollarParams(sub.sql || "")) {
                    set.add(name);
                }
            }
        }
        return Array.from(set).sort();
    }, [definitions?.parameters, mergedBlocks]);

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap gap-2 rounded-[24px] border border-[#E8E6E1] bg-white px-5 py-4">
                <Button
                    className="rounded-xl bg-[#0D7377] px-4 text-white hover:bg-[#0B6164]"
                    onClick={onBootstrap}
                    disabled={!template || bootstrapPhase === "running"}
                    title={
                        blockCount > 0
                            ? `Génère une logique CTE draftée pour chacun des ${blockCount} data-blocks.`
                            : "Génère une logique CTE draftée pour chaque data-block du template."
                    }
                >
                    {bootstrapPhase === "running" ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                        <Sparkles className="mr-2 h-4 w-4" />
                    )}
                    {bootstrapPhase === "running"
                        ? "Génération des CTE…"
                        : "Générer les CTE des data-blocks"}
                </Button>
                <Button
                    variant="ghost"
                    className="rounded-xl border border-[#E8E6E1] bg-[#F8F7F4] px-3 text-sm font-medium text-[#2B2B2B] hover:bg-white"
                    onClick={onReload}
                    disabled={loading || tokensLoading || !template}
                >
                    <RefreshCw
                        className={cn(
                            "mr-2 h-4 w-4",
                            (loading || tokensLoading) && "animate-spin",
                        )}
                    />
                    Recharger
                </Button>
                <Button
                    className="rounded-xl bg-[#0D7377] px-4 text-white hover:bg-[#0B6164]"
                    onClick={onListBlocks}
                    disabled={!template || tokensLoading}
                    title="Scanner le HTML pour lister tous les blocs (sans LLM)."
                >
                    {tokensLoading
                        ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        : <Boxes className="mr-2 h-4 w-4" />}
                    Lister les blocs
                </Button>
                <Button
                    variant="ghost"
                    className="rounded-xl border border-amber-200 bg-amber-50 px-3 text-sm font-medium text-amber-700 hover:bg-amber-100"
                    onClick={onBootstrap}
                    disabled={!template || bootstrapPhase === "running"}
                    title={
                        blockCount > 0
                            ? `Lance ~${blockCount} appels LLM pour drafter chaque bloc.`
                            : "Lance l'agent pour drafter chaque bloc tagué."
                    }
                >
                    {bootstrapPhase === "running" ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                        <Wand2 className="mr-2 h-4 w-4" />
                    )}
                    {bootstrapPhase === "running"
                        ? "Amorçage en cours…"
                        : "Amorçage avancé"}
                </Button>
            </div>

            {bootstrapEvents.length > 0 && (
                <EventLog
                    title="Bootstrap pipeline"
                    events={bootstrapEvents}
                    phase={bootstrapPhase}
                />
            )}

            {orphanCount > 0 && (
                <OrphanList orphans={tokens?.tokens?.orphans ?? []} />
            )}

            <GlobalParametersPanel
                templateId={template?.template_id}
                paramNames={detectedParamNames}
                schema={definitions?.parameters ?? []}
                onSaved={onReload}
                onChange={onParamChange}
                onClear={onParamClear}
            />

            {!template ? null : (loading || tokensLoading) && mergedBlocks.length === 0 ? (
                <div className="rounded-[24px] border border-[#E8E6E1] bg-white p-8 text-center text-sm text-[#6B6966]">
                    <Loader2 className="mx-auto mb-3 h-5 w-5 animate-spin text-[#0D7377]" />
                    Scan du template et chargement des définitions…
                </div>
            ) : mergedBlocks.length === 0 ? (
                <div className="rounded-[24px] border border-dashed border-[#E8E6E1] bg-white p-8 text-center text-sm text-[#6B6966]">
                    <Settings2 className="mx-auto mb-3 h-6 w-6 text-[#A09E99]" />
                    <p className="font-semibold text-[#2B2B2B]">Rien à afficher pour le moment.</p>
                    <p className="mt-1">
                        Cliquez sur <strong>Lister les blocs</strong> pour scanner le HTML
                        sans appeler le LLM.
                    </p>
                </div>
            ) : (
                    <BlockList
                        blocks={mergedBlocks}
                        skeletonCount={skeletonCount}
                        definitionsLoaded={!!definitions}
                        onDefineWithAgent={onDefineWithAgent}
                        onBlockSaved={onReload}
                        templateId={template?.template_id}
                        paramValues={paramValues}
                        onParamChange={onParamChange}
                    parquetPaths={parquetSelection.paths}
                />
            )}
        </div>
    );
};


/* ── Parquet source panel ─────────────────────────────────────────────────
 *
 * One ``<select>`` per declared ``definitions.sources[*].name`` (e.g.
 * ``ledger``).  The dropdown is populated from the backend's discovery
 * of ``data/parquet/*.parquet``; the user's choice persists in
 * localStorage and is forwarded to every block preview as
 * ``parquet_paths``.  When the user hasn't chosen anything yet, the
 * backend's auto-resolution still picks the latest matching file —
 * the panel surfaces that fallback as a hint.
 */

function _formatParquetSize(bytes: number): string {
    if (!bytes) return "—";
    const KB = 1024;
    const MB = KB * 1024;
    if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
    if (bytes >= KB) return `${Math.round(bytes / KB)} KB`;
    return `${bytes} B`;
}

const ParquetSourcePanel: React.FC<{
    sources:    string[];
    files:      ParquetFileEntry[];
    selection:  Record<string, string>;
    defaults:   Record<string, string>;
    onSelect:   (sourceName: string, path: string) => void;
    loadError:  string | null;
}> = ({ sources, files, selection, defaults, onSelect, loadError }) => {
    const [open, setOpen] = React.useState(true);
    const usable = files.filter((f) => !f.is_embeddings);
    const filledCount = sources.filter(
        (s) => (selection[s] || defaults[s] || "").trim() !== "",
    ).length;

    return (
        <div className="rounded-[24px] border border-[#E8E6E1] bg-white px-5 py-4">
            <button
                type="button"
                onClick={() => setOpen((p) => !p)}
                className="flex w-full items-center justify-between gap-3 text-left"
            >
                <div className="flex flex-col">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">
                        Source de données
                    </span>
                    <span className="text-sm text-[#6B6966]">
                        Fichier <code className="rounded bg-[#F8F7F4] px-1 font-mono">.parquet</code>{" "}
                        utilisé pour exécuter chaque CTE.
                        {sources.length > 0 && (
                            <span className="ml-1 text-[#A09E99]">
                                · {filledCount}/{sources.length} liée(s)
                            </span>
                        )}
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    <span className="rounded-full border border-[#0D7377]/30 bg-[#0D7377]/5 px-2 py-0.5 text-[11px] font-semibold text-[#0D7377]">
                        <Database className="-mt-0.5 mr-1 inline h-3 w-3" />
                        {usable.length}
                    </span>
                    <ChevronRight
                        className={cn(
                            "h-4 w-4 shrink-0 text-[#A09E99] transition-transform",
                            open && "rotate-90",
                        )}
                    />
                </div>
            </button>
            {open && (
                <div className="mt-3 space-y-3 border-t border-[#E8E6E1] pt-3">
                    {loadError && (
                        <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                            <p className="flex items-center gap-1 font-semibold">
                                <AlertTriangle className="h-3 w-3" />
                                Impossible de charger les fichiers parquet
                            </p>
                            <pre className="mt-1 whitespace-pre-wrap break-words text-[11px]">
                                {loadError}
                            </pre>
                        </div>
                    )}

                    {usable.length === 0 && !loadError && (
                        <p className="text-xs italic text-[#6B6966]">
                            Aucun fichier <code className="rounded bg-[#F8F7F4] px-1 font-mono">.parquet</code>{" "}
                            détecté dans <code className="rounded bg-[#F8F7F4] px-1 font-mono">data/parquet/</code>.
                            Importez un grand-livre via le pipeline XLSX pour activer la prévisualisation.
                        </p>
                    )}

                    {sources.length === 0 && usable.length > 0 && (
                        <p className="text-xs italic text-[#6B6966]">
                            Aucune source déclarée dans{" "}
                            <code className="rounded bg-[#F8F7F4] px-1 font-mono">definitions.yaml</code>.
                            Les blocs constants (sans <code className="rounded bg-[#F8F7F4] px-1 font-mono">FROM ledger</code>)
                            fonctionnent quand même ; ajoutez{" "}
                            <code className="rounded bg-[#F8F7F4] px-1 font-mono">sources: [{`{`}name: ledger{`}`}]</code>{" "}
                            pour activer les blocs basés sur les données.
                        </p>
                    )}

                    {sources.length > 0 && usable.length > 0 && (
                        <div className="grid gap-2">
                            {sources.map((sourceName) => {
                                const eligible = usable.filter((f) =>
                                    (f.matches_sources ?? []).includes(sourceName),
                                );
                                const explicit = selection[sourceName] ?? "";
                                const fallback = defaults[sourceName] ?? "";
                                const effective = explicit || fallback;
                                const usingFallback =
                                    !explicit && !!fallback;
                                const options = eligible.length > 0 ? eligible : usable;
                                return (
                                    <div
                                        key={sourceName}
                                        className="grid grid-cols-[140px_1fr] items-start gap-2"
                                    >
                                        <div className="flex flex-col pt-1">
                                            <span className="font-mono text-[12px] font-semibold text-[#2B2B2B]">
                                                {sourceName}
                                            </span>
                                            <span className="text-[10px] text-[#A09E99]">
                                                {eligible.length === 0
                                                    ? "(aucun fichier compatible)"
                                                    : `${eligible.length} fichier(s) compatibles`}
                                            </span>
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <select
                                                value={effective}
                                                onChange={(e) => onSelect(sourceName, e.target.value)}
                                                className="w-full rounded-lg border border-[#E8E6E1] bg-white px-2 py-1.5 text-[12px] text-[#2B2B2B] outline-none focus:border-[#0D7377]/40 focus:ring-1 focus:ring-[#0D7377]/10"
                                            >
                                                <option value="">
                                                    {fallback
                                                        ? `(auto · ${fallback.split("/").pop()})`
                                                        : "(non sélectionné)"}
                                                </option>
                                                {options.map((f) => (
                                                    <option key={f.path} value={f.path}>
                                                        {f.label || f.filename}
                                                        {" — "}
                                                        {_formatParquetSize(f.size_bytes)}
                                                        {f.kind !== "unknown" && ` · ${f.kind}`}
                                                    </option>
                                                ))}
                                            </select>
                                            {usingFallback && (
                                                <span className="text-[10px] italic text-[#A09E99]">
                                                    auto-résolution serveur — sélectionnez explicitement pour figer ce choix.
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};


/* ── Global parameters panel ──────────────────────────────────────────────
 *
 * One textbox per known ``$param``.  Values are shared across every
 * block in the template (each ``BlockCard`` consumes a focused subset
 * via the ``paramValues`` prop) and persisted in ``localStorage``.
 */
type EditableTemplateParameterRow = {
    key: string;
    id: string;
    type: string;
    description: string;
    defaultValue: string;
};

function buildEditableTemplateParameterRows(
    schema: NonNullable<ReportDefinitions["parameters"]>,
    detectedParamNames: string[],
): EditableTemplateParameterRow[] {
    const rows: EditableTemplateParameterRow[] = [];
    const seen = new Set<string>();
    for (const p of schema ?? []) {
        const id = String(p?.id || "").trim();
        if (!id) continue;
        const key = id.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
            key,
            id,
            type: String(p?.type || "string"),
            description: String(p?.description || ""),
            defaultValue:
                p?.default === undefined || p?.default === null ? "" : String(p.default),
        });
    }
    for (const rawName of detectedParamNames) {
        const id = String(rawName || "").trim();
        if (!id) continue;
        const key = id.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
            key,
            id,
            type: "string",
            description: "",
            defaultValue: "",
        });
    }
    return rows;
}

const GlobalParametersPanel: React.FC<{
    templateId: string | undefined;
    paramNames: string[];
    schema: NonNullable<ReportDefinitions["parameters"]>;
    onSaved: () => void;
    onChange: (name: string, value: string) => void;
    onClear: (name: string) => void;
}> = ({ templateId, paramNames, schema, onSaved, onChange, onClear }) => {
    const [open, setOpen] = React.useState(true);
    const [rows, setRows] = React.useState<EditableTemplateParameterRow[]>(() =>
        buildEditableTemplateParameterRows(schema, paramNames),
    );
    const [saving, setSaving] = React.useState(false);
    const [saveError, setSaveError] = React.useState<string | null>(null);
    const [saveVersion, setSaveVersion] = React.useState<number | null>(null);

    React.useEffect(() => {
        setRows(buildEditableTemplateParameterRows(schema, paramNames));
    }, [schema, paramNames]);

    const filledCount = rows.filter((r) => r.defaultValue.trim() !== "").length;

    const updateRow = React.useCallback((
        key: string,
        patch: Partial<EditableTemplateParameterRow>,
    ) => {
        setRows((prev) => prev.map((row) => row.key === key ? { ...row, ...patch } : row));
    }, []);

    const addRow = React.useCallback(() => {
        setRows((prev) => [
            ...prev,
            {
                key: `new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                id: "",
                type: "string",
                description: "",
                defaultValue: "",
            },
        ]);
        setOpen(true);
    }, []);

    const deleteRow = React.useCallback((key: string) => {
        setRows((prev) => prev.filter((row) => row.key !== key));
    }, []);

    const handleSave = React.useCallback(async () => {
        if (!templateId) return;
        setSaving(true);
        setSaveError(null);
        setSaveVersion(null);
        try {
            const payload: ReportTemplateParameter[] = [];
            const seen = new Set<string>();
            for (const row of rows) {
                const id = row.id.trim();
                if (!id) continue;
                const lower = id.toLowerCase();
                if (seen.has(lower)) {
                    throw new Error(`Paramètre dupliqué : ${id}`);
                }
                seen.add(lower);
                const entry: ReportTemplateParameter = { id };
                const type = row.type.trim();
                if (type) entry.type = type;
                const description = row.description.trim();
                if (description) entry.description = description;
                const rawDefault = row.defaultValue.trim();
                if (rawDefault !== "") {
                    if (type === "int") {
                        const parsed = Number.parseInt(rawDefault, 10);
                        if (Number.isNaN(parsed)) {
                            throw new Error(`Valeur entière invalide pour ${id}`);
                        }
                        entry.default = parsed;
                    } else if (type === "float") {
                        const parsed = Number.parseFloat(rawDefault.replace(",", "."));
                        if (Number.isNaN(parsed)) {
                            throw new Error(`Valeur numérique invalide pour ${id}`);
                        }
                        entry.default = parsed;
                    } else {
                        entry.default = rawDefault;
                    }
                }
                payload.push(entry);
            }

            const result = await updateReportTemplateParameters(templateId, payload);
            setRows(buildEditableTemplateParameterRows(result.parameters, paramNames));
            setSaveVersion(result.version);

            const kept = new Set(result.parameters.map((p) => String(p.id).toLowerCase()));
            for (const row of rows) {
                const id = row.id.trim();
                if (!id) continue;
                if (!kept.has(id.toLowerCase())) onClear(id);
            }
            for (const p of result.parameters) {
                if (p.default === undefined || p.default === null || String(p.default).trim() === "") {
                    onClear(p.id);
                } else {
                    onChange(p.id, String(p.default));
                }
            }
            onSaved();
        } catch (e: any) {
            setSaveError(String(e?.message ?? e));
        } finally {
            setSaving(false);
        }
    }, [templateId, rows, paramNames, onSaved, onChange, onClear]);

    return (
        <div className="rounded-[24px] border border-[#E8E6E1] bg-white px-5 py-4">
            <button
                type="button"
                onClick={() => setOpen((p) => !p)}
                className="flex w-full items-center justify-between gap-3 text-left"
            >
                <div className="flex flex-col">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">
                        Paramètres du rapport
                    </span>
                    <span className="text-sm text-[#6B6966]">
                        Paramètres persistés dans <code className="rounded bg-[#F8F7F4] px-1 font-mono">definitions.yaml</code>.
                        {rows.length > 0 && (
                            <span className="ml-1 text-[#A09E99]">
                                · {filledCount}/{rows.length} valeur(s) par défaut
                            </span>
                        )}
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    <span className="rounded-full border border-[#0D7377]/30 bg-[#0D7377]/5 px-2 py-0.5 text-[11px] font-semibold text-[#0D7377]">
                        {rows.length}
                    </span>
                    <ChevronRight
                        className={cn(
                            "h-4 w-4 shrink-0 text-[#A09E99] transition-transform",
                            open && "rotate-90",
                        )}
                    />
                </div>
            </button>
            {open && (
                <div className="mt-3 space-y-3 border-t border-[#E8E6E1] pt-3">
                    {rows.length === 0 && (
                        <p className="text-xs italic text-[#6B6966]">
                            Aucun paramètre détecté. Ajoutez-en un manuellement ou laissez les blocs SQL
                            faire émerger les <code className="rounded bg-[#F8F7F4] px-1 font-mono">$params</code>.
                        </p>
                    )}

                    <div className="space-y-2">
                        {rows.map((row) => (
                            <div
                                key={row.key}
                                className="grid gap-2 rounded-[18px] border border-[#E8E6E1] bg-[#FCFBF8] p-3 xl:grid-cols-[180px_110px_minmax(0,1fr)_minmax(0,1.2fr)_auto]"
                            >
                                <input
                                    type="text"
                                    value={row.id}
                                    onChange={(e) => updateRow(row.key, { id: e.target.value })}
                                    placeholder="YEAR"
                                    spellCheck={false}
                                    className="rounded-lg border border-[#E8E6E1] bg-white px-2 py-2 font-mono text-[12px] text-[#2B2B2B] outline-none focus:border-[#0D7377]/40 focus:ring-1 focus:ring-[#0D7377]/10"
                                />
                                <select
                                    value={row.type}
                                    onChange={(e) => updateRow(row.key, { type: e.target.value })}
                                    className="rounded-lg border border-[#E8E6E1] bg-white px-2 py-2 text-[12px] text-[#2B2B2B] outline-none focus:border-[#0D7377]/40 focus:ring-1 focus:ring-[#0D7377]/10"
                                >
                                    <option value="string">string</option>
                                    <option value="int">int</option>
                                    <option value="float">float</option>
                                    <option value="date">date</option>
                                </select>
                                <input
                                    type="text"
                                    value={row.defaultValue}
                                    onChange={(e) => updateRow(row.key, { defaultValue: e.target.value })}
                                    placeholder={
                                        row.id.trim().toLowerCase() === "period"
                                            ? "2024-01-01..2024-12-31"
                                            : "Valeur par défaut"
                                    }
                                    spellCheck={false}
                                    className="rounded-lg border border-[#E8E6E1] bg-white px-2 py-2 font-mono text-[12px] text-[#2B2B2B] outline-none focus:border-[#0D7377]/40 focus:ring-1 focus:ring-[#0D7377]/10"
                                />
                                <input
                                    type="text"
                                    value={row.description}
                                    onChange={(e) => updateRow(row.key, { description: e.target.value })}
                                    placeholder="Description métier"
                                    className="rounded-lg border border-[#E8E6E1] bg-white px-2 py-2 text-[12px] text-[#2B2B2B] outline-none focus:border-[#0D7377]/40 focus:ring-1 focus:ring-[#0D7377]/10"
                                />
                                <button
                                    type="button"
                                    onClick={() => deleteRow(row.key)}
                                    className="inline-flex items-center justify-center rounded-lg border border-red-200 bg-red-50 px-2 py-2 text-red-700 transition-colors hover:bg-red-100"
                                    title="Supprimer ce paramètre"
                                >
                                    <Trash2 className="h-4 w-4" />
                                </button>
                            </div>
                        ))}
                    </div>

                    {saveError && (
                        <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                            {saveError}
                        </div>
                    )}

                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                            <Button
                                type="button"
                                variant="ghost"
                                className="rounded-xl border border-[#E8E6E1] bg-[#F8F7F4] px-3 text-sm font-medium text-[#2B2B2B] hover:bg-white"
                                onClick={addRow}
                            >
                                <Plus className="mr-2 h-4 w-4" />
                                Ajouter un paramètre
                            </Button>
                            <Button
                                type="button"
                                className="rounded-xl bg-[#0D7377] px-4 text-white hover:bg-[#0B6164]"
                                onClick={handleSave}
                                disabled={!templateId || saving}
                            >
                                {saving ? (
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                ) : (
                                    <Save className="mr-2 h-4 w-4" />
                                )}
                                {saving ? "Enregistrement…" : "Enregistrer les paramètres"}
                            </Button>
                        </div>
                        {saveVersion ? (
                            <span className="text-xs text-[#6B6966]">
                                Sauvegardé en v{saveVersion}.
                            </span>
                        ) : null}
                    </div>
                </div>
            )}
        </div>
    );
};


const OrphanList: React.FC<{
    orphans: NonNullable<ReportTokens["tokens"]["orphans"]>;
}> = ({ orphans }) => (
    <div className="rounded-[20px] border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
        <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div>
                <p className="font-semibold">
                    {orphans.length} marqueur(s) DSL hors de tout
                    <code className="mx-1 rounded bg-amber-100 px-1 py-0.5">data-block</code>.
                </p>
                <p className="mt-1">
                    Ajoutez un <code>&lt;div data-block="…"&gt;</code> autour de chaque
                    occurrence ci-dessous pour qu'elle soit prise en compte.
                </p>
                <ul className="mt-2 space-y-0.5 font-mono text-[11px]">
                    {orphans.map((o, i) => (
                        <li key={`${o.kind}:${o.name}:${i}`}>
                            <span className="font-semibold">{o.kind}</span>:{o.name}
                            <span className="ml-2 text-amber-700">(ligne {o.line})</span>
                        </li>
                    ))}
                </ul>
            </div>
        </div>
    </div>
);


const BlockList: React.FC<{
    blocks: MergedBlock[];
    skeletonCount: number;
    definitionsLoaded: boolean;
    onDefineWithAgent: (b: MergedBlock) => void;
    onBlockSaved: () => void;
    templateId: string | undefined;
    paramValues: Record<string, string>;
    onParamChange: (name: string, value: string) => void;
    /** Source-name → parquet absolute path, forwarded to every preview. */
    parquetPaths: Record<string, string>;
}> = ({
    blocks, skeletonCount, definitionsLoaded, onDefineWithAgent, onBlockSaved, templateId,
    paramValues, onParamChange, parquetPaths,
}) => {
    if (!blocks.length) {
        return (
            <div className="rounded-[24px] border border-[#E8E6E1] bg-white p-6 text-center text-sm text-[#6B6966]">
                Le dictionnaire est vide.
            </div>
        );
    }
    return (
        <div className="space-y-3">
            {skeletonCount > 0 && (
                <div className="rounded-[18px] border border-dashed border-zinc-300 bg-zinc-50 px-4 py-3 text-xs text-zinc-600">
                    <ListChecks className="mr-2 inline h-3.5 w-3.5 text-zinc-500" />
                    {skeletonCount} bloc(s) tagué(s) sans définition.
                    {!definitionsLoaded && (
                        <>{" "}Aucun <code>definitions.yaml</code> sur disque — utilisez
                        <strong> Définir avec l'agent</strong> sur chaque carte pour
                        les autoriser un par un.</>
                    )}
                </div>
            )}
            {blocks.map((b) => (
                <BlockCard
                    key={b.id}
                    block={b}
                    onDefineWithAgent={onDefineWithAgent}
                    onBlockSaved={onBlockSaved}
                    templateId={templateId}
                    paramValues={paramValues}
                    onParamChange={onParamChange}
                    parquetPaths={parquetPaths}
                />
            ))}
        </div>
    );
};


const BlockCard: React.FC<{
    block: MergedBlock;
    onDefineWithAgent: (b: MergedBlock) => void;
    onBlockSaved: () => void;
    templateId: string | undefined;
    /** Shared parameter pool (lower-cased keys). */
    paramValues: Record<string, string>;
    /** Editing a value here propagates to every other block. */
    onParamChange: (name: string, value: string) => void;
    /** ``{ledger: "/abs/path.parquet"}`` map sent on every preview. */
    parquetPaths: Record<string, string>;
}> = ({
    block, onDefineWithAgent, onBlockSaved, templateId, paramValues, onParamChange,
    parquetPaths,
}) => {
    const [open, setOpen] = React.useState(false);
    const [goalDraft, setGoalDraft] = React.useState((block.goal ?? "").trim());
    const [savingCte, setSavingCte] = React.useState(false);
    const [saveCteError, setSaveCteError] = React.useState<string | null>(null);
    const status = block._isSkeleton
        ? "skeleton"
        : block.deprecated
            ? "deprecated"
            : (block.status ?? "draft");
    const isSkeleton = !!block._isSkeleton;
    const innerTokens = block.tokens ?? [];
    const hasInline = !!(block.sql && block.sql.trim());
    const cteRef = block.cte_ref || null;

    const mixedExecutableSubs = React.useMemo((): ReportBlockSubCte[] => {
        if (block.kind !== "mixed" || !block.ctes?.length) return [];
        return block.ctes.filter((c) => {
            if (!c?.id) return false;
            const s = (c.sql || "").trim();
            const r = (c.cte_ref || "").toString().trim();
            return !!(s || r);
        });
    }, [block.kind, block.ctes]);

    const [mixedSubPick, setMixedSubPick] = React.useState("");
    React.useEffect(() => {
        setMixedSubPick("");
    }, [block.id]);

    const selectedMixedSubId =
        mixedSubPick && mixedExecutableSubs.some((s) => s.id === mixedSubPick)
            ? mixedSubPick
            : (mixedExecutableSubs[0]?.id ?? "");

    const activeMixedSub =
        block.kind === "mixed"
            ? mixedExecutableSubs.find((s) => s.id === selectedMixedSubId)
            : undefined;
    const mixedSubSqlTrim = (activeMixedSub?.sql || "").trim();
    const mixedSubCteRef = (activeMixedSub?.cte_ref || "").toString().trim();
    const shouldResolveSqlSource =
        open &&
        !!templateId &&
        (
            (block.kind !== "mixed" && !hasInline && !!cteRef) ||
            (block.kind === "mixed" && !mixedSubSqlTrim && !!mixedSubCteRef && !!selectedMixedSubId)
        );
    const {
        result: resolvedSqlSource,
        loading: resolvedSqlSourceLoading,
        error: resolvedSqlSourceError,
    } = useResolvedBlockSqlSource(
        templateId,
        block.id,
        block.kind === "mixed" ? selectedMixedSubId : null,
        shouldResolveSqlSource,
    );
    const tokenCteRows = React.useMemo(() => buildTokenCteRows(block), [block]);
    /** ``goal`` in YAML — instruction passed to the edit agent; shown as "Prompt". */
    const promptText = (block.goal ?? "").trim();

    React.useEffect(() => {
        setGoalDraft((block.goal ?? "").trim());
        setSaveCteError(null);
    }, [block.id, block.goal]);

    /* ── Inline preview state ──
     * We let the user execute the block's CTE on demand from the card
     * so they can see the projected rows BEFORE rendering the full
     * report.  Errors come back as 422s with a human-readable detail
     * which we surface inline as a "fix your CTE" hint.
     */
    const canPreview =
        !!templateId &&
        !block._isSkeleton &&
        !block.deprecated &&
        (
            (
                block.kind !== "mixed" &&
                (hasInline || !!cteRef)
            ) ||
            (
                block.kind === "mixed" &&
                mixedExecutableSubs.length > 0 &&
                !!selectedMixedSubId
            )
        );
    const [running, setRunning] = React.useState(false);
    const [previewResult, setPreviewResult] =
        React.useState<BlockPreviewResult | null>(null);
    const [previewError, setPreviewError] = React.useState<string | null>(null);
    const [showAdvanced, setShowAdvanced] = React.useState(false);

    /* Params this block actually references — union of:
     *   1. literal ``$names`` in the block SQL,
     *   2. ``referenced_params`` returned by the last preview run
     *      (this is how params from ``{{include: …}}`` surface).
     * Values themselves live in the shared pool ``paramValues`` so the
     * user can type them once at the top of the page and every block
     * picks them up.
     */
    const sqlForParamScan =
        block.kind === "mixed" ? mixedSubSqlTrim : (block.sql || "");

    const blockParams = React.useMemo<string[]>(() => {
        const set = new Set<string>(extractDollarParams(sqlForParamScan));
        for (const p of previewResult?.referenced_params ?? []) {
            set.add(p.toLowerCase());
        }
        return Array.from(set).sort();
    }, [sqlForParamScan, previewResult]);

    const runPreview = React.useCallback(async () => {
        if (!templateId || !canPreview) return;
        setRunning(true);
        setPreviewError(null);
        // Bind only the params this block actually uses, drawing from
        // the shared pool.  Empty strings are filtered so we never send
        // ``""`` to a column that expects a date/number.
        const cleaned: Record<string, any> = {};
        for (const name of blockParams) {
            const v = (paramValues[name] ?? "").trim();
            if (v !== "") cleaned[name] = v;
        }
        const parameters =
            Object.keys(cleaned).length > 0 ? cleaned : undefined;
        const cleanedParquet: Record<string, string> = {};
        for (const [k, v] of Object.entries(parquetPaths || {})) {
            if (typeof v === "string" && v.trim() !== "") cleanedParquet[k] = v;
        }
        const parquet =
            Object.keys(cleanedParquet).length > 0 ? cleanedParquet : undefined;
        try {
            const body: Parameters<typeof previewReportBlock>[2] = {
                parameters,
                parquet_paths: parquet,
                limit: 25,
            };
            if (block.kind === "mixed" && selectedMixedSubId) {
                body.sub_block_id = selectedMixedSubId;
            }
            const result = await previewReportBlock(templateId, block.id, body);
            setPreviewResult(result);
        } catch (e: any) {
            setPreviewError(String(e?.detail ?? e?.message ?? e));
        } finally {
            setRunning(false);
        }
    }, [
        templateId,
        canPreview,
        blockParams,
        paramValues,
        block.id,
        block.kind,
        selectedMixedSubId,
        parquetPaths,
    ]);

    const handleSaveCte = React.useCallback(async () => {
        if (!templateId || !goalDraft.trim() || savingCte) return;
        setSavingCte(true);
        setSaveCteError(null);
        try {
            await saveReportBlockCte(templateId, block.id, {
                goal: goalDraft.trim(),
            });
            onBlockSaved();
        } catch (e: any) {
            const detail = e?.detail;
            if (detail?.validation_summary?.reports) {
                const reports = detail.validation_summary.reports
                    .map((r: any) => `${r.block_id}: ${(r.errors || []).join(" ; ")}`)
                    .join("\n");
                setSaveCteError(`${detail.message}\n${reports}`);
            } else {
                setSaveCteError(String(detail?.message ?? e?.message ?? e));
            }
        } finally {
            setSavingCte(false);
        }
    }, [templateId, goalDraft, savingCte, block.id, onBlockSaved]);

    return (
        <div
            className={cn(
                "rounded-[22px] border bg-white px-5 py-4 transition-all",
                block.deprecated
                    ? "border-zinc-200 opacity-70"
                    : isSkeleton
                        ? "border-dashed border-zinc-300 bg-zinc-50/50"
                        : "border-[#E8E6E1]",
            )}
        >
            <div className="flex w-full items-start justify-between gap-3">
                <button
                    type="button"
                    onClick={() => setOpen((p) => !p)}
                    className="flex min-w-0 flex-1 items-start justify-between gap-3 text-left"
                >
                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-sm font-semibold text-[#2B2B2B]">
                                {block.id}
                            </span>
                            <span
                                className={cn(
                                    "rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em]",
                                    KIND_BADGE_STYLES[block.kind] ?? "border-zinc-200 bg-zinc-50 text-zinc-700",
                                )}
                            >
                                {block.kind}
                            </span>
                            <span
                                className={cn(
                                    "rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em]",
                                    STATUS_BADGE_STYLES[status] ?? "border-zinc-200 bg-zinc-50 text-zinc-700",
                                )}
                            >
                                {status}
                            </span>
                            {cteRef && (
                                <span className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-sky-700">
                                    cte_ref: {cteRef}
                                </span>
                            )}
                            {block._scan && typeof block._scan.line === "number" && (
                                <span className="rounded-full border border-zinc-200 bg-white px-2 py-0.5 text-[10px] font-mono text-zinc-600">
                                    L{block._scan.line}
                                </span>
                            )}
                        </div>
                        {innerTokens.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                                {innerTokens.slice(0, 12).map((t) => (
                                    <span
                                        key={t}
                                        className="rounded-md border border-[#E8E6E1] bg-[#FCFBF8] px-1.5 py-0.5 font-mono text-[10px] text-[#2B2B2B]"
                                    >
                                        {t}
                                    </span>
                                ))}
                                {innerTokens.length > 12 && (
                                    <span className="text-[10px] text-[#A09E99]">
                                        +{innerTokens.length - 12}…
                                    </span>
                                )}
                            </div>
                        )}
                    </div>
                    <ChevronRight
                        className={cn(
                            "mt-1 h-4 w-4 shrink-0 text-[#A09E99] transition-transform",
                            open && "rotate-90",
                        )}
                    />
                </button>
                <Button
                    variant="ghost"
                    className={cn(
                        "shrink-0 rounded-xl border px-3 text-xs font-semibold",
                        isSkeleton
                            ? "border-[#0D7377] bg-[#0D7377]/5 text-[#0D7377] hover:bg-[#0D7377]/10"
                            : "border-[#E8E6E1] bg-[#F8F7F4] text-[#2B2B2B] hover:bg-white",
                    )}
                    onClick={() => onDefineWithAgent(block)}
                    title={
                        isSkeleton
                            ? "Ouvrir l'agent éditeur pour définir ce bloc"
                            : "Ouvrir l'agent éditeur pour modifier ce bloc"
                    }
                >
                    <Wand2 className="mr-2 h-3 w-3" />
                    {isSkeleton ? "Définir avec l'agent" : "Modifier avec l'agent"}
                </Button>
            </div>

            {open && (
                <div className="mt-4 space-y-3 border-t border-[#E8E6E1] pt-3">
                    <div className="rounded-xl border border-[#E8E6E1] bg-[#FCFBF8] px-3 py-2.5">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">
                            Prompt
                        </p>
                        <textarea
                            value={goalDraft}
                            onChange={(event) => setGoalDraft(event.target.value)}
                            placeholder="Décrivez la CTE attendue pour ce bloc, les métriques, filtres et alias à projeter."
                            className="mt-2 min-h-[110px] w-full resize-none rounded-xl border border-[#E8E6E1] bg-white px-3 py-2 text-sm leading-relaxed text-[#2B2B2B] outline-none focus:border-[#0D7377]/40 focus:ring-2 focus:ring-[#0D7377]/10"
                        />
                        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                            <p className="text-[11px] text-[#6B6966]">
                                Le flow backend scanne le template, drafte la CTE depuis ce prompt, valide puis persiste le bloc.
                            </p>
                            <Button
                                type="button"
                                onClick={() => void handleSaveCte()}
                                disabled={!templateId || !goalDraft.trim() || savingCte}
                                className="rounded-xl bg-[#0D7377] px-3 text-xs font-semibold text-white hover:bg-[#0B6164]"
                            >
                                {savingCte ? (
                                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    <Save className="mr-2 h-3.5 w-3.5" />
                                )}
                                {savingCte ? "Génération…" : "Save CTE"}
                            </Button>
                        </div>
                        {saveCteError && (
                            <pre className="mt-3 whitespace-pre-wrap rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[11px] leading-relaxed text-red-700">
                                {saveCteError}
                            </pre>
                        )}
                    </div>
                    {block.mapping && Object.keys(block.mapping).length > 0 && (
                        <Detail
                            label="Mapping"
                            value={Object.entries(block.mapping)
                                .map(([k, v]) => `${k} → ${v}`).join(", ")}
                        />
                    )}
                    {block.grounding_fields && block.grounding_fields.length > 0 && (
                        <Detail label="grounding_fields" value={block.grounding_fields.join(", ")} />
                    )}
                    {block.style && <Detail label="Style" value={block.style} />}
                    {block.fallback_text && (
                        <Detail label="Fallback" value={block.fallback_text} />
                    )}
                    {block.depends_on && block.depends_on.length > 0 && (
                        <Detail label="depends_on" value={block.depends_on.join(", ")} />
                    )}
                    {block.draft_errors && block.draft_errors.length > 0 && (
                        <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                            <p className="font-semibold">Erreurs de validation :</p>
                            <ul className="mt-1 list-disc pl-5">
                                {block.draft_errors.map((e, i) => <li key={i}>{e}</li>)}
                            </ul>
                        </div>
                    )}
                    <div>
                        {tokenCteRows.length > 0 && (
                            <TokenCteMatrix
                                rows={tokenCteRows}
                                activeSubId={activeMixedSub?.id}
                            />
                        )}
                        {block.kind === "mixed" && mixedExecutableSubs.length > 0 && (
                            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-fuchsia-100 bg-fuchsia-50/40 px-3 py-2">
                                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fuchsia-800">
                                    Sous-CTE
                                </span>
                                <select
                                    value={selectedMixedSubId}
                                    onChange={(e) => setMixedSubPick(e.target.value)}
                                    className="max-w-[min(100%,28rem)] rounded-lg border border-fuchsia-200/80 bg-white px-2 py-1.5 font-mono text-xs text-[#2B2B2B]"
                                >
                                    {mixedExecutableSubs.map((s) => (
                                        <option key={s.id} value={s.id}>
                                            {s.id} ({s.kind})
                                        </option>
                                    ))}
                                </select>
                                <span className="text-[10px] text-fuchsia-900/70">
                                    Aperçu DuckDB pour cette feuille du bloc mixte.
                                </span>
                            </div>
                        )}
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                                CTE SQL
                            </p>
                            {canPreview && (
                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={() => setShowAdvanced((p) => !p)}
                                        className="flex items-center gap-1 rounded-lg border border-[#E8E6E1] bg-[#FCFBF8] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#6B6966] hover:bg-white"
                                        title="Lier les $param avant l'exécution (valeurs partagées entre blocs)"
                                    >
                                        <Sliders className="h-3 w-3" />
                                        Paramètres
                                        {blockParams.length > 0 && (
                                            <span className="rounded-full bg-[#0D7377]/10 px-1.5 text-[#0D7377]">
                                                {blockParams.length}
                                            </span>
                                        )}
                                    </button>
                                    <Button
                                        variant="ghost"
                                        onClick={runPreview}
                                        disabled={running}
                                        className="rounded-lg border border-[#0D7377]/30 bg-[#0D7377]/5 px-3 py-1 text-xs font-semibold text-[#0D7377] hover:bg-[#0D7377]/10"
                                        title="Exécuter la CTE sur DuckDB et afficher les lignes projetées"
                                    >
                                        {running
                                            ? <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                            : <Play className="mr-1 h-3 w-3" />}
                                        {running ? "Exécution…" : "Exécuter"}
                                    </Button>
                                </div>
                            )}
                        </div>
                        {block.kind === "mixed" && activeMixedSub ? (
                            mixedSubSqlTrim ? (
                                <pre className="mt-1 max-h-[300px] overflow-auto rounded-xl border border-[#E8E6E1] bg-[#1B1F23] px-4 py-3 text-[12px] leading-relaxed text-[#E6E1D9]">
                                    <code>{activeMixedSub.sql}</code>
                                </pre>
                            ) : mixedSubCteRef ? (
                                resolvedSqlSourceLoading ? (
                                    <div className="mt-1 flex items-center gap-2 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-xs text-sky-800">
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        Chargement de la CTE <code className="font-semibold">sql/fragment_library/{mixedSubCteRef}.sql</code>…
                                    </div>
                                ) : resolvedSqlSourceError ? (
                                    <div className="mt-1 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
                                        Impossible de résoudre <code className="font-semibold">sql/fragment_library/{mixedSubCteRef}.sql</code> : {resolvedSqlSourceError}
                                    </div>
                                ) : resolvedSqlSource?.sql ? (
                                    <ResolvedCteMeta
                                        cteName={resolvedSqlSource.cte_ref || mixedSubCteRef}
                                        sourcePath={resolvedSqlSource.source_path || `sql/fragment_library/${mixedSubCteRef}.sql`}
                                    />
                                ) : (
                                    <div className="mt-1 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-xs text-sky-800">
                                        Référence à <code className="font-semibold">sql/fragment_library/{mixedSubCteRef}.sql</code>
                                    </div>
                                )
                            ) : (
                                <div className="mt-1 rounded-xl border border-dashed border-zinc-300 bg-zinc-50 px-4 py-3 text-xs italic text-zinc-500">
                                    (sous-CTE sans SQL — choisissez une autre entrée.)
                                </div>
                            )
                        ) : hasInline ? (
                            <pre className="mt-1 max-h-[300px] overflow-auto rounded-xl border border-[#E8E6E1] bg-[#1B1F23] px-4 py-3 text-[12px] leading-relaxed text-[#E6E1D9]">
                                <code>{block.sql}</code>
                            </pre>
                        ) : cteRef ? (
                            resolvedSqlSourceLoading ? (
                                <div className="mt-1 flex items-center gap-2 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-xs text-sky-800">
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    Chargement de la CTE <code className="font-semibold">sql/fragment_library/{cteRef}.sql</code>…
                                </div>
                            ) : resolvedSqlSourceError ? (
                                <div className="mt-1 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
                                    Impossible de résoudre <code className="font-semibold">sql/fragment_library/{cteRef}.sql</code> : {resolvedSqlSourceError}
                                </div>
                            ) : resolvedSqlSource?.sql ? (
                                <ResolvedCteMeta
                                    cteName={resolvedSqlSource.cte_ref || cteRef}
                                    sourcePath={resolvedSqlSource.source_path || `sql/fragment_library/${cteRef}.sql`}
                                />
                            ) : (
                                <div className="mt-1 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-xs text-sky-800">
                                    Référence à <code className="font-semibold">sql/fragment_library/{cteRef}.sql</code>
                                </div>
                            )
                        ) : (
                            <div className="mt-1 rounded-xl border border-dashed border-zinc-300 bg-zinc-50 px-4 py-3 text-xs italic text-zinc-500">
                                (non défini — cliquez sur <strong>Définir avec l'agent</strong>{" "}
                                pour générer une CTE.)
                            </div>
                        )}
                        {showAdvanced && canPreview && (
                            <div className="mt-2 rounded-xl border border-[#E8E6E1] bg-[#FCFBF8] px-3 py-3 text-xs">
                                <div className="mb-2 flex items-center justify-between gap-2">
                                    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                                        Paramètres ({blockParams.length})
                                    </p>
                                    <span className="text-[10px] italic text-[#A09E99]">
                                        valeurs partagées avec tous les blocs
                                    </span>
                                </div>
                                {blockParams.length === 0 ? (
                                    <p className="italic text-[#6B6966]">
                                        Aucun <code className="rounded bg-white px-1 font-mono">$param</code>{" "}
                                        détecté dans la CTE.{" "}
                                        Cliquez <strong>Exécuter</strong> une fois pour découvrir ceux issus des{" "}
                                        <code className="rounded bg-white px-1 font-mono">{`{{include: …}}`}</code>.
                                    </p>
                                ) : (
                                    <div className="grid gap-2">
                                        {blockParams.map((name) => (
                                            <label
                                                key={name}
                                                className="grid grid-cols-[140px_1fr] items-center gap-2"
                                            >
                                                <span className="truncate font-mono text-[11px] text-[#2B2B2B]">
                                                    ${name}
                                                </span>
                                                <input
                                                    type="text"
                                                    value={paramValues[name] ?? ""}
                                                    onChange={(e) => onParamChange(name, e.target.value)}
                                                    placeholder={
                                                        name === "period"
                                                            ? "2024-01 ou 2024-01-01..2024-12-31"
                                                            : ""
                                                    }
                                                    spellCheck={false}
                                                    className="rounded-lg border border-[#E8E6E1] bg-white px-2 py-1 font-mono text-[11px] text-[#2B2B2B] outline-none focus:border-[#0D7377]/40 focus:ring-1 focus:ring-[#0D7377]/10"
                                                />
                                            </label>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}
                        {previewError && (
                            <div className="mt-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                                <p className="flex items-center gap-1 font-semibold">
                                    <AlertTriangle className="h-3 w-3" />
                                    Échec de l'exécution
                                </p>
                                <pre className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed">
                                    {previewError}
                                </pre>
                            </div>
                        )}
                        {previewResult && (
                            <PreviewResultTable result={previewResult} />
                        )}
                    </div>
                    {block.ctes && block.ctes.length > 0 && (
                        <div>
                            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                                Sous-CTE ({block.ctes.length})
                            </p>
                            <div className="mt-1 space-y-2">
                                {block.ctes.map((sub, idx) => (
                                    <div
                                        key={`${sub.id}-${idx}`}
                                        className="rounded-xl border border-[#E8E6E1] bg-[#FCFBF8] px-3 py-2 text-xs"
                                    >
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="font-mono font-semibold text-[#2B2B2B]">
                                                {sub.id}
                                            </span>
                                            <span
                                                className={cn(
                                                    "rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.18em]",
                                                    KIND_BADGE_STYLES[sub.kind] ?? "border-zinc-200 bg-zinc-50 text-zinc-700",
                                                )}
                                            >
                                                {sub.kind}
                                            </span>
                                            {sub.cte_ref && (
                                                <span className="font-mono text-[10px] text-sky-700">
                                                    ref: {sub.cte_ref}
                                                </span>
                                            )}
                                        </div>
                                        {sub.tokens && sub.tokens.length > 0 && (
                                            <p className="mt-1 font-mono text-[10px] text-[#6B6966]">
                                                tokens: {sub.tokens.join(", ")}
                                            </p>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                    {block._scan?.html_excerpt && (
                        <div>
                            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                                Extrait HTML
                            </p>
                            <pre className="mt-1 max-h-[160px] overflow-auto rounded-xl border border-[#E8E6E1] bg-[#FCFBF8] px-3 py-2 text-[11px] leading-relaxed text-[#2B2B2B]">
                                <code>{block._scan.html_excerpt}</code>
                            </pre>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};


const Detail: React.FC<{ label: string; value: string }> = ({ label, value }) => (
    <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-3 text-xs">
        <span className="font-semibold uppercase tracking-[0.18em] text-[#A09E99]">{label}</span>
        <span className="break-words text-[#2B2B2B]">{value}</span>
    </div>
);


type TokenCteRow = {
    token: string;
    alias: string;
    sourceLabel: string;
    subId?: string | null;
};

function formatDslTokenLabel(token: string): string {
    return token.startsWith("NARRATIVE:") ? token : `{{${token}}}`;
}

function inferSqlAlias(token: string, mapping?: Record<string, string>): string {
    const explicit = mapping?.[token];
    if (explicit && explicit.trim()) return explicit.trim();
    if (token.startsWith("NARRATIVE:")) {
        return token.slice("NARRATIVE:".length).toLowerCase();
    }
    return token.toLowerCase();
}

function describeCteSource(
    label: string,
    sql?: string,
    cteRef?: string | null,
): string {
    const ref = (cteRef || "").trim();
    if (ref) return `${label} -> sql/fragment_library/${ref}.sql`;
    if ((sql || "").trim()) return `${label} -> CTE inline`;
    return `${label} -> non défini`;
}

function buildTokenCteRows(block: MergedBlock): TokenCteRow[] {
    const seen = new Set<string>();
    const rows: TokenCteRow[] = [];
    const add = (token: string, sourceLabel: string, subId?: string | null) => {
        const key = `${token}::${sourceLabel}`;
        if (!token || seen.has(key)) return;
        seen.add(key);
        rows.push({
            token,
            alias: inferSqlAlias(token, block.mapping),
            sourceLabel,
            subId: subId ?? null,
        });
    };

    const blockTokens = block.tokens ?? [];
    const mainSource = describeCteSource("CTE principale", block.sql, block.cte_ref);

    if (block.kind === "mixed" && block.ctes?.length) {
        const covered = new Set<string>();
        for (const sub of block.ctes) {
            const subTokens = sub.tokens ?? [];
            const subSource = describeCteSource(
                `Sous-CTE ${sub.id}`,
                sub.sql,
                sub.cte_ref,
            );
            for (const token of subTokens) {
                covered.add(token);
                add(token, subSource, sub.id);
            }
        }
        for (const token of blockTokens) {
            if (!covered.has(token)) add(token, mainSource, null);
        }
        if (rows.length === 0) {
            for (const token of blockTokens) add(token, mainSource, null);
        }
        return rows;
    }

    for (const token of blockTokens) add(token, mainSource, null);
    return rows;
}

const TokenCteMatrix: React.FC<{
    rows: TokenCteRow[];
    activeSubId?: string;
}> = ({ rows, activeSubId }) => (
    <div className="mb-3 rounded-xl border border-[#E8E6E1] bg-[#FCFBF8] px-3 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                Jetons HTML vers CTE
            </p>
            <span className="text-[10px] text-[#A09E99]">
                Correspondance entre les `{"{{TOKEN}}"}` et la CTE qui les alimente
            </span>
        </div>
        <div className="mt-2 space-y-2">
            {rows.map((row, idx) => (
                <div
                    key={`${row.token}-${row.sourceLabel}-${idx}`}
                    className={cn(
                        "grid gap-2 rounded-xl border bg-white px-3 py-2 text-xs md:grid-cols-[minmax(0,0.95fr)_minmax(0,0.8fr)_minmax(0,1.45fr)]",
                        row.subId && activeSubId === row.subId
                            ? "border-fuchsia-200 bg-fuchsia-50/30"
                            : "border-[#E8E6E1]",
                    )}
                >
                    <div className="min-w-0">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#A09E99]">
                            Token
                        </p>
                        <code className="mt-1 block break-words rounded bg-[#F8F7F4] px-1.5 py-1 font-mono text-[11px] text-[#2B2B2B]">
                            {formatDslTokenLabel(row.token)}
                        </code>
                    </div>
                    <div className="min-w-0">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#A09E99]">
                            Alias SQL
                        </p>
                        <code className="mt-1 block break-words rounded bg-[#F8F7F4] px-1.5 py-1 font-mono text-[11px] text-[#2B2B2B]">
                            {row.alias}
                        </code>
                    </div>
                    <div className="min-w-0">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#A09E99]">
                            CTE source
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                            <span className="break-words font-mono text-[11px] text-[#2B2B2B]">
                                {row.sourceLabel}
                            </span>
                            {row.subId && activeSubId === row.subId && (
                                <span className="rounded-full border border-fuchsia-200 bg-fuchsia-50 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-fuchsia-700">
                                    sous-CTE active
                                </span>
                            )}
                        </div>
                    </div>
                </div>
            ))}
        </div>
    </div>
);


const FocusedBlockCtePanel: React.FC<{
    block: MergedBlock;
    focusIntent: AgentHandoffIntent;
    templateId: string;
    onBlockSaved: () => void;
    paramValues: Record<string, string>;
    parquetPaths: Record<string, string>;
}> = ({ block, focusIntent, templateId, onBlockSaved, paramValues, parquetPaths }) => {
    const tokenRows = React.useMemo(() => buildTokenCteRows(block), [block]);
    const mainSql = (block.sql || "").trim();
    const mainRef = (block.cte_ref || "").trim();
    const promptText = (block.goal || "").trim();
    const blockStatus = (block.status || "").trim();
    const [editingPrompt, setEditingPrompt] = React.useState(false);
    const [promptDraft, setPromptDraft] = React.useState(promptText);
    const [savingPrompt, setSavingPrompt] = React.useState(false);
    const [promptSaveError, setPromptSaveError] = React.useState<string | null>(null);
    const effectivePromptText = editingPrompt ? promptDraft : (promptDraft || promptText);

    React.useEffect(() => {
        setPromptDraft(promptText);
        setEditingPrompt(false);
        setPromptSaveError(null);
    }, [block.id, promptText]);

    const visibleSubCtes = React.useMemo(
        () => (block.ctes ?? []).filter((sub) => {
            const hasSql = !!(sub.sql || "").trim();
            const hasRef = !!(sub.cte_ref || "").trim();
            return hasSql || hasRef;
        }),
        [block.ctes],
    );
    const {
        result: resolvedMainSqlSource,
        loading: resolvedMainSqlSourceLoading,
        error: resolvedMainSqlSourceError,
    } = useResolvedBlockSqlSource(
        templateId,
        block.id,
        null,
        !!templateId && !mainSql && !!mainRef,
    );
    const executableSqlForPreview = React.useMemo(
        () => (mainSql || resolvedMainSqlSource?.expanded_sql || resolvedMainSqlSource?.sql || "").trim(),
        [mainSql, resolvedMainSqlSource],
    );
    const ctePreviewParams = React.useMemo<string[]>(() => {
        const names = extractDollarParams(executableSqlForPreview);
        return Array.from(new Set(names)).sort();
    }, [executableSqlForPreview]);
    const canPreviewMainCte =
        !!templateId &&
        !block.deprecated &&
        block.kind !== "mixed" &&
        !!(mainSql || mainRef);
    const [runningPreview, setRunningPreview] = React.useState(false);
    const [previewError, setPreviewError] = React.useState<string | null>(null);
    const [previewResult, setPreviewResult] = React.useState<BlockPreviewResult | null>(null);

    const handleSavePrompt = React.useCallback(async () => {
        if (!templateId.trim() || savingPrompt) return;
        setSavingPrompt(true);
        setPromptSaveError(null);
        try {
            await upsertReportBlock(templateId, block.id, {
                kind: block.kind,
                goal: promptDraft.trim(),
                tokens: block.tokens ?? [],
                mapping: block.mapping,
                grounding_fields: block.grounding_fields,
                sql: block.sql,
                cte_ref: block.cte_ref ?? null,
                ctes: block.ctes,
                depends_on: block.depends_on,
                style: (block as any).style,
                fallback_text: (block as any).fallback_text,
            });
            setEditingPrompt(false);
            onBlockSaved();
        } catch (e: any) {
            setPromptSaveError(String(e?.detail?.message ?? e?.message ?? e));
        } finally {
            setSavingPrompt(false);
        }
    }, [templateId, savingPrompt, block, promptDraft, onBlockSaved]);

    const runCtePreview = React.useCallback(async () => {
        if (!canPreviewMainCte) return;
        setRunningPreview(true);
        setPreviewError(null);
        const cleanedParams: Record<string, any> = {};
        for (const name of ctePreviewParams) {
            const value = (paramValues[name] ?? "").trim();
            if (value !== "") cleanedParams[name] = value;
        }
        const cleanedParquet: Record<string, string> = {};
        for (const [k, v] of Object.entries(parquetPaths || {})) {
            if (typeof v === "string" && v.trim() !== "") cleanedParquet[k] = v;
        }
        try {
            const result = await previewReportBlock(templateId, block.id, {
                parameters: Object.keys(cleanedParams).length > 0 ? cleanedParams : undefined,
                parquet_paths: Object.keys(cleanedParquet).length > 0 ? cleanedParquet : undefined,
                limit: 25,
            });
            setPreviewResult(result);
        } catch (e: any) {
            setPreviewError(String(e?.detail ?? e?.message ?? e));
        } finally {
            setRunningPreview(false);
        }
    }, [canPreviewMainCte, ctePreviewParams, paramValues, parquetPaths, templateId, block.id]);

    if (
        tokenRows.length === 0 &&
        !mainSql &&
        !mainRef &&
        visibleSubCtes.length === 0
    ) {
        return null;
    }

    return (
        <div className="border-t border-[#E8E6E1] bg-[#FCFBF8] px-5 py-4">
            <div className="flex flex-wrap gap-2">
                <span className="rounded-full border border-[#E8E6E1] bg-white px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#6B6966]">
                    Bloc {block.id}
                </span>
                <span className="rounded-full border border-[#E8E6E1] bg-white px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#6B6966]">
                    {focusIntent === "layout" ? "Patch HTML attendu" : "Mise à jour définition attendue"}
                </span>
                <span className="rounded-full border border-[#E8E6E1] bg-white px-2 py-0.5 text-[10px] font-semibold text-[#6B6966]">
                    {block.kind}
                </span>
                {blockStatus && (
                    <span
                        className={cn(
                            "rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em]",
                            STATUS_BADGE_STYLES[blockStatus] ?? "border-zinc-200 bg-zinc-50 text-zinc-700",
                        )}
                    >
                        {blockStatus}
                    </span>
                )}
            </div>

            <div className="mt-3 rounded-xl border border-[#E8E6E1] bg-white px-4 py-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                    CTE correspondante
                </p>
                <p className="mt-1 text-xs text-[#6B6966]">
                    SQL ou référence utilisée pour alimenter les `{"{{TOKENS}}"}` de ce bloc.
                </p>
            </div>

            <div className="mt-3 rounded-xl border border-[#E8E6E1] bg-white px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                        Prompt du bloc
                    </p>
                    {!editingPrompt ? (
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 rounded-xl border-[#E8E6E1] bg-white px-3 text-xs"
                            onClick={() => {
                                setPromptDraft(effectivePromptText);
                                setEditingPrompt(true);
                                setPromptSaveError(null);
                            }}
                        >
                            Modifier
                        </Button>
                    ) : (
                        <div className="flex items-center gap-2">
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-8 rounded-xl border-[#E8E6E1] bg-white px-3 text-xs"
                                onClick={() => {
                                    setPromptDraft(promptText);
                                    setEditingPrompt(false);
                                    setPromptSaveError(null);
                                }}
                                disabled={savingPrompt}
                            >
                                Annuler
                            </Button>
                            <Button
                                type="button"
                                size="sm"
                                className="h-8 rounded-xl bg-[#0D7377] px-3 text-xs text-white hover:bg-[#0B6164]"
                                onClick={handleSavePrompt}
                                disabled={savingPrompt}
                            >
                                {savingPrompt ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                                Enregistrer
                            </Button>
                        </div>
                    )}
                </div>
                {editingPrompt ? (
                    <>
                        <textarea
                            value={promptDraft}
                            onChange={(e) => setPromptDraft(e.target.value)}
                            className="mt-2 min-h-[112px] w-full resize-y rounded-xl border border-[#E8E6E1] bg-white px-3 py-2 text-sm leading-relaxed text-[#2B2B2B] outline-none focus:border-[#0D7377]/40 focus:ring-2 focus:ring-[#0D7377]/10"
                            placeholder="Décrivez ce que ce bloc doit afficher ou calculer."
                        />
                        {promptSaveError && (
                            <div className="mt-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                                {promptSaveError}
                            </div>
                        )}
                    </>
                ) : (
                    <p className={cn(
                        "mt-2 text-sm leading-relaxed",
                        effectivePromptText ? "text-[#2B2B2B]" : "italic text-[#A09E99]",
                    )}>
                        {effectivePromptText || "Aucune consigne enregistrée pour ce bloc."}
                    </p>
                )}
            </div>

            {tokenRows.length > 0 && (
                <div className="mt-3">
                    <TokenCteMatrix rows={tokenRows} />
                </div>
            )}

            {block.kind !== "mixed" ? (
                <div className="mt-3 rounded-xl border border-[#E8E6E1] bg-white px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                                CTE associée au data-block
                            </p>
                            {mainRef && (
                                <span className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-sky-700">
                                    cte_ref
                                </span>
                            )}
                        </div>
                        {canPreviewMainCte && (
                            <Button
                                type="button"
                                variant="ghost"
                                onClick={() => void runCtePreview()}
                                disabled={runningPreview}
                                className="rounded-lg border border-[#0D7377]/30 bg-[#0D7377]/5 px-3 py-1 text-xs font-semibold text-[#0D7377] hover:bg-[#0D7377]/10"
                                title="Exécuter la CTE sur DuckDB et afficher le résultat"
                            >
                                {runningPreview
                                    ? <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                    : <Play className="mr-1 h-3 w-3" />}
                                {runningPreview ? "Exécution…" : "Exécuter"}
                            </Button>
                        )}
                    </div>
                    {mainSql ? (
                        <pre className="mt-2 max-h-[320px] overflow-auto rounded-xl bg-[#1B1F23] px-4 py-3 text-[12px] leading-relaxed text-[#E6E1D9]">
                            <code>{block.sql}</code>
                        </pre>
                    ) : mainRef ? (
                        resolvedMainSqlSourceLoading ? (
                            <div className="mt-2 flex items-center gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                Chargement de la CTE <code className="font-semibold">sql/fragment_library/{mainRef}.sql</code>…
                            </div>
                        ) : resolvedMainSqlSourceError ? (
                            <div className="mt-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                                Impossible de résoudre <code className="font-semibold">sql/fragment_library/{mainRef}.sql</code> : {resolvedMainSqlSourceError}
                            </div>
                        ) : resolvedMainSqlSource?.sql ? (
                            <ResolvedCteMeta
                                cteName={resolvedMainSqlSource.cte_ref || mainRef}
                                sourcePath={resolvedMainSqlSource.source_path || `sql/fragment_library/${mainRef}.sql`}
                            />
                        ) : (
                            <div className="mt-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
                                Référence <code className="font-semibold">sql/fragment_library/{mainRef}.sql</code>
                            </div>
                        )
                    ) : (
                        <div className="mt-2 rounded-xl border border-dashed border-zinc-300 bg-zinc-50 px-3 py-2 text-xs italic text-zinc-500">
                            Aucune CTE définie pour ce bloc.
                        </div>
                    )}
                    {previewError && (
                        <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                            <p className="flex items-center gap-1 font-semibold">
                                <AlertTriangle className="h-3 w-3" />
                                Échec de l&apos;exécution
                            </p>
                            <pre className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed">
                                {previewError}
                            </pre>
                        </div>
                    )}
                    {previewResult && (
                        <PreviewResultTable result={previewResult} />
                    )}
                </div>
            ) : (
                <div className="mt-3 space-y-3">
                    {visibleSubCtes.map((sub, idx) => {
                        const subSql = (sub.sql || "").trim();
                        const subRef = (sub.cte_ref || "").trim();
                        return (
                            <div
                                key={`${sub.id}-${idx}`}
                                className="rounded-xl border border-[#E8E6E1] bg-white px-4 py-3"
                            >
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="font-mono text-xs font-semibold text-[#2B2B2B]">
                                        {sub.id}
                                    </span>
                                    <span
                                        className={cn(
                                            "rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.16em]",
                                            KIND_BADGE_STYLES[sub.kind] ?? "border-zinc-200 bg-zinc-50 text-zinc-700",
                                        )}
                                    >
                                        {sub.kind}
                                    </span>
                                    {subRef && (
                                        <span className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 font-mono text-[10px] font-semibold text-sky-700">
                                            sql/fragment_library/{subRef}.sql
                                        </span>
                                    )}
                                </div>
                                {sub.tokens && sub.tokens.length > 0 && (
                                    <div className="mt-2 flex flex-wrap gap-1">
                                        {sub.tokens.map((token) => (
                                            <code
                                                key={token}
                                                className="rounded bg-[#F8F7F4] px-1.5 py-1 font-mono text-[10px] text-[#2B2B2B]"
                                            >
                                                {formatDslTokenLabel(token)}
                                            </code>
                                        ))}
                                    </div>
                                )}
                                {subSql ? (
                                    <pre className="mt-2 max-h-[280px] overflow-auto rounded-xl bg-[#1B1F23] px-4 py-3 text-[12px] leading-relaxed text-[#E6E1D9]">
                                        <code>{sub.sql}</code>
                                    </pre>
                                ) : (
                                    <div className="mt-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
                                        Référence à <code className="font-semibold">sql/fragment_library/{subRef}.sql</code>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};


/**
 * Inline rendering of :func:`previewReportBlock`'s response — the
 * columns + rows actually returned by DuckDB, plus the bound parameter
 * values and any soft warnings (truncation, NULL bindings…).
 *
 * Cell values arrive already JSON-coerced from the backend (dates as
 * ISO strings, decimals as floats, etc.) so we just need to render
 * them and right-align numerics for legibility.
 */
const PreviewResultTable: React.FC<{ result: BlockPreviewResult }> = ({ result }) => {
    const formatCell = (v: any): string => {
        if (v === null || v === undefined) return "—";
        if (typeof v === "number") {
            return Number.isInteger(v) ? v.toString() : v.toLocaleString();
        }
        if (typeof v === "boolean") return v ? "true" : "false";
        if (typeof v === "object") return JSON.stringify(v);
        return String(v);
    };
    const isNumericCol = (idx: number): boolean =>
        result.rows.length > 0 &&
        result.rows.every((r) => {
            const v = r[idx];
            return v === null || v === undefined || typeof v === "number";
        });
    const empty = result.rows.length === 0;
    return (
        <div className="mt-3 rounded-xl border border-[#E8E6E1] bg-white">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#E8E6E1] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#6B6966]">
                <span className="flex flex-wrap items-center gap-1.5">
                    <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                    Résultat ({result.row_count} ligne{result.row_count !== 1 ? "s" : ""}
                    {result.truncated ? ", tronqué" : ""}
                    {" · "}
                    {result.duration_ms.toFixed(1)} ms)
                    {result.sub_block_id && (
                        <span className="rounded-md bg-fuchsia-100/80 px-1.5 font-mono normal-case text-fuchsia-900">
                            {result.block_id}.{result.sub_block_id}
                        </span>
                    )}
                </span>
                {result.referenced_params.length > 0 && (
                    <span className="font-mono normal-case text-[10px] text-[#6B6966]">
                        params:{" "}
                        {result.referenced_params
                            .map((p) => `${p}=${formatCell(result.bound_params[p])}`)
                            .join(", ")}
                    </span>
                )}
            </div>
            {empty ? (
                <div className="px-3 py-6 text-center text-xs italic text-[#A09E99]">
                    (aucune ligne — la CTE s'exécute mais ne projette rien.)
                </div>
            ) : (
                <div className="max-h-[280px] overflow-auto">
                    <table className="w-full border-collapse text-[11px]">
                        <thead className="sticky top-0 bg-[#F8F7F4]">
                            <tr>
                                {result.columns.map((c, i) => (
                                    <th
                                        key={`${c}-${i}`}
                                        className={cn(
                                            "border-b border-[#E8E6E1] px-2 py-1.5 font-mono text-[10px] font-semibold text-[#2B2B2B]",
                                            isNumericCol(i) ? "text-right" : "text-left",
                                        )}
                                    >
                                        {c}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {result.rows.map((row, rIdx) => (
                                <tr
                                    key={rIdx}
                                    className={rIdx % 2 === 0 ? "bg-white" : "bg-[#FCFBF8]"}
                                >
                                    {row.map((cell, cIdx) => (
                                        <td
                                            key={cIdx}
                                            className={cn(
                                                "border-b border-[#F0EEE9] px-2 py-1 align-top font-mono text-[#2B2B2B]",
                                                isNumericCol(cIdx)
                                                    ? "text-right tabular-nums"
                                                    : "text-left",
                                                (cell === null || cell === undefined) &&
                                                    "italic text-[#A09E99]",
                                            )}
                                        >
                                            {formatCell(cell)}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {result.warnings.length > 0 && (
                <ul className="border-t border-[#E8E6E1] bg-amber-50 px-3 py-1.5 text-[10px] text-amber-800">
                    {result.warnings.map((w, i) => (
                        <li key={i} className="flex items-start gap-1">
                            <AlertTriangle className="mt-0.5 h-2.5 w-2.5 shrink-0 text-amber-600" />
                            <span>{w}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};


const ChatPane: React.FC<{
    template: ReportTemplateInfo | undefined;
    messages: ChatMessage[];
    chatInput: string;
    onInputChange: (v: string) => void;
    onSend: () => void;
    scrollRef: React.RefObject<HTMLDivElement | null>;
    phase: "idle" | "running" | "completed" | "failed";
}> = ({
    template, messages, chatInput, onInputChange, onSend, scrollRef, phase,
}) => {
    type PanelTab = "conversation" | "activity";
    const [showToolGuide, setShowToolGuide] = React.useState(false);
    const [panelTab, setPanelTab] = React.useState<PanelTab>("conversation");
    const conversationMessages = React.useMemo(
        () => messages.filter((msg) => msg.kind === "user" || msg.kind === "assistant" || msg.kind === "error"),
        [messages],
    );
    const activityMessages = React.useMemo(
        () => messages.filter((msg) => msg.kind === "tool" || msg.kind === "thinking"),
        [messages],
    );
    const toolEventCount = activityMessages.filter((msg) => msg.kind === "tool").length;
    const thinkingEventCount = activityMessages.filter((msg) => msg.kind === "thinking").length;
    const tabItems: Array<{
        id: PanelTab;
        label: string;
        icon: React.ComponentType<{ className?: string }>;
        count?: number;
    }> = [
        { id: "conversation", label: "Conversation", icon: PenLine, count: conversationMessages.length || undefined },
        { id: "activity", label: "Activité", icon: ListChecks, count: activityMessages.length || undefined },
    ];

    return (
        <div className="rounded-[32px] border border-[#E8E6E1] bg-[#FCFBF8] p-4 shadow-[0_18px_50px_rgba(15,23,42,0.05)] xl:flex xl:h-[calc(100dvh-11.5rem)] xl:flex-col xl:overflow-hidden">
            <div className="space-y-4 xl:grid xl:min-h-0 xl:flex-1 xl:grid-rows-[auto_minmax(0,1fr)_auto] xl:gap-4 xl:space-y-0">
                <div className="rounded-[22px] border border-[#E8E6E1] bg-white p-3">
                    <div className="flex flex-wrap gap-1.5">
                        {tabItems.map((tab) => {
                            const Icon = tab.icon;
                            const isActive = panelTab === tab.id;
                            return (
                                <button
                                    key={tab.id}
                                    type="button"
                                    onClick={() => setPanelTab(tab.id)}
                                    className={cn(
                                        "inline-flex items-center gap-2 rounded-[14px] border px-3 py-1.5 text-xs font-semibold transition-all",
                                        isActive
                                            ? "border-[#0D7377]/20 bg-white text-[#0D7377] shadow-sm"
                                            : "border-transparent text-[#6B6966] hover:border-[#E8E6E1] hover:bg-white/80",
                                    )}
                                >
                                    <Icon className="h-3.5 w-3.5" />
                                    <span>{tab.label}</span>
                                    {tab.count ? (
                                        <span className={cn(
                                            "rounded-full px-1.5 py-0.5 text-[10px]",
                                            isActive ? "bg-[#0D7377]/10 text-[#0D7377]" : "bg-[#F0EEE9] text-[#8A867F]",
                                        )}>
                                            {tab.count}
                                        </span>
                                    ) : null}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {panelTab === "conversation" && (
                    <div className="rounded-[28px] border border-[#E8E6E1] bg-white xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
                        {(toolEventCount > 0 || thinkingEventCount > 0) && (
                            <div className="flex items-center justify-end border-b border-[#E8E6E1] px-3 py-2">
                                <button
                                    type="button"
                                    onClick={() => setPanelTab("activity")}
                                    className="rounded-xl border border-[#E8E6E1] bg-white px-3 py-1.5 text-[11px] font-medium text-[#6B6966] hover:text-[#2B2B2B]"
                                >
                                    {toolEventCount} outil(s) · {thinkingEventCount} étape(s) agent
                                </button>
                            </div>
                        )}
                        <div
                            ref={scrollRef}
                            className="flex h-[clamp(18rem,44dvh,32rem)] min-h-[18rem] flex-col space-y-3 overflow-y-auto px-4 py-4 md:h-[clamp(20rem,46dvh,34rem)] xl:h-auto xl:min-h-0 xl:flex-1"
                        >
                            {conversationMessages.map((msg, i) => (
                                <ChatBubble key={i} message={msg} />
                            ))}
                            {phase === "running" && (
                                <div className="self-start rounded-full bg-[#0D7377]/8 px-3 py-1 text-xs text-[#0D7377]">
                                    <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
                                    L&apos;agent prépare la réponse…
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {panelTab === "activity" && (
                    <div className="grid gap-3 rounded-[28px] border border-[#E8E6E1] bg-white p-3 xl:min-h-0 xl:flex-1 xl:overflow-y-auto">
                        <div className="rounded-[18px] border border-[#E8E6E1] bg-white p-3 text-xs leading-relaxed text-[#6B6966]">
                            <div className="flex items-center justify-between gap-3">
                                <p className="font-semibold text-[#2B2B2B]">
                                    Outils disponibles pour cette conversation
                                </p>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-8 rounded-xl border-[#E8E6E1] bg-white px-3 text-xs"
                                    onClick={() => setShowToolGuide((v) => !v)}
                                >
                                    {showToolGuide ? "Réduire" : "Afficher"}
                                </Button>
                            </div>
                            {showToolGuide && (
                                <>
                                    <p className="mt-2">
                                        <span className="font-mono text-[11px] text-[#2B2B2B]">
                                            list_blocks · get_block · get_block_html · propose_block_definition · set_block_definition · preview_block · delete_block · rescan_template · apply_template_html_patch
                                        </span>
                                    </p>
                                    <p className="mt-2">
                                        Chaque écriture est validée avant persistance, puis tracée dans
                                        <code className="mx-1 rounded bg-[#F8F7F4] px-1 font-mono text-[11px]">definitions.history.jsonl</code>.
                                    </p>
                                </>
                            )}
                        </div>

                        <div className="rounded-[18px] border border-[#E8E6E1] bg-white">
                            <div className="flex items-center justify-between gap-3 border-b border-[#E8E6E1] px-4 py-3">
                                <div>
                                    <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">
                                        Chronologie technique
                                    </p>
                                    <p className="mt-1 text-sm text-[#6B6966]">
                                        Appels outils et étapes internes de l’agent.
                                    </p>
                                </div>
                                <span className="rounded-full border border-[#E8E6E1] bg-[#FCFBF8] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#6B6966]">
                                    {activityMessages.length} événement(s)
                                </span>
                            </div>
                            <div className="max-h-[clamp(16rem,40dvh,26rem)] space-y-3 overflow-y-auto px-4 py-4">
                                {activityMessages.length === 0 ? (
                                    <div className="rounded-xl border border-dashed border-[#E8E6E1] bg-[#FCFBF8] px-4 py-6 text-center text-xs text-[#A09E99]">
                                        Aucune trace technique pour cette conversation.
                                    </div>
                                ) : (
                                    activityMessages.map((msg, i) => (
                                        <ChatBubble key={i} message={msg} />
                                    ))
                                )}
                            </div>
                        </div>
                    </div>
                )}

                <div className="rounded-[22px] border border-[#E8E6E1] bg-white p-3 shadow-[0_8px_20px_rgba(15,23,42,0.03)]">
                    <div className="flex items-stretch gap-3">
                        <textarea
                            value={chatInput}
                            onChange={(e) => onInputChange(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.shiftKey) {
                                    e.preventDefault();
                                    onSend();
                                }
                            }}
                            disabled={!template || phase === "running"}
                            placeholder="Ex : augmente les marges latérales, aligne les KPI sur 3 colonnes et réduis la densité visuelle du tableau"
                            className="min-h-[84px] flex-1 resize-none rounded-[18px] border border-[#E8E6E1] bg-white px-4 py-3 text-sm text-[#2B2B2B] outline-none transition-all placeholder:text-[#A09E99] focus:border-[#0D7377]/40 focus:ring-2 focus:ring-[#0D7377]/10 disabled:opacity-60 xl:min-h-[96px]"
                        />
                        <Button
                            className="h-auto min-w-[56px] rounded-[18px] bg-[#0D7377] px-4 text-white hover:bg-[#0B6164]"
                            onClick={onSend}
                            disabled={!template || !chatInput.trim() || phase === "running"}
                        >
                            <Send className="h-4 w-4" />
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
};


const ChatBubble: React.FC<{ message: ChatMessage }> = ({ message }) => {
    if (message.kind === "user") {
        return (
            <div className="flex justify-end">
                <div className="max-w-[88%] rounded-[20px] bg-[#0D7377] px-4 py-3 text-sm leading-relaxed text-white shadow-sm">
                    {message.content}
                </div>
            </div>
        );
    }
    if (message.kind === "assistant") {
        return (
            <div className="flex justify-start">
                <div className="max-w-[88%] rounded-[20px] border border-[#E8E6E1] bg-white px-4 py-3 text-sm leading-relaxed text-[#2B2B2B] shadow-sm">
                    <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#0D7377]">
                        <Sparkles className="h-3 w-3" />
                        Agent
                    </div>
                    {message.content}
                </div>
            </div>
        );
    }
    if (message.kind === "tool") {
        const ok = message.status === "success" || message.status === "ok";
        return (
            <div className="flex justify-start">
                <div className={cn(
                    "max-w-[94%] rounded-[18px] border px-3 py-2 text-xs shadow-sm",
                    ok ? "border-[#D8E8E3] bg-[#F7FBF9] text-[#3E6358]"
                       : "border-amber-200 bg-amber-50 text-amber-800",
                )}>
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold uppercase tracking-[0.18em]">
                            {ok ? "outil exécuté" : `outil ${message.status}`}
                        </span>
                        <code className="rounded bg-white/80 px-1.5 py-0.5 text-[11px]">{message.tool}</code>
                    </div>
                    {message.preview && (
                        <details className="mt-2">
                            <summary className="cursor-pointer list-none text-[11px] font-semibold text-[#6B6966]">
                                Voir le détail technique
                            </summary>
                            <pre className="mt-2 max-h-[180px] overflow-auto whitespace-pre-wrap rounded-xl border border-white/70 bg-white/80 px-3 py-2 text-[11px] leading-snug text-[#5C5A57]">
                                {message.preview}
                            </pre>
                        </details>
                    )}
                </div>
            </div>
        );
    }
    if (message.kind === "thinking") {
        return (
            <div className="flex justify-start">
                <div className="max-w-[88%] rounded-[18px] border border-blue-100 bg-blue-50 px-3 py-1.5 text-[11px] italic text-blue-700">
                    {message.content}
                </div>
            </div>
        );
    }
    return (
        <div className="flex justify-start">
            <div className="max-w-[92%] rounded-[18px] border border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">
                <AlertTriangle className="mr-2 inline h-3 w-3" />
                {message.content}
            </div>
        </div>
    );
};


const RenderPane: React.FC<{
    template: ReportTemplateInfo | undefined;
    definitions: ReportDefinitions | null;
    params: string;
    onParamsChange: (v: string) => void;
    rendering: boolean;
    result: RenderResult | null;
    error: string | null;
    onRender: () => void;
    onBootstrap: () => void;
    bootstrapPhase: "idle" | "running" | "completed" | "failed";
    /** Same map shown in « Source de données » (Définitions tab). */
    parquetSelection: Record<string, string>;
}> = ({
    template, definitions, params, onParamsChange, rendering,
    result, error, onRender, onBootstrap, bootstrapPhase,
    parquetSelection,
}) => {
    const hasDefinitions = !!definitions && (definitions.blocks?.length ?? 0) > 0;
    const renderDisabled = rendering || !template || !hasDefinitions;
    const [pdfExportError, setPdfExportError] = React.useState<string | null>(null);

    /* Mirror the « Source de données » panel: list every declared
     * source and surface what « Lancer le rendu » will send.  Any
     * name left empty falls back to the backend's period-aware
     * auto-detection — make that contract visible to the user. */
    const declaredSources = (definitions?.sources ?? [])
        .map((s) => s?.name)
        .filter((n): n is string => typeof n === "string" && n.length > 0);
    const _basename = (p: string) => p.split(/[\\/]/).pop() ?? p;
    const boundCount = declaredSources.filter(
        (n) => (parquetSelection?.[n] ?? "").trim() !== "",
    ).length;

    const handleExportPdf = React.useCallback(() => {
        if (!result?.html || !template) return;
        const ok = openReportPdfExport(
            result.html,
            `${template.template_id}-report`,
        );
        setPdfExportError(
            ok
                ? null
                : "Impossible d’ouvrir la fenêtre d’impression. Autorisez les popups puis réessayez.",
        );
    }, [result?.html, template]);

    return (
    <div className="space-y-4">
        <div className="rounded-[24px] border border-[#E8E6E1] bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E8E6E1] pb-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">
                    Rendu HTML synchrone
                </p>
                <Button
                    className="rounded-xl bg-[#0D7377] px-4 text-white hover:bg-[#0B6164]"
                    onClick={onRender}
                    disabled={renderDisabled}
                    title={!hasDefinitions ? "Amorcez d'abord les blocs" : undefined}
                >
                    {rendering
                        ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        : <PlayCircle className="mr-2 h-4 w-4" />}
                    {rendering ? "Rendu en cours…" : "Lancer le rendu"}
                </Button>
            </div>

            {!hasDefinitions && template && (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    <div className="flex items-start gap-2">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        <div>
                            <p className="font-semibold">Aucun fichier definitions.yaml.</p>
                            <p className="mt-1 text-xs">
                                À l&apos;ouverture, un fichier minimal est créé automatiquement
                                (une entrée squelette par <code className="rounded bg-[#F8F7F4] px-1 font-mono">data-block</code>
                                ). Complétez ensuite la logique SQL bloc par bloc, ou lancez
                                <strong className="mx-1 font-semibold">Amorcer maintenant</strong>
                                pour un brouillon LLM sur tout le template.
                            </p>
                        </div>
                    </div>
                    <Button
                        className="rounded-xl bg-[#0D7377] px-3 text-white hover:bg-[#0B6164]"
                        onClick={onBootstrap}
                        disabled={bootstrapPhase === "running"}
                    >
                        {bootstrapPhase === "running"
                            ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            : <Wand2 className="mr-2 h-4 w-4" />}
                        {bootstrapPhase === "running" ? "Amorçage…" : "Amorcer maintenant"}
                    </Button>
                </div>
            )}

            {declaredSources.length > 0 && (
                <div className="mt-4 rounded-xl border border-[#E8E6E1] bg-[#FCFBF8] px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                            Sources de données utilisées
                        </p>
                        <span className="rounded-full border border-[#0D7377]/30 bg-[#0D7377]/5 px-2 py-0.5 text-[11px] font-semibold text-[#0D7377]">
                            <Database className="-mt-0.5 mr-1 inline h-3 w-3" />
                            {boundCount}/{declaredSources.length} liée(s)
                        </span>
                    </div>
                    <ul className="mt-2 space-y-1">
                        {declaredSources.map((src) => {
                            const path = (parquetSelection?.[src] ?? "").trim();
                            return (
                                <li
                                    key={src}
                                    className="flex flex-wrap items-center justify-between gap-2 text-xs"
                                >
                                    <span className="font-mono text-[#2B2B2B]">{src}</span>
                                    {path ? (
                                        <span className="font-mono text-[11px] text-[#6B6966]" title={path}>
                                            {_basename(path)}
                                        </span>
                                    ) : (
                                        <span className="text-[11px] italic text-[#A09E99]">
                                            auto-détection (backend)
                                        </span>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                    <p className="mt-2 text-[11px] text-[#A09E99]">
                        Modifiez la sélection dans l'onglet
                        <strong className="mx-1 font-semibold text-[#2B2B2B]">Définitions</strong>
                        → panneau « Source de données ».
                    </p>
                </div>
            )}

            <div className="mt-4">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                    Paramètres (JSON)
                </p>
                <textarea
                    value={params}
                    onChange={(e) => onParamsChange(e.target.value)}
                    spellCheck={false}
                    className="mt-1 min-h-[120px] w-full resize-none rounded-xl border border-[#E8E6E1] bg-[#FCFBF8] px-3 py-2 font-mono text-[12px] text-[#2B2B2B] outline-none focus:border-[#0D7377]/40 focus:bg-white focus:ring-2 focus:ring-[#0D7377]/10"
                />
                <p className="mt-1 text-[11px] text-[#A09E99]">
                    Exemple : <code>{`{ "PERIOD": "2024-01-01..2024-12-31" }`}</code>
                </p>
            </div>

            {error && (
                <div className="mt-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    {error}
                </div>
            )}

            {pdfExportError && (
                <div className="mt-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    {pdfExportError}
                </div>
            )}
        </div>

        {result && (
            <div className="space-y-4">
                <RenderSummary result={result} />
                {result.html && (
                    <div className="overflow-hidden rounded-[24px] border border-[#E8E6E1] bg-white">
                        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E8E6E1] px-4 py-2">
                            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                                <FileText className="h-3.5 w-3.5 text-[#0D7377]" />
                                Aperçu
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="text-[11px] text-[#A09E99]">
                                    Export PDF via la boîte d’impression système
                                </span>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-8 rounded-xl border-[#E8E6E1] bg-[#F8F7F4] px-3 text-xs"
                                    onClick={handleExportPdf}
                                >
                                    <Printer className="mr-2 h-3.5 w-3.5" />
                                    Exporter en PDF
                                </Button>
                            </div>
                        </div>
                        <iframe
                            title={`Aperçu de ${template?.template_id}`}
                            srcDoc={result.html}
                            className="h-[clamp(24rem,74dvh,58rem)] w-full bg-white"
                        />
                    </div>
                )}
            </div>
        )}
    </div>
    );
};


const RenderSummary: React.FC<{ result: RenderResult }> = ({ result }) => (
    <div
        className={cn(
            "rounded-[22px] border px-5 py-4 text-sm",
            result.success
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-amber-200 bg-amber-50 text-amber-800",
        )}
    >
        <div className="flex flex-wrap items-center gap-3">
            {result.success
                ? <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                : <AlertTriangle className="h-5 w-5 text-amber-600" />}
            <span className="text-base font-semibold">
                {result.success ? "Rendu réussi" : "Rendu en mode dégradé"}
            </span>
            {typeof result.duration_ms === "number" && (
                <span className="text-xs">
                    {(result.duration_ms / 1000).toFixed(2)} s
                </span>
            )}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
            <Stat label="blocs SQL" value={result.sql_summary?.total ?? "—"} />
            <Stat label="erreurs SQL" value={result.sql_errors?.length ?? 0} />
            <Stat label="narratives" value={result.narrative_summary?.total ?? "—"} />
            <Stat label="fallback" value={result.narrative_summary?.fallback ?? 0} />
        </div>
        {result.error && (
            <p className="mt-3 text-xs">
                <span className="font-semibold">Détails :</span> {result.error}
            </p>
        )}
        {result.missing && result.missing.length > 0 && (
            <p className="mt-1 text-xs">
                <span className="font-semibold">Tokens manquants :</span> {result.missing.join(", ")}
            </p>
        )}
        {result.sql_errors && result.sql_errors.length > 0 && (
            <ul className="mt-2 space-y-0.5 font-mono text-[11px]">
                {result.sql_errors.slice(0, 5).map((e, i) => (
                    <li key={i}>
                        <span className="font-semibold">{e.block_id ?? "?"}</span>
                        {e.kind && <span className="ml-1 text-amber-700">({e.kind})</span>}
                        : {e.error}
                    </li>
                ))}
            </ul>
        )}
    </div>
);


const Stat: React.FC<{ label: string; value: any }> = ({ label, value }) => (
    <div className="rounded-lg border border-white/40 bg-white/60 px-3 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em]">{label}</p>
        <p className="mt-1 font-mono text-sm">{String(value)}</p>
    </div>
);


function buildPrintableReportHtml(rawHtml: string, title: string): string {
    const safeTitle = title
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    if (/<html[\s>]/i.test(rawHtml)) {
        let html = rawHtml;
        if (/<title[\s>]/i.test(html)) {
            html = html.replace(/<title[^>]*>.*?<\/title>/i, `<title>${safeTitle}</title>`);
        } else if (/<head[^>]*>/i.test(html)) {
            html = html.replace(/<head[^>]*>/i, (m) => `${m}<title>${safeTitle}</title>`);
        } else {
            html = html.replace(/<html[^>]*>/i, (m) => `${m}<head><title>${safeTitle}</title></head>`);
        }
        return html;
    }
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${safeTitle}</title>
  <style>
    body { margin: 0; color: #111827; background: #ffffff; }
    @media print { body { margin: 0; } }
  </style>
</head>
<body>
${rawHtml}
</body>
</html>`;
}


function openReportPdfExport(rawHtml: string, title: string): boolean {
    if (typeof window === "undefined") return false;
    const printWindow = window.open("", "_blank", "width=1280,height=920");
    if (!printWindow) return false;

    printWindow.document.open();
    printWindow.document.write(buildPrintableReportHtml(rawHtml, title));
    printWindow.document.close();

    const triggerPrint = () => {
        printWindow.focus();
        printWindow.print();
        setTimeout(() => {
            printWindow.close();
        }, 250);
    };

    printWindow.onload = () => {
        setTimeout(triggerPrint, 120);
    };

    return true;
}


const EventLog: React.FC<{
    title: string;
    events: ReportEvent[];
    phase: "idle" | "running" | "completed" | "failed";
}> = ({ title, events, phase }) => (
    <div className="rounded-[22px] border border-[#E8E6E1] bg-white p-4">
        <div className="flex items-center justify-between gap-3 border-b border-[#E8E6E1] pb-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">
                {title}
            </p>
            <span
                className={cn(
                    "rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em]",
                    phase === "running" ? "border-blue-200 bg-blue-50 text-blue-700"
                        : phase === "completed" ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : phase === "failed" ? "border-red-200 bg-red-50 text-red-700"
                        : "border-zinc-200 bg-zinc-50 text-zinc-700",
                )}
            >
                {phase}
            </span>
        </div>
        <div className="mt-2 max-h-[200px] overflow-y-auto font-mono text-[11px] leading-relaxed">
            {events.map((evt, i) => (
                <div key={i} className="flex gap-2">
                    <span className="w-24 shrink-0 text-[#A09E99]">{evt.step}</span>
                    <span className="text-[#2B2B2B]">{evt.message}</span>
                </div>
            ))}
        </div>
    </div>
);


/* ─────────────────────────────────────────────────────────────────────────
 * TemplatePreview — clickable HTML view (block-aware)
 *
 * Two modes:
 *
 * 1. Source mode — renders the raw HTML with one badge per
 *    ``data-block="…"`` attribute (block-level click target) plus
 *    contextual badges on inner DSL markers (read-only chips, kept for
 *    quick orientation but not the primary handle).
 *
 * 2. Visual mode — renders inside an iframe and wraps every tagged
 *    ``<div data-block="…">`` in a coloured frame with a name badge;
 *    clicking the frame opens the agent for that block via
 *    ``window.parent.postMessage``.
 *
 * Block names recognised come from ``ReportTokens.tokens.blocks``.
 * ──────────────────────────────────────────────────────────────────────── */

type DslMarkerKind =
    | "scalar"
    | "section_begin"
    | "section_end"
    | "condition_begin"
    | "condition_end"
    | "narrative_marker";

interface DslMarker {
    raw:  string;        // the literal source text matched
    kind: DslMarkerKind;
    id:   string;        // canonical token id
    fieldKind: ReportBlockKind;
}

const DSL_TOKENISER = new RegExp(
    [
        "(\\{\\{[A-Z][A-Z0-9_]*\\}\\})",
        "(<!--\\s*(?:BEGIN|END|IF|ENDIF|NARRATIVE):[A-Za-z_][A-Za-z0-9_]*[^-]*?-->)",
    ].join("|"),
    "g",
);

const COMMENT_TOKENISER = /^<!--\s*(BEGIN|END|IF|ENDIF|NARRATIVE):([A-Za-z_][A-Za-z0-9_]*)/;


function buildKindIndexFromTokens(tokens: ReportTokens | null): Record<string, ReportBlockKind> {
    const out: Record<string, ReportBlockKind> = {};
    if (!tokens) return out;
    for (const s of tokens.tokens.scalars) out[s.name] = "scalar";
    for (const s of tokens.tokens.sections) out[s.name] = "section";
    for (const c of tokens.tokens.conditions) out[c.name] = "condition";
    for (const n of tokens.tokens.narratives) out[`NARRATIVE:${n.name}`] = "narrative";
    for (const c of tokens.tokens.chart_arrays) out[c.name] = "chart_array";
    return out;
}


function classifyMarker(
    raw: string,
    kindIndex: Record<string, ReportBlockKind>,
): DslMarker | null {
    if (raw.startsWith("{{") && raw.endsWith("}}")) {
        const id = raw.slice(2, -2);
        return {
            raw,
            kind: "scalar",
            id,
            fieldKind: kindIndex[id] ?? "scalar",
        };
    }
    const m = COMMENT_TOKENISER.exec(raw);
    if (!m) return null;
    const [, marker, name] = m;
    switch (marker) {
        case "BEGIN":
            return { raw, kind: "section_begin", id: name,
                     fieldKind: kindIndex[name] ?? "section" };
        case "END":
            return { raw, kind: "section_end", id: name,
                     fieldKind: kindIndex[name] ?? "section" };
        case "IF":
            return { raw, kind: "condition_begin", id: name,
                     fieldKind: kindIndex[name] ?? "condition" };
        case "ENDIF":
            return { raw, kind: "condition_end", id: name,
                     fieldKind: kindIndex[name] ?? "condition" };
        case "NARRATIVE":
            return { raw, kind: "narrative_marker", id: `NARRATIVE:${name}`,
                     fieldKind: "narrative" };
        default:
            return null;
    }
}


/**
 * Single-pass HTML tokeniser yielding alternating text / DSL-marker /
 * data-block-attribute chunks.
 *
 * The ``data-block`` chunk type lets the source mode show a small
 * "🧱 <name>" badge inline with the attribute so users can click the
 * block from anywhere in the source view.
 */
type SourceChunk =
    | { kind: "text"; value: string }
    | { kind: "marker"; marker: DslMarker }
    | { kind: "data-block"; name: string; raw: string };

const DATA_BLOCK_RE = /\bdata-block\s*=\s*"([A-Za-z_][A-Za-z0-9_]*)"/g;


function tokeniseTemplate(
    html: string,
    kindIndex: Record<string, ReportBlockKind>,
): SourceChunk[] {
    const chunks: SourceChunk[] = [];
    type Hit =
        | { idx: number; len: number; kind: "marker"; marker: DslMarker }
        | { idx: number; len: number; kind: "data-block"; name: string; raw: string };

    const hits: Hit[] = [];

    DSL_TOKENISER.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DSL_TOKENISER.exec(html)) !== null) {
        const raw = m[0];
        const marker = classifyMarker(raw, kindIndex);
        if (marker) {
            hits.push({ idx: m.index, len: raw.length, kind: "marker", marker });
        }
    }

    DATA_BLOCK_RE.lastIndex = 0;
    let d: RegExpExecArray | null;
    while ((d = DATA_BLOCK_RE.exec(html)) !== null) {
        hits.push({
            idx: d.index, len: d[0].length, kind: "data-block",
            name: d[1], raw: d[0],
        });
    }

    hits.sort((a, b) => a.idx - b.idx);

    let cursor = 0;
    for (const h of hits) {
        if (h.idx < cursor) continue;
        if (h.idx > cursor) {
            chunks.push({ kind: "text", value: html.slice(cursor, h.idx) });
        }
        if (h.kind === "marker") {
            chunks.push({ kind: "marker", marker: h.marker });
        } else {
            chunks.push({ kind: "data-block", name: h.name, raw: h.raw });
        }
        cursor = h.idx + h.len;
    }
    if (cursor < html.length) {
        chunks.push({ kind: "text", value: html.slice(cursor) });
    }
    return chunks;
}


type PreviewMode = "source" | "visual";


/**
 * Replace ``<link rel="stylesheet" href="…">`` tags whose href maps to
 * a sibling asset shipped in ``template_assets`` with an inline
 * ``<style>`` block.  External / root-absolute hrefs are left intact.
 */
function inlineLocalStylesheets(
    html: string,
    assets: Record<string, string> | undefined | null,
): string {
    if (!assets) return html;
    const keys = Object.keys(assets);
    if (keys.length === 0) return html;

    return html.replace(/<link\b([^>]*)\/?>/gi, (full, attrs: string) => {
        if (!/\brel\s*=\s*["']?\s*stylesheet\s*["']?/i.test(attrs)) {
            return full;
        }
        const hrefMatch = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i);
        if (!hrefMatch) return full;
        const href = hrefMatch[1].trim();
        if (
            href.startsWith("http://") ||
            href.startsWith("https://") ||
            href.startsWith("//")     ||
            href.startsWith("/")      ||
            href.startsWith("data:")
        ) {
            return full;
        }
        const cleanName = href.replace(/^\.\//, "").split(/[?#]/)[0];
        const css = assets[cleanName];
        if (typeof css !== "string") return full;
        return (
            `<style data-inlined-from="${cleanName.replace(/"/g, "&quot;")}">\n` +
            `${css}\n` +
            `</style>`
        );
    });
}


/**
 * Build the iframe HTML used by the visual preview mode.
 *
 * The transform pipeline is:
 *
 * 1. Inline sibling stylesheets so corporate styling renders.
 * 2. Tag every ``<div data-block="…">`` (or other tagged element) with
 *    a ``data-qclick-block`` attribute and CSS classes that draw a
 *    coloured frame plus a "name" pill in the top-left corner.
 * 3. Highlight inner DSL markers (read-only chips) so the user keeps
 *    a quick visual orientation while still clicking the BLOCK as the
 *    primary handle.
 * 4. Inject a click handler that posts ``{type, blockId, kind}`` back
 *    to the parent window when a block frame is clicked.
 */
function buildVisualPreviewHtml(
    rawHtml: string,
    blockKindByName: Record<string, ReportBlockKind>,
    definedBlockIds: Set<string>,
    kindIndex: Record<string, ReportBlockKind>,
    assets: Record<string, string> | undefined | null,
    /** Used to merge bundled ``report.css`` (e.g. model1) when API assets omit it. */
    templateId?: string | null,
): string {
    const escapeHtml = (s: string) =>
        s.replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;");

    const mergedAssets = mergeReportingTemplateAssets(templateId, assets);
    let processed = inlineLocalStylesheets(rawHtml, mergedAssets);

    // ── (1) Tag block-owning elements ────────────────────────────────
    processed = processed.replace(
        /<([A-Za-z][A-Za-z0-9-]*)([^>]*\bdata-block\s*=\s*"([A-Za-z_][A-Za-z0-9_]*)"[^>]*)>/g,
        (_full, tag: string, attrs: string, name: string) => {
            const kind = blockKindByName[name] ?? "empty";
            const defined = definedBlockIds.has(name);
            const safeName = escapeHtml(name);
            const safeKind = escapeHtml(kind);
            const baseClass = `qclick-block qclick-${safeKind} ${defined ? "qclick-defined" : "qclick-skeleton"}`;
            const classMatch = attrs.match(/\bclass\s*=\s*"([^"]*)"/);
            const newAttrs = classMatch
                ? attrs.replace(/\bclass\s*=\s*"([^"]*)"/,
                    `class="$1 ${baseClass}"`)
                : `${attrs} class="${baseClass}"`;
            return (
                `<${tag}${newAttrs} ` +
                `data-qclick-block="${safeName}" ` +
                `data-qclick-kind="${safeKind}" ` +
                `data-qclick-defined="${defined ? "1" : "0"}">`
            );
        },
    );

    // ── (1b) Mark non-tagged DIVs as candidates for quick block creation ──
    let candidateCounter = 0;
    processed = processed.replace(
        /<div\b([^>]*)>/gi,
        (full: string, attrs: string) => {
            if (/\bdata-block\s*=/.test(attrs) || /\bdata-qclick-candidate\s*=/.test(attrs)) {
                return full;
            }
            const candidateClass = "qclick-block-candidate";
            const classMatch = attrs.match(/\bclass\s*=\s*"([^"]*)"/i);
            const newAttrs = classMatch
                ? attrs.replace(/\bclass\s*=\s*"([^"]*)"/i, `class="$1 ${candidateClass}"`)
                : `${attrs} class="${candidateClass}"`;
            const key = candidateCounter++;
            return `<div${newAttrs} data-qclick-candidate="1" data-qclick-candidate-key="${key}">`;
        },
    );

    // ── (2) Highlight inner DSL markers ──────────────────────────────
    const wrap = (
        id: string,
        kind: ReportBlockKind,
        label: string,
        marker: "scalar" | "section-begin" | "section-end" |
                "condition-begin" | "condition-end" | "narrative",
    ): string =>
        `<span class="dsl-marker dsl-${marker}" ` +
        `data-dsl-id="${escapeHtml(id)}" ` +
        `data-dsl-kind="${escapeHtml(kind)}" ` +
        `title="Marqueur ${escapeHtml(id)}">` +
        `<span class="dsl-label">${escapeHtml(label)}</span>` +
        `</span>`;

    processed = processed.replace(
        /\{\{([A-Z][A-Z0-9_]*)\}\}/g,
        (_m, id: string) =>
            wrap(id, kindIndex[id] ?? "scalar", `{{${id}}}`, "scalar"),
    );
    processed = processed.replace(
        /<!--\s*NARRATIVE:([A-Za-z_][A-Za-z0-9_]*)[^-]*?-->/g,
        (_m, name: string) => {
            const id = `NARRATIVE:${name}`;
            return wrap(id, "narrative", `📝 ${name}`, "narrative");
        },
    );
    processed = processed.replace(
        /<!--\s*BEGIN:([A-Za-z_][A-Za-z0-9_]*)[^-]*?-->/g,
        (_m, name: string) =>
            wrap(name, kindIndex[name] ?? "section",
                 `▼ BEGIN:${name}`, "section-begin"),
    );
    processed = processed.replace(
        /<!--\s*END:([A-Za-z_][A-Za-z0-9_]*)[^-]*?-->/g,
        (_m, name: string) =>
            wrap(name, kindIndex[name] ?? "section",
                 `▲ END:${name}`, "section-end"),
    );
    processed = processed.replace(
        /<!--\s*IF:([A-Za-z_][A-Za-z0-9_]*)[^-]*?-->/g,
        (_m, name: string) =>
            wrap(name, kindIndex[name] ?? "condition",
                 `IF:${name}`, "condition-begin"),
    );
    processed = processed.replace(
        /<!--\s*ENDIF:([A-Za-z_][A-Za-z0-9_]*)[^-]*?-->/g,
        (_m, name: string) =>
            wrap(name, kindIndex[name] ?? "condition",
                 `ENDIF:${name}`, "condition-end"),
    );

    const styleAndScript = `
<style>
  .qclick-block {
    position: relative;
    outline: 2px dashed transparent;
    outline-offset: 4px;
    border-radius: 6px;
    transition: outline-color .15s ease, box-shadow .15s ease;
    cursor: pointer;
  }
  .qclick-block::before {
    content: attr(data-qclick-block);
    position: absolute;
    top: -10px;
    left: 8px;
    padding: 1px 8px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 10px;
    font-weight: 700;
    border-radius: 9999px;
    background: rgba(255,255,255,.92);
    border: 1px solid currentColor;
    line-height: 1.4;
    z-index: 10;
    pointer-events: none;
    text-transform: lowercase;
    letter-spacing: .02em;
  }
  .qclick-block:hover {
    outline-color: currentColor;
    box-shadow: 0 12px 30px rgba(15,23,42,.08);
  }
  .qclick-skeleton { color: #71717a; }
  .qclick-skeleton::before { background:#fafafa; color:#52525b; }
  .qclick-skeleton:hover  { outline-color:#71717a; }
  .qclick-defined.qclick-scalar      { color:#1d4ed8; }
  .qclick-defined.qclick-scalar::before    { color:#1e3a8a; }
  .qclick-defined.qclick-section     { color:#047857; }
  .qclick-defined.qclick-section::before   { color:#064e3b; }
  .qclick-defined.qclick-condition   { color:#6d28d9; }
  .qclick-defined.qclick-condition::before { color:#4c1d95; }
  .qclick-defined.qclick-narrative   { color:#b45309; }
  .qclick-defined.qclick-narrative::before { color:#78350f; }
  .qclick-defined.qclick-chart_array { color:#be123c; }
  .qclick-defined.qclick-chart_array::before { color:#9f1239; }
  .qclick-defined.qclick-mixed       { color:#a21caf; }
  .qclick-defined.qclick-mixed::before     { color:#701a75; }
  .qclick-defined.qclick-empty       { color:#71717a; }
  .qclick-defined.qclick-empty::before     { color:#52525b; }

  .qclick-block-candidate {
    position: relative;
    transition: box-shadow .15s ease, outline-color .15s ease;
  }
  .qclick-block-candidate:hover {
    outline: 1px dashed rgba(13,115,119,.42);
    outline-offset: 3px;
  }
  .qclick-candidate-button {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 2147483646;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-radius: 9999px;
    border: 1px solid rgba(13,115,119,.22);
    background: rgba(255,255,255,.96);
    color: #0d7377;
    box-shadow: 0 10px 28px rgba(15,23,42,.12);
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: .01em;
    cursor: pointer;
  }
  .qclick-candidate-button:hover {
    background: #f1fafa;
  }

  .dsl-marker {
    display: inline-flex;
    align-items: center;
    margin: 0 1px;
    padding: 0 4px;
    border: 1px solid;
    border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.78em;
    font-weight: 600;
    line-height: 1.1;
    vertical-align: baseline;
    user-select: none;
    pointer-events: none;
  }
  .dsl-scalar           { background:#dbeafe; border-color:#93c5fd; color:#1e3a8a; }
  .dsl-section-begin    { background:#d1fae5; border-color:#6ee7b7; color:#064e3b; }
  .dsl-section-end      { background:#ecfdf5; border-color:#6ee7b7; color:#047857; }
  .dsl-condition-begin  { background:#ede9fe; border-color:#c4b5fd; color:#4c1d95; }
  .dsl-condition-end    { background:#f5f3ff; border-color:#c4b5fd; color:#5b21b6; }
  .dsl-narrative        { background:#fef3c7; border-color:#fcd34d; color:#78350f; }
</style>
<script>
(function () {
  var hoverBtn = null;
  var hoverTarget = null;

  function cleanupHoverBtn() {
    if (hoverBtn && hoverBtn.parentNode) hoverBtn.parentNode.removeChild(hoverBtn);
    hoverBtn = null;
    hoverTarget = null;
  }

  function candidatePayload(target) {
    if (!target) return null;
    var text = (target.textContent || '').replace(/\\s+/g, ' ').trim();
    var key = Number(target.getAttribute('data-qclick-candidate-key'));
    return {
      type: 'qclick.mark-div-block',
      action: 'add',
      candidateKey: Number.isFinite(key) ? key : null,
      tagName: (target.tagName || '').toLowerCase(),
      outerHtml: target.outerHTML || '',
      className: target.className || '',
      id: target.id || '',
      textPreview: text.slice(0, 180)
    };
  }

  function revokePayload(target) {
    if (!target) return null;
    var text = (target.textContent || '').replace(/\\s+/g, ' ').trim();
    var blockId = target.getAttribute('data-qclick-block');
    if (!blockId) return null;
    return {
      type: 'qclick.mark-div-block',
      action: 'revoke',
      blockId: blockId,
      tagName: (target.tagName || '').toLowerCase(),
      outerHtml: target.outerHTML || '',
      className: target.className || '',
      id: target.id || '',
      textPreview: text.slice(0, 180)
    };
  }

  function notify(target) {
    var blockId = target.getAttribute('data-qclick-block');
    var kind = target.getAttribute('data-qclick-kind');
    if (!blockId) return;
    window.parent.postMessage(
      { type: 'qclick.block-click', blockId: blockId, kind: kind },
      '*'
    );
  }
  function showHoverButton(target, mode) {
    if (!target || !target.getAttribute) return;
    if (hoverTarget === target && hoverBtn) return;
    cleanupHoverBtn();
    hoverTarget = target;
    hoverBtn = document.createElement('button');
    hoverBtn.type = 'button';
    hoverBtn.className = 'qclick-candidate-button';
    hoverBtn.textContent = mode === 'revoke' ? 'Révoquer data-block' : 'Marquer en data-block';
    hoverBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var payload = mode === 'revoke' ? revokePayload(target) : candidatePayload(target);
      if (!payload) return;
      window.parent.postMessage(payload, '*');
    });
    target.appendChild(hoverBtn);
  }
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.classList && t.classList.contains('qclick-candidate-button')) {
      return;
    }
    while (t && t !== document.body) {
      if (t.classList && t.classList.contains('qclick-block')) {
        e.preventDefault();
        e.stopPropagation();
        notify(t);
        return;
      }
      t = t.parentNode;
    }
  }, true);
  document.addEventListener('mouseover', function (e) {
    var t = e.target;
    while (t && t !== document.body) {
      if (t.classList && t.classList.contains('qclick-block')) {
        showHoverButton(t, 'revoke');
        return;
      }
      if (
        t.tagName &&
        t.tagName.toLowerCase() === 'div' &&
        t.getAttribute &&
        t.getAttribute('data-qclick-candidate')
      ) {
        showHoverButton(t, 'add');
        return;
      }
      t = t.parentNode;
    }
    cleanupHoverBtn();
  }, true);
  document.addEventListener('scroll', cleanupHoverBtn, true);
  document.addEventListener('mouseleave', cleanupHoverBtn, true);
})();
</script>`;

    if (/<\/head>/i.test(processed)) {
        return processed.replace(/<\/head>/i, `${styleAndScript}</head>`);
    }
    if (/<head[^>]*>/i.test(processed)) {
        return processed.replace(/<head[^>]*>/i, (m) => `${m}${styleAndScript}`);
    }
    return (
        `<!DOCTYPE html><html><head><meta charset="utf-8">` +
        `${styleAndScript}</head><body>${processed}</body></html>`
    );
}


const TemplatePreview: React.FC<{
    html: string;
    tokens: ReportTokens | null;
    onDefineWithAgent: (b: MergedBlock, intent?: AgentHandoffIntent) => void;
    onSuggestDataBlock: (payload: VisualCandidatePayload) => void;
    definitions: ReportDefinitions | null;
    /** ``{{TOKEN}}`` → Paramètres (keys lower-case).  Omitted / empty = raw template. */
    paramValues?: Record<string, string>;
}> = ({
    html,
    tokens,
    onDefineWithAgent,
    onSuggestDataBlock,
    definitions,
    paramValues = {},
}) => {
    const [expanded, setExpanded] = React.useState(true);
    const [mode] = React.useState<PreviewMode>("visual");

    const kindIndex = React.useMemo(
        () => buildKindIndexFromTokens(tokens), [tokens],
    );
    const htmlLive = React.useMemo(
        () => applyTemplateScalarSubstitutions(html, paramValues),
        [html, paramValues],
    );
    const blockKindByName = React.useMemo(() => {
        const out: Record<string, ReportBlockKind> = {};
        for (const b of tokens?.tokens?.blocks ?? []) {
            out[b.name] = b.kind as ReportBlockKind;
        }
        return out;
    }, [tokens]);
    const scanByName = React.useMemo(() => {
        const out: Record<string, ReportTokenBlock> = {};
        for (const b of tokens?.tokens?.blocks ?? []) {
            out[b.name] = b;
        }
        return out;
    }, [tokens]);
    const chunks = React.useMemo(
        () => tokeniseTemplate(htmlLive, kindIndex),
        [htmlLive, kindIndex],
    );

    const definedBlockIds = React.useMemo(() => {
        const set = new Set<string>();
        for (const b of definitions?.blocks ?? []) {
            if (!b.deprecated && (b.sql || b.cte_ref || b.ctes?.length)) {
                set.add(b.id);
            }
        }
        return set;
    }, [definitions]);

    const blockMarkerCount = chunks.filter((c) => c.kind === "data-block").length;

    const handleClickBlock = React.useCallback(
        (blockName: string) => {
            const live = definitions?.blocks?.find((b) => b.id === blockName);
            const scan = scanByName[blockName];
            if (live) {
                onDefineWithAgent({ ...live, _scan: scan }, "layout");
                return;
            }
            const kind = blockKindByName[blockName] ?? "empty";
            onDefineWithAgent({
                id:   blockName,
                kind,
                goal: "(bloc scanné — pas encore défini)",
                tokens: scan
                    ? [
                        ...scan.inner_scalars,
                        ...scan.inner_sections,
                        ...scan.inner_conditions,
                        ...scan.inner_narratives.map((n) => `NARRATIVE:${n}`),
                        ...scan.inner_chart_arrays,
                    ]
                    : [],
                depends_on: [],
                sql:        "",
                status:     "skeleton",
                _isSkeleton: true,
                _scan:       scan,
            }, "layout");
        },
        [definitions, blockKindByName, scanByName, onDefineWithAgent],
    );

    /* ── Visual preview: render in iframe + bridge clicks back ──────── */
    const assets = tokens?.template_assets;
    const visualHtml = React.useMemo(
        () =>
            buildVisualPreviewHtml(
                htmlLive,
                blockKindByName,
                definedBlockIds,
                kindIndex,
                assets,
                tokens?.template_id,
            ),
        [htmlLive, blockKindByName, definedBlockIds, kindIndex, assets, tokens?.template_id],
    );

    React.useEffect(() => {
        const handler = (e: MessageEvent) => {
            const data = e.data;
            if (
                data &&
                typeof data === "object" &&
                data.type === "qclick.block-click" &&
                typeof data.blockId === "string"
            ) {
                handleClickBlock(data.blockId);
            } else if (
                data &&
                typeof data === "object" &&
                data.type === "qclick.mark-div-block"
            ) {
                onSuggestDataBlock(data as VisualCandidatePayload);
            }
        };
        window.addEventListener("message", handler);
        return () => window.removeEventListener("message", handler);
    }, [handleClickBlock, onSuggestDataBlock]);

    const hasParamSubs = React.useMemo(
        () => htmlLive !== html,
        [html, htmlLive],
    );

    return (
        <div className="rounded-[24px] border border-[#E8E6E1] bg-white xl:flex xl:h-full xl:flex-col">
            <div className="flex w-full flex-wrap items-center gap-3 px-5 py-3">
                <button
                    type="button"
                    onClick={() => setExpanded((p) => !p)}
                    className="flex flex-1 items-center gap-2 text-left min-w-[200px]"
                >
                    <Code2 className="h-4 w-4 text-[#0D7377]" />
                    <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">
                        Aperçu du template HTML
                    </p>
                    <span className="rounded-full border border-[#E8E6E1] bg-[#F8F7F4] px-2 py-0.5 text-[10px] font-semibold text-[#6B6966]">
                        {blockMarkerCount} bloc(s) tagués
                    </span>
                    <ChevronDown
                        className={cn(
                            "ml-auto h-4 w-4 text-[#A09E99] transition-transform",
                            expanded && "rotate-180",
                        )}
                    />
                </button>
                {expanded && (
                    <div className="ml-auto shrink-0 rounded-xl border border-[#E8E6E1] bg-[#F8F7F4] px-3 py-1.5 text-xs font-semibold text-[#0D7377]">
                        Aperçu visuel
                    </div>
                )}
            </div>
            {expanded && (
                <>
                    <div className="border-t border-[#E8E6E1] bg-[#FCFBF8] px-5 py-2 text-[11px] text-[#6B6966]">
                        {hasParamSubs && (
                            <span className="mb-1 block font-medium text-[#0D7377]">
                                Les jetons{" "}
                                <code className="rounded bg-white px-1 font-mono">{"{{…}}"}</code>{" "}
                                correspondant aux paramètres saisis sont remplacés dans cet aperçu.
                            </span>
                        )}
                        {"Aperçu rendu du HTML. Chaque bloc tagué est encadré et nommé — cliquez sur un cadre pour ouvrir l’agent éditeur sur ce bloc."}
                    </div>
                    <div className="overflow-hidden rounded-b-[24px] border-t border-[#E8E6E1] bg-white xl:flex xl:min-h-0 xl:flex-1">
                        <iframe
                            title="Aperçu visuel du template"
                            srcDoc={visualHtml}
                            className="h-[clamp(22rem,62dvh,48rem)] w-full border-0 bg-white xl:h-auto xl:min-h-0 xl:flex-1"
                            sandbox="allow-scripts"
                        />
                    </div>
                </>
            )}
        </div>
    );
};


const MARKER_BADGE_STYLES: Record<DslMarkerKind, string> = {
    scalar:            "border-blue-300 bg-blue-100/90 text-blue-900",
    section_begin:     "border-emerald-300 bg-emerald-100/90 text-emerald-900",
    section_end:       "border-emerald-300 bg-emerald-50 text-emerald-700",
    condition_begin:   "border-violet-300 bg-violet-100/90 text-violet-900",
    condition_end:     "border-violet-300 bg-violet-50 text-violet-700",
    narrative_marker:  "border-amber-300 bg-amber-100/90 text-amber-900",
};


const BLOCK_BADGE_STYLES: Record<ReportBlockKind, string> = {
    scalar:      "border-blue-300 bg-blue-50 text-blue-800",
    section:     "border-emerald-300 bg-emerald-50 text-emerald-800",
    condition:   "border-violet-300 bg-violet-50 text-violet-800",
    narrative:   "border-amber-300 bg-amber-50 text-amber-800",
    chart_array: "border-rose-300 bg-rose-50 text-rose-800",
    mixed:       "border-fuchsia-300 bg-fuchsia-50 text-fuchsia-800",
    empty:       "border-zinc-300 bg-zinc-100 text-zinc-700",
};


const TemplateMarkerBadge: React.FC<{ marker: DslMarker }> = ({ marker }) => (
    <span
        title={`Marqueur ${marker.id} (lecture seule — cliquez sur le bloc parent pour éditer)`}
        className={cn(
            "mx-[1px] inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 align-baseline font-mono text-[11px] font-semibold",
            MARKER_BADGE_STYLES[marker.kind],
        )}
    >
        {marker.raw}
    </span>
);


const DataBlockBadge: React.FC<{
    name: string;
    raw: string;
    kind: ReportBlockKind;
    defined: boolean;
    onClick: () => void;
}> = ({ name, raw, kind, defined, onClick }) => (
    <button
        type="button"
        onClick={onClick}
        title={
            defined
                ? `Modifier le bloc "${name}" avec l'agent`
                : `Définir le bloc "${name}" avec l'agent`
        }
        className={cn(
            "mx-[1px] inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 align-baseline font-mono text-[11px] font-semibold transition-all hover:scale-[1.04] hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-[#0D7377]/40",
            BLOCK_BADGE_STYLES[kind],
            !defined && "ring-1 ring-dashed ring-zinc-300/70",
        )}
    >
        <Boxes className="h-2.5 w-2.5 opacity-80" />
        <span>{raw}</span>
    </button>
);


/** HTML of the single tagged element (open tag → matching close tag) from the scanner. */
function getFocusedBlockHtmlFragment(
    block: MergedBlock,
    tokens: ReportTokens | null,
): string | null {
    const fromMerged = block._scan?.html_excerpt?.trim();
    if (fromMerged) return fromMerged;
    const t = tokens?.tokens?.blocks?.find((b) => b.name === block.id);
    return t?.html_excerpt?.trim() || null;
}

/**
 * Wrap a subtree in a minimal document that references ``report.css`` so
 * ``inlineLocalStylesheets`` can inject the same styles as the full
 * template preview.
 */
function wrapBlockFragmentAsMiniDocument(fragment: string): string {
    const body = fragment.trim();
    return (
        `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"/>` +
        `<link rel="stylesheet" href="report.css"/></head><body>\n${body}\n</body></html>`
    );
}


/**
 * Browsers do not paint ``<title>`` inside ``<body>`` (it is document
 * metadata only).  For the isolated iframe we swap a lone
 * ``<title …>…</title>`` root for a ``<div>`` carrying the same
 * attributes so **Visuel** shows the string and block chrome still works.
 */
function coerceFragmentRootForVisualBody(fragment: string): {
    body: string;
    wasTitle: boolean;
} {
    const t = fragment.trim();
    const m = t.match(/^<title\b([^>]*)>([\s\S]*?)<\/title>\s*$/i);
    if (!m) return { body: t, wasTitle: false };
    const attrs = m[1].trim();
    const inner = m[2];
    const open = attrs ? `<div ${attrs}` : "<div";
    return {
        body:
            `${open} style="font-size:clamp(1.1rem,2.4vw,1.65rem);font-weight:600;line-height:1.25;padding:0.5rem 0;">` +
            `${inner}</div>`,
        wasTitle: true,
    };
}


/**
 * HTML preview limited to the ``data-block="…"`` subtree for the block
 * opened from « Modifier avec l'agent » (scanner ``html_excerpt``).
 */
const FocusedBlockHtmlPreview: React.FC<{
    block: MergedBlock;
    tokens: ReportTokens;
    definitions: ReportDefinitions | null;
    onDefineWithAgent: (b: MergedBlock, intent?: AgentHandoffIntent) => void;
    onSuggestDataBlock: (payload: VisualCandidatePayload) => void;
    /** Same pool as Paramètres — ``{{TOKEN}}`` in the fragment is replaced for preview. */
    paramValues?: Record<string, string>;
    /** Return to the full template preview after focusing a block. */
    onBackToTemplate?: () => void;
    focusIntent: AgentHandoffIntent;
    templateId: string;
    onBlockSaved: () => void;
    parquetPaths?: Record<string, string>;
}> = ({
    block,
    tokens,
    definitions,
    onDefineWithAgent,
    onSuggestDataBlock,
    paramValues = {},
    onBackToTemplate,
    focusIntent,
    templateId,
    onBlockSaved,
    parquetPaths = {},
}) => {
    const [expanded, setExpanded] = React.useState(true);
    const [mode, setMode] = React.useState<PreviewMode>("source");
    const [genLoading, setGenLoading] = React.useState(false);
    const [genApplying, setGenApplying] = React.useState(false);
    const [genError, setGenError] = React.useState<string | null>(null);
    const [genResult, setGenResult] = React.useState<GenerateInsuranceCteResponse | null>(null);

    const fragmentRaw = React.useMemo(
        () => getFocusedBlockHtmlFragment(block, tokens),
        [block.id, block._scan?.html_excerpt, tokens],
    );
    const fragmentRendered = React.useMemo(
        () => applyTemplateScalarSubstitutions(fragmentRaw ?? "", paramValues),
        [fragmentRaw, paramValues],
    );

    const kindIndex = React.useMemo(
        () => buildKindIndexFromTokens(tokens), [tokens],
    );
    const blockKindByName = React.useMemo(() => {
        const out: Record<string, ReportBlockKind> = {};
        for (const b of tokens?.tokens?.blocks ?? []) {
            out[b.name] = b.kind as ReportBlockKind;
        }
        return out;
    }, [tokens]);
    const scanByName = React.useMemo(() => {
        const out: Record<string, ReportTokenBlock> = {};
        for (const b of tokens?.tokens?.blocks ?? []) {
            out[b.name] = b;
        }
        return out;
    }, [tokens]);

    const definedBlockIds = React.useMemo(() => {
        const set = new Set<string>();
        for (const b of definitions?.blocks ?? []) {
            if (!b.deprecated && (b.sql || b.cte_ref || b.ctes?.length)) {
                set.add(b.id);
            }
        }
        return set;
    }, [definitions]);

    const handleClickBlock = React.useCallback(
        (blockName: string) => {
            const live = definitions?.blocks?.find((b) => b.id === blockName);
            const scan = scanByName[blockName];
            if (live) {
                onDefineWithAgent({ ...live, _scan: scan }, mode === "visual" ? "layout" : "definition");
                return;
            }
            const kind = blockKindByName[blockName] ?? "empty";
            onDefineWithAgent({
                id:   blockName,
                kind,
                goal: "(bloc scanné — pas encore défini)",
                tokens: scan
                    ? [
                        ...scan.inner_scalars,
                        ...scan.inner_sections,
                        ...scan.inner_conditions,
                        ...scan.inner_narratives.map((n) => `NARRATIVE:${n}`),
                        ...scan.inner_chart_arrays,
                    ]
                    : [],
                depends_on: [],
                sql:        "",
                status:     "skeleton",
                _isSkeleton: true,
                _scan:       scan,
            }, mode === "visual" ? "layout" : "definition");
        },
        [definitions, blockKindByName, scanByName, onDefineWithAgent, mode],
    );

    const assets = tokens?.template_assets;
    const { body: fragmentVisualBody, wasTitle: visualTitleProxy } = React.useMemo(
        () => coerceFragmentRootForVisualBody(fragmentRendered),
        [fragmentRendered],
    );

    const visualHtml = React.useMemo(() => {
        if (mode !== "visual" || !fragmentRaw) return "";
        const wrapped = wrapBlockFragmentAsMiniDocument(fragmentVisualBody);
        return buildVisualPreviewHtml(
            wrapped,
            blockKindByName,
            definedBlockIds,
            kindIndex,
            assets,
            tokens.template_id,
        );
    }, [
        mode, fragmentRaw, fragmentVisualBody, blockKindByName,
        definedBlockIds, kindIndex, assets, tokens.template_id,
    ]);

    const handleGenerateInsuranceCte = React.useCallback(async () => {
        if (!templateId.trim()) return;
        setGenLoading(true);
        setGenError(null);
        try {
            const res = await generateInsuranceProductionCte(templateId, block.id);
            setGenResult(res);
        } catch (e: unknown) {
            const err = e as { detail?: string; message?: string };
            setGenError(String(err?.detail ?? err?.message ?? e));
            setGenResult(null);
        } finally {
            setGenLoading(false);
        }
    }, [templateId, block.id]);

    const handleApplyGeneratedCte = React.useCallback(async () => {
        if (!genResult || !templateId.trim() || genApplying) return;
        setGenApplying(true);
        setGenError(null);
        try {
            await upsertReportBlock(templateId, block.id, {
                kind: block.kind,
                goal: block.goal ?? undefined,
                tokens: block.tokens,
                mapping: block.mapping,
                grounding_fields: block.grounding_fields,
                sql: genResult.generated_sql,
                cte_ref: null,
                ctes: block.ctes,
                depends_on: block.depends_on,
                style: (block as { style?: string }).style,
                fallback_text: (block as { fallback_text?: string }).fallback_text,
            });
            setGenResult(null);
            onBlockSaved();
        } catch (e: unknown) {
            const err = e as { detail?: string; message?: string };
            setGenError(String(err?.detail ?? err?.message ?? e));
        } finally {
            setGenApplying(false);
        }
    }, [genResult, templateId, block, genApplying, onBlockSaved]);

    React.useEffect(() => {
        if (mode !== "visual") return;
        const handler = (e: MessageEvent) => {
            const data = e.data;
            if (
                data &&
                typeof data === "object" &&
                data.type === "qclick.block-click" &&
                typeof data.blockId === "string"
            ) {
                handleClickBlock(data.blockId);
            } else if (
                data &&
                typeof data === "object" &&
                data.type === "qclick.mark-div-block"
            ) {
                onSuggestDataBlock(data as VisualCandidatePayload);
            }
        };
        window.addEventListener("message", handler);
        return () => window.removeEventListener("message", handler);
    }, [mode, handleClickBlock, onSuggestDataBlock]);

    const sourceChunks = React.useMemo(() => {
        if (!fragmentRaw) return [];
        return tokeniseTemplate(fragmentRendered, kindIndex);
    }, [fragmentRaw, fragmentRendered, kindIndex]);

    const blockMarkerCount = sourceChunks.filter((c) => c.kind === "data-block").length;
    const dslMarkerCount = sourceChunks.filter((c) => c.kind === "marker").length;
    const hasParamSubs = fragmentRaw != null && fragmentRendered !== fragmentRaw;
    const hasCtePanel =
        (block.tokens?.length ?? 0) > 0 ||
        !!(block.sql || "").trim() ||
        !!(block.cte_ref || "").trim() ||
        (block.ctes?.some((sub) => !!(sub.sql || "").trim() || !!(sub.cte_ref || "").trim()) ?? false);

    return (
        <div className="rounded-[24px] border border-[#E8E6E1] bg-white">
            <div className="flex w-full flex-wrap items-center justify-between gap-3 px-5 py-3">
                <button
                    type="button"
                    onClick={() => setExpanded((p) => !p)}
                    className="flex flex-1 items-center gap-2 text-left"
                >
                    <Eye className="h-4 w-4 text-[#0D7377]" />
                    <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">
                        Aperçu HTML du bloc
                    </p>
                    <span className="rounded-full border border-[#0D7377]/25 bg-[#0D7377]/5 px-2 py-0.5 font-mono text-[11px] font-semibold text-[#0D7377]">
                        {block.id}
                    </span>
                    {fragmentRaw && (
                        <span className="rounded-full border border-[#E8E6E1] bg-[#F8F7F4] px-2 py-0.5 text-[10px] font-semibold text-[#6B6966]">
                            {blockMarkerCount} bloc(s) dans l&apos;extrait · {dslMarkerCount} marqueur(s)
                        </span>
                    )}
                    <ChevronDown
                        className={cn(
                            "ml-auto h-4 w-4 text-[#A09E99] transition-transform",
                            expanded && "rotate-180",
                        )}
                    />
                </button>
                {expanded && fragmentRaw && (
                    <div className="flex flex-wrap items-center gap-2">
                        {onBackToTemplate && (
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-8 rounded-xl border-[#E8E6E1] bg-white px-3 text-xs"
                                onClick={onBackToTemplate}
                            >
                                <ChevronRight className="mr-1 h-3.5 w-3.5 rotate-180" />
                                Retour au HTML complet
                            </Button>
                        )}
                        <div
                            role="tablist"
                            aria-label="Mode d'aperçu du bloc"
                            className="inline-flex items-center gap-1 rounded-xl border border-[#E8E6E1] bg-[#F8F7F4] p-1"
                        >
                            <button
                                type="button"
                                role="tab"
                                aria-selected={mode === "source"}
                                onClick={() => setMode("source")}
                                className={cn(
                                    "inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-semibold transition-all",
                                    mode === "source"
                                        ? "bg-white text-[#0D7377] shadow-[0_2px_6px_rgba(13,115,119,0.15)]"
                                        : "text-[#6B6966] hover:text-[#2B2B2B]",
                                )}
                            >
                                <Code2 className="h-3.5 w-3.5" />
                                Source
                            </button>
                            <button
                                type="button"
                                role="tab"
                                aria-selected={mode === "visual"}
                                onClick={() => setMode("visual")}
                                className={cn(
                                    "inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-semibold transition-all",
                                    mode === "visual"
                                        ? "bg-white text-[#0D7377] shadow-[0_2px_6px_rgba(13,115,119,0.15)]"
                                        : "text-[#6B6966] hover:text-[#2B2B2B]",
                                )}
                            >
                                <Eye className="h-3.5 w-3.5" />
                                Visuel
                            </button>
                        </div>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 rounded-xl border-[#0D7377]/35 bg-white px-3 text-xs text-[#0D7377] hover:bg-[#0D7377]/5"
                            disabled={genLoading || !templateId.trim()}
                            onClick={handleGenerateInsuranceCte}
                            title="Proposer une CTE à partir du catalogue insurance_production (respect des depends_on)"
                        >
                            {genLoading ? (
                                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <Database className="mr-1 h-3.5 w-3.5" />
                            )}
                            Générer CTE
                        </Button>
                    </div>
                )}
            </div>
            {expanded && fragmentRaw && genError && (
                <div className="border-t border-red-200 bg-red-50 px-5 py-2 text-xs text-red-800">
                    {genError}
                </div>
            )}
            {expanded && fragmentRaw && genResult && (
                <div className="border-t border-[#C5E8E5] bg-[#F0FAF9] px-5 py-4 text-xs text-[#2B2B2B]">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#0D7377]">
                                CTE assurance (insurance_production)
                            </p>
                            <p className="mt-1 text-[11px] text-[#6B6966]">
                                Ancrage : <code className="rounded bg-white px-1 font-mono">{genResult.leaf_cte}</code>
                                {" · "}
                                Chaîne amont (topologique) :{" "}
                                {genResult.depends_ordered.map((n, i) => (
                                    <span key={n}>
                                        {i > 0 ? " → " : ""}
                                        <code className="rounded bg-white px-1 font-mono">{n}</code>
                                    </span>
                                ))}
                            </p>
                            {!genResult.validation_ok && genResult.validation_errors.length > 0 && (
                                <ul className="mt-2 list-inside list-disc text-[11px] text-amber-900">
                                    {genResult.validation_errors.map((msg) => (
                                        <li key={msg}>{msg}</li>
                                    ))}
                                </ul>
                            )}
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-8 rounded-xl border-[#E8E6E1] bg-white px-3 text-xs"
                                onClick={() => {
                                    setGenResult(null);
                                    setGenError(null);
                                }}
                            >
                                Fermer
                            </Button>
                            <Button
                                type="button"
                                size="sm"
                                className="h-8 rounded-xl bg-[#0D7377] px-3 text-xs text-white hover:bg-[#0B6164]"
                                disabled={genApplying || !genResult.validation_ok}
                                onClick={handleApplyGeneratedCte}
                                title={
                                    genResult.validation_ok
                                        ? "Enregistrer le SQL généré dans definitions.yaml"
                                        : "Corrigez les erreurs de validation avant d'appliquer"
                                }
                            >
                                {genApplying ? (
                                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                                ) : null}
                                Appliquer au bloc
                            </Button>
                        </div>
                    </div>
                    <details className="mt-3 rounded-xl border border-[#E8E6E1] bg-white p-3">
                        <summary className="cursor-pointer text-[11px] font-semibold text-[#0D7377]">
                            SQL généré (avec includes)
                        </summary>
                        <pre className="mt-2 max-h-[200px] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[#1B1F23] p-3 font-mono text-[11px] text-[#E6E1D9]">
                            {genResult.generated_sql}
                        </pre>
                    </details>
                    <details className="mt-2 rounded-xl border border-[#E8E6E1] bg-white p-3">
                        <summary className="cursor-pointer text-[11px] font-semibold text-[#6B6966]">
                            SQL développé (includes résolus)
                        </summary>
                        <pre className="mt-2 max-h-[240px] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[#1B1F23] p-3 font-mono text-[10px] leading-relaxed text-[#C8C2BA]">
                            {genResult.expanded_sql}
                        </pre>
                    </details>
                </div>
            )}
            {expanded && (
                <>
                    {!fragmentRaw ? (
                        <div className="border-t border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900">
                            <p className="font-semibold">Extrait HTML introuvable</p>
                            <p className="mt-1 text-xs leading-relaxed">
                                Le scanner n&apos;a pas renvoyé de fragment pour{" "}
                                <code className="rounded bg-white px-1 font-mono">{block.id}</code>.
                                Ouvrez <strong>Définitions</strong> puis{" "}
                                <strong>Lister les blocs</strong> pour rafraîchir le template.
                            </p>
                            {onBackToTemplate && (
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="mt-3 h-8 rounded-xl border-amber-300 bg-white px-3 text-xs text-amber-900 hover:bg-amber-100"
                                    onClick={onBackToTemplate}
                                >
                                    <ChevronRight className="mr-1 h-3.5 w-3.5 rotate-180" />
                                    Retour au HTML complet
                                </Button>
                            )}
                        </div>
                    ) : (
                        <>
                            <div className="border-t border-[#E8E6E1] bg-[#FCFBF8] px-5 py-2 text-[11px] text-[#6B6966]">
                                {onBackToTemplate && (
                                    <span className="mb-1 block">
                                        Vous êtes dans un extrait ciblé. Utilisez{" "}
                                        <strong>Retour au HTML complet</strong> pour revenir au template principal.
                                    </span>
                                )}
                                {hasParamSubs && (
                                    <span className="mb-1 block font-medium text-[#0D7377]">
                                        Les valeurs saisies sous Paramètres remplacent les{" "}
                                        <code className="rounded bg-white px-1 font-mono">{"{{…}}"}</code>{" "}
                                        correspondants dans cet aperçu.
                                    </span>
                                )}
                                {mode === "source"
                                    ? "Sous-arbre HTML du seul élément portant data-block pour ce nom (tel que scanné dans le template)."
                                    : (
                                        <>
                                            Rendu isolé avec les mêmes styles que le template. Les cadres
                                            cliquables renvoient vers l&apos;agent éditeur.
                                            {visualTitleProxy && (
                                                <span className="mt-1 block text-[#0D7377]">
                                                    {" "}
                                                    <strong>Note :</strong> un{" "}
                                                    <code className="rounded bg-white px-1 font-mono">&lt;title&gt;</code>{" "}
                                                    dans le corps de la page n&apos;est pas affiché par le
                                                    navigateur — il est rendu comme un{" "}
                                                    <code className="rounded bg-white px-1 font-mono">&lt;div&gt;</code>{" "}
                                                    équivalent pour l&apos;aperçu.
                                                </span>
                                            )}
                                        </>
                                    )}
                            </div>
                            {mode === "source" ? (
                                <pre className={cn(
                                    "max-h-[420px] overflow-auto bg-[#1B1F23] px-5 py-4 text-[12px] leading-relaxed text-[#E6E1D9]",
                                    hasCtePanel ? "rounded-none" : "rounded-b-[24px]",
                                )}>
                                    <code className="whitespace-pre-wrap break-words font-mono">
                                        {sourceChunks.map((c, i) => {
                                            if (c.kind === "text") {
                                                return <span key={i}>{c.value}</span>;
                                            }
                                            if (c.kind === "marker") {
                                                return (
                                                    <TemplateMarkerBadge
                                                        key={i}
                                                        marker={c.marker}
                                                    />
                                                );
                                            }
                                            return (
                                                <DataBlockBadge
                                                    key={i}
                                                    name={c.name}
                                                    raw={c.raw}
                                                    kind={blockKindByName[c.name] ?? "empty"}
                                                    defined={definedBlockIds.has(c.name)}
                                                    onClick={() => handleClickBlock(c.name)}
                                                />
                                            );
                                        })}
                                    </code>
                                </pre>
                            ) : (
                                <div className={cn(
                                    "overflow-hidden border-t border-[#E8E6E1] bg-white",
                                    hasCtePanel ? "rounded-none" : "rounded-b-[24px]",
                                )}>
                                    <iframe
                                        title={`Aperçu visuel — ${block.id}`}
                                        srcDoc={visualHtml}
                                        className="h-[clamp(18rem,46dvh,32rem)] w-full min-h-[200px] border-0 bg-white md:h-[clamp(20rem,50dvh,36rem)]"
                                        sandbox="allow-scripts"
                                    />
                                </div>
                            )}
                            {hasCtePanel && (
                                <FocusedBlockCtePanel
                                    block={block}
                                    focusIntent={focusIntent}
                                    templateId={templateId}
                                    onBlockSaved={onBlockSaved}
                                    paramValues={paramValues}
                                    parquetPaths={parquetPaths}
                                />
                            )}
                        </>
                    )}
                </>
            )}
        </div>
    );
};


export default ReportingView;
