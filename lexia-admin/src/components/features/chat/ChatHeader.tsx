import React from 'react';
import { Save, Trash2, RotateCcw } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { asset } from "@/lib/asset";

interface ChatHeaderProps {
    onSave: () => void;
    onClear: () => void;
    onResetMemory?: () => void;
    isResettingMemory?: boolean;
}

const ChatHeader: React.FC<ChatHeaderProps> = ({ onSave, onClear, onResetMemory, isResettingMemory }) => (
    <div className="flex items-center justify-between border-b border-[#E8E6E1] bg-white/95 px-4 py-3 backdrop-blur-sm">
        <div className="flex items-center gap-2.5">
            <Avatar className="h-7 w-7 overflow-hidden ring-1 ring-[#0D7377]/20 bg-[#F8F7F4]">
                <img src={asset("logo.png")} alt="qclick" className="h-full w-full object-cover" />
            </Avatar>
            <span className="settings-display text-base tracking-[-0.03em] text-[#2B2B2B]">qclick</span>
            <span className="rounded-full border border-[#0D7377]/10 bg-[#F1FAFA] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#0D7377]">
                Agent
            </span>
        </div>
        <div className="flex items-center gap-0.5">
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg text-[#A09E99] hover:bg-[#F8F7F4] hover:text-[#0D7377]" onClick={onSave}>
                        <Save className="h-3.5 w-3.5" />
                    </Button>
                </TooltipTrigger>
                <TooltipContent>Enregistrer</TooltipContent>
            </Tooltip>

            {onResetMemory && (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 rounded-lg text-[#A09E99] hover:bg-[#FFF1ED] hover:text-[#E8725A]"
                            onClick={onResetMemory}
                            disabled={isResettingMemory}
                        >
                            <RotateCcw className={cn("h-3.5 w-3.5", isResettingMemory && "animate-spin")} />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>Réinitialiser la mémoire</TooltipContent>
                </Tooltip>
            )}

            <Tooltip>
                <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg text-[#A09E99] hover:bg-[#FFF1ED] hover:text-[#E8725A]" onClick={onClear}>
                        <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                </TooltipTrigger>
                <TooltipContent>Effacer</TooltipContent>
            </Tooltip>
        </div>
    </div>
);

export default ChatHeader;
