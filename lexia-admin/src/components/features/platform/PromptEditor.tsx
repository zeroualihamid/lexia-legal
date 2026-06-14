import React, { useState, useEffect, useRef } from "react";
import { RotateCw, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface PromptEditorProps {
    prompt: string;
    regenerating?: boolean;
    onSave: (newPrompt: string) => void;
    onClose: () => void;
}

const PromptEditor: React.FC<PromptEditorProps> = ({
    prompt,
    regenerating,
    onSave,
    onClose,
}) => {
    const [draft, setDraft] = useState(prompt);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        setDraft(prompt);
    }, [prompt]);

    useEffect(() => {
        textareaRef.current?.focus();
        textareaRef.current?.select();
    }, []);

    const dirty = draft.trim() !== prompt;

    const handleSave = () => {
        const trimmed = draft.trim();
        if (trimmed) {
            onSave(trimmed);
        }
    };

    return (
        <div className="border-t border-border/50 bg-muted/20 px-3 py-2.5 space-y-2 animate-in slide-in-from-top-1 duration-150">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                <span>Prompt de génération</span>
            </div>

            <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={Math.min(8, Math.max(2, draft.split("\n").length + 1))}
                disabled={regenerating}
                className={cn(
                    "w-full resize-y rounded border border-border bg-background px-2.5 py-2 text-xs leading-relaxed",
                    "text-foreground placeholder:text-muted-foreground/50",
                    "focus:outline-none focus:ring-1 focus:ring-primary/40",
                    "disabled:opacity-50 disabled:cursor-not-allowed",
                )}
                placeholder="Décrivez ce que cette carte doit afficher..."
            />

            <div className="flex items-center justify-end gap-1.5">
                <button
                    onClick={onClose}
                    disabled={regenerating}
                    className="flex items-center gap-1 rounded px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-muted transition-colors disabled:opacity-50"
                >
                    <X className="h-3 w-3" />
                    Annuler
                </button>
                <button
                    onClick={handleSave}
                    disabled={regenerating || !draft.trim()}
                    className={cn(
                        "flex items-center gap-1 rounded px-2.5 py-1 text-[11px] font-medium transition-colors",
                        dirty
                            ? "bg-primary text-primary-foreground hover:bg-primary/90"
                            : "bg-primary/10 text-primary hover:bg-primary/20",
                        (regenerating || !draft.trim()) && "opacity-50 cursor-not-allowed",
                    )}
                >
                    {regenerating ? (
                        <RotateCw className="h-3 w-3 animate-spin" />
                    ) : (
                        <Check className="h-3 w-3" />
                    )}
                    {regenerating ? "Régénération..." : dirty ? "Régénérer" : "Sauvegarder"}
                </button>
            </div>
        </div>
    );
};

export default PromptEditor;
