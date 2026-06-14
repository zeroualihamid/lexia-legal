import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    Background,
    BackgroundVariant,
    Controls,
    Handle,
    MarkerType,
    MiniMap,
    Position,
    ReactFlow,
    ReactFlowProvider,
    useEdgesState,
    useNodesState,
    type Edge,
    type Node,
    type NodeProps,
    type OnEdgesChange,
    type OnNodesChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import {
    AlertTriangle,
    ArrowLeft,
    Bot,
    CheckCircle2,
    ChevronDown,
    Database,
    FilePenLine,
    GitBranch,
    Layers,
    Loader2,
    MessageSquareText,
    Network,
    PencilLine,
    Play,
    RefreshCw,
    Route,
    Search,
    Send,
    Sparkles,
    Table2,
    Trash2,
    User,
    X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
    assistCteGraphProfiles,
    buildCteLibraryGraph,
    createCteGraphProfile,
    pruneEmptyCteGraphProfiles,
    deleteCteGraphProfile,
    generateCteProfileGraph,
    getCteGraph,
    getCteParentPaths,
    listCteGraphProfiles,
    runCteGraphQuery,
    searchCteGraph,
    type CTEBuildResponse,
    type CTEGraphProfile,
    type CTEGraphProfileAssistantResponse,
    type CTEGraphProfileChatMessage,
    type CTEParentPathsResponse,
    type CTEQueryResponse,
    type CTEReactFlowGraph,
    type CTEReactFlowNodeData,
    type CTESearchHit,
    updateCteGraphProfile,
} from "@/lib/cte_graph_api";
import { getParquetHeads, listSkills, getSkill, type ParquetFileHead, type SkillSummary } from "@/lib/parquet_api";

// ──────────────────────────────────────────────────────────────────────────
// Layered layout — assigns each node a (level, slot) so the graph renders
// left → right with a clean rank-based grid. ReactFlow's spec accepts dummy
// (0, 0) positions, so we compute meaningful ones in the front-end.
// ──────────────────────────────────────────────────────────────────────────

const NODE_WIDTH = 240;
const NODE_HEIGHT = 108;
const COLUMN_GAP = 80;
const ROW_GAP = 28;
const LIBRARY_COLUMN_GAP = 180;
const SMART_LAYOUT_NODE_THRESHOLD = 18;

interface RFNodeData extends Record<string, unknown> {
    name: string;
    description: string;
    rawSql: string;
    parents: string[];
    children: string[];
    library: string;
    parameters: string[];
    projects: string[];
    isRoot: boolean;
    isLeaf: boolean;
    isHighlighted: boolean;
    isSelected: boolean;
    isOnShortestPath: boolean;
}

type GraphLayoutMode = "smart" | "flow" | "library" | "stacked";

function computeNodeLevels(graph: CTEReactFlowGraph): Map<string, number> {
    const adjacency = new Map<string, string[]>();
    const indegree = new Map<string, number>();
    for (const node of graph.nodes) {
        adjacency.set(node.id, []);
        indegree.set(node.id, 0);
    }
    for (const edge of graph.edges) {
        adjacency.get(edge.source)?.push(edge.target);
        indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1);
    }

    const level = new Map<string, number>();
    const queue: string[] = [];
    for (const [id, deg] of indegree) {
        if (deg === 0) {
            level.set(id, 0);
            queue.push(id);
        }
    }
    const remaining = new Map(indegree);
    while (queue.length > 0) {
        const node = queue.shift()!;
        const cur = level.get(node) ?? 0;
        for (const child of adjacency.get(node) || []) {
            level.set(child, Math.max(level.get(child) ?? 0, cur + 1));
            const next = (remaining.get(child) || 0) - 1;
            remaining.set(child, next);
            if (next === 0) queue.push(child);
        }
    }
    for (const node of graph.nodes) {
        if (!level.has(node.id)) level.set(node.id, 0);
    }
    return level;
}

function groupNodeIdsByLevel(levels: Map<string, number>): Map<number, string[]> {
    const byLevel = new Map<number, string[]>();
    for (const [id, lvl] of levels) {
        if (!byLevel.has(lvl)) byLevel.set(lvl, []);
        byLevel.get(lvl)!.push(id);
    }
    return byLevel;
}

function sortedLibraries(graph: CTEReactFlowGraph): string[] {
    const counts = new Map<string, number>();
    for (const node of graph.nodes) {
        const library = (node.data.library || "unknown").trim() || "unknown";
        counts.set(library, (counts.get(library) || 0) + 1);
    }
    const pinned = ["accounting", "blocks", "insurance_audit"];
    return [...counts.keys()].sort((a, b) => {
        const pinnedA = pinned.indexOf(a);
        const pinnedB = pinned.indexOf(b);
        if (pinnedA !== -1 || pinnedB !== -1) {
            if (pinnedA === -1) return 1;
            if (pinnedB === -1) return -1;
            return pinnedA - pinnedB;
        }
        const countDiff = (counts.get(b) || 0) - (counts.get(a) || 0);
        if (countDiff !== 0) return countDiff;
        return a.localeCompare(b);
    });
}

function computeFlowPositions(graph: CTEReactFlowGraph): Map<string, { x: number; y: number }> {
    const level = computeNodeLevels(graph);
    const byLevel = groupNodeIdsByLevel(level);
    const positions = new Map<string, { x: number; y: number }>();
    const levels = [...byLevel.keys()].sort((a, b) => a - b);
    for (const lvl of levels) {
        const ids = byLevel.get(lvl)!.sort();
        ids.forEach((id, idx) => {
            positions.set(id, {
                x: lvl * (NODE_WIDTH + COLUMN_GAP),
                y: idx * (NODE_HEIGHT + ROW_GAP),
            });
        });
    }
    return positions;
}

function computeStackedPositions(graph: CTEReactFlowGraph): Map<string, { x: number; y: number }> {
    const level = computeNodeLevels(graph);
    const byLevel = groupNodeIdsByLevel(level);
    const positions = new Map<string, { x: number; y: number }>();
    const levels = [...byLevel.keys()].sort((a, b) => a - b);
    for (const lvl of levels) {
        const ids = byLevel.get(lvl)!.sort((a, b) => {
            const libA = graph.nodes.find((node) => node.id === a)?.data.library || "";
            const libB = graph.nodes.find((node) => node.id === b)?.data.library || "";
            return libA.localeCompare(libB) || a.localeCompare(b);
        });
        ids.forEach((id, idx) => {
            positions.set(id, {
                x: idx * (NODE_WIDTH + 42),
                y: lvl * (NODE_HEIGHT + 74),
            });
        });
    }
    return positions;
}

function computeLibraryPositions(graph: CTEReactFlowGraph): Map<string, { x: number; y: number }> {
    const level = computeNodeLevels(graph);
    const libraries = sortedLibraries(graph);
    const libraryIndex = new Map(libraries.map((library, index) => [library, index]));
    const nodesByLibrary = new Map<string, Array<{ id: string; level: number }>>();
    for (const node of graph.nodes) {
        const library = (node.data.library || "unknown").trim() || "unknown";
        if (!nodesByLibrary.has(library)) nodesByLibrary.set(library, []);
        nodesByLibrary.get(library)!.push({ id: node.id, level: level.get(node.id) ?? 0 });
    }

    const positions = new Map<string, { x: number; y: number }>();
    for (const [library, items] of nodesByLibrary.entries()) {
        const libIdx = libraryIndex.get(library) ?? 0;
        items
            .sort((a, b) => a.level - b.level || a.id.localeCompare(b.id))
            .forEach((item, idx) => {
                positions.set(item.id, {
                    x: libIdx * (NODE_WIDTH + LIBRARY_COLUMN_GAP) + item.level * 36,
                    y: idx * (NODE_HEIGHT + ROW_GAP),
                });
            });
    }
    return positions;
}

function resolveGraphLayoutMode(
    requested: GraphLayoutMode,
    graph: CTEReactFlowGraph,
): Exclude<GraphLayoutMode, "smart"> {
    if (requested !== "smart") return requested;
    const libraries = new Set(graph.nodes.map((node) => node.data.library || "unknown"));
    if (libraries.size > 1 && graph.nodes.length >= SMART_LAYOUT_NODE_THRESHOLD) {
        return "library";
    }
    return "flow";
}

function computePositionsForLayout(
    graph: CTEReactFlowGraph,
    requested: GraphLayoutMode,
): Map<string, { x: number; y: number }> {
    const resolved = resolveGraphLayoutMode(requested, graph);
    if (resolved === "library") return computeLibraryPositions(graph);
    if (resolved === "stacked") return computeStackedPositions(graph);
    return computeFlowPositions(graph);
}

// ──────────────────────────────────────────────────────────────────────────
// Library-aware accent palette for the node + minimap.
// ──────────────────────────────────────────────────────────────────────────

const LIBRARY_ACCENTS: Record<string, { chip: string; minimap: string }> = {
    accounting: { chip: "bg-[#0D7377]/12 text-[#0D7377]", minimap: "#0D7377" },
    blocks:     { chip: "bg-[#9A4DDB]/15 text-[#9A4DDB]", minimap: "#9A4DDB" },
    insurance_audit: {
        chip: "bg-[#1D4ED8]/12 text-[#1D4ED8]",
        minimap: "#1D4ED8",
    },
};

const fallbackLibraryAccent = { chip: "bg-[#A09E99]/15 text-[#4A4845]", minimap: "#A09E99" };

const accentForLibrary = (library?: string) =>
    (library && LIBRARY_ACCENTS[library]) || fallbackLibraryAccent;

// ──────────────────────────────────────────────────────────────────────────
// Custom node — small card with name, description, library chip and rank.
// ──────────────────────────────────────────────────────────────────────────

const CTEFlowNode: React.FC<NodeProps<Node<RFNodeData>>> = ({ data, selected }) => {
    const accentRing = data.isOnShortestPath
        ? "border-[#0D7377] ring-2 ring-[#0D7377]/40 bg-[#0D7377]/8"
        : data.isHighlighted
            ? "border-[#E8725A] ring-2 ring-[#E8725A]/30 bg-[#E8725A]/5"
            : data.isSelected || selected
                ? "border-[#0D7377] ring-2 ring-[#0D7377]/40 bg-white"
                : "border-[#E8E6E1] bg-white";
    const libraryAccent = accentForLibrary(data.library);
    return (
        <div
            className={cn(
                "rounded-xl border px-3 py-2.5 shadow-sm transition-all",
                accentRing,
            )}
            style={{ width: NODE_WIDTH }}
        >
            <Handle type="target" position={Position.Left} className="!bg-[#0D7377]" />
            <div className="flex items-center gap-2">
                <div
                    className={cn(
                        "h-7 w-7 rounded-lg flex items-center justify-center",
                        data.isRoot
                            ? "bg-[#0D7377]/15 text-[#0D7377]"
                            : data.isLeaf
                                ? "bg-[#E8725A]/15 text-[#E8725A]"
                                : "bg-[#F8F7F4] text-[#6B6966]",
                    )}
                >
                    {data.isRoot ? (
                        <Layers className="h-3.5 w-3.5" />
                    ) : data.isLeaf ? (
                        <Sparkles className="h-3.5 w-3.5" />
                    ) : (
                        <GitBranch className="h-3.5 w-3.5" />
                    )}
                </div>
                <div className="min-w-0 flex-1">
                    <p className="text-[12px] font-semibold text-[#2B2B2B] truncate">{data.name}</p>
                    <p className="text-[10px] text-[#A09E99] uppercase tracking-wider">
                        {data.isRoot ? "Root" : data.isLeaf ? "Leaf" : "Step"}
                        <span className="ml-1 lowercase tracking-normal text-[#A09E99]">
                            · {data.parents.length}↥ / {data.children.length}↧
                        </span>
                    </p>
                </div>
                {data.library && (
                    <span
                        className={cn(
                            "rounded-md px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider",
                            libraryAccent.chip,
                        )}
                    >
                        {data.library}
                    </span>
                )}
            </div>
            {data.description && (
                <p className="mt-2 text-[11px] text-[#6B6966] line-clamp-2 leading-snug">
                    {data.description}
                </p>
            )}
            {(data.parameters.length > 0 || data.projects.length > 0) && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                    {data.parameters.map((p) => (
                        <span
                            key={`p-${p}`}
                            className="rounded-full bg-[#E8725A]/12 text-[#E8725A] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider"
                        >
                            ${p}
                        </span>
                    ))}
                </div>
            )}
            <Handle type="source" position={Position.Right} className="!bg-[#0D7377]" />
        </div>
    );
};

const NODE_TYPES = { default: CTEFlowNode };

type CTEGraphViewMode = "catalog" | "workspace";

