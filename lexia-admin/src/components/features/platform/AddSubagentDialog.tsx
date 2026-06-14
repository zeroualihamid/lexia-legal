import React, { useState, useEffect, useCallback } from "react";
import { Loader2, Check } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
    createDomain,
    fetchSkills,
    type SkillInfo,
    type CreateDomainPayload,
} from "@/lib/domains_api";
import { ICON_MAP } from "./domain-config";

interface AddSubagentDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCreated: () => void;
}

const ICON_OPTIONS = Object.keys(ICON_MAP);

const AddSubagentDialog: React.FC<AddSubagentDialogProps> = ({
    open,
    onOpenChange,
    onCreated,
}) => {
    const [name, setName] = useState("");
    const [systemPrompt, setSystemPrompt] = useState("");
    const [description, setDescription] = useState("");
    const [icon, setIcon] = useState("Bot");
    const [selectedSkills, setSelectedSkills] = useState<Set<string>>(
        new Set(),
    );
    const [skills, setSkills] = useState<SkillInfo[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setName("");
        setSystemPrompt("");
        setDescription("");
        setIcon("Bot");
        setSelectedSkills(new Set());
        setError(null);

        fetchSkills()
            .then(setSkills)
            .catch(() => setSkills([]));
    }, [open]);

    const toggleSkill = useCallback((dirName: string) => {
        setSelectedSkills((prev) => {
            const next = new Set(prev);
            if (next.has(dirName)) next.delete(dirName);
            else next.add(dirName);
            return next;
        });
    }, []);

    const handleSubmit = async () => {
        if (!name.trim() || !systemPrompt.trim()) return;
        setSubmitting(true);
        setError(null);

        try {
            const payload: CreateDomainPayload = {
                name: name.trim(),
                system_prompt: systemPrompt.trim(),
                description: description.trim() || undefined,
                icon,
            };

            if (selectedSkills.size > 0) {
                const skillNames = skills
                    .filter((s) => selectedSkills.has(s.directory_name))
                    .map((s) => s.name);
                payload.system_prompt += `\n\n## Skills actifs\nCe sous-agent utilise les compétences suivantes : ${skillNames.join(", ")}.`;
            }

            await createDomain(payload);
            onCreated();
        } catch (e: any) {
            setError(e?.message ?? "Erreur lors de la création");
        } finally {
            setSubmitting(false);
        }
    };

    const SelectedIcon = ICON_MAP[icon] ?? ICON_MAP.Bot;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[540px] max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <SelectedIcon className="h-5 w-5" />
                        Nouveau sous-agent
                    </DialogTitle>
                    <DialogDescription>
                        Créez un sous-agent avec sa propre personnalité et ses
                        compétences.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-2">
                    {/* Name */}
                    <div className="space-y-1.5">
                        <label className="text-sm font-medium">
                            Nom <span className="text-destructive">*</span>
                        </label>
                        <Input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="Ex : Analyse RH, Logistique..."
                            maxLength={80}
                        />
                    </div>

                    {/* Description */}
                    <div className="space-y-1.5">
                        <label className="text-sm font-medium">
                            Description
                        </label>
                        <Input
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder="Courte description du domaine"
                            maxLength={500}
                        />
                    </div>

                    {/* System Prompt */}
                    <div className="space-y-1.5">
                        <label className="text-sm font-medium">
                            System Prompt{" "}
                            <span className="text-destructive">*</span>
                        </label>
                        <Textarea
                            value={systemPrompt}
                            onChange={(e) => setSystemPrompt(e.target.value)}
                            placeholder="Décrivez le rôle, l'objectif principal et les consignes de ce sous-agent..."
                            className="min-h-[120px]"
                            maxLength={8000}
                        />
                        <p className="text-xs text-muted-foreground">
                            {systemPrompt.length}/8000
                        </p>
                    </div>

                    {/* Icon */}
                    <div className="space-y-1.5">
                        <label className="text-sm font-medium">Icône</label>
                        <div className="flex flex-wrap gap-1.5">
                            {ICON_OPTIONS.map((name) => {
                                const Ic = ICON_MAP[name];
                                const selected = icon === name;
                                return (
                                    <button
                                        key={name}
                                        type="button"
                                        onClick={() => setIcon(name)}
                                        className={cn(
                                            "rounded-md p-1.5 transition-colors",
                                            "hover:bg-accent",
                                            selected
                                                ? "bg-primary text-primary-foreground"
                                                : "text-muted-foreground",
                                        )}
                                        title={name}
                                    >
                                        <Ic className="h-4 w-4" />
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {/* Skills */}
                    {skills.length > 0 && (
                        <div className="space-y-1.5">
                            <label className="text-sm font-medium">
                                Compétences (skills)
                            </label>
                            <div className="flex flex-wrap gap-2">
                                {skills.map((s) => {
                                    const active = selectedSkills.has(
                                        s.directory_name,
                                    );
                                    return (
                                        <Badge
                                            key={s.directory_name}
                                            variant={
                                                active ? "default" : "outline"
                                            }
                                            className="cursor-pointer gap-1 select-none"
                                            onClick={() =>
                                                toggleSkill(s.directory_name)
                                            }
                                        >
                                            {active && (
                                                <Check className="h-3 w-3" />
                                            )}
                                            {s.name}
                                        </Badge>
                                    );
                                })}
                            </div>
                            <p className="text-xs text-muted-foreground">
                                Les compétences sélectionnées seront
                                automatiquement ajoutées au prompt système.
                            </p>
                        </div>
                    )}

                    {error && (
                        <p className="text-sm text-destructive">{error}</p>
                    )}
                </div>

                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                        disabled={submitting}
                    >
                        Annuler
                    </Button>
                    <Button
                        onClick={handleSubmit}
                        disabled={
                            !name.trim() || !systemPrompt.trim() || submitting
                        }
                    >
                        {submitting ? (
                            <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        ) : null}
                        Créer le sous-agent
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

export default AddSubagentDialog;
