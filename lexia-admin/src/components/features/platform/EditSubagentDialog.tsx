import React, { useState, useEffect } from "react";
import { Loader2, Sparkles, Send } from "lucide-react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
    fetchDomain,
    updateDomain,
    resetDomainPrompts,
    refinePrompt,
    type DomainDetail,
    type UpdateDomainPayload,
} from "@/lib/domains_api";
import { refreshCards } from "@/lib/cards_api";

interface EditSubagentDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    domainId: string | null;
    domainLabel: string;
    onUpdated: () => void;
}

const EditSubagentDialog: React.FC<EditSubagentDialogProps> = ({
    open,
    onOpenChange,
    domainId,
    domainLabel,
    onUpdated,
}) => {
    const [systemPrompt, setSystemPrompt] = useState("");
    const [name, setName] = useState("");
    const [loading, setLoading] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [resetting, setResetting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // AI helper state
    const [aiInstruction, setAiInstruction] = useState("");
    const [aiLoading, setAiLoading] = useState(false);

    const isBuiltin = domainId === "dashboard";

    useEffect(() => {
        if (!open || !domainId) return;
        setLoading(true);
        setError(null);
        setAiInstruction("");
        fetchDomain(domainId)
            .then((d: DomainDetail) => {
                setSystemPrompt(d.system_prompt ?? "");
                setName(d.name ?? "");
            })
            .catch((e) => {
                setError(e?.message ?? "Erreur lors du chargement");
            })
            .finally(() => setLoading(false));
    }, [open, domainId]);

    const handleAiRefine = async () => {
        if (!aiInstruction.trim() || aiLoading) return;
        setAiLoading(true);
        setError(null);
        try {
            const result = await refinePrompt({
                current_prompt: systemPrompt,
                user_instruction: aiInstruction.trim(),
                domain_id: domainId ?? undefined,
            });
            setSystemPrompt(result.prompt);
            setAiInstruction("");
        } catch (e: unknown) {
            setError((e as Error)?.message ?? "Erreur lors de la génération AI");
        } finally {
            setAiLoading(false);
        }
    };

    const handleSubmit = async (regenCards = false) => {
        if (!domainId || !systemPrompt.trim()) return;
        setSubmitting(true);
        setError(null);

        try {
            const payload: UpdateDomainPayload & { regenerate_cards?: boolean } = {
                system_prompt: systemPrompt.trim(),
                name: name.trim() || undefined,
                regenerate_cards: regenCards,
            };
            await updateDomain(domainId, payload);

            onUpdated();
            onOpenChange(false);
        } catch (e: unknown) {
            setError((e as Error)?.message ?? "Erreur lors de la mise à jour");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[600px] max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>Modifier le sous-agent</DialogTitle>
                    <DialogDescription>
                        Modifiez le prompt système et les paramètres de{" "}
                        {domainLabel}.
                    </DialogDescription>
                </DialogHeader>

                {loading ? (
                    <div className="flex items-center justify-center py-12">
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    </div>
                ) : (
                    <div className="space-y-4 py-2">
                        <div className="space-y-1.5">
                            <label className="text-sm font-medium">Nom</label>
                            <Input
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="Nom du sous-agent"
                                maxLength={80}
                            />
                        </div>

                        <div className="space-y-1.5">
                            <label className="text-sm font-medium">
                                System Prompt{" "}
                                <span className="text-destructive">*</span>
                            </label>
                            <Textarea
                                value={systemPrompt}
                                onChange={(e) => setSystemPrompt(e.target.value)}
                                placeholder="Rôle, objectif et consignes du sous-agent..."
                                className="min-h-[160px] font-mono text-xs"
                                maxLength={8000}
                            />
                            <p className="text-xs text-muted-foreground">
                                {systemPrompt.length}/8000
                            </p>
                            {isBuiltin && (
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="mt-1 text-xs text-muted-foreground"
                                    disabled={resetting}
                                    onClick={async () => {
                                        if (!domainId) return;
                                        setResetting(true);
                                        setError(null);
                                        try {
                                            const res = await resetDomainPrompts(domainId);
                                            setSystemPrompt(res.system_prompt ?? "");
                                        } catch (e) {
                                            setError((e as Error)?.message ?? "Erreur lors du reset");
                                        } finally {
                                            setResetting(false);
                                        }
                                    }}
                                >
                                    {resetting ? (
                                        <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                    ) : null}
                                    Réinitialiser au défaut
                                </Button>
                            )}
                        </div>

                        {/* AI Prompt Helper */}
                        <div className="space-y-1.5 rounded-lg border border-dashed border-primary/30 bg-primary/5 p-3">
                            <label className="text-sm font-medium flex items-center gap-1.5">
                                <Sparkles className="h-3.5 w-3.5 text-primary" />
                                Assistant IA — Affiner le prompt
                            </label>
                            <p className="text-xs text-muted-foreground">
                                Décrivez ce que le sous-agent doit analyser. L'IA génèrera ou améliorera le prompt.
                            </p>
                            <div className="flex gap-2">
                                <Input
                                    value={aiInstruction}
                                    onChange={(e) => setAiInstruction(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleAiRefine(); } }}
                                    placeholder="Ex: Analyser le CA par branche avec les tendances mensuelles..."
                                    disabled={aiLoading}
                                    className="flex-1 text-sm"
                                />
                                <Button
                                    size="sm"
                                    onClick={handleAiRefine}
                                    disabled={!aiInstruction.trim() || aiLoading}
                                    className="shrink-0 gap-1.5"
                                >
                                    {aiLoading ? (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                        <Send className="h-3.5 w-3.5" />
                                    )}
                                    {aiLoading ? "Génération..." : "Générer"}
                                </Button>
                            </div>
                        </div>

                        {error && (
                            <p className="text-sm text-destructive">{error}</p>
                        )}
                    </div>
                )}

                {!loading && (
                    <DialogFooter className="gap-2 sm:gap-0">
                        <Button
                            variant="outline"
                            onClick={() => onOpenChange(false)}
                            disabled={submitting}
                        >
                            Annuler
                        </Button>
                        <Button
                            variant="outline"
                            onClick={() => handleSubmit(false)}
                            disabled={!systemPrompt.trim() || submitting}
                        >
                            {submitting ? (
                                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                            ) : null}
                            Enregistrer
                        </Button>
                        <Button
                            onClick={() => handleSubmit(true)}
                            disabled={!systemPrompt.trim() || submitting}
                            className="gap-1.5"
                        >
                            {submitting ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <Sparkles className="h-4 w-4" />
                            )}
                            Enregistrer & Générer les cartes
                        </Button>
                    </DialogFooter>
                )}
            </DialogContent>
        </Dialog>
    );
};

export default EditSubagentDialog;