type ConversationMessage =
    | { id: string; role: "user"; content: string }
    | { id: string; role: "assistant"; content: string; result?: CTEQueryResponse; error?: string };

interface ProfileFormState {
    id?: string;
    name: string;
    description: string;
    libraries: string[];
    /** Parquet/DTO stem names (from `classes/dtos/*_dto.py`) for column contracts. */
    dtoStems: string[];
    queryExamples: string;
}

interface ProfileAgentMessage extends CTEGraphProfileChatMessage {
    id: string;
    proposal?: CTEGraphProfileAssistantResponse;
    error?: string;
}

/** Dropdown multiselect for DTO stems listed by the API (disk scan ∪ cache). */
const DtoStemMultiselect: React.FC<{
    stems: string[];
    selected: string[];
    onToggle: (stem: string) => void;
}> = ({ stems, selected, onToggle }) => {
    const [open, setOpen] = useState(false);
    const [filter, setFilter] = useState("");
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const close = (e: MouseEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener("mousedown", close);
        return () => document.removeEventListener("mousedown", close);
    }, [open]);

    const filtered = useMemo(
        () =>
            stems.filter((s) =>
                s.toLowerCase().includes(filter.trim().toLowerCase()),
            ),
        [stems, filter],
    );

    const summary =
        selected.length === 0
            ? "Choisir une ou plusieurs classes DTO…"
            : `${selected.length} classe${selected.length > 1 ? "s" : ""} sélectionnée${selected.length > 1 ? "s" : ""}`;

    if (stems.length === 0) return null;

    return (
        <div ref={rootRef} className="relative">
            <Button
                type="button"
                variant="outline"
                onClick={() => setOpen((v) => !v)}
                className="h-auto min-h-10 w-full justify-between rounded-xl border-[#E8E6E1] bg-[#F8F7F4] px-3 py-2 text-left font-normal text-[#2B2B2B]"
            >
                <span className="line-clamp-2 text-[13px]">{summary}</span>
                <ChevronDown
                    className={cn("h-4 w-4 shrink-0 opacity-60 transition-transform", open && "rotate-180")}
                />
            </Button>
            {open && (
                <div className="absolute left-0 right-0 z-50 mt-1 overflow-hidden rounded-xl border border-[#E8E6E1] bg-white shadow-lg">
                    <div className="border-b border-[#E8E6E1] p-2">
                        <div className="relative">
                            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#A09E99]" />
                            <Input
                                value={filter}
                                onChange={(e) => setFilter(e.target.value)}
                                placeholder="Filtrer par nom…"
                                className="h-9 border-[#E8E6E1] bg-[#F8F7F4] pl-8 text-[12px]"
                                onClick={(e) => e.stopPropagation()}
                            />
                        </div>
                    </div>
                    <ScrollArea className="max-h-56">
                        <div className="py-1">
                            {filtered.length === 0 ? (
                                <p className="px-3 py-4 text-center text-[12px] text-[#6B6966]">Aucun résultat</p>
                            ) : (
                                filtered.map((stem) => {
                                    const isOn = selected.includes(stem);
                                    return (
                                        <label
                                            key={stem}
                                            className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-[12px] hover:bg-[#F8F7F4]"
                                        >
                                            <input
                                                type="checkbox"
                                                className="h-3.5 w-3.5 rounded border-[#C9C7C2] accent-[#5C4D7D]"
                                                checked={isOn}
                                                onChange={() => onToggle(stem)}
                                            />
                                            <span className="font-mono text-[#2B2B2B]">{stem}</span>
                                        </label>
                                    );
                                })
                            )}
                        </div>
                    </ScrollArea>
                </div>
            )}
            {selected.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                    {selected.map((stem) => (
                        <span
                            key={stem}
                            className="inline-flex items-center gap-1 rounded-full border border-[#5C4D7D]/25 bg-[#5C4D7D]/10 py-0.5 pl-2 pr-1 text-[10px] font-mono text-[#4A3D66]"
                        >
                            {stem}
                            <button
                                type="button"
                                className="rounded-full p-0.5 text-[#6B6966] hover:bg-[#5C4D7D]/20 hover:text-[#2B2B2B]"
                                aria-label={`Retirer ${stem}`}
                                onClick={() => onToggle(stem)}
                            >
                                <X className="h-3 w-3" />
                            </button>
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
};

const parquetRoleTokens: Record<"ledger" | "balance", string[]> = {
    ledger: ["ledger", "grand_livre", "grand livre", "ecriture", "écriture"],
    balance: ["balance", "bilan"],
};

function dedupeParquetOptions(files: ParquetFileHead[]): ParquetFileHead[] {
    const seen = new Set<string>();
    const out: ParquetFileHead[] = [];
    for (const file of files) {
        if (!file.path || seen.has(file.path)) continue;
        seen.add(file.path);
        out.push(file);
    }
    return out;
}

function parquetMatchesRole(file: ParquetFileHead, role: "ledger" | "balance"): boolean {
    const haystack = [
        file.file,
        file.path,
        file.source_id || "",
        file.table_id || "",
        file.cache_type || "",
    ]
        .join(" ")
        .toLowerCase();
    return parquetRoleTokens[role].some((token) => haystack.includes(token));
}

function parquetLabel(file: ParquetFileHead): string {
    const suffix = [file.source_id, file.table_id].filter(Boolean).join(" / ");
    return suffix ? `${file.file} · ${suffix}` : file.file;
}

function profileToForm(profile: CTEGraphProfile | null): ProfileFormState {
    if (!profile) {
        return {
            name: "",
            description: "",
            libraries: [],
            dtoStems: [],
            queryExamples: "",
        };
    }
    return {
        id: profile.id,
        name: profile.name,
        description: profile.description,
        libraries: [...profile.libraries],
        dtoStems: [...(profile.dto_stems ?? [])],
        queryExamples: (profile.query_examples || []).join("\n"),
    };
}

function serializeQueryExamples(value: string): string[] {
    return value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}

function assistantSummary(result: CTEQueryResponse): string {
    const rowLabel = `${result.execution.row_count} ligne${result.execution.row_count > 1 ? "s" : ""}`;
    const chainLabel = result.execution.execution_chain.length > 0
        ? result.execution.execution_chain.join(" → ")
        : result.selected_node;
    const finalResult = describeExecutionResult(result.execution);
    if (finalResult.kind === "scalar") {
        return `CTE retenu: ${result.selected_node}. Chaîne exécutée: ${chainLabel}. Résultat final: ${finalResult.value}.`;
    }
    if (finalResult.kind === "record") {
        return `CTE retenu: ${result.selected_node}. Chaîne exécutée: ${chainLabel}. Résultat final: ${finalResult.entries.map(([key, value]) => `${key}=${value}`).join(", ")}.`;
    }
    return `CTE retenu: ${result.selected_node}. Chaîne exécutée: ${chainLabel}. Résultat: ${rowLabel}.`;
}

function renderCellValue(value: unknown): string {
    if (value === null || value === undefined) return "—";
    if (typeof value === "string") return value;
    if (typeof value === "number") {
        return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(value);
    }
    if (typeof value === "boolean") return value ? "Oui" : "Non";
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function prettifyMetricLabel(label: string): string {
    return label
        .replace(/^total_/, "total ")
        .replace(/^charge_/, "charge ")
        .replace(/_/g, " ")
        .replace(/\b\w/g, (match) => match.toUpperCase());
}

function extractSummaryMetrics(
    execution: CTEQueryResponse["execution"],
): Array<{ label: string; value: string }> {
    const rows = execution.rows || [];
    const columns = execution.columns || [];
    if (rows.length === 0 || columns.length === 0) return [];

    const metrics: Array<{ label: string; value: string }> = [];
    for (const column of columns) {
        if (!(column.startsWith("total_") || column === "total" || column === "value")) continue;
        const first = renderCellValue(rows[0][column]);
        const stable = rows.every((row) => renderCellValue(row[column]) === first);
        if (!stable) continue;
        metrics.push({ label: prettifyMetricLabel(column), value: first });
    }
    return metrics;
}

function describeExecutionResult(execution: CTEQueryResponse["execution"]):
    | { kind: "empty" }
    | { kind: "scalar"; label: string; value: string }
    | { kind: "record"; entries: Array<[string, string]> }
    | {
        kind: "table";
        columns: string[];
        previewRows: Record<string, unknown>[];
        summaryMetrics: Array<{ label: string; value: string }>;
    } {
    const rows = execution.rows || [];
    const columns = execution.columns || [];
    if (rows.length === 0 || columns.length === 0) {
        return { kind: "empty" };
    }

    if (rows.length === 1 && columns.length === 1) {
        const label = columns[0];
        const value = renderCellValue(rows[0][label]);
        return { kind: "scalar", label, value };
    }

    if (rows.length === 1 && columns.length <= 6) {
        return {
            kind: "record",
            entries: columns.map((column) => [column, renderCellValue(rows[0][column])]),
        };
    }

    return {
        kind: "table",
        columns,
        previewRows: rows.slice(0, 3),
        summaryMetrics: extractSummaryMetrics(execution),
    };
}

interface GraphCanvasProps {
    graph: CTEReactFlowGraph | null;
    nodes: Node<RFNodeData>[];
    edges: Edge[];
    isBuilding: boolean;
    layoutMode: GraphLayoutMode;
    resolvedLayoutMode: Exclude<GraphLayoutMode, "smart">;
    onLayoutChange: (mode: GraphLayoutMode) => void;
    onNodesChange: OnNodesChange<Node<RFNodeData>>;
    onEdgesChange: OnEdgesChange<Edge>;
    onSelectNode: (nodeId: string) => void;
    onClearSelection: () => void;
    heightClassName?: string;
}

const GraphCanvas: React.FC<GraphCanvasProps> = ({
    graph,
    nodes,
    edges,
    isBuilding,
    layoutMode,
    resolvedLayoutMode,
    onLayoutChange,
    onNodesChange,
    onEdgesChange,
    onSelectNode,
    onClearSelection,
    heightClassName = "h-[640px]",
}) => (
    <Card className={cn("flex min-h-0 flex-col p-0 overflow-hidden border-[#E8E6E1] bg-white shadow-none", heightClassName)}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E8E6E1] px-4 py-3">
            <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                    Visualisation
                </p>
                <p className="mt-1 text-[12px] text-[#6B6966]">
                    {resolvedLayoutMode === "library"
                        ? "Groupement par bibliothèque pour séparer clairement les familles de CTE."
                        : resolvedLayoutMode === "stacked"
                            ? "Lecture verticale par niveaux de dépendance."
                            : "Lecture de gauche à droite pour suivre le flux de calcul."}
                </p>
            </div>
            <div className="flex flex-wrap gap-2">
                {[
                    { id: "smart" as const, label: "Intelligent" },
                    { id: "flow" as const, label: "Flux" },
                    { id: "library" as const, label: "Bibliothèque" },
                    { id: "stacked" as const, label: "Niveaux" },
                ].map((option) => {
                    const isActive = layoutMode === option.id;
                    return (
                        <button
                            key={option.id}
                            type="button"
                            onClick={() => onLayoutChange(option.id)}
                            className={cn(
                                "rounded-full border px-3 py-1.5 text-[11px] font-semibold transition-all",
                                isActive
                                    ? "border-[#0D7377] bg-[#0D7377] text-white"
                                    : "border-[#E8E6E1] bg-[#F8F7F4] text-[#6B6966] hover:border-[#0D7377]/35 hover:text-[#0D7377]",
                            )}
                        >
                            {option.label}
                        </button>
                    );
                })}
            </div>
        </div>
        <div className="min-h-0 flex-1">
            {graph ? (
                <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onNodeClick={(_, n) => onSelectNode(n.id)}
                    onPaneClick={onClearSelection}
                    nodeTypes={NODE_TYPES}
                    fitView
                    fitViewOptions={{ padding: 0.2 }}
                    proOptions={{ hideAttribution: true }}
                    minZoom={0.2}
                    maxZoom={1.5}
                >
                    <Background
                        variant={BackgroundVariant.Dots}
                        gap={18}
                        size={1.2}
                        color="#E8E6E1"
                    />
                    <MiniMap
                        pannable
                        zoomable
                        nodeColor={(n) => {
                            const data = n.data as RFNodeData;
                            if (data?.isOnShortestPath) return "#0D7377";
                            if (data?.isHighlighted) return "#E8725A";
                            if (data?.isRoot) return "#0D7377";
                            if (data?.isLeaf) return "#E8725A";
                            return accentForLibrary(data?.library).minimap;
                        }}
                        maskColor="rgba(248, 247, 244, 0.85)"
                    />
                    <Controls showInteractive={false} />
                </ReactFlow>
            ) : (
                <div className="flex h-full flex-col items-center justify-center px-8 text-center text-[#6B6966]">
                    {isBuilding ? (
                        <>
                            <Loader2 className="mb-3 h-10 w-10 animate-spin text-[#A09E99]" />
                            <p className="text-sm font-semibold text-[#2B2B2B]">
                                Lecture de la bibliothèque…
                            </p>
                            <p className="mt-1 max-w-md text-xs">
                                Chargement des fichiers <span className="font-mono">index.yaml</span> depuis
                                <span className="font-mono"> data/reporting/sql/</span>.
                            </p>
                        </>
                    ) : (
                        <>
                            <Network className="mb-3 h-10 w-10 text-[#A09E99]" />
                            <p className="text-sm font-semibold text-[#2B2B2B]">
                                Aucun graphe chargé
                            </p>
                            <p className="mt-1 max-w-md text-xs">
                                Cliquez sur <span className="font-semibold">Recharger la bibliothèque</span> pour
                                construire le graphe à partir des CTE déclarés dans
                                <span className="font-mono"> data/reporting/sql/</span>.
                            </p>
                        </>
                    )}
                </div>
            )}
        </div>
    </Card>
);

// ──────────────────────────────────────────────────────────────────────────
// Inner panel (must live inside <ReactFlowProvider>).
// ──────────────────────────────────────────────────────────────────────────

const CTEGraphPanelInner: React.FC<CTEGraphPanelProps> = ({ onActiveGraphChange }) => {
    const [viewMode, setViewMode] = useState<CTEGraphViewMode>("catalog");
    const [profiles, setProfiles] = useState<CTEGraphProfile[]>([]);
    const [availableLibraries, setAvailableLibraries] = useState<string[]>([]);
    const [availableDtoStems, setAvailableDtoStems] = useState<string[]>([]);
    const [skills, setSkills] = useState<SkillSummary[]>([]);
    const [skillDtoByDir, setSkillDtoByDir] = useState<Record<string, string>>({});
    const [skillParquetByDir, setSkillParquetByDir] = useState<Record<string, string>>({});
    const [workspaceTab, setWorkspaceTab] = useState<"infos" | "graph">("infos");
    const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
    const [profileForm, setProfileForm] = useState<ProfileFormState>(profileToForm(null));
    const [isLoadingProfiles, setIsLoadingProfiles] = useState(false);
    const [isSavingProfile, setIsSavingProfile] = useState(false);
    const [isDeletingProfile, setIsDeletingProfile] = useState(false);
    const [showCreateProfileForm, setShowCreateProfileForm] = useState(false);
    const [isCreatingProfile, setIsCreatingProfile] = useState(false);
    const [newProfileName, setNewProfileName] = useState("");
    const [newProfileId, setNewProfileId] = useState("");
    const [newProfileDescription, setNewProfileDescription] = useState("");
    const [newProfileSkill, setNewProfileSkill] = useState("");
    const [isPruning, setIsPruning] = useState(false);
    const [generatingProfileId, setGeneratingProfileId] = useState<string | null>(null);
    const [catalogGenerateMessage, setCatalogGenerateMessage] = useState<string | null>(null);
    const [profileAgentMessages, setProfileAgentMessages] = useState<ProfileAgentMessage[]>([]);
    const [profileAgentInput, setProfileAgentInput] = useState("");
    const [isRunningProfileAgent, setIsRunningProfileAgent] = useState(false);

    const [graphId, setGraphId] = useState<string | null>(null);
    const [graphMeta, setGraphMeta] = useState<CTEBuildResponse | null>(null);
    const [graph, setGraph] = useState<CTEReactFlowGraph | null>(null);
    const [graphLayoutMode, setGraphLayoutMode] = useState<GraphLayoutMode>("smart");
    const [isBuilding, setIsBuilding] = useState(false);
    const [buildError, setBuildError] = useState<string | null>(null);

    // Surface the selected profile's graph_id to the parent so the section chat
    // ("Assistant CTE") binds the agent to THIS graph + its source, instead of
    // falling back to the default (insurance) library.
    useEffect(() => {
        const prof = profiles.find((p) => p.id === selectedProfileId);
        onActiveGraphChange?.(prof?.graph_id ?? graphId ?? null);
    }, [selectedProfileId, profiles, graphId, onActiveGraphChange]);

    const [searchQuery, setSearchQuery] = useState("");
    const [searchResults, setSearchResults] = useState<CTESearchHit[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [semanticHighlightedNodeIds, setSemanticHighlightedNodeIds] = useState<string[]>([]);

    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const [parentPaths, setParentPaths] = useState<CTEParentPathsResponse | null>(null);
    const [isLoadingPaths, setIsLoadingPaths] = useState(false);

    const [parquetOptions, setParquetOptions] = useState<ParquetFileHead[]>([]);
    const [isLoadingParquets, setIsLoadingParquets] = useState(false);
    const [ledgerParquetPath, setLedgerParquetPath] = useState("");
    const [balanceParquetPath, setBalanceParquetPath] = useState("");
    const [conversationQuery, setConversationQuery] = useState("");
    const [conversationMessages, setConversationMessages] = useState<ConversationMessage[]>([]);
    const [isRunningConversation, setIsRunningConversation] = useState(false);

    const [nodes, setNodes, onNodesChange] = useNodesState<Node<RFNodeData>>([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

    const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
    const selectedProfile = useMemo(
        () => profiles.find((profile) => profile.id === selectedProfileId) ?? null,
        [profiles, selectedProfileId],
    );

    // Resolve the SKILL(s) backing this graph. The agent maps a skill to its CTE
    // graph as `cte-prof-<slug(skill name)>`, and a profile's `libraries` are those
    // skill/library names — so match the profile libraries against the skills list.
    const linkedSkills = useMemo(() => {
        const slug = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        const libs = profileForm.libraries.length ? profileForm.libraries : (selectedProfile?.libraries ?? []);
        const libSlugs = new Set(libs.map(slug));
        return skills.filter((sk) => libSlugs.has(slug(sk.name)) || libSlugs.has(slug(sk.directory_name)));
    }, [skills, profileForm.libraries, selectedProfile]);

    // Fetch the linked skill(s)' DTO class (skill frontmatter `dto`) — this is the
    // DTO actually bound to the graph even when the profile declares no dto_stems.
    useEffect(() => {
        linkedSkills.forEach((sk) => {
            if (skillDtoByDir[sk.directory_name] !== undefined) return;
            void getSkill(sk.directory_name)
                .then((d) => {
                    // Skills bind a DTO via `dto`, or implicitly via `source_view` /
                    // `parquet_source` (e.g. oracle_env_ca_view → oracle_env_ca_view_dto).
                    const raw = (d.dto || d.source_view || (d.parquet_source || "").split("/").pop() || "")
                        .replace(/\.parquet$/i, "").replace(/_dto$/i, "").trim();
                    setSkillDtoByDir((prev) => ({ ...prev, [sk.directory_name]: raw }));
                    setSkillParquetByDir((prev) => ({ ...prev, [sk.directory_name]: (d.parquet_source || "").trim() }));
                })
                .catch(() => setSkillDtoByDir((prev) => ({ ...prev, [sk.directory_name]: "" })));
        });
    }, [linkedSkills, skillDtoByDir]);

    // Reset to the Infos tab when leaving the workspace (each open starts on Infos).
    useEffect(() => {
        if (viewMode === "catalog") setWorkspaceTab("infos");
    }, [viewMode]);

    // DTO class(es) actually used by this graph: skill `dto` ∪ profile dto_stems.
    const usedDtos = useMemo(() => {
        const out = new Set<string>();
        linkedSkills.forEach((sk) => {
            const d = skillDtoByDir[sk.directory_name];
            if (d) out.add(d.replace(/_dto$/i, ""));
        });
        profileForm.dtoStems.forEach((s) => s && out.add(s));
        return [...out];
    }, [linkedSkills, skillDtoByDir, profileForm.dtoStems]);

    // Parquet ledger(s) the graph executes against — resolved from the linked
    // skill's `parquet_source`. The graph is bound skill → DTO → parquet, so this
    // is informational (auto), not user-selectable.
    const usedParquet = useMemo(() => {
        const out = new Set<string>();
        linkedSkills.forEach((sk) => {
            const p = skillParquetByDir[sk.directory_name];
            if (p) out.add(p);
        });
        return [...out];
    }, [linkedSkills, skillParquetByDir]);

    const loadProfiles = useCallback(async () => {
        setIsLoadingProfiles(true);
        setBuildError(null);
        try {
            const response = await listCteGraphProfiles();
            setProfiles(response.profiles);
            setAvailableLibraries(response.available_libraries);
            setAvailableDtoStems(response.available_dto_stems ?? []);
            void listSkills().then((r) => setSkills(r.skills ?? [])).catch(() => {});
            setSelectedProfileId((current) => {
                if (current && response.profiles.some((profile) => profile.id === current)) return current;
                return null;
            });
        } catch (err) {
            setBuildError((err as Error).message);
        } finally {
            setIsLoadingProfiles(false);
        }
    }, []);

    const loadProfileGraph = useCallback(
        async (profileId: string, opts?: { force?: boolean }) => {
            setIsBuilding(true);
            setBuildError(null);
            setSearchResults([]);
            setSemanticHighlightedNodeIds([]);
            setSelectedNodeId(null);
            setParentPaths(null);
            positionsRef.current = new Map();
            try {
                const meta = await buildCteLibraryGraph({
                    profileId,
                    forceRebuild: Boolean(opts?.force),
                });
                const data = await getCteGraph(meta.graph_id);
                setGraphId(meta.graph_id);
                setGraphMeta(meta);
                setGraph(data);
            } catch (err) {
                setBuildError((err as Error).message);
                setGraph(null);
                setGraphMeta(null);
                setGraphId(null);
            } finally {
                setIsBuilding(false);
            }
        },
        [],
    );

    const buildLibrary = useCallback(
        async (opts?: { force?: boolean }) => {
            if (!selectedProfile) return;
            await loadProfileGraph(selectedProfile.id, opts);
        },
        [loadProfileGraph, selectedProfile],
    );

    const handleGenerateProfileGraph = useCallback(
        async (profileId: string, opts?: { refreshGraph?: boolean }) => {
            setGeneratingProfileId(profileId);
            setCatalogGenerateMessage(null);
            setBuildError(null);
            try {
                const res = await generateCteProfileGraph(profileId);
                if (!res.success) {
                    setCatalogGenerateMessage(res.message || res.error || "Échec de la génération.");
                    return;
                }
                let msg = `${res.cte_count} CTE — graphe ${res.graph_id ?? ""} (${Math.round(res.duration_ms)} ms)`;
                if (res.chain_warning) {
                    msg += `. Attention : ${res.chain_warning}`;
                }
                setCatalogGenerateMessage(msg);
                await loadProfiles();
                if (opts?.refreshGraph || selectedProfileId === profileId) {
                    await loadProfileGraph(profileId, { force: true });
                }
            } catch (err) {
                setCatalogGenerateMessage((err as Error).message);
            } finally {
                setGeneratingProfileId(null);
            }
        },
        [loadProfileGraph, loadProfiles, selectedProfileId],
    );

    useEffect(() => {
        void loadProfiles();
    }, [loadProfiles]);

    useEffect(() => {
        if (selectedProfile) {
            setProfileForm(profileToForm(selectedProfile));
        }
    }, [selectedProfile]);

    useEffect(() => {
        if (viewMode !== "workspace" || !selectedProfileId) {
            setGraph(null);
            setGraphId(null);
            setGraphMeta(null);
            return;
        }
        if (!profiles.some((p) => p.id === selectedProfileId)) {
            return;
        }
        void buildLibrary();
    }, [buildLibrary, selectedProfileId, viewMode, profiles]);

    useEffect(() => {
        positionsRef.current = new Map();
    }, [graphLayoutMode]);

    useEffect(() => {
        let cancelled = false;
        const loadParquets = async () => {
            setIsLoadingParquets(true);
            try {
                const response = await getParquetHeads(200, false, 0);
                if (cancelled) return;
                const options = dedupeParquetOptions(response.files || []);
                setParquetOptions(options);
                setLedgerParquetPath((prev) => {
                    if (prev && options.some((file) => file.path === prev)) return prev;
                    return options.find((file) => parquetMatchesRole(file, "ledger"))?.path || "";
                });
                setBalanceParquetPath((prev) => {
                    if (prev && options.some((file) => file.path === prev)) return prev;
                    return options.find((file) => parquetMatchesRole(file, "balance"))?.path || "";
                });
            } catch (err) {
                if (!cancelled) setBuildError((err as Error).message);
            } finally {
                if (!cancelled) setIsLoadingParquets(false);
            }
        };
        void loadParquets();
        return () => {
            cancelled = true;
        };
    }, []);

    const toggleDtoStem = useCallback((stem: string) => {
        setProfileForm((prev) => {
            const exists = prev.dtoStems.includes(stem);
            return {
                ...prev,
                dtoStems: exists
                    ? prev.dtoStems.filter((item) => item !== stem)
                    : [...prev.dtoStems, stem],
            };
        });
    }, []);

    const handleSaveProfile = useCallback(async () => {
        if (!profileForm.name.trim() || !profileForm.id) return;
        setIsSavingProfile(true);
        setBuildError(null);
        try {
            const payload = {
                name: profileForm.name.trim(),
                description: profileForm.description.trim(),
                dtoStems: profileForm.dtoStems,
                queryExamples: serializeQueryExamples(profileForm.queryExamples),
            };
            const saved = await updateCteGraphProfile(profileForm.id, payload);
            await loadProfiles();
            setSelectedProfileId(saved.id);
            setViewMode("workspace");
        } catch (err) {
            setBuildError((err as Error).message);
        } finally {
            setIsSavingProfile(false);
        }
    }, [loadProfiles, profileForm]);

    const handleDeleteProfile = useCallback(async (profileId?: string | null) => {
        const targetId = profileId || profileForm.id || selectedProfileId;
        if (!targetId) return;
        setIsDeletingProfile(true);
        setBuildError(null);
        try {
            await deleteCteGraphProfile(targetId);
            if (targetId === selectedProfileId) {
                setViewMode("catalog");
                setSelectedProfileId(null);
                setProfileForm(profileToForm(null));
            }
            setProfileAgentMessages((prev) => [
                ...prev,
                {
                    id: `profile-delete-${Date.now()}`,
                    role: "assistant",
                    content: "La carte, le graphe en cache et le dossier data/reporting/sql ont été supprimés sur le serveur.",
                },
            ]);
            await loadProfiles();
        } catch (err) {
            setBuildError((err as Error).message);
        } finally {
            setIsDeletingProfile(false);
        }
    }, [loadProfiles, profileForm.id, selectedProfileId]);

    const handleProfileAgentSubmit = useCallback(async () => {
        const prompt = profileAgentInput.trim();
        if (!prompt) return;
        const nextMessages: ProfileAgentMessage[] = [
            ...profileAgentMessages,
            { id: `profile-user-${Date.now()}`, role: "user", content: prompt },
        ];
        setProfileAgentMessages(nextMessages);
        setProfileAgentInput("");
        setIsRunningProfileAgent(true);
        setBuildError(null);
        try {
            const response = await assistCteGraphProfiles({
                messages: nextMessages.map(({ role, content }) => ({ role, content })),
                currentProfileId: selectedProfileId,
                dtoStems: profileForm.dtoStems,
            });
            if (response.draft_profile) {
                setProfileForm(profileToForm(response.draft_profile));
                if (response.operation === "update" && response.target_profile_id) {
                    setSelectedProfileId(response.target_profile_id);
                }
                if (response.operation === "create") {
                    setSelectedProfileId(null);
                }
                setViewMode("workspace");
            }
            setProfileAgentMessages((prev) => [
                ...prev,
                {
                    id: `profile-assistant-${Date.now()}`,
                    role: "assistant",
                    content: response.assistant_message,
                    proposal: response,
                },
            ]);
        } catch (err) {
            const message = (err as Error).message;
            setBuildError(message);
            setProfileAgentMessages((prev) => [
                ...prev,
                {
                    id: `profile-assistant-error-${Date.now()}`,
                    role: "assistant",
                    content: message,
                    error: message,
                },
            ]);
        } finally {
            setIsRunningProfileAgent(false);
        }
    }, [profileAgentInput, profileAgentMessages, profileForm.dtoStems, selectedProfileId]);

    const persistAgentProposal = useCallback(async (proposal: CTEGraphProfileAssistantResponse) => {
        if (proposal.operation === "delete" && proposal.target_profile_id) {
            await handleDeleteProfile(proposal.target_profile_id);
            return null;
        }
        const draft = proposal.draft_profile;
        if (!draft) return null;
        setIsSavingProfile(true);
        setBuildError(null);
        try {
            const payload = {
                name: draft.name,
                description: draft.description,
                dtoStems: draft.dto_stems ?? [],
                queryExamples: draft.query_examples,
            };
            const targetId = proposal.target_profile_id || draft.id;
            const canUpdate = Boolean(targetId && profiles.some((p) => p.id === targetId));
            const saved = canUpdate && proposal.operation !== "create"
                ? await updateCteGraphProfile(targetId, payload)
                : await createCteGraphProfile({
                    id: draft.id,
                    name: draft.name,
                    skill: draft.name,
                    description: draft.description,
                    dtoStems: draft.dto_stems ?? [],
                    queryExamples: draft.query_examples,
                });
            await loadProfiles();
            setSelectedProfileId(saved.id);
            setProfileForm(profileToForm(saved));
            setViewMode("workspace");
            return saved;
        } catch (err) {
            setBuildError((err as Error).message);
            return null;
        } finally {
            setIsSavingProfile(false);
        }
    }, [handleDeleteProfile, loadProfiles, profiles]);

    const handleApplyAgentProposal = useCallback(async (proposal: CTEGraphProfileAssistantResponse) => {
        await persistAgentProposal(proposal);
    }, [persistAgentProposal]);

    const handleApplyAndGenerateAgentProposal = useCallback(async (proposal: CTEGraphProfileAssistantResponse) => {
        const saved = await persistAgentProposal(proposal);
        if (!saved) return;
        await handleGenerateProfileGraph(saved.id, { refreshGraph: true });
    }, [handleGenerateProfileGraph, persistAgentProposal]);

    const handleCreateProfile = useCallback(async () => {
        const skill = newProfileSkill.trim();
        const name = newProfileName.trim() || skill;
        if (!skill) {
            setBuildError("Un graphe CTE doit être associé à un skill (SKILL.md).");
            return;
        }
        setIsCreatingProfile(true);
        setBuildError(null);
        try {
            const created = await createCteGraphProfile({
                name,
                skill,
                description: newProfileDescription.trim(),
            });
            await loadProfiles();
            setSelectedProfileId(created.id);
            setProfileForm(profileToForm(created));
            setShowCreateProfileForm(false);
            setNewProfileName("");
            setNewProfileId("");
            setNewProfileDescription("");
            setNewProfileSkill("");
            setViewMode("workspace");
        } catch (err) {
            setBuildError((err as Error).message);
        } finally {
            setIsCreatingProfile(false);
        }
    }, [loadProfiles, newProfileDescription, newProfileName, newProfileSkill]);

    const handlePruneEmpty = useCallback(async () => {
        if (!window.confirm("Supprimer tous les graphes CTE sans aucune CTE ?")) return;
        setIsPruning(true);
        setBuildError(null);
        try {
            await pruneEmptyCteGraphProfiles();
            await loadProfiles();
        } catch (err) {
            setBuildError((err as Error).message);
        } finally {
            setIsPruning(false);
        }
    }, [loadProfiles]);

    const resolvedGraphLayoutMode = useMemo<Exclude<GraphLayoutMode, "smart">>(() => {
        if (!graph) return "flow";
        return resolveGraphLayoutMode(graphLayoutMode, graph);
    }, [graph, graphLayoutMode]);

    const rebuildFlow = useCallback(
        (
            currentGraph: CTEReactFlowGraph | null,
            highlights: { nodes: Set<string>; edgeKeys: Set<string> } = {
                nodes: new Set(),
                edgeKeys: new Set(),
            },
            shortestPath: { nodes: Set<string>; edgeKeys: Set<string> } = {
                nodes: new Set(),
                edgeKeys: new Set(),
            },
            selected: string | null = null,
            roots: Set<string> = new Set(),
            leaves: Set<string> = new Set(),
        ) => {
            if (!currentGraph) {
                setNodes([]);
                setEdges([]);
                return;
            }

            const positions = positionsRef.current.size === currentGraph.nodes.length
                ? positionsRef.current
                : computePositionsForLayout(currentGraph, graphLayoutMode);
            positionsRef.current = positions;

            const nextNodes: Node<RFNodeData>[] = currentGraph.nodes.map((n) => {
                const pos = positions.get(n.id) ?? { x: 0, y: 0 };
                const data = n.data as CTEReactFlowNodeData;
                return {
                    id: n.id,
                    type: "default",
                    position: pos,
                    data: {
                        name: data.name,
                        description: data.description,
                        rawSql: data.rawSql,
                        parents: data.parents,
                        children: data.children,
                        library: data.library || "",
                        parameters: data.parameters || [],
                        projects: data.projects || [],
                        isRoot: roots.has(n.id),
                        isLeaf: leaves.has(n.id),
                        isHighlighted: highlights.nodes.has(n.id),
                        isOnShortestPath: shortestPath.nodes.has(n.id),
                        isSelected: selected === n.id,
                    },
                };
            });

            const nextEdges: Edge[] = currentGraph.edges.map((e) => {
                const key = `${e.source}__${e.target}`;
                const onShortest = shortestPath.edgeKeys.has(key);
                const onHighlight = highlights.edgeKeys.has(key);
                return {
                    id: e.id,
                    source: e.source,
                    target: e.target,
                    label: e.label || undefined,
                    animated: onShortest,
                    style: {
                        stroke: onShortest ? "#0D7377" : onHighlight ? "#E8725A" : "#A09E99",
                        strokeWidth: onShortest ? 2.5 : onHighlight ? 2 : 1.2,
                    },
                    markerEnd: {
                        type: MarkerType.ArrowClosed,
                        color: onShortest ? "#0D7377" : onHighlight ? "#E8725A" : "#A09E99",
                    },
                };
            });

            setNodes(nextNodes);
            setEdges(nextEdges);
        },
        [graphLayoutMode, setNodes, setEdges],
    );

    const rootSet = useMemo(() => new Set(graphMeta?.roots || []), [graphMeta]);
    const leafSet = useMemo(() => new Set(graphMeta?.leaves || []), [graphMeta]);

    useEffect(() => {
        if (!graph) return;
        const highlights = {
            nodes: new Set<string>([
                ...(parentPaths?.highlight.nodes || []),
                ...semanticHighlightedNodeIds,
            ]),
            edgeKeys: new Set<string>(
                (parentPaths?.highlight.edges || []).map((e) => `${e.source}__${e.target}`),
            ),
        };
        const shortest = {
            nodes: new Set<string>(parentPaths?.shortest_path || []),
            edgeKeys: new Set<string>(),
        };
        const sp = parentPaths?.shortest_path || [];
        for (let i = 0; i < sp.length - 1; i += 1) {
            shortest.edgeKeys.add(`${sp[i]}__${sp[i + 1]}`);
        }
        rebuildFlow(graph, highlights, shortest, selectedNodeId, rootSet, leafSet);
    }, [graph, parentPaths, semanticHighlightedNodeIds, selectedNodeId, rootSet, leafSet, rebuildFlow]);

    const handleSearch = useCallback(async () => {
        if (!graphId || !searchQuery.trim()) return;
        setIsSearching(true);
        try {
            const hits = await searchCteGraph(graphId, searchQuery, 5);
            setSearchResults(hits);
            setSemanticHighlightedNodeIds(hits.map((hit) => hit.node_id));
        } catch (err) {
            setBuildError((err as Error).message);
        } finally {
            setIsSearching(false);
        }
    }, [graphId, searchQuery]);

    const fetchParentPaths = useCallback(
        async (nodeId: string) => {
            if (!graphId) return;
            setIsLoadingPaths(true);
            try {
                const data = await getCteParentPaths(graphId, nodeId);
                setParentPaths(data);
            } catch (err) {
                setBuildError((err as Error).message);
                setParentPaths(null);
            } finally {
                setIsLoadingPaths(false);
            }
        },
        [graphId],
    );

    const handleSelectNode = useCallback(
        (nodeId: string) => {
            setSelectedNodeId(nodeId);
            void fetchParentPaths(nodeId);
        },
        [fetchParentPaths],
    );

    const handleClearSelection = useCallback(() => {
        setSelectedNodeId(null);
        setParentPaths(null);
    }, []);

    const handleConversationSubmit = useCallback(async () => {
        if (!graphId || !conversationQuery.trim()) return;
        const prompt = conversationQuery.trim();
        const parquetPaths = {
            ...(ledgerParquetPath ? { ledger: ledgerParquetPath } : {}),
            ...(balanceParquetPath ? { balance: balanceParquetPath } : {}),
        };

        setConversationMessages((prev) => [
            ...prev,
            { id: `user-${Date.now()}`, role: "user", content: prompt },
        ]);
        setConversationQuery("");
        setIsRunningConversation(true);
        setBuildError(null);

        try {
            const result = await runCteGraphQuery({
                graphId,
                query: prompt,
                parquetPaths,
                topK: 6,
                maxRows: 50,
            });
            setSearchResults(result.search_hits);
            setSemanticHighlightedNodeIds(result.matched_nodes);
            setSelectedNodeId(result.selected_node);
            setParentPaths(result.parent_paths);
            setConversationMessages((prev) => [
                ...prev,
                {
                    id: `assistant-${Date.now()}`,
                    role: "assistant",
                    content: assistantSummary(result),
                    result,
                },
            ]);
        } catch (err) {
            const message = (err as Error).message;
            setBuildError(message);
            setConversationMessages((prev) => [
                ...prev,
                {
                    id: `assistant-error-${Date.now()}`,
                    role: "assistant",
                    content: message,
                    error: message,
                },
            ]);
        } finally {
            setIsRunningConversation(false);
        }
    }, [balanceParquetPath, conversationQuery, graphId, ledgerParquetPath]);

    const selectedNodeDetails = useMemo(() => {
        if (!graph || !selectedNodeId) return null;
        return graph.nodes.find((n) => n.id === selectedNodeId) ?? null;
    }, [graph, selectedNodeId]);

    const libraryBreakdown = useMemo(() => {
        if (!graph) return [] as { library: string; count: number }[];
        const counts = new Map<string, number>();
        for (const node of graph.nodes) {
            const lib = (node.data as CTEReactFlowNodeData).library || "—";
            counts.set(lib, (counts.get(lib) || 0) + 1);
        }
        return [...counts.entries()].map(([library, count]) => ({ library, count })).sort(
            (a, b) => b.count - a.count,
        );
    }, [graph]);

    const ledgerOptions = useMemo(
        () => parquetOptions.filter((file) => parquetMatchesRole(file, "ledger")),
        [parquetOptions],
    );
    const balanceOptions = useMemo(
        () => parquetOptions.filter((file) => parquetMatchesRole(file, "balance")),
        [parquetOptions],
    );

    return (
        <div className="space-y-5">
            <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2.5 min-w-0">
                    <div className="h-9 w-9 rounded-lg bg-[#0D7377]/10 flex items-center justify-center text-[#0D7377] shrink-0">
                        <Network className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                        <h3 className="settings-display text-lg leading-tight text-[#2B2B2B]">
                            Graphe CTE (reporting)
                        </h3>
                        <p className="text-[11px] text-[#6B6966] leading-snug mt-1">
                            1 carte = 1 dossier <span className="font-mono">data/reporting/sql/&lt;nom&gt;/</span> avec{" "}
                            <span className="font-mono">index.yaml</span>. Le schéma est généré côté serveur à l’ouverture
                            d’un profil.
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() => void loadProfiles()}
                        disabled={isLoadingProfiles}
                        className="rounded-xl border-[#E8E6E1] bg-white text-[#2B2B2B] gap-2"
                    >
                        {isLoadingProfiles ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <RefreshCw className="h-4 w-4" />
                        )}
                        Actualiser le catalogue
                    </Button>
                    {viewMode === "catalog" ? (
                        <>
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => void handlePruneEmpty()}
                                disabled={isPruning}
                                title="Supprime les graphes CTE sans aucune CTE."
                                className="rounded-xl border-[#E8725A]/30 bg-white text-[#A04A36] gap-2 hover:bg-[#FFF5F2]"
                            >
                                {isPruning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                                Supprimer les graphes vides
                            </Button>
                            <Button
                                type="button"
                                onClick={() => setShowCreateProfileForm((prev) => !prev)}
                                className="rounded-xl bg-[#0D7377] hover:bg-[#0B6164] text-white gap-2"
                            >
                                <Sparkles className="h-4 w-4" />
                                Créer un graphe
                            </Button>
                        </>
                    ) : null}
                    {viewMode === "workspace" && selectedProfile ? (
                        <>
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => void handleGenerateProfileGraph(selectedProfile.id)}
                                disabled={isBuilding || generatingProfileId === selectedProfile.id}
                                className="rounded-xl border-[#0D7377]/35 bg-white text-[#0D7377] gap-2 shrink-0"
                            >
                                {generatingProfileId === selectedProfile.id ? (
                                    <>
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                        Génération…
                                    </>
                                ) : (
                                    <>
                                        <Sparkles className="h-4 w-4" />
                                        Générer le graph
                                    </>
                                )}
                            </Button>
                            <Button
                                onClick={() => void buildLibrary({ force: true })}
                                disabled={isBuilding || generatingProfileId === selectedProfile.id}
                                className="rounded-xl bg-[#0D7377] hover:bg-[#0B6164] text-white font-semibold gap-2 shrink-0"
                            >
                                {isBuilding ? (
                                    <>
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                        Construction…
                                    </>
                                ) : (
                                    <>
                                        <RefreshCw className="h-4 w-4" />
                                        Reconstruire le schéma CTE
                                    </>
                                )}
                            </Button>
                        </>
                    ) : null}
                </div>
            </div>

            {buildError && (
                <div className="rounded-lg border border-[#E8725A]/40 bg-[#E8725A]/10 px-4 py-3 text-[12px] text-[#A04A36] flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                    <div>
                        <p className="font-semibold mb-0.5">Erreur de chargement</p>
                        <p className="font-mono text-[11px] leading-snug break-all">{buildError}</p>
                    </div>
                </div>
            )}

            {catalogGenerateMessage && (
                <div className="rounded-lg border border-[#C5E8EA] bg-[#F2FBFB] px-4 py-3 text-[12px] text-[#2B2B2B] flex items-start gap-2">
                    <Sparkles className="h-4 w-4 mt-0.5 shrink-0 text-[#0D7377]" />
                    <p className="font-mono text-[11px] leading-snug break-words flex-1">{catalogGenerateMessage}</p>
                </div>
            )}

            {viewMode === "catalog" ? (
                <div className="space-y-4">
                    <div>
                        <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#A09E99]">
                            Catalogue
                        </p>
                        <p className="text-[12px] text-[#6B6966] leading-snug mt-1">
                            <strong>Actualiser</strong> si vous avez ajouté un dossier sur l’agent. <strong>Ouvrir</strong> un
                            profil : génération du graph, édition, schéma.
                        </p>
                    </div>

                    {showCreateProfileForm && (
                        <Card className="p-5 border-[#E8E6E1] bg-white shadow-none">
                            <div className="flex items-start justify-between gap-4">
                                <div>
                                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                                        Nouveau graphe
                                    </p>
                                    <h4 className="text-base font-semibold text-[#2B2B2B] mt-1">
                                        Créer un dossier CTE et son profil
                                    </h4>
                                    <p className="mt-2 text-[12px] text-[#6B6966] leading-snug">
                                        Cela crée <span className="font-mono">data/reporting/sql/&lt;id&gt;/index.yaml</span>,
                                        puis ouvre le workspace du graphe pour l’éditer.
                                    </p>
                                </div>
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => setShowCreateProfileForm(false)}
                                    className="rounded-xl border-[#E8E6E1] bg-white text-[#2B2B2B]"
                                >
                                    <X className="h-4 w-4" />
                                </Button>
                            </div>

                            <div className="mt-4 grid gap-4 md:grid-cols-2">
                                <label className="space-y-1.5">
                                    <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                                        Nom du graphe
                                    </span>
                                    <Input
                                        value={newProfileName}
                                        onChange={(event) => setNewProfileName(event.target.value)}
                                        placeholder="Ex: Analyse Finance Maroc"
                                        className="border-[#E8E6E1] bg-[#F8F7F4]"
                                    />
                                </label>
                                <label className="space-y-1.5">
                                    <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                                        Skill associé (SKILL.md) *
                                    </span>
                                    <select
                                        value={newProfileSkill}
                                        onChange={(event) => {
                                            setNewProfileSkill(event.target.value);
                                            if (!newProfileName.trim()) setNewProfileName(event.target.value);
                                        }}
                                        className="w-full rounded-xl border border-[#E8E6E1] bg-[#F8F7F4] px-3 py-2 text-sm text-[#2B2B2B] outline-none"
                                    >
                                        <option value="">— Choisir un skill —</option>
                                        {skills.map((sk) => (
                                            <option key={sk.directory_name} value={sk.name || sk.directory_name}>
                                                {sk.name || sk.directory_name}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <label className="space-y-1.5 md:col-span-2">
                                    <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                                        Description
                                    </span>
                                    <Textarea
                                        value={newProfileDescription}
                                        onChange={(event) => setNewProfileDescription(event.target.value)}
                                        placeholder="Décrivez le périmètre métier et le rôle de ce graphe CTE."
                                        className="min-h-[92px] border-[#E8E6E1] bg-[#F8F7F4] resize-none"
                                    />
                                </label>
                            </div>

                            <div className="mt-4 flex flex-wrap items-center gap-3">
                                <Button
                                    type="button"
                                    onClick={() => void handleCreateProfile()}
                                    disabled={isCreatingProfile || !newProfileSkill.trim()}
                                    className="rounded-xl bg-[#0D7377] hover:bg-[#0B6164] text-white gap-2"
                                >
                                    {isCreatingProfile ? (
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                    ) : (
                                        <Sparkles className="h-4 w-4" />
                                    )}
                                    Créer et ouvrir
                                </Button>
                                <span className="text-[11px] text-[#A09E99]">
                                    Le graphe sera lié au skill choisi (<span className="font-mono">cte-prof-&lt;skill&gt;</span>).
                                </span>
                            </div>
                        </Card>
                    )}

                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                        {profiles.filter((profile) => (profile.cte_count ?? 0) > 0).map((profile) => (
                            <button
                                key={profile.id}
                                type="button"
                                onClick={() => {
                                    setSelectedProfileId(profile.id);
                                    setViewMode("workspace");
                                }}
                                className="rounded-3xl border border-[#E8E6E1] bg-white p-5 text-left shadow-none transition-all hover:border-[#0D7377]/35 hover:shadow-sm w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0D7377]/30"
                            >
                                <div className="flex items-start justify-between gap-3">
                                    <div className="h-11 w-11 rounded-2xl bg-[#0D7377]/10 flex items-center justify-center text-[#0D7377] shrink-0">
                                        <Network className="h-5 w-5" />
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span className="rounded-full bg-[#0D7377]/10 px-2 py-0.5 text-[10px] font-bold text-[#0D7377]">
                                            {profile.cte_count ?? 0} CTE
                                        </span>
                                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#0D7377]">
                                            <PencilLine className="h-3 w-3" />
                                            Ouvrir
                                        </span>
                                    </div>
                                </div>
                                <h5 className="mt-4 text-base font-semibold text-[#2B2B2B]">
                                    {profile.name}
                                </h5>
                                {profile.skill && (
                                    <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-[#0D7377]/8 px-2 py-0.5 text-[10px] font-semibold text-[#0D7377]" title="Skill associé (SKILL.md)">
                                        <Sparkles className="h-3 w-3" /> {profile.skill}
                                    </span>
                                )}
                                {profile.graph_id ? (
                                    <p
                                        className="mt-1 text-[10px] text-[#5A8A8D] font-mono truncate"
                                        title={profile.graph_id}
                                    >
                                        Schéma : {profile.graph_id}
                                    </p>
                                ) : null}
                                <p className="mt-2 text-[12px] leading-relaxed text-[#6B6966]">
                                    {profile.description || "Sans description métier pour le moment."}
                                </p>
                            </button>
                        ))}
                    </div>

                    {profiles.length === 0 && !isLoadingProfiles && (
                        <Card className="p-8 border-[#E8E6E1] bg-white shadow-none text-center">
                            <p className="text-sm font-semibold text-[#2B2B2B]">
                                Aucun graphe déclaré
                            </p>
                            <p className="mt-1 text-[12px] text-[#6B6966]">
                                Créez un graphe depuis ce catalogue, ou ajoutez manuellement un dossier{" "}
                                <span className="font-mono">qclick-agent/data/reporting/sql/&lt;nom&gt;/</span> avec un fichier{" "}
                                <span className="font-mono">index.yaml</span> et des <span className="font-mono">*.sql</span>,
                                puis rechargez le catalogue.
                            </p>
                        </Card>
                    )}
                </div>
            ) : (
                <div className="space-y-6">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => setViewMode("catalog")}
                            className="rounded-xl border-[#E8E6E1] bg-white text-[#2B2B2B] gap-2"
                        >
                            <ArrowLeft className="h-4 w-4" />
                            Retour aux graphes
                        </Button>
                        {/* Tabs: graph infos ↔ CTE visualisation */}
                        <div className="flex gap-1 rounded-xl border border-[#E8E6E1] bg-[#F0EFEC] p-1">
                            <button
                                type="button"
                                onClick={() => setWorkspaceTab("infos")}
                                className={cn(
                                    "flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-[12px] font-semibold transition-colors",
                                    workspaceTab === "infos" ? "bg-white text-[#2B2B2B] shadow-sm" : "text-[#A09E99] hover:text-[#2B2B2B]",
                                )}
                            >
                                <FilePenLine className="h-3.5 w-3.5" /> Infos du graphe
                            </button>
                            <button
                                type="button"
                                onClick={() => setWorkspaceTab("graph")}
                                className={cn(
                                    "flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-[12px] font-semibold transition-colors",
                                    workspaceTab === "graph" ? "bg-white text-[#2B2B2B] shadow-sm" : "text-[#A09E99] hover:text-[#2B2B2B]",
                                )}
                            >
                                <Network className="h-3.5 w-3.5" /> Visualisation CTE
                            </button>
                        </div>
                    </div>

                    {workspaceTab === "infos" && (
                    <div className="space-y-6">
                    <Card className="p-4 border-[#E8E6E1] bg-white shadow-none">
                        {/* Compact header */}
                        <div className="flex items-center gap-2.5">
                            <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-[#0D7377]/10 text-[#0D7377]">
                                <FilePenLine className="h-3.5 w-3.5" />
                            </div>
                            <h4 className="text-sm font-semibold text-[#2B2B2B]">Modifier le profil CTE</h4>
                            {profileForm.id ? (
                                <button
                                    type="button"
                                    title={`Supprimer le dossier data/reporting/sql/${profileForm.id}/ sur le serveur.`}
                                    onClick={() => void handleDeleteProfile(profileForm.id)}
                                    disabled={isDeletingProfile}
                                    className="ml-auto flex h-7 items-center gap-1 rounded-md border border-[#E8725A]/30 px-2 text-[11px] font-medium text-[#A04A36] transition-colors hover:bg-[#FFF5F2] disabled:opacity-50"
                                >
                                    {isDeletingProfile ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                                    Supprimer
                                </button>
                            ) : null}
                        </div>

                        {/* Single context ribbon — Skill · DTO · graphe */}
                        <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border border-[#E8E6E1] bg-[#F8F7F4] px-2.5 py-2 text-[11px]">
                            <span className="flex items-center gap-1 font-semibold uppercase tracking-wider text-[#A09E99]">
                                <Sparkles className="h-3 w-3 text-[#0D7377]" />Skill
                            </span>
                            {linkedSkills.length ? (
                                linkedSkills.map((sk) => (
                                    <span key={sk.directory_name} title={`prompts/skills/${sk.directory_name}/SKILL.md`} className="rounded bg-[#0D7377]/10 px-1.5 py-0.5 font-semibold text-[#0D7377]">
                                        {sk.name || sk.directory_name}
                                    </span>
                                ))
                            ) : (
                                <span className="rounded bg-[#E8725A]/10 px-1.5 py-0.5 font-medium text-[#A04A36]">orphelin (aucun skill)</span>
                            )}
                            {linkedSkills[0] && (
                                <span className="font-mono text-[10px] text-[#A09E99]" title="SKILL.md associé">
                                    · prompts/skills/{linkedSkills[0].directory_name}/SKILL.md
                                </span>
                            )}
                            {profileForm.libraries[0] && (
                                <span className="ml-auto font-mono text-[10px] text-[#A09E99]" title="Graphe pickle data/cte_graphs/">
                                    cte-prof-{(profileForm.libraries[0] || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}
                                </span>
                            )}
                        </div>

                        <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
                            <label className="space-y-1.5">
                                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                                    Nom du graphe
                                </span>
                                <Input
                                    value={profileForm.name}
                                    onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                                        setProfileForm((prev) => ({ ...prev, name: event.target.value }))
                                    }
                                    placeholder="Ex: Finance comptable Maroc"
                                    className="border-[#E8E6E1] bg-[#F8F7F4]"
                                />
                            </label>

                            <label className="space-y-1.5 lg:col-span-2">
                                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                                    Description
                                </span>
                                <Textarea
                                    value={profileForm.description}
                                    onChange={(event) =>
                                        setProfileForm((prev) => ({ ...prev, description: event.target.value }))
                                    }
                                    placeholder="Scope métier, questions adressées, rôle de ce graphe CTE."
                                    className="min-h-[60px] border-[#E8E6E1] bg-[#F8F7F4] resize-none"
                                />
                            </label>

                            {/* Classe DTO — read-only (déterminée par le skill, cf. le bandeau ci-dessus). */}
                            <div className="space-y-1.5 lg:col-span-2">
                                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                                    Classe DTO (structure des colonnes)
                                </span>
                                <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-[#E8E6E1] bg-[#F8F7F4] px-3 py-2">
                                    {usedDtos.length ? (
                                        usedDtos.map((d) => (
                                            <span
                                                key={d}
                                                title={`data/classes/dtos/${d}_dto.py`}
                                                className="rounded-full border border-[#E8E6E1] bg-white px-2.5 py-1 font-mono text-[11px] text-[#2B2B2B]"
                                            >
                                                {d}_dto
                                            </span>
                                        ))
                                    ) : (
                                        <span className="text-[12px] text-[#6B6966]">
                                            Déterminée par le skill — aucune classe DTO résolue.
                                        </span>
                                    )}
                                    <span className="text-[10px] text-[#A09E99]">— aligne les projections CTE sur les colonnes réelles.</span>
                                </div>
                            </div>
                        </div>

                        <div className="mt-3 flex items-center justify-end">
                            <Button
                                type="button"
                                onClick={() => void handleSaveProfile()}
                                disabled={isSavingProfile || !profileForm.name.trim() || !profileForm.id}
                                className="rounded-xl bg-[#0D7377] hover:bg-[#0B6164] text-white gap-2"
                            >
                                {isSavingProfile ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <FilePenLine className="h-4 w-4" />
                                )}
                                Enregistrer
                            </Button>
                        </div>
                    </Card>

                    {selectedProfile && graphMeta && !buildError && (
                        <Card className="p-4 border-[#E8E6E1] bg-white shadow-none">
                            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[12px]">
                                <p className="flex items-center gap-1.5 font-semibold text-[#0D7377]">
                                    <CheckCircle2 className="h-3.5 w-3.5" />
                                    Graphe {graphMeta.graph_id.slice(0, 8)}…
                                </p>
                                <span className="text-[#6B6966]">
                                    <span className="font-semibold text-[#2B2B2B]">{graphMeta.node_count}</span> CTE
                                </span>
                                <span className="text-[#6B6966]">
                                    <span className="font-semibold text-[#2B2B2B]">{graphMeta.edge_count}</span> dépendances
                                </span>
                                <span className="text-[#6B6966]">
                                    <span className="font-semibold text-[#2B2B2B]">{graphMeta.roots.length}</span> racine(s)
                                </span>
                                <span className="text-[#6B6966]">
                                    <span className="font-semibold text-[#2B2B2B]">{graphMeta.leaves.length}</span> feuille(s)
                                </span>
                                {libraryBreakdown.map(({ library, count }) => {
                                    const accent = accentForLibrary(library);
                                    return (
                                        <span
                                            key={library}
                                            className={cn(
                                                "rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                                                accent.chip,
                                            )}
                                        >
                                            {library} · {count}
                                        </span>
                                    );
                                })}
                            </div>
                        </Card>
                    )}

                    <Card className="p-0 border-[#E8E6E1] bg-white shadow-none overflow-hidden">
                        <div className="border-b border-[#E8E6E1] px-5 py-4">
                            <div className="flex items-center gap-2">
                                <Bot className="h-4 w-4 text-[#0D7377]" />
                                <h4 className="text-sm font-semibold text-[#2B2B2B]">
                                    Agent édition de graphe CTE
                                </h4>
                            </div>
                            <p className="mt-1 text-[12px] leading-relaxed text-[#6B6966]">
                                {profileForm.id
                                    ? "L’agent est spécialisé dans la création des CTE et du graphe actif. S’il manque du contexte, il pose des questions ciblées ; quand le périmètre est suffisant, il propose d’enregistrer puis de générer les CTE."
                                    : "Décrivez le graphe à créer, les calculs attendus et les DTO/parquets à utiliser. L’agent demandera les précisions manquantes avant de proposer la création des CTE."}
                            </p>
                        </div>
                        <ScrollArea className="h-[220px] border-b border-[#E8E6E1]">
                            <div className="space-y-3 p-5">
                                {profileAgentMessages.map((message) => (
                                    <div
                                        key={message.id}
                                        className={cn(
                                            "rounded-2xl border px-4 py-3",
                                            message.role === "user"
                                                ? "border-[#0D7377]/20 bg-[#0D7377]/6"
                                                : message.error
                                                    ? "border-[#E8725A]/30 bg-[#E8725A]/8"
                                                    : "border-[#E8E6E1] bg-white",
                                        )}
                                    >
                                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                                            {message.role === "user" ? "Vous" : "Agent"}
                                        </p>
                                        <p className="mt-2 text-sm leading-relaxed text-[#2B2B2B] whitespace-pre-line">
                                            {message.content}
                                        </p>
                                        {Boolean(message.proposal?.follow_up_questions?.length) && (
                                            <div className="mt-3 rounded-xl border border-[#E8E6E1] bg-[#F8F7F4] px-3 py-2.5">
                                                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                                                    Questions à préciser
                                                </p>
                                                <ul className="mt-2 space-y-1.5 text-[12px] leading-relaxed text-[#2B2B2B]">
                                                    {message.proposal!.follow_up_questions!.map((question) => (
                                                        <li key={question} className="flex gap-2">
                                                            <span className="mt-[2px] text-[#0D7377]">•</span>
                                                            <span>{question}</span>
                                                        </li>
                                                    ))}
                                                </ul>
                                            </div>
                                        )}
                                        {message.proposal && message.proposal.operation !== "none" && (
                                            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#E8E6E1] bg-[#F8F7F4] px-3 py-2">
                                                <div className="text-[11px] text-[#6B6966]">
                                                    Action proposée: <span className="font-semibold text-[#2B2B2B]">{message.proposal.operation}</span>
                                                    {message.proposal.ready_to_generate && (
                                                        <span className="ml-2 rounded-full bg-[#0D7377]/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#0D7377]">
                                                            Prêt à générer
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <Button
                                                        type="button"
                                                        variant="outline"
                                                        onClick={() => void handleApplyAgentProposal(message.proposal!)}
                                                        className="rounded-xl border-[#0D7377]/25 bg-white text-[#0D7377]"
                                                    >
                                                        Appliquer
                                                    </Button>
                                                    {message.proposal.ready_to_generate && message.proposal.draft_profile && (
                                                        <Button
                                                            type="button"
                                                            onClick={() => void handleApplyAndGenerateAgentProposal(message.proposal!)}
                                                            className="rounded-xl bg-[#0D7377] hover:bg-[#0B6164] text-white"
                                                        >
                                                            Enregistrer + Générer
                                                        </Button>
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                ))}
                                {profileAgentMessages.length === 0 && (
                                    <div className="rounded-2xl border border-dashed border-[#D9D5CD] bg-[#F8F7F4] px-4 py-6 text-center">
                                        <p className="text-[12px] text-[#6B6966]">
                                            Utilisez ce chat pour cadrer le graphe, préciser les DTO, puis laisser l’agent préparer la création des CTE.
                                        </p>
                                    </div>
                                )}
                            </div>
                        </ScrollArea>
                        <div className="p-5">
                            <div className="flex gap-3">
                                <Textarea
                                    value={profileAgentInput}
                                    onChange={(event) => setProfileAgentInput(event.target.value)}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                                            event.preventDefault();
                                            void handleProfileAgentSubmit();
                                        }
                                    }}
                                    placeholder="Ex: je veux un graphe qui calcule Solde, Solde_N1 et variation mensuelle à partir de ledger et balance."
                                    className="min-h-[92px] border-[#E8E6E1] bg-[#F8F7F4] resize-none"
                                />
                                <Button
                                    type="button"
                                    onClick={() => void handleProfileAgentSubmit()}
                                    disabled={!profileAgentInput.trim() || isRunningProfileAgent}
                                    className="h-auto min-w-[56px] rounded-2xl bg-[#0D7377] hover:bg-[#0B6164] text-white"
                                >
                                    {isRunningProfileAgent ? (
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                    ) : (
                                        <Send className="h-4 w-4" />
                                    )}
                                </Button>
                            </div>
                        </div>
                    </Card>
                    </div>
                    )}
                </div>
            )}

            {viewMode === "workspace" && selectedProfile && workspaceTab === "graph" && (
                <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
                    <GraphCanvas
                        graph={graph}
                        nodes={nodes}
                        edges={edges}
                        isBuilding={isBuilding}
                        layoutMode={graphLayoutMode}
                        resolvedLayoutMode={resolvedGraphLayoutMode}
                        onLayoutChange={setGraphLayoutMode}
                        onNodesChange={onNodesChange}
                        onEdgesChange={onEdgesChange}
                        onSelectNode={handleSelectNode}
                        onClearSelection={handleClearSelection}
                        heightClassName="h-[min(68vh,700px)]"
                    />

                    <ScrollArea className="w-full xl:max-h-[min(82vh,900px)]">
                        <div className="space-y-4 pr-3 pb-2">
                        <Card className="p-4 border-[#E8E6E1] bg-white shadow-none space-y-3">
                            <div className="flex items-center gap-2">
                                <Search className="h-4 w-4 text-[#0D7377]" />
                                <h4 className="text-sm font-semibold text-[#2B2B2B]">Recherche sémantique</h4>
                            </div>
                            <div className="flex gap-2">
                                <Input
                                    value={searchQuery}
                                    onChange={(event: React.ChangeEvent<HTMLInputElement>) => setSearchQuery(event.target.value)}
                                    onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
                                        if (event.key === "Enter") handleSearch();
                                    }}
                                    placeholder="Décrivez le concept à retrouver…"
                                    disabled={!graphId}
                                    className="border-[#E8E6E1] bg-[#F8F7F4]"
                                />
                                <Button
                                    onClick={handleSearch}
                                    disabled={!graphId || !searchQuery.trim() || isSearching}
                                    className="rounded-xl bg-[#0D7377] hover:bg-[#0B6164] text-white"
                                >
                                    {isSearching ? (
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                    ) : (
                                        <Search className="h-4 w-4" />
                                    )}
                                </Button>
                            </div>
                            {searchResults.length > 0 && (
                                <ScrollArea className="h-44 -mx-1">
                                    <div className="px-1 space-y-1.5">
                                        {searchResults.map((hit) => (
                                            <button
                                                key={hit.node_id}
                                                type="button"
                                                onClick={() => handleSelectNode(hit.node_id)}
                                                className={cn(
                                                    "w-full text-left rounded-lg border px-3 py-2 transition-all",
                                                    selectedNodeId === hit.node_id
                                                        ? "border-[#0D7377] bg-[#0D7377]/8"
                                                        : "border-[#E8E6E1] bg-[#F8F7F4] hover:border-[#0D7377]/40",
                                                )}
                                            >
                                                <div className="flex items-center justify-between gap-2">
                                                    <span className="text-[12px] font-semibold text-[#2B2B2B] truncate">
                                                        {hit.name}
                                                    </span>
                                                    <span className="text-[10px] font-bold uppercase tracking-wider text-[#0D7377]">
                                                        {(hit.similarity_score * 100).toFixed(0)}%
                                                    </span>
                                                </div>
                                                {hit.description && (
                                                    <p className="text-[11px] text-[#6B6966] mt-0.5 line-clamp-2">
                                                        {hit.description}
                                                    </p>
                                                )}
                                            </button>
                                        ))}
                                    </div>
                                </ScrollArea>
                            )}
                        </Card>

                        {selectedNodeDetails && (() => {
                            const data = selectedNodeDetails.data as CTEReactFlowNodeData;
                            const accent = accentForLibrary(data.library);
                            return (
                                <Card className="p-4 border-[#E8E6E1] bg-white shadow-none space-y-3">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <Route className="h-4 w-4 text-[#0D7377]" />
                                        <h4 className="text-sm font-semibold text-[#2B2B2B] truncate">
                                            {data.name}
                                        </h4>
                                        {data.library && (
                                            <span
                                                className={cn(
                                                    "rounded-md px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider",
                                                    accent.chip,
                                                )}
                                            >
                                                {data.library}
                                            </span>
                                        )}
                                    </div>
                                    <p className="text-[11px] font-semibold uppercase tracking-wider text-[#A09E99]">
                                        {data.parents.length} parent(s) · {data.children.length} enfant(s)
                                    </p>
                                    {data.description && (
                                        <p className="text-[12px] text-[#6B6966] leading-relaxed whitespace-pre-line">
                                            {data.description}
                                        </p>
                                    )}

                                    {(data.parameters?.length || 0) > 0 && (
                                        <div>
                                            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#A09E99] mb-1.5">
                                                Paramètres
                                            </p>
                                            <div className="flex flex-wrap gap-1.5">
                                                {data.parameters!.map((param) => (
                                                    <span
                                                        key={param}
                                                        className="rounded-full bg-[#E8725A]/15 text-[#E8725A] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
                                                    >
                                                        ${param}
                                                    </span>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {(data.projects?.length || 0) > 0 && (
                                        <div>
                                            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#A09E99] mb-1.5">
                                                Colonnes projetées
                                            </p>
                                            <div className="flex flex-wrap gap-1.5">
                                                {data.projects!.map((col) => (
                                                    <span
                                                        key={col}
                                                        className="rounded-md bg-[#F8F7F4] border border-[#E8E6E1] px-1.5 py-0.5 text-[10px] font-mono text-[#2B2B2B]"
                                                    >
                                                        {col}
                                                    </span>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    <details className="rounded-lg border border-[#E8E6E1] bg-[#F8F7F4]">
                                        <summary className="cursor-pointer px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-[#0D7377]">
                                            Bloc SQL brut
                                        </summary>
                                        <pre className="px-3 pb-3 text-[11px] text-[#2B2B2B] whitespace-pre-wrap font-mono leading-snug">
                                            {data.rawSql || "—"}
                                        </pre>
                                    </details>

                                    {isLoadingPaths ? (
                                        <div className="flex items-center gap-2 text-[12px] text-[#6B6966]">
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                            Calcul des chemins parents…
                                        </div>
                                    ) : parentPaths ? (
                                        <div className="space-y-3">
                                            <div>
                                                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#A09E99] mb-1.5">
                                                    Plus court chemin
                                                </p>
                                                <div className="flex flex-wrap items-center gap-1.5">
                                                    {parentPaths.shortest_path.length === 0 ? (
                                                        <span className="text-[12px] text-[#6B6966] italic">
                                                            Le noeud est lui-même une racine.
                                                        </span>
                                                    ) : (
                                                        parentPaths.shortest_path.map((nodeName, idx) => (
                                                            <React.Fragment key={`${nodeName}-${idx}`}>
                                                                <span className="rounded-md bg-[#0D7377]/10 px-2 py-0.5 text-[11px] font-semibold text-[#0D7377]">
                                                                    {nodeName}
                                                                </span>
                                                                {idx < parentPaths.shortest_path.length - 1 && (
                                                                    <span className="text-[#A09E99]">→</span>
                                                                )}
                                                            </React.Fragment>
                                                        ))
                                                    )}
                                                </div>
                                            </div>
                                            <div>
                                                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#A09E99] mb-1.5">
                                                    Tous les chemins ({parentPaths.all_parent_paths.length})
                                                </p>
                                                <ScrollArea className="max-h-44 -mx-1">
                                                    <ul className="px-1 space-y-1.5">
                                                        {parentPaths.all_parent_paths.length === 0 ? (
                                                            <li className="text-[12px] text-[#6B6966] italic">
                                                                Aucun ancêtre — racine.
                                                            </li>
                                                        ) : (
                                                            parentPaths.all_parent_paths.map((path, idx) => (
                                                                <li
                                                                    key={idx}
                                                                    className="rounded-md bg-[#F8F7F4] border border-[#E8E6E1] px-2 py-1 text-[11px] text-[#2B2B2B] font-mono"
                                                                >
                                                                    {path.join(" → ")}
                                                                </li>
                                                            ))
                                                        )}
                                                    </ul>
                                                </ScrollArea>
                                            </div>
                                        </div>
                                    ) : null}
                                </Card>
                            );
                        })()}

                        <Card className="p-4 border-[#E8E6E1] bg-white shadow-none space-y-3">
                            <div className="flex items-center gap-2">
                                <Database className="h-4 w-4 text-[#0D7377]" />
                                <h4 className="text-sm font-semibold text-[#2B2B2B]">Sources parquet</h4>
                            </div>
                            <p className="text-[11px] text-[#A09E99] -mt-2">
                                Déterminées automatiquement via le skill → classe DTO → ledger parquet. La période
                                (ex. <span className="font-mono">2025</span>, <span className="font-mono">2025-03</span>, plage)
                                est inférée par le backend depuis la question.
                            </p>

                            {/* Read-only — source resolved from the skill → DTO → parquet chain (not user-pickable). */}
                            <div className="space-y-1.5 rounded-xl border border-[#E8E6E1] bg-[#F8F7F4] p-3 text-[11px]">
                                <div className="flex items-baseline gap-2">
                                    <span className="w-[88px] flex-shrink-0 font-semibold uppercase tracking-[0.12em] text-[#A09E99]">Skill</span>
                                    <span className="min-w-0 font-semibold text-[#2B2B2B]">
                                        {linkedSkills.length ? linkedSkills.map((s) => s.name || s.directory_name).join(", ") : "— (graphe orphelin)"}
                                    </span>
                                </div>
                                <div className="flex items-baseline gap-2">
                                    <span className="w-[88px] flex-shrink-0 font-semibold uppercase tracking-[0.12em] text-[#A09E99]">Classe DTO</span>
                                    <span className="min-w-0 break-all font-mono text-[#2B2B2B]">
                                        {usedDtos.length ? usedDtos.map((d) => `${d}_dto`).join(", ") : "—"}
                                    </span>
                                </div>
                                <div className="flex items-baseline gap-2">
                                    <span className="w-[88px] flex-shrink-0 font-semibold uppercase tracking-[0.12em] text-[#A09E99]">Ledger</span>
                                    <span className="min-w-0 break-all font-mono text-[#2B2B2B]">
                                        {usedParquet.length ? usedParquet.join(", ") : "Auto-détection backend"}
                                    </span>
                                </div>
                            </div>

                            <div className="rounded-xl border border-[#E8E6E1] bg-[#F8F7F4] p-3">
                                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#A09E99] mb-2">
                                    Requête métier
                                </p>
                                <Textarea
                                    value={conversationQuery}
                                    onChange={(event) => setConversationQuery(event.target.value)}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                                            event.preventDefault();
                                            void handleConversationSubmit();
                                        }
                                    }}
                                    placeholder="Ex: montre-moi le total revenue 2025 et le chemin de calcul utilisé"
                                    className="min-h-[120px] border-[#E8E6E1] bg-white text-sm resize-none"
                                />
                                <div className="mt-3 flex items-center justify-between gap-3">
                                    <p className="text-[11px] text-[#A09E99]">
                                        Entrée rapide: <span className="font-mono">Ctrl/Cmd + Entrée</span>
                                    </p>
                                    <Button
                                        onClick={() => void handleConversationSubmit()}
                                        disabled={!graphId || !conversationQuery.trim() || isRunningConversation}
                                        className="rounded-xl bg-[#0D7377] hover:bg-[#0B6164] text-white gap-2"
                                    >
                                        {isRunningConversation ? (
                                            <>
                                                <Loader2 className="h-4 w-4 animate-spin" />
                                                Exécution…
                                            </>
                                        ) : (
                                            <>
                                                <Play className="h-4 w-4" />
                                                Interroger les CTE
                                            </>
                                        )}
                                    </Button>
                                </div>
                            </div>

                        </Card>

                        <Card className="p-0 border-[#E8E6E1] bg-white shadow-none overflow-hidden">
                            <div className="flex items-center justify-between gap-3 border-b border-[#E8E6E1] px-4 py-3">
                                <div className="flex items-center gap-2">
                                    <MessageSquareText className="h-4 w-4 text-[#0D7377]" />
                                    <div>
                                        <h4 className="text-sm font-semibold text-[#2B2B2B]">Conversation & résultat</h4>
                                        <p className="text-[11px] text-[#A09E99]">
                                            Réponses enrichies avec CTEs correspondants, chaîne récursive, SQL et jeu de résultats.
                                        </p>
                                    </div>
                                </div>
                                {searchResults.length > 0 && (
                                    <span className="rounded-full bg-[#F8F7F4] border border-[#E8E6E1] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-[#6B6966]">
                                        {searchResults.length} match(s)
                                    </span>
                                )}
                            </div>

                            <div className="max-h-[min(52vh,560px)] overflow-y-auto overflow-x-hidden">
                                <div className="space-y-3 p-4">
                                    {conversationMessages.length === 0 ? (
                                        <div className="rounded-2xl border border-dashed border-[#D9D5CD] bg-[#F8F7F4] px-5 py-8 text-center">
                                            <MessageSquareText className="h-8 w-8 mx-auto text-[#A09E99]" />
                                            <p className="mt-3 text-sm font-semibold text-[#2B2B2B]">
                                                Aucun échange pour le moment
                                            </p>
                                            <p className="mt-1 text-[12px] text-[#6B6966] max-w-sm mx-auto">
                                                Lancez une requête métier pour choisir le meilleur CTE, voir son chemin
                                                de dépendances et exécuter le résultat sur les parquets sélectionnés.
                                            </p>
                                        </div>
                                    ) : (
                                        conversationMessages.map((message) => (
                                            <div
                                                key={message.id}
                                                className={cn(
                                                    "rounded-2xl border px-4 py-3",
                                                    message.role === "user"
                                                        ? "border-[#0D7377]/20 bg-[#0D7377]/6"
                                                        : message.error
                                                            ? "border-[#E8725A]/30 bg-[#E8725A]/8"
                                                            : "border-[#E8E6E1] bg-white",
                                                )}
                                            >
                                                <div className="flex items-center gap-2 mb-2">
                                                    <div
                                                        className={cn(
                                                            "h-7 w-7 rounded-full flex items-center justify-center",
                                                            message.role === "user"
                                                                ? "bg-[#0D7377] text-white"
                                                                : message.error
                                                                    ? "bg-[#E8725A] text-white"
                                                                    : "bg-[#F8F7F4] text-[#0D7377]",
                                                        )}
                                                    >
                                                        {message.role === "user" ? (
                                                            <User className="h-3.5 w-3.5" />
                                                        ) : (
                                                            <Bot className="h-3.5 w-3.5" />
                                                        )}
                                                    </div>
                                                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                                                        {message.role === "user" ? "Question" : "Agent CTE"}
                                                    </p>
                                                </div>

                                                <p className="text-sm text-[#2B2B2B] leading-relaxed whitespace-pre-line">
                                                    {message.content}
                                                </p>

                                                {message.result && (
                                                    <div className="mt-4 space-y-4">
                                                        {(() => {
                                                            const finalResult = describeExecutionResult(message.result.execution);
                                                            return (
                                                                <div className="rounded-2xl border border-[#0D7377]/18 bg-gradient-to-br from-[#0D7377]/8 via-white to-[#2DD4BF]/8 p-4">
                                                                    <div className="flex items-center gap-2">
                                                                        <CheckCircle2 className="h-4 w-4 text-[#0D7377]" />
                                                                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#0D7377]">
                                                                            Résultat final
                                                                        </p>
                                                                    </div>

                                                                    {finalResult.kind === "scalar" && (
                                                                        <div className="mt-3 space-y-1">
                                                                            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                                                                                {finalResult.label}
                                                                            </p>
                                                                            <p className="settings-display text-3xl text-[#2B2B2B] break-words">
                                                                                {finalResult.value}
                                                                            </p>
                                                                        </div>
                                                                    )}

                                                                    {finalResult.kind === "record" && (
                                                                        <div className="mt-3 grid gap-2 sm:grid-cols-2">
                                                                            {finalResult.entries.map(([key, value]) => (
                                                                                <div
                                                                                    key={`${message.id}-final-${key}`}
                                                                                    className="rounded-xl border border-white/80 bg-white/90 px-3 py-2"
                                                                                >
                                                                                    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                                                                                        {key}
                                                                                    </p>
                                                                                    <p className="mt-1 text-sm font-semibold text-[#2B2B2B] break-words">
                                                                                        {value}
                                                                                    </p>
                                                                                </div>
                                                                            ))}
                                                                        </div>
                                                                    )}

                                                                    {finalResult.kind === "table" && (
                                                                        <div className="mt-3 space-y-3">
                                                                            {finalResult.summaryMetrics.length > 0 && (
                                                                                <div className="grid gap-2 sm:grid-cols-2">
                                                                                    {finalResult.summaryMetrics.map((metric) => (
                                                                                        <div
                                                                                            key={`${message.id}-summary-${metric.label}`}
                                                                                            className="rounded-xl border border-white/80 bg-white/90 px-3 py-2"
                                                                                        >
                                                                                            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                                                                                                {metric.label}
                                                                                            </p>
                                                                                            <p className="mt-1 text-lg font-semibold text-[#2B2B2B] break-words">
                                                                                                {metric.value}
                                                                                            </p>
                                                                                        </div>
                                                                                    ))}
                                                                                </div>
                                                                            )}
                                                                            <p className="text-sm text-[#2B2B2B]">
                                                                                {message.result.execution.row_count} ligne(s) retournée(s). Aperçu des premières lignes ci-dessous.
                                                                            </p>
                                                                            <div className="max-h-[300px] overflow-auto rounded-xl border border-[#E8E6E1] bg-white">
                                                                                <table className="min-w-full whitespace-nowrap text-left text-[12px]">
                                                                                    <thead className="sticky top-0 bg-[#F8F7F4]">
                                                                                        <tr>
                                                                                            {finalResult.columns.map((column) => (
                                                                                                <th
                                                                                                    key={`${message.id}-final-head-${column}`}
                                                                                                    className="border-b border-[#E8E6E1] px-3 py-2 font-semibold text-[#2B2B2B]"
                                                                                                >
                                                                                                    {column}
                                                                                                </th>
                                                                                            ))}
                                                                                        </tr>
                                                                                    </thead>
                                                                                    <tbody>
                                                                                        {finalResult.previewRows.map((row, rowIdx) => (
                                                                                            <tr key={`${message.id}-final-row-${rowIdx}`} className="odd:bg-white even:bg-[#FCFBF9]">
                                                                                                {finalResult.columns.map((column) => (
                                                                                                    <td
                                                                                                        key={`${message.id}-final-cell-${rowIdx}-${column}`}
                                                                                                        className="border-b border-[#F1EEE8] px-3 py-2 align-top text-[#2B2B2B]"
                                                                                                    >
                                                                                                        {renderCellValue(row[column])}
                                                                                                    </td>
                                                                                                ))}
                                                                                            </tr>
                                                                                        ))}
                                                                                    </tbody>
                                                                                </table>
                                                                            </div>
                                                                        </div>
                                                                    )}

                                                                    {finalResult.kind === "empty" && (
                                                                        <p className="mt-3 text-sm text-[#6B6966] italic">
                                                                            La requête n’a retourné aucune ligne.
                                                                        </p>
                                                                    )}
                                                                </div>
                                                            );
                                                        })()}

                                                        <div className="flex flex-wrap gap-2">
                                                            {message.result.search_hits.map((hit) => (
                                                                <button
                                                                    key={`${message.id}-${hit.node_id}`}
                                                                    type="button"
                                                                    onClick={() => handleSelectNode(hit.node_id)}
                                                                    className={cn(
                                                                        "rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider transition-all",
                                                                        hit.node_id === message.result?.selected_node
                                                                            ? "border-[#0D7377] bg-[#0D7377] text-white"
                                                                            : "border-[#E8E6E1] bg-[#F8F7F4] text-[#6B6966] hover:border-[#0D7377]/40 hover:text-[#0D7377]",
                                                                    )}
                                                                >
                                                                    {hit.name} · {(hit.similarity_score * 100).toFixed(0)}%
                                                                </button>
                                                            ))}
                                                        </div>

                                                        <div className="rounded-xl border border-[#E8E6E1] bg-[#F8F7F4] p-3 space-y-3">
                                                            <div className="flex items-center gap-2">
                                                                <Route className="h-4 w-4 text-[#0D7377]" />
                                                                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                                                                    Chaîne récursive exécutée
                                                                </p>
                                                            </div>
                                                            <div className="flex flex-wrap items-center gap-1.5">
                                                                {message.result.execution.execution_chain.map((nodeName, idx) => (
                                                                    <React.Fragment key={`${message.id}-chain-${nodeName}-${idx}`}>
                                                                        <span className="rounded-md bg-white border border-[#E8E6E1] px-2 py-1 text-[11px] font-mono text-[#2B2B2B]">
                                                                            {nodeName}
                                                                        </span>
                                                                        {idx < message.result.execution.execution_chain.length - 1 && (
                                                                            <span className="text-[#A09E99]">→</span>
                                                                        )}
                                                                    </React.Fragment>
                                                                ))}
                                                            </div>
                                                        </div>

                                                        <div className="grid gap-3 md:grid-cols-2">
                                                            <div className="rounded-xl border border-[#E8E6E1] bg-white p-3">
                                                                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#A09E99] mb-2">
                                                                    Paramètres liés
                                                                </p>
                                                                <pre className="text-[11px] font-mono text-[#2B2B2B] whitespace-pre-wrap break-words">
                                                                    {JSON.stringify(message.result.execution.bound_parameters, null, 2)}
                                                                </pre>
                                                            </div>
                                                            <div className="rounded-xl border border-[#E8E6E1] bg-white p-3">
                                                                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#A09E99] mb-2">
                                                                    Parquets résolus
                                                                </p>
                                                                <ul className="space-y-1.5">
                                                                    {Object.entries(message.result.execution.resolved_paths).map(([name, path]) => (
                                                                        <li key={`${message.id}-path-${name}`} className="text-[11px] text-[#2B2B2B]">
                                                                            <span className="font-semibold text-[#0D7377]">{name}</span>
                                                                            <span className="mx-1 text-[#A09E99]">→</span>
                                                                            <span className="font-mono break-all">{path}</span>
                                                                        </li>
                                                                    ))}
                                                                    {Object.keys(message.result.execution.resolved_paths).length === 0 && (
                                                                        <li className="text-[11px] text-[#6B6966] italic">
                                                                            Aucun override explicite.
                                                                        </li>
                                                                    )}
                                                                </ul>
                                                            </div>
                                                        </div>

                                                        <div className="rounded-xl border border-[#E8E6E1] bg-white overflow-hidden">
                                                            <div className="flex items-center justify-between gap-3 border-b border-[#E8E6E1] px-3 py-2.5">
                                                                <div className="flex items-center gap-2">
                                                                    <Table2 className="h-4 w-4 text-[#0D7377]" />
                                                                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                                                                        Résultat ({message.result.execution.row_count} ligne(s){message.result.execution.truncated ? ", tronqué" : ""})
                                                                    </p>
                                                                </div>
                                                            </div>
                                                            <ScrollArea className="max-h-[280px]">
                                                                <table className="min-w-full text-left text-[12px]">
                                                                    <thead className="bg-[#F8F7F4]">
                                                                        <tr>
                                                                            {message.result.execution.columns.map((column) => (
                                                                                <th
                                                                                    key={`${message.id}-col-${column}`}
                                                                                    className="border-b border-[#E8E6E1] px-3 py-2 font-semibold text-[#2B2B2B]"
                                                                                >
                                                                                    {column}
                                                                                </th>
                                                                            ))}
                                                                        </tr>
                                                                    </thead>
                                                                    <tbody>
                                                                        {message.result.execution.rows.length === 0 ? (
                                                                            <tr>
                                                                                <td
                                                                                    colSpan={Math.max(message.result.execution.columns.length, 1)}
                                                                                    className="px-3 py-4 text-[#6B6966] italic"
                                                                                >
                                                                                    Aucune ligne retournée.
                                                                                </td>
                                                                            </tr>
                                                                        ) : (
                                                                            message.result.execution.rows.map((row, rowIdx) => (
                                                                                <tr key={`${message.id}-row-${rowIdx}`} className="odd:bg-white even:bg-[#FCFBF9]">
                                                                                    {message.result.execution.columns.map((column) => (
                                                                                        <td
                                                                                            key={`${message.id}-cell-${rowIdx}-${column}`}
                                                                                            className="border-b border-[#F1EEE8] px-3 py-2 align-top text-[#2B2B2B]"
                                                                                        >
                                                                                            {renderCellValue(row[column])}
                                                                                        </td>
                                                                                    ))}
                                                                                </tr>
                                                                            ))
                                                                        )}
                                                                    </tbody>
                                                                </table>
                                                            </ScrollArea>
                                                        </div>

                                                        <details className="rounded-xl border border-[#E8E6E1] bg-[#F8F7F4]">
                                                            <summary className="cursor-pointer px-3 py-2.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#0D7377]">
                                                                SQL final exécuté
                                                            </summary>
                                                            <pre className="px-3 pb-3 text-[11px] font-mono text-[#2B2B2B] whitespace-pre-wrap break-words">
                                                                {message.result.execution.sql}
                                                            </pre>
                                                        </details>
                                                    </div>
                                                )}
                                            </div>
                                        ))
                                    )}
                                </div>
                            </div>
                        </Card>
                    </div>
                </ScrollArea>
                </div>
            )}
        </div>
    );
};

export interface CTEGraphPanelProps {
    /** Notified with the graph_id of the currently-selected profile (or null). */
    onActiveGraphChange?: (graphId: string | null) => void;
}

const CTEGraphPanel: React.FC<CTEGraphPanelProps> = (props) => (
    <ReactFlowProvider>
        <CTEGraphPanelInner {...props} />
    </ReactFlowProvider>
);

export default CTEGraphPanel;
