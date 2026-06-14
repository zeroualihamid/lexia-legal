import React from 'react';
import { Save } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface SaveConversationDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    saveName: string;
    onSaveNameChange: (name: string) => void;
    onSave: (name: string) => void;
}

const SaveConversationDialog: React.FC<SaveConversationDialogProps> = ({ open, onOpenChange, saveName, onSaveNameChange, onSave }) => {
    const handleSave = () => {
        const name = saveName.endsWith('.json') ? saveName : saveName + '.json';
        onSave(name);
        onOpenChange(false);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="settings-ui max-w-sm rounded-3xl border-[#E8E6E1] bg-[#FBFAF7] text-[#2B2B2B]">
                <DialogHeader>
                    <div className="flex items-center gap-3">
                        <div className="rounded-2xl bg-[#F1FAFA] p-3 text-[#0D7377]">
                            <Save className="h-6 w-6" />
                        </div>
                        <DialogTitle className="settings-display text-xl text-[#2B2B2B]">Enregistrer le chat</DialogTitle>
                    </div>
                    <DialogDescription className="sr-only">
                        Donnez un nom au fichier de sauvegarde
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                    <div>
                        <label className="ml-1 text-xs font-semibold uppercase tracking-[0.2em] text-[#A09E99]">Nom du fichier</label>
                        <Input
                            autoFocus
                            value={saveName}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => onSaveNameChange(e.target.value)}
                            onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                                if (e.key === 'Enter') handleSave();
                            }}
                            className="mt-1 h-12 rounded-xl border-[#E8E6E1] bg-white px-4 text-sm font-medium text-[#2B2B2B]"
                            placeholder="Ex: Analyse PNB Janvier"
                        />
                    </div>
                    <div className="flex gap-2 pt-2">
                        <Button
                            variant="ghost"
                            className="h-11 flex-1 rounded-xl border border-[#E8E6E1] bg-white text-[#6B6966] hover:bg-[#F8F7F4] hover:text-[#2B2B2B]"
                            onClick={() => onOpenChange(false)}
                        >
                            Annuler
                        </Button>
                        <Button
                            className="h-11 flex-1 rounded-xl border border-[#0D7377] bg-[#0D7377] text-white hover:bg-[#0B6164]"
                            onClick={handleSave}
                        >
                            Enregistrer
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
};

export default SaveConversationDialog;
