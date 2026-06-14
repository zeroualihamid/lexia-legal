import React, { useState } from "react";
import { X, Pin, Pencil, RotateCw } from "lucide-react";
import ReactECharts from "echarts-for-react";
import { cn } from "@/lib/utils";
import MarkdownRenderer from "../chat/MarkdownRenderer";
import type { DomainCard } from "@/types/cards";
import PromptEditor from "./PromptEditor";

const TAG_COLORS: Record<string, string> = {
    f: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
    m: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
    g: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
    gr: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
    r: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
    p: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
    pk: "bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300",
};

interface AnalysisCardProps {
    card: DomainCard;
    onRemove?: (cardId: string) => void;
    onPin?: (cardId: string, pinned: boolean) => void;
    onPromptEdit?: (cardId: string, newPrompt: string) => void;
    onRegenerate?: (cardId: string) => void;
    regenerating?: boolean;
}

const AnalysisCard: React.FC<AnalysisCardProps> = ({ card, onRemove, onPin, onPromptEdit, onRegenerate, regenerating }) => {
    const [showPrompt, setShowPrompt] = useState(false);
    const c = card.content;
    const tagCls = TAG_COLORS[c.tag_type || "g"] || TAG_COLORS.g;

    return (
        <div className="group relative rounded-lg border bg-card shadow-sm transition-all hover:shadow-md">
            {/* Header */}
            <div className="flex items-center justify-between border-b px-4 py-2.5 bg-muted/10">
                <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{card.title}</span>
                    {c.tag && (
                        <span
                            className={cn(
                                "rounded px-1.5 py-0.5 text-[9px] font-bold uppercase",
                                tagCls,
                            )}
                        >
                            {c.tag}
                        </span>
                    )}
                </div>

                <div className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    {card.prompt && onRegenerate && (
                        <button
                            onClick={() => onRegenerate(card.card_id)}
                            disabled={regenerating}
                            className={cn(
                                "rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                                "disabled:opacity-50 disabled:cursor-not-allowed",
                            )}
                            title="Régénérer la carte"
                        >
                            <RotateCw className={cn("h-3 w-3", regenerating && "animate-spin")} />
                        </button>
                    )}
                    {onPromptEdit && (
                        <button
                            onClick={() => setShowPrompt(!showPrompt)}
                            className={cn(
                                "rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                                showPrompt && "text-primary bg-primary/10",
                            )}
                            title="Modifier le prompt"
                        >
                            <Pencil className="h-3 w-3" />
                        </button>
                    )}
                    {onPin && (
                        <button
                            onClick={() => onPin(card.card_id, !card.pinned)}
                            className={cn(
                                "rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                                card.pinned && "text-blue-500",
                            )}
                            title={card.pinned ? "Détacher" : "Épingler"}
                        >
                            <Pin className="h-3 w-3" />
                        </button>
                    )}
                    {onRemove && (
                        <button
                            onClick={() => onRemove(card.card_id)}
                            className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            title="Supprimer"
                        >
                            <X className="h-3 w-3" />
                        </button>
                    )}
                </div>
            </div>

            {/* Inline prompt editor — slides in below header */}
            {showPrompt && onPromptEdit && (
                <PromptEditor
                    prompt={card.prompt ?? ""}
                    regenerating={regenerating}
                    onSave={(p) => onPromptEdit(card.card_id, p)}
                    onClose={() => setShowPrompt(false)}
                />
            )}

            {/* Body */}
            <div className="p-4">
                {c.markdown && (
                    <div className="prose prose-sm dark:prose-invert max-w-none">
                        <MarkdownRenderer content={c.markdown} />
                    </div>
                )}

                {c.echarts_option && (
                    <div className="mt-3 h-[240px] w-full rounded-lg border border-border/10 bg-muted/5">
                        <ReactECharts
                            option={c.echarts_option}
                            style={{ height: "100%", width: "100%" }}
                            opts={{ renderer: "canvas" }}
                            notMerge
                            lazyUpdate
                        />
                    </div>
                )}
            </div>
        </div>
    );
};

export default AnalysisCard;
