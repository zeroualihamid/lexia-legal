import React, { useEffect, useState, useCallback, useRef } from "react";
import { RefreshCw, Clock, Loader2, AlertCircle, Plus, X, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
    fetchCards,
    fetchCardStatus,
    refreshCards,
    deleteCard,
    pinCard,
    createCard,
    reorderCards as apiReorder,
    updateCardPrompt,
} from "@/lib/cards_api";
import type { DomainCard } from "@/types/cards";
import KpiCard from "./KpiCard";
import AnalysisCard from "./AnalysisCard";

interface DomainCardGridProps {
    domain: string;
    /** Externally managed card cache so tabs survive switching */
    cards: DomainCard[];
    onCardsChange: (cards: DomainCard[]) => void;
}

const DomainCardGrid: React.FC<DomainCardGridProps> = ({
    domain,
    cards,
    onCardsChange,
}) => {
    const [loading, setLoading] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [lastRefresh, setLastRefresh] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
    const [showAddForm, setShowAddForm] = useState(false);
    const [addPrompt, setAddPrompt] = useState("");
    const [addCardType, setAddCardType] = useState<"kpi" | "analysis">("analysis");
    const [adding, setAdding] = useState(false);
    const [addError, setAddError] = useState<string | null>(null);
    const addInputRef = useRef<HTMLTextAreaElement>(null);

    const loadCards = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const fetched = await fetchCards(domain);
            onCardsChange(fetched);
            const status = await fetchCardStatus(domain);
            setLastRefresh(status.last_refresh);
        } catch (e: any) {
            setError(e.message || "Erreur de chargement");
        } finally {
            setLoading(false);
        }
    }, [domain, onCardsChange]);

    useEffect(() => {
        if (cards.length === 0) {
            loadCards();
        } else {
            fetchCardStatus(domain)
                .then((s) => setLastRefresh(s.last_refresh))
                .catch(() => {});
        }
    }, [domain]);

    const handleRefresh = useCallback(async () => {
        setRefreshing(true);
        try {
            await refreshCards(domain);
            // Poll until refresh finishes (max 120s)
            const start = Date.now();
            const poll = async () => {
                const status = await fetchCardStatus(domain);
                if (!status.is_running || Date.now() - start > 120_000) {
                    const fetched = await fetchCards(domain);
                    onCardsChange(fetched);
                    setLastRefresh(status.last_refresh);
                    setRefreshing(false);
                    return;
                }
                setTimeout(poll, 2000);
            };
            setTimeout(poll, 3000);
        } catch {
            setRefreshing(false);
        }
    }, [domain, onCardsChange]);

    const handleRemove = useCallback(
        async (cardId: string) => {
            try {
                await deleteCard(domain, cardId);
                // Refetch to stay in sync with persisted cards.json
                const fetched = await fetchCards(domain);
                onCardsChange(fetched);
            } catch {
                /* delete failed — keep current cards */
            }
        },
        [domain, onCardsChange],
    );

    const handlePin = useCallback(
        async (cardId: string, pinned: boolean) => {
            try {
                await pinCard(domain, cardId, pinned);
                onCardsChange(
                    cards.map((c) =>
                        c.card_id === cardId ? { ...c, pinned } : c,
                    ),
                );
            } catch {}
        },
        [domain, cards, onCardsChange],
    );

    const handlePromptEdit = useCallback(
        async (cardId: string, newPrompt: string) => {
            setRegeneratingId(cardId);
            try {
                const updated = await updateCardPrompt(domain, cardId, newPrompt);
                onCardsChange(
                    cards.map((c) => (c.card_id === cardId ? updated : c)),
                );
            } catch {
                /* toast error in a real app */
            } finally {
                setRegeneratingId(null);
            }
        },
        [domain, cards, onCardsChange],
    );

    const handleRegenerate = useCallback(
        async (cardId: string) => {
            const card = cards.find((c) => c.card_id === cardId);
            if (!card?.prompt) return;
            setRegeneratingId(cardId);
            try {
                const updated = await updateCardPrompt(domain, cardId, card.prompt);
                onCardsChange(
                    cards.map((c) => (c.card_id === cardId ? updated : c)),
                );
            } catch {
                /* silent */
            } finally {
                setRegeneratingId(null);
            }
        },
        [domain, cards, onCardsChange],
    );

    const handleAddCard = useCallback(
        async () => {
            const trimmed = addPrompt.trim();
            if (!trimmed || adding) return;
            setAdding(true);
            setAddError(null);
            try {
                const card = await createCard(domain, trimmed, addCardType);
                onCardsChange([...cards, card]);
                setAddPrompt("");
                setShowAddForm(false);
            } catch (e: any) {
                setAddError(e?.message || "Échec de la création de la carte");
            } finally {
                setAdding(false);
            }
        },
        [domain, addPrompt, addCardType, adding, cards, onCardsChange],
    );

    const handleAddKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleAddCard();
        }
        if (e.key === "Escape") {
            setShowAddForm(false);
            setAddPrompt("");
        }
    };

    useEffect(() => {
        if (showAddForm) {
            addInputRef.current?.focus();
        }
    }, [showAddForm]);

    const kpiCards = cards.filter((c) => c.card_type === "kpi");
    const analysisCards = cards.filter(
        (c) => c.card_type === "analysis" || c.card_type === "chart",
    );

    const fmtTime = (iso: string | null) => {
        if (!iso) return "—";
        try {
            return new Date(iso).toLocaleTimeString("fr-FR", {
                hour: "2-digit",
                minute: "2-digit",
            });
        } catch {
            return iso;
        }
    };

    if (loading && cards.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
                <Loader2 className="h-8 w-8 animate-spin text-primary/50" />
                <p className="text-xs uppercase tracking-widest font-bold opacity-60">
                    Chargement des analyses...
                </p>
            </div>
        );
    }

    if (error && cards.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
                <AlertCircle className="h-8 w-8 text-destructive/60" />
                <p className="text-xs">{error}</p>
                <Button variant="outline" size="sm" onClick={loadCards}>
                    Réessayer
                </Button>
            </div>
        );
    }

    if (cards.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
                <RefreshCw className="h-8 w-8 opacity-30" />
                <p className="text-sm">Aucune analyse disponible.</p>
                <p className="text-xs opacity-60">
                    Les agents génèrent les fiches en arrière-plan...
                </p>
                <Button variant="outline" size="sm" onClick={handleRefresh}>
                    Lancer l'analyse
                </Button>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">
            {/* Toolbar */}
            <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/10 shrink-0">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    <span>Dernière MAJ : {fmtTime(lastRefresh)}</span>
                </div>
                <div className="flex items-center gap-1">
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                            setShowAddForm(!showAddForm);
                            setAddPrompt("");
                            setAddError(null);
                        }}
                        className={cn(
                            "gap-1.5 text-xs",
                            showAddForm && "bg-primary/10 text-primary",
                        )}
                    >
                        <Plus className="h-3.5 w-3.5" />
                        Ajouter
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleRefresh}
                        disabled={refreshing}
                        className="gap-1.5 text-xs"
                    >
                        <RefreshCw
                            className={cn("h-3.5 w-3.5", refreshing && "animate-spin")}
                        />
                        {refreshing ? "Rafraîchissement..." : "Rafraîchir"}
                    </Button>
                </div>
            </div>

            {/* Add card form */}
            {showAddForm && (
                <div className="border-b bg-muted/20 px-4 py-3 space-y-2.5 animate-in slide-in-from-top-1 duration-150 shrink-0">
                    <div className="flex items-center justify-between">
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                            Nouvelle carte
                        </div>
                        {/* Card type toggle */}
                        <div className="flex rounded-md border border-border overflow-hidden text-[11px]">
                            <button
                                onClick={() => setAddCardType("kpi")}
                                className={cn(
                                    "px-3 py-1 font-medium transition-colors",
                                    addCardType === "kpi"
                                        ? "bg-primary text-primary-foreground"
                                        : "bg-background text-muted-foreground hover:bg-muted",
                                )}
                            >
                                KPI
                            </button>
                            <button
                                onClick={() => setAddCardType("analysis")}
                                className={cn(
                                    "px-3 py-1 font-medium transition-colors border-l border-border",
                                    addCardType === "analysis"
                                        ? "bg-primary text-primary-foreground"
                                        : "bg-background text-muted-foreground hover:bg-muted",
                                )}
                            >
                                Analyse
                            </button>
                        </div>
                    </div>
                    <div className="flex gap-2">
                        <textarea
                            ref={addInputRef}
                            value={addPrompt}
                            onChange={(e) => setAddPrompt(e.target.value)}
                            onKeyDown={handleAddKeyDown}
                            rows={addCardType === "analysis" ? 3 : 2}
                            disabled={adding}
                            placeholder={
                                addCardType === "kpi"
                                    ? "Ex: Chiffre d'affaires total en MAD avec variation vs mois précédent"
                                    : "Ex: Analyser l'évolution du CA par mois avec tableau comparatif et tendances"
                            }
                            className={cn(
                                "flex-1 resize-none rounded border border-border bg-background px-2.5 py-2 text-xs leading-relaxed",
                                "text-foreground placeholder:text-muted-foreground/50",
                                "focus:outline-none focus:ring-1 focus:ring-primary/40",
                                "disabled:opacity-50",
                            )}
                        />
                        <div className="flex flex-col gap-1 shrink-0">
                            <Button
                                size="sm"
                                onClick={handleAddCard}
                                disabled={!addPrompt.trim() || adding}
                                className="gap-1.5 text-xs h-8"
                            >
                                {adding ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                    <Send className="h-3 w-3" />
                                )}
                                {adding ? "Création..." : "Créer"}
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                    setShowAddForm(false);
                                    setAddPrompt("");
                                }}
                                disabled={adding}
                                className="gap-1.5 text-xs h-8"
                            >
                                <X className="h-3 w-3" />
                                Annuler
                            </Button>
                        </div>
                    </div>
                    {addError && (
                        <div className="flex items-center gap-1.5 text-[11px] text-destructive">
                            <AlertCircle className="h-3 w-3 shrink-0" />
                            <span>{addError}</span>
                        </div>
                    )}
                </div>
            )}

            <ScrollArea className="flex-1">
                <div className="p-4 space-y-6 pb-8">
                    {/* KPI Grid */}
                    {kpiCards.length > 0 && (
                        <div
                            className={cn(
                                "grid gap-3",
                                kpiCards.length <= 3
                                    ? "grid-cols-1 sm:grid-cols-3"
                                    : kpiCards.length <= 4
                                      ? "grid-cols-2 sm:grid-cols-4"
                                      : kpiCards.length <= 5
                                        ? "grid-cols-2 sm:grid-cols-5"
                                        : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-6",
                            )}
                        >
                            {kpiCards.map((card) => (
                                <KpiCard
                                    key={card.card_id}
                                    card={card}
                                    onRemove={handleRemove}
                                    onPin={handlePin}
                                    onPromptEdit={handlePromptEdit}
                                    onRegenerate={handleRegenerate}
                                    regenerating={regeneratingId === card.card_id}
                                />
                            ))}
                        </div>
                    )}

                    {/* Analysis / Chart panels */}
                    {analysisCards.length > 0 && (
                        <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
                            {analysisCards.map((card) => (
                                <AnalysisCard
                                    key={card.card_id}
                                    card={card}
                                    onRemove={handleRemove}
                                    onPin={handlePin}
                                    onPromptEdit={handlePromptEdit}
                                    onRegenerate={handleRegenerate}
                                    regenerating={regeneratingId === card.card_id}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </ScrollArea>
        </div>
    );
};

export default DomainCardGrid;
