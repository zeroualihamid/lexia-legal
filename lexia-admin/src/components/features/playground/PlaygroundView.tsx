import React, { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
    Play, Pause, SkipForward, X, Send, ChevronDown, ChevronRight,
    Database, Brain, Wrench, CheckCircle2, AlertCircle, Zap,
    ArrowRight, RotateCcw, Loader2, MessageSquare, Code2, Layers,
    Terminal, Search, FileText, Globe, Table2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

// ── Types ──────────────────────────────────────────────────────────────────

interface FlowNode {
    id: string;
    name: string;
    type: string;
    description: string;
    methods: string[];
}

interface FlowEdge {
    from: string;
    to: string | null;
    label: string;
}

interface DebugEvent {
    id: string;
    event: string;
    message: string;
    node?: string;
    data?: Record<string, any>;
    timestamp: string;
}

interface SqlEntry {
    sql: string;
    columns?: string[];
    rows?: Record<string, any>[];
    row_count?: number;
    error?: string;
}

interface ChatMessage {
    role: "user" | "assistant";
    content: string;
}

interface PlaygroundViewProps {
    onClose: () => void;
}

// ── Constants ──────────────────────────────────────────────────────────────

const API_URL = (import.meta.env.VITE_CHAT_URL || import.meta.env.VITE_API_URL || "").replace(/\/+$/, "");

const NODE_COLORS: Record<string, { bg: string; border: string; text: string; icon: string }> = {
    pre: { bg: "bg-blue-50", border: "border-blue-300", text: "text-blue-700", icon: "text-blue-600" },
    router: { bg: "bg-violet-50", border: "border-violet-300", text: "text-violet-700", icon: "text-violet-600" },
    executor: { bg: "bg-amber-50", border: "border-amber-300", text: "text-amber-700", icon: "text-amber-600" },
    decision: { bg: "bg-cyan-50", border: "border-cyan-300", text: "text-cyan-700", icon: "text-cyan-600" },
    output: { bg: "bg-emerald-50", border: "border-emerald-300", text: "text-emerald-700", icon: "text-emerald-600" },
};

const NODE_ICONS: Record<string, React.ElementType> = {
    pre: Layers,
    router: Brain,
    executor: Wrench,
    decision: Zap,
    output: CheckCircle2,
};

const TOOL_ICONS: Record<string, React.ElementType> = {
    sql_query: Database,
    semantic_search: Search,
    list_tables: Table2,
    describe_table: FileText,
    web_search: Globe,
    read_file: FileText,
};

/** Map backend class names (from SSE events) → flow-schema node IDs. */
const EVENT_NODE_TO_SCHEMA_ID: Record<string, string> = {
    AgentRouterNode: "AgentRouter",
    ToolDispatchNode: "ToolDispatch",
    VerifyNode: "Verify",
    AgentResponseNode: "AgentResponse",
    pre_processing: "pre_processing",
    FlowEnd: "FlowEnd",
};

function resolveNodeId(raw: string): string {
    return EVENT_NODE_TO_SCHEMA_ID[raw] ?? raw;
}

// ── Sub-Components ─────────────────────────────────────────────────────────

function FlowGraph({
    nodes,
    edges,
    activeNode,
    nodeStates,
    selectedNodeId,
    onNodeClick,
}: {
    nodes: FlowNode[];
    edges: FlowEdge[];
    activeNode: string | null;
    nodeStates: Record<string, "idle" | "active" | "done" | "error">;
    selectedNodeId: string | null;
    onNodeClick: (nodeId: string) => void;
}) {
    return (
        <div className="flex flex-col items-center gap-1 py-4 px-2">
            {nodes.map((node, idx) => {
                const state = nodeStates[node.id] || "idle";
                const colors = NODE_COLORS[node.type] || NODE_COLORS.pre;
                const Icon = NODE_ICONS[node.type] || Layers;
                const isActive = state === "active";
                const isDone = state === "done";
                const isError = state === "error";
                const isSelected = selectedNodeId === node.id;

                const outEdge = edges.find((e) => e.from === node.id);

                return (
                    <React.Fragment key={node.id}>
                        <motion.div
                            layout
                            role="button"
                            tabIndex={0}
                            onClick={() => onNodeClick(node.id)}
                            onKeyDown={(e) => { if (e.key === "Enter") onNodeClick(node.id); }}
                            className={`
                                relative w-full rounded-lg border px-3 py-2.5 transition-all duration-300 cursor-pointer
                                ${isSelected
                                    ? `ring-2 ring-[#0D7377] ${colors.bg} ${colors.text} shadow-md`
                                    : isActive
                                        ? `${colors.bg} border-current ${colors.text} shadow-lg shadow-current/10`
                                        : isDone
                                            ? "bg-white border-[#E8E6E1] opacity-70 hover:opacity-90"
                                            : isError
                                                ? "bg-red-50 border-red-300 text-red-600 hover:bg-red-100"
                                                : "bg-white border-[#E8E6E1] text-[#A09E99] hover:border-[#C5C3BE] hover:bg-[#FAFAF8]"
                                }
                            `}
                        >
                            {isActive && !isSelected && (
                                <motion.div
                                    className={`absolute inset-0 rounded-lg ${colors.border} border`}
                                    animate={{ opacity: [0.3, 0.8, 0.3] }}
                                    transition={{ duration: 1.5, repeat: Infinity }}
                                />
                            )}
                            <div className="relative flex items-center gap-2">
                                <Icon className={`h-3.5 w-3.5 shrink-0 ${isSelected ? colors.icon : isActive ? colors.icon : isDone ? "text-emerald-600" : ""}`} />
                                <span className={`text-xs font-semibold tracking-wide ${isSelected ? colors.text : isActive ? colors.text : isDone ? "text-[#6B6966]" : ""}`}>
                                    {node.name}
                                </span>
                                {isDone && !isSelected && <CheckCircle2 className="h-3 w-3 text-emerald-600 ml-auto" />}
                                {isError && <AlertCircle className="h-3 w-3 text-red-500 ml-auto" />}
                                {isActive && !isSelected && <Loader2 className="h-3 w-3 animate-spin ml-auto opacity-60" />}
                                {isSelected && (
                                    <span className="ml-auto text-[9px] font-mono px-1.5 py-0.5 rounded bg-[#0D7377]/10 text-[#0D7377]">
                                        filtered
                                    </span>
                                )}
                            </div>
                            <p className="text-[10px] mt-1 leading-tight opacity-60 line-clamp-2">{node.description}</p>
                        </motion.div>
                        {idx < nodes.length - 1 && (
                            <div className="flex flex-col items-center gap-0.5 py-0.5">
                                <div className={`w-px h-3 ${isActive || isDone ? "bg-[#C5C3BE]" : "bg-[#E8E6E1]"}`} />
                                {outEdge && (
                                    <span className="text-[9px] text-[#A09E99] font-mono">{outEdge.label}</span>
                                )}
                                <ArrowRight className={`h-2.5 w-2.5 rotate-90 ${isActive || isDone ? "text-[#A09E99]" : "text-[#D1CFCA]"}`} />
                            </div>
                        )}
                    </React.Fragment>
                );
            })}
        </div>
    );
}

/** Rich detail renderer for expanded trace events — shows structured content
 *  instead of raw JSON for pre_step results, tool results, etc. */
function PreStepDetail({ event: evt }: { event: DebugEvent }) {
    const d = evt.data || {};
    const step = d.step as string | undefined;

    // ── pre_step result events with rich content ──
    if (evt.event === "pre_step" && step) {
        // DTO cache / schema
        if (step === "dto_cache" && d.schema) {
            return (
                <div className="mx-2 mb-1 space-y-2">
                    <div className="flex items-center gap-2 text-[10px] text-[#A09E99]">
                        <Database className="h-3 w-3" />
                        <span>{d.file_count} file(s) — {d.schema_len} chars</span>
                    </div>
                    {d.parquet_stems && (
                        <div className="flex flex-wrap gap-1">
                            {(d.parquet_stems as string[]).map((s: string) => (
                                <span key={s} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                                    {s}.parquet
                                </span>
                            ))}
                        </div>
                    )}
                    <pre className="text-[10px] font-mono text-[#6B6966] bg-[#F0EFEC] rounded p-2 overflow-x-auto max-h-64 whitespace-pre-wrap">
                        {d.schema}
                    </pre>
                </div>
            );
        }

        // Query augmentation
        if (step === "augment" && (d.augmented || d.original)) {
            return (
                <div className="mx-2 mb-1 space-y-2">
                    {d.original && (
                        <div>
                            <span className="text-[10px] uppercase tracking-widest text-[#A09E99] font-semibold">Original</span>
                            <p className="text-[11px] mt-0.5 text-[#6B6966] bg-[#F0EFEC] rounded px-2 py-1.5 italic">
                                {d.original}
                            </p>
                        </div>
                    )}
                    {d.augmented && (
                        <div>
                            <span className="text-[10px] uppercase tracking-widest text-emerald-600 font-semibold">Augmented</span>
                            <p className="text-[11px] mt-0.5 text-[#2B2B2B] bg-emerald-50 border border-emerald-200 rounded px-2 py-1.5 font-medium">
                                {d.augmented}
                            </p>
                        </div>
                    )}
                </div>
            );
        }

        // Embedding column matches
        if (step === "embeddings" && d.matches) {
            const matches = d.matches as Record<string, any[]>;
            const cols = Object.keys(matches);
            return (
                <div className="mx-2 mb-1 space-y-2">
                    <div className="flex items-center gap-2 text-[10px] text-[#A09E99]">
                        <Search className="h-3 w-3" />
                        <span>{d.match_count} match(es) across {cols.length} column(s)</span>
                    </div>
                    {cols.length > 0 ? (
                        <div className="space-y-1.5 max-h-64 overflow-y-auto">
                            {cols.map((col) => (
                                <div key={col} className="bg-[#F0EFEC] rounded p-2">
                                    <span className="text-[10px] font-semibold text-violet-700 font-mono">{col}</span>
                                    <div className="mt-1 space-y-0.5">
                                        {(matches[col] as any[]).slice(0, 5).map((m: any, i: number) => (
                                            <div key={i} className="flex items-baseline gap-2 text-[10px]">
                                                <span className="font-mono text-amber-700 font-semibold shrink-0">
                                                    {m.score ?? m.score}
                                                </span>
                                                <span className="font-medium text-[#2B2B2B]">{m.value ?? m.distinct_value}</span>
                                                {(m.definition || (m.definitions && m.definitions[0])) && (
                                                    <span className="text-[#A09E99] truncate">
                                                        — {m.definition || m.definitions[0]}
                                                    </span>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <p className="text-[10px] text-[#A09E99] italic">No matches above threshold</p>
                    )}
                </div>
            );
        }

        // Plan decomposition
        if (step === "plan" && d.plan) {
            return (
                <div className="mx-2 mb-1">
                    <span className="text-[10px] uppercase tracking-widest text-[#A09E99] font-semibold">Analysis Plan</span>
                    <div className="mt-1 bg-[#F0EFEC] rounded p-2 space-y-1">
                        {(d.plan as string).split("\n").filter(Boolean).map((line: string, i: number) => (
                            <div key={i} className="flex items-start gap-2 text-[11px]">
                                <span className="shrink-0 h-4 w-4 flex items-center justify-center rounded-full bg-violet-100 text-violet-700 text-[9px] font-bold mt-0.5">
                                    {i + 1}
                                </span>
                                <span className="text-[#2B2B2B]">{line.replace(/^\d+\.\s*/, "")}</span>
                            </div>
                        ))}
                    </div>
                </div>
            );
        }

        // System prompt
        if (step === "system_prompt" && d.prompt_preview) {
            return (
                <div className="mx-2 mb-1">
                    <div className="flex items-center gap-2 text-[10px] text-[#A09E99]">
                        <FileText className="h-3 w-3" />
                        <span>{d.prompt_length} chars</span>
                    </div>
                    <pre className="mt-1 text-[10px] font-mono text-[#6B6966] bg-[#F0EFEC] rounded p-2 overflow-x-auto max-h-64 whitespace-pre-wrap">
                        {d.prompt_preview}
                    </pre>
                </div>
            );
        }
    }

    // ── Default: raw JSON (for all other events) ──
    return (
        <pre className="text-[10px] font-mono text-[#6B6966] bg-[#F0EFEC] rounded mx-2 mb-1 p-2 overflow-x-auto max-h-48 whitespace-pre-wrap break-all">
            {JSON.stringify(d, null, 2)}
        </pre>
    );
}

function TracePanel({
    events,
    onEventClick,
    filterNodeId,
    onClearFilter,
}: {
    events: DebugEvent[];
    onEventClick: (evt: DebugEvent) => void;
    filterNodeId: string | null;
    onClearFilter: () => void;
}) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
    const [autoScroll, setAutoScroll] = useState(true);

    const visibleEvents = React.useMemo(() => {
        if (!filterNodeId) return events;
        return events.filter((evt) => {
            const evtNodeId = resolveNodeId(evt.node || "");
            if (evtNodeId === filterNodeId) return true;
            if (filterNodeId === "pre_processing" && evt.event.startsWith("pre_")) return true;
            return false;
        });
    }, [events, filterNodeId]);

    useEffect(() => {
        if (autoScroll && scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [visibleEvents.length, autoScroll]);

    const toggle = (id: string) => {
        setExpandedIds((prev) => {
            const next = new Set(prev);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    };

    const eventColor = (evt: string) => {
        if (evt === "error" || evt === "node_error") return "text-red-600";
        if (evt === "paused") return "text-amber-600";
        if (evt === "resumed") return "text-emerald-600";
        if (evt.startsWith("pre_")) return "text-blue-600";
        if (evt === "node_enter") return "text-violet-600";
        if (evt === "node_exit") return "text-violet-500";
        if (evt === "prep_done" || evt === "exec_done" || evt === "post_done") return "text-cyan-600";
        if (evt === "tool_start") return "text-amber-600";
        if (evt === "tool_result") return "text-amber-500";
        if (evt === "thinking") return "text-violet-500";
        return "text-[#6B6966]";
    };

    const eventIcon = (evt: string) => {
        if (evt === "error" || evt === "node_error") return AlertCircle;
        if (evt === "paused") return Pause;
        if (evt === "resumed") return Play;
        if (evt.startsWith("pre_")) return Layers;
        if (evt === "node_enter" || evt === "node_exit") return Zap;
        if (evt.includes("prep") || evt.includes("exec") || evt.includes("post")) return Code2;
        if (evt === "tool_start" || evt === "tool_result") return Wrench;
        if (evt === "thinking") return Brain;
        return Terminal;
    };

    return (
        <div className="h-full flex flex-col">
            <div className="flex items-center justify-between px-3 py-2 border-b border-[#E8E6E1]">
                <div className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold tracking-widest uppercase text-[#A09E99]">
                        Trace ({visibleEvents.length}{filterNodeId ? ` / ${events.length}` : ""})
                    </span>
                    {filterNodeId && (
                        <button
                            onClick={onClearFilter}
                            className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-[#0D7377]/10 text-[#0D7377] hover:bg-[#0D7377]/20 transition-colors"
                        >
                            <X className="h-2.5 w-2.5" />
                            {filterNodeId}
                        </button>
                    )}
                </div>
                <button
                    onClick={() => setAutoScroll(!autoScroll)}
                    className={`text-[10px] px-2 py-0.5 rounded ${autoScroll ? "bg-emerald-100 text-emerald-700" : "bg-[#F0EFEC] text-[#A09E99]"}`}
                >
                    {autoScroll ? "Auto-scroll ON" : "Auto-scroll OFF"}
                </button>
            </div>
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-2 py-1 space-y-0.5">
                {visibleEvents.length === 0 && (
                    <div className="flex items-center justify-center h-32 text-[#C5C3BE] text-xs">
                        {filterNodeId
                            ? `No events for "${filterNodeId}" — click the node again to clear filter`
                            : "Run a query to see execution trace"
                        }
                    </div>
                )}
                {visibleEvents.map((evt) => {
                    const isExpanded = expandedIds.has(evt.id);
                    const Icon = eventIcon(evt.event);
                    const hasData = evt.data && Object.keys(evt.data).length > 0;
                    const ts = evt.timestamp ? new Date(evt.timestamp).toLocaleTimeString("fr-FR", { hour12: false }) : "";

                    return (
                        <div key={evt.id}>
                            <div
                                role="button"
                                tabIndex={0}
                                onClick={() => { toggle(evt.id); onEventClick(evt); }}
                                onKeyDown={(e) => { if (e.key === "Enter") toggle(evt.id); }}
                                className={`
                                    flex items-start gap-2 px-2 py-1.5 rounded-md cursor-pointer
                                    hover:bg-[#F0EFEC] transition-colors group
                                `}
                            >
                                <span className="text-[10px] font-mono text-[#C5C3BE] mt-0.5 shrink-0 w-16">{ts}</span>
                                <Icon className={`h-3 w-3 mt-0.5 shrink-0 ${eventColor(evt.event)}`} />
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-1.5">
                                        <span className={`text-[10px] font-mono font-bold ${eventColor(evt.event)}`}>
                                            {evt.event}
                                        </span>
                                        {evt.node && evt.node !== evt.message && (
                                            <span className="text-[10px] text-[#A09E99]">{evt.node}</span>
                                        )}
                                    </div>
                                    <p className="text-[11px] text-[#6B6966] truncate">{evt.message}</p>
                                </div>
                                {hasData && (
                                    isExpanded
                                        ? <ChevronDown className="h-3 w-3 text-[#C5C3BE] mt-1 shrink-0" />
                                        : <ChevronRight className="h-3 w-3 text-[#C5C3BE] mt-1 shrink-0 opacity-0 group-hover:opacity-100" />
                                )}
                            </div>
                            <AnimatePresence>
                                {isExpanded && hasData && (
                                    <motion.div
                                        initial={{ height: 0, opacity: 0 }}
                                        animate={{ height: "auto", opacity: 1 }}
                                        exit={{ height: 0, opacity: 0 }}
                                        transition={{ duration: 0.15 }}
                                        className="overflow-hidden"
                                    >
                                        <PreStepDetail event={evt} />
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function SqlViewer({ queries }: { queries: SqlEntry[] }) {
    const [activeIdx, setActiveIdx] = useState(0);

    if (queries.length === 0) {
        return (
            <div className="flex items-center justify-center h-full text-[#C5C3BE] text-xs">
                <Database className="h-5 w-5 mr-2 opacity-40" />
                No SQL queries executed yet
            </div>
        );
    }

    const q = queries[activeIdx] || queries[0];

    return (
        <div className="h-full flex flex-col">
            {queries.length > 1 && (
                <div className="flex gap-1 px-3 py-2 border-b border-[#E8E6E1] overflow-x-auto">
                    {queries.map((_, i) => (
                        <button
                            key={i}
                            onClick={() => setActiveIdx(i)}
                            className={`text-[10px] px-2 py-0.5 rounded font-mono shrink-0 ${
                                i === activeIdx ? "bg-amber-100 text-amber-700" : "text-[#A09E99] hover:bg-[#F0EFEC]"
                            }`}
                        >
                            Q{i + 1}
                        </button>
                    ))}
                </div>
            )}
            <div className="flex-1 overflow-auto p-3 space-y-3">
                {/* SQL */}
                <div>
                    <span className="text-[10px] uppercase tracking-widest text-[#A09E99] font-semibold">SQL</span>
                    <pre className="mt-1 text-[11px] font-mono text-amber-800 bg-amber-50 rounded p-2 overflow-x-auto whitespace-pre-wrap border border-amber-200">
                        {q.sql}
                    </pre>
                </div>
                {/* Error */}
                {q.error && (
                    <div className="text-[11px] text-red-600 bg-red-50 border border-red-200 rounded p-2">
                        {q.error}
                    </div>
                )}
                {/* Results table */}
                {q.columns && q.rows && q.rows.length > 0 && (
                    <div>
                        <span className="text-[10px] uppercase tracking-widest text-[#A09E99] font-semibold">
                            Results ({q.row_count ?? q.rows.length} rows)
                        </span>
                        <div className="mt-1 overflow-auto max-h-64 rounded border border-[#E8E6E1]">
                            <table className="w-full text-[10px] font-mono">
                                <thead>
                                    <tr className="bg-[#F0EFEC]">
                                        {q.columns.map((col) => (
                                            <th key={col} className="px-2 py-1.5 text-left text-[#6B6966] font-semibold border-b border-[#E8E6E1] whitespace-nowrap">
                                                {col}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {q.rows.slice(0, 50).map((row, ri) => (
                                        <tr key={ri} className={ri % 2 === 0 ? "bg-white" : "bg-[#FAFAF8]"}>
                                            {q.columns!.map((col) => (
                                                <td key={col} className="px-2 py-1 text-[#2B2B2B] border-b border-[#F0EFEC] whitespace-nowrap max-w-48 truncate">
                                                    {String(row[col] ?? "")}
                                                </td>
                                            ))}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

function StateViewer({ state }: { state: Record<string, any> }) {
    if (!state || Object.keys(state).length === 0) {
        return (
            <div className="flex items-center justify-center h-full text-[#C5C3BE] text-xs">
                <Code2 className="h-5 w-5 mr-2 opacity-40" />
                Shared state will appear here during execution
            </div>
        );
    }

    return (
        <ScrollArea className="h-full">
            <pre className="text-[10px] font-mono p-3 text-[#6B6966] whitespace-pre-wrap break-all">
                {JSON.stringify(state, null, 2)}
            </pre>
        </ScrollArea>
    );
}

function LlmChat({
    messages,
    isLoading,
    onSend,
}: {
    messages: ChatMessage[];
    isLoading: boolean;
    onSend: (msg: string) => void;
}) {
    const [input, setInput] = useState("");
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }, [messages.length]);

    const handleSend = () => {
        const msg = input.trim();
        if (!msg || isLoading) return;
        setInput("");
        onSend(msg);
    };

    return (
        <div className="h-full flex flex-col">
            <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
                {messages.length === 0 && (
                    <div className="text-[11px] text-[#A09E99] text-center mt-8">
                        <MessageSquare className="h-6 w-6 mx-auto mb-2 opacity-30" />
                        Ask the LLM to diagnose issues, suggest fixes, or explain what happened.
                    </div>
                )}
                {messages.map((msg, i) => (
                    <div key={i} className={msg.role === "user" ? "flex justify-end" : ""}>
                        <div className={`
                            max-w-[90%] rounded-lg px-3 py-2 text-[11px] leading-relaxed
                            ${msg.role === "user"
                                ? "bg-[#0D7377]/10 text-[#0D7377] border border-[#0D7377]/20"
                                : "bg-[#F0EFEC] text-[#2B2B2B] border border-[#E8E6E1]"
                            }
                        `}>
                            <pre className="whitespace-pre-wrap font-mono break-words">{msg.content}</pre>
                        </div>
                    </div>
                ))}
                {isLoading && (
                    <div className="flex items-center gap-2 text-[11px] text-[#A09E99]">
                        <Loader2 className="h-3 w-3 animate-spin" /> Analyzing...
                    </div>
                )}
            </div>
            <div className="border-t border-[#E8E6E1] p-2 flex gap-2">
                <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                    placeholder="Ask about the execution..."
                    className="flex-1 bg-white border border-[#E8E6E1] rounded px-2 py-1.5 text-[11px] text-[#2B2B2B] placeholder-[#C5C3BE] outline-none focus:border-[#0D7377]/40"
                />
                <button
                    onClick={handleSend}
                    disabled={isLoading || !input.trim()}
                    className="bg-[#0D7377]/10 hover:bg-[#0D7377]/20 text-[#0D7377] rounded px-2 py-1.5 disabled:opacity-30 transition-colors"
                >
                    <Send className="h-3.5 w-3.5" />
                </button>
            </div>
        </div>
    );
}

// ── Main Component ─────────────────────────────────────────────────────────

export default function PlaygroundView({ onClose }: PlaygroundViewProps) {
    // Flow schema
    const [flowNodes, setFlowNodes] = useState<FlowNode[]>([]);
    const [flowEdges, setFlowEdges] = useState<FlowEdge[]>([]);

    // Execution state
    const [query, setQuery] = useState("");
    const [isRunning, setIsRunning] = useState(false);
    const [isPaused, setIsPaused] = useState(false);
    const [runId, setRunId] = useState<string | null>(null);
    const [activeNode, setActiveNode] = useState<string | null>(null);
    const [nodeStates, setNodeStates] = useState<Record<string, "idle" | "active" | "done" | "error">>({});

    // Trace + data
    const [events, setEvents] = useState<DebugEvent[]>([]);
    const [sqlQueries, setSqlQueries] = useState<SqlEntry[]>([]);
    const [sharedState, setSharedState] = useState<Record<string, any>>({});
    const [finalResponse, setFinalResponse] = useState("");
    const [iterations, setIterations] = useState(0);
    const [elapsed, setElapsed] = useState(0);
    const startTimeRef = useRef<number>(0);
    const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);

    // Flow Graph node filter
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

    // Inspector tab
    const [inspectorTab, setInspectorTab] = useState<"sql" | "state" | "chat">("sql");

    // LLM Chat
    const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
    const [chatLoading, setChatLoading] = useState(false);

    // Abort controller
    const abortRef = useRef<AbortController | null>(null);

    // Load flow schema
    useEffect(() => {
        fetch(`${API_URL}/playground/flow-schema`)
            .then((r) => r.json())
            .then((data) => {
                setFlowNodes(data.nodes || []);
                setFlowEdges(data.edges || []);
            })
            .catch(() => {});
    }, []);

    // Timer
    useEffect(() => {
        if (isRunning) {
            startTimeRef.current = Date.now();
            timerRef.current = setInterval(() => setElapsed(Date.now() - startTimeRef.current), 100);
        }
        return () => { if (timerRef.current) clearInterval(timerRef.current); };
    }, [isRunning]);

    // Process SSE event
    const processEvent = useCallback((eventName: string, data: any) => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const ts = data?.timestamp || new Date().toISOString();
        const rawNode = data?.node || data?.message || "";
        const node = rawNode;
        const schemaId = resolveNodeId(rawNode);
        const message = data?.message || node || eventName;

        const evt: DebugEvent = { id, event: eventName, message, node, data, timestamp: ts };
        setEvents((prev) => [...prev, evt]);

        // Update node states (keyed by schema node ID for FlowGraph)
        if (eventName === "node_enter") {
            setActiveNode(schemaId);
            setNodeStates((prev) => ({ ...prev, [schemaId]: "active" }));
        } else if (eventName === "node_exit") {
            setNodeStates((prev) => ({ ...prev, [schemaId]: "done" }));
            setActiveNode(null);
        } else if (eventName === "node_error") {
            setNodeStates((prev) => ({ ...prev, [schemaId]: "error" }));
        } else if (eventName === "pre_step") {
            setActiveNode("pre_processing");
            setNodeStates((prev) => ({ ...prev, pre_processing: "active" }));
        } else if (eventName === "pre_complete") {
            setNodeStates((prev) => ({ ...prev, pre_processing: "done" }));
            setActiveNode(null);
        } else if (eventName === "paused") {
            setIsPaused(true);
        } else if (eventName === "resumed") {
            setIsPaused(false);
        } else if (eventName === "tool_result") {
            const toolName = data?.tool;
            if (toolName === "sql_query") {
                const preview = data?.preview || "";
                setSqlQueries((prev) => [
                    ...prev,
                    { sql: preview, columns: [], rows: [], row_count: 0 },
                ]);
            }
        } else if (eventName === "flow_complete") {
            setFinalResponse(data?.final_response || "");
            setIterations(data?.iterations || 0);
            setSharedState(data?.shared_state || {});
            if (data?.sql_queries) {
                const entries: SqlEntry[] = (data.sql_queries as any[]).map((q: any, i: number) => {
                    const result = data?.sql_results?.[i];
                    return {
                        sql: q?.sql || "",
                        columns: result?.columns || [],
                        rows: result?.rows || [],
                        row_count: result?.row_count || 0,
                    };
                });
                if (entries.length > 0) setSqlQueries(entries);
            }
        }
    }, []);

    // Run flow
    const handleRun = useCallback(async (startPaused = false) => {
        if (!query.trim()) return;

        // Reset state
        setEvents([]);
        setSqlQueries([]);
        setSharedState({});
        setFinalResponse("");
        setIterations(0);
        setElapsed(0);
        setNodeStates({});
        setActiveNode(null);
        setIsRunning(true);
        setIsPaused(startPaused);

        const controller = new AbortController();
        abortRef.current = controller;

        try {
            const resp = await fetch(`${API_URL}/playground/stream`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ query: query.trim(), max_iterations: 10, start_paused: startPaused }),
                signal: controller.signal,
            });

            if (!resp.body) throw new Error("No response body");

            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            const firstRunId = resp.headers.get("X-Run-ID");
            if (firstRunId) setRunId(firstRunId);

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                buffer = buffer.replace(/\r\n/g, "\n");

                let sepIdx = buffer.indexOf("\n\n");
                while (sepIdx !== -1) {
                    const rawEvent = buffer.slice(0, sepIdx).trim();
                    buffer = buffer.slice(sepIdx + 2);

                    if (rawEvent) {
                        const lines = rawEvent.split("\n");
                        const nameLine = lines.find((l) => l.startsWith("event:"));
                        const eventName = nameLine ? nameLine.slice(6).trim() : "message";
                        const dataLines = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());

                        if (dataLines.length > 0) {
                            try {
                                const payload = JSON.parse(dataLines.join("\n"));
                                if (eventName === "run_start" && payload.run_id) {
                                    setRunId(payload.run_id);
                                } else if (eventName !== "heartbeat") {
                                    processEvent(eventName, payload);
                                }
                            } catch {
                                // skip unparseable
                            }
                        }
                    }
                    sepIdx = buffer.indexOf("\n\n");
                }
            }
        } catch (err: any) {
            if (err.name !== "AbortError") {
                processEvent("error", { message: err.message });
            }
        } finally {
            setIsRunning(false);
            setIsPaused(false);
            if (timerRef.current) clearInterval(timerRef.current);
        }
    }, [query, processEvent]);

    // Control actions
    const handleControl = useCallback(async (action: "pause" | "resume" | "step") => {
        if (!runId) return;
        try {
            await fetch(`${API_URL}/playground/control/${runId}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action }),
            });
            if (action === "pause") setIsPaused(true);
            else if (action === "resume") setIsPaused(false);
            else if (action === "step") setIsPaused(false);
        } catch {
            // ignore
        }
    }, [runId]);

    // Stop
    const handleStop = useCallback(() => {
        abortRef.current?.abort();
        setIsRunning(false);
        setIsPaused(false);
    }, []);

    // LLM Chat
    const handleChatSend = useCallback(async (message: string) => {
        setChatMessages((prev) => [...prev, { role: "user", content: message }]);
        setChatLoading(true);

        try {
            const resp = await fetch(`${API_URL}/playground/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    message,
                    trace: events.slice(-30).map((e) => ({ event: e.event, node: e.node, message: e.message, data: e.data })),
                    shared_state_summary: JSON.stringify(sharedState).slice(0, 2000),
                }),
            });
            const data = await resp.json();
            setChatMessages((prev) => [...prev, { role: "assistant", content: data.response || "No response" }]);
        } catch (err: any) {
            setChatMessages((prev) => [...prev, { role: "assistant", content: `Error: ${err.message}` }]);
        } finally {
            setChatLoading(false);
        }
    }, [events, sharedState]);

    // Event click → switch to relevant tab
    const handleEventClick = useCallback((evt: DebugEvent) => {
        if (evt.event === "tool_result" && evt.data?.tool === "sql_query") {
            setInspectorTab("sql");
        }
    }, []);

    // Flow graph node click → toggle trace filter
    const handleFlowNodeClick = useCallback((nodeId: string) => {
        setSelectedNodeId((prev) => (prev === nodeId ? null : nodeId));
    }, []);

    const formatElapsed = (ms: number) => {
        const s = Math.floor(ms / 1000);
        const m = Math.floor(s / 60);
        return m > 0 ? `${m}m ${s % 60}s` : `${s}.${Math.floor((ms % 1000) / 100)}s`;
    };

    return (
        <div className="fixed inset-0 z-[100] flex flex-col" style={{ background: "#FFFEFC" }}>
            {/* ── Top Bar ─────────────────────────────────────────────────── */}
            <div className="flex items-center gap-3 px-4 py-2.5 border-b" style={{ borderColor: "#E8E6E1", background: "#F8F7F4" }}>
                <div className="flex items-center gap-2">
                    <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="text-[13px] font-bold tracking-wide" style={{ color: "#2B2B2B" }}>
                        Playground
                    </span>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ background: "#E8E6E1", color: "#6B6966" }}>
                        Agent Flow Debugger
                    </span>
                </div>

                {/* Query input */}
                <div className="flex-1 flex items-center gap-2 mx-4">
                    <input
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter" && !isRunning) handleRun(); }}
                        placeholder="Enter a query to debug..."
                        className="flex-1 rounded-md px-3 py-1.5 text-[12px] outline-none font-mono"
                        style={{
                            background: "#FFFFFF",
                            border: "1px solid #E8E6E1",
                            color: "#2B2B2B",
                        }}
                        disabled={isRunning}
                    />
                </div>

                {/* Controls */}
                <div className="flex items-center gap-1.5">
                    {!isRunning ? (
                        <>
                            <Button
                                size="sm"
                                onClick={() => handleRun(false)}
                                disabled={!query.trim()}
                                className="h-7 px-3 gap-1.5 text-[11px] font-semibold bg-emerald-600 hover:bg-emerald-500 text-white border-0"
                            >
                                <Play className="h-3 w-3" /> Run
                            </Button>
                            <Button
                                size="sm"
                                onClick={() => handleRun(true)}
                                disabled={!query.trim()}
                                className="h-7 px-3 gap-1.5 text-[11px] font-semibold bg-amber-600/80 hover:bg-amber-500 text-white border-0"
                            >
                                <SkipForward className="h-3 w-3" /> Step
                            </Button>
                        </>
                    ) : (
                        <>
                            {isPaused ? (
                                <>
                                    <Button size="sm" onClick={() => handleControl("resume")} className="h-7 px-3 gap-1.5 text-[11px] bg-emerald-600 hover:bg-emerald-500 text-white border-0">
                                        <Play className="h-3 w-3" /> Resume
                                    </Button>
                                    <Button size="sm" onClick={() => handleControl("step")} className="h-7 px-3 gap-1.5 text-[11px] bg-amber-600/80 hover:bg-amber-500 text-white border-0">
                                        <SkipForward className="h-3 w-3" /> Step
                                    </Button>
                                </>
                            ) : (
                                <Button size="sm" onClick={() => handleControl("pause")} className="h-7 px-3 gap-1.5 text-[11px] bg-amber-600/80 hover:bg-amber-500 text-white border-0">
                                    <Pause className="h-3 w-3" /> Pause
                                </Button>
                            )}
                            <Button size="sm" onClick={handleStop} className="h-7 px-2 text-[11px] bg-red-600/80 hover:bg-red-500 text-white border-0">
                                <X className="h-3 w-3" />
                            </Button>
                        </>
                    )}

                    <div className="w-px h-5 mx-1" style={{ background: "#E8E6E1" }} />

                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => { setEvents([]); setSqlQueries([]); setSharedState({}); setFinalResponse(""); setNodeStates({}); setSelectedNodeId(null); }}
                        className="h-7 px-2 text-[11px] text-[#A09E99] hover:text-[#6B6966] hover:bg-[#F0EFEC]"
                    >
                        <RotateCcw className="h-3 w-3" />
                    </Button>

                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={onClose}
                        className="h-7 px-2 text-[11px] text-[#A09E99] hover:text-red-500 hover:bg-red-50"
                    >
                        <X className="h-3.5 w-3.5" />
                    </Button>
                </div>
            </div>

            {/* ── Main Content (3-column) ─────────────────────────────────── */}
            <div className="flex-1 flex overflow-hidden">
                {/* Left: Flow Graph */}
                <div className="w-56 shrink-0 overflow-y-auto border-r" style={{ borderColor: "#E8E6E1", background: "#F8F7F4" }}>
                    <div className="px-3 py-2 border-b" style={{ borderColor: "#E8E6E1" }}>
                        <span className="text-[10px] font-semibold tracking-widest uppercase" style={{ color: "#A09E99" }}>Flow Graph</span>
                    </div>
                    <FlowGraph
                        nodes={flowNodes}
                        edges={flowEdges}
                        activeNode={activeNode}
                        nodeStates={nodeStates}
                        selectedNodeId={selectedNodeId}
                        onNodeClick={handleFlowNodeClick}
                    />
                </div>

                {/* Center: Execution Trace */}
                <div className="flex-1 flex flex-col overflow-hidden" style={{ background: "#FFFEFC" }}>
                    <TracePanel
                        events={events}
                        onEventClick={handleEventClick}
                        filterNodeId={selectedNodeId}
                        onClearFilter={() => setSelectedNodeId(null)}
                    />
                </div>

                {/* Right: Inspector */}
                <div className="w-96 shrink-0 flex flex-col border-l overflow-hidden" style={{ borderColor: "#E8E6E1", background: "#F8F7F4" }}>
                    {/* Tabs */}
                    <div className="flex border-b" style={{ borderColor: "#E8E6E1" }}>
                        {(["sql", "state", "chat"] as const).map((tab) => {
                            const icons = { sql: Database, state: Code2, chat: MessageSquare };
                            const labels = { sql: "SQL", state: "State", chat: "LLM Chat" };
                            const Icon = icons[tab];
                            return (
                                <button
                                    key={tab}
                                    onClick={() => setInspectorTab(tab)}
                                    className={`flex items-center gap-1.5 px-3 py-2 text-[11px] font-semibold tracking-wide transition-colors border-b-2 ${
                                        inspectorTab === tab
                                            ? "text-[#0D7377] border-[#0D7377]"
                                            : "text-[#A09E99] border-transparent hover:text-[#6B6966]"
                                    }`}
                                >
                                    <Icon className="h-3 w-3" /> {labels[tab]}
                                </button>
                            );
                        })}
                    </div>
                    <div className="flex-1 overflow-hidden">
                        {inspectorTab === "sql" && <SqlViewer queries={sqlQueries} />}
                        {inspectorTab === "state" && <StateViewer state={sharedState} />}
                        {inspectorTab === "chat" && (
                            <LlmChat messages={chatMessages} isLoading={chatLoading} onSend={handleChatSend} />
                        )}
                    </div>
                </div>
            </div>

            {/* ── Status Bar ──────────────────────────────────────────────── */}
            <div className="flex items-center gap-4 px-4 py-1.5 border-t text-[10px] font-mono" style={{ borderColor: "#E8E6E1", background: "#F8F7F4", color: "#A09E99" }}>
                <span className="flex items-center gap-1.5">
                    <div className={`h-1.5 w-1.5 rounded-full ${isRunning ? (isPaused ? "bg-amber-500" : "bg-emerald-500 animate-pulse") : "bg-[#D1CFCA]"}`} />
                    {isRunning ? (isPaused ? "PAUSED" : "RUNNING") : events.length > 0 ? "COMPLETE" : "IDLE"}
                </span>
                {runId && <span>Run: {runId}</span>}
                {iterations > 0 && <span>Iterations: {iterations}</span>}
                <span>Events: {events.length}</span>
                <span>SQL: {sqlQueries.length}</span>
                {elapsed > 0 && <span>Elapsed: {formatElapsed(elapsed)}</span>}
                {finalResponse && (
                    <span className="ml-auto text-emerald-600 truncate max-w-96">
                        Response: {finalResponse.slice(0, 80)}...
                    </span>
                )}
            </div>
        </div>
    );
}
