import React, { useState } from "react";
import { X, Pin, Pencil, RotateCw, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DomainCard } from "@/types/cards";
import PromptEditor from "./PromptEditor";

const COLOR_MAP: Record<string, { border: string; text: string }> = {
    green:  { border: "border-t-emerald-500",  text: "text-emerald-600 dark:text-emerald-400" },
    red:    { border: "border-t-red-500",       text: "text-red-600 dark:text-red-400" },
    blue:   { border: "border-t-blue-500",      text: "text-blue-600 dark:text-blue-400" },
    orange: { border: "border-t-orange-500",    text: "text-orange-600 dark:text-orange-400" },
    purple: { border: "border-t-violet-500",    text: "text-violet-600 dark:text-violet-400" },
    accent: { border: "border-t-yellow-500",    text: "text-yellow-600 dark:text-yellow-400" },
};

interface KpiCardProps {
    card: DomainCard;
    onRemove?: (cardId: string) => void;
    onPin?: (cardId: string, pinned: boolean) => void;
    onPromptEdit?: (cardId: string, newPrompt: string) => void;
    onRegenerate?: (cardId: string) => void;
    regenerating?: boolean;
}

const KpiCard: React.FC<KpiCardProps> = ({ card, onRemove, onPin, onPromptEdit, onRegenerate, regenerating }) => {
    const [showPrompt, setShowPrompt] = useState(false);
    const c = card.content;
    const colors = COLOR_MAP[c.color || "accent"] || COLOR_MAP.accent;
    const DeltaIcon =
        c.delta_direction === "up"
            ? TrendingUp
            : c.delta_direction === "down"
              ? TrendingDown
              : Minus;
    const deltaColor =
        c.delta_direction === "up"
            ? "text-emerald-600 dark:text-emerald-400"
            : c.delta_direction === "down"
              ? "text-red-600 dark:text-red-400"
              : "text-muted-foreground";

    return (
        <div
            className={cn(
                "group relative rounded-lg border bg-card shadow-sm transition-all hover:shadow-md",
                "border-t-2",
                colors.border,
            )}
        >
            {/* Actions — visible on hover */}
            <div className="absolute right-1.5 top-1.5 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
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

            {/* Card content */}
            <div className="p-4">
                {/* Label */}
                <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {card.title}
                </div>

                {/* Value */}
                <div className={cn("mt-1 text-xl font-bold", colors.text)}>
                    {c.value || "—"}
                </div>

                {/* Delta */}
                {c.delta && (
                    <div className="mt-1 flex items-center gap-1 text-[10px]">
                        <DeltaIcon className={cn("h-3 w-3", deltaColor)} />
                        <span className={deltaColor}>{c.delta}</span>
                        {c.label && (
                            <span className="text-muted-foreground">{c.label}</span>
                        )}
                    </div>
                )}
            </div>

            {/* Inline prompt editor */}
            {showPrompt && onPromptEdit && (
                <PromptEditor
                    prompt={card.prompt ?? ""}
                    regenerating={regenerating}
                    onSave={(p) => onPromptEdit(card.card_id, p)}
                    onClose={() => setShowPrompt(false)}
                />
            )}
        </div>
    );
};

export default KpiCard;
