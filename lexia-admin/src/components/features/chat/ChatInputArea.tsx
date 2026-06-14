import React, { useRef, useEffect } from 'react';
import { Send, Paperclip, Loader2 } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface ChatInputAreaProps {
    input: string;
    onInputChange: (value: string) => void;
    onSend: () => void;
    onFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
    isLoading: boolean;
    isUploading: boolean;
}

const ChatInputArea: React.FC<ChatInputAreaProps> = ({ input, onInputChange, onSend, onFileUpload, isLoading, isUploading }) => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
            textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 140)}px`;
        }
    }, [input]);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
            e.preventDefault();
            if (input.trim() && !isLoading && !isUploading) {
                onSend();
            }
        }
    };

    const canSend = input.trim().length > 0 && !isLoading && !isUploading;

    return (
        <div className="px-4 pb-4 pt-3">
            <div className="relative flex items-end rounded-[24px] border border-[#E8E6E1] bg-white shadow-sm transition-all duration-200 focus-within:border-[#0D7377]/40 focus-within:shadow-md focus-within:shadow-[#0D7377]/5">
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            type="button"
                            className="mb-0.5 ml-1 flex h-10 w-10 items-center justify-center text-[#A09E99] transition-colors hover:text-[#2B2B2B] disabled:opacity-40"
                            onClick={() => document.getElementById('file-upload')?.click()}
                            disabled={isUploading}
                        >
                            {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
                        </button>
                    </TooltipTrigger>
                    <TooltipContent>Joindre un fichier</TooltipContent>
                </Tooltip>

                <input
                    type="file"
                    id="file-upload"
                    className="hidden"
                    multiple
                    onChange={onFileUpload}
                />

                <textarea
                    ref={textareaRef}
                    value={input}
                    onChange={(e) => onInputChange(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={isUploading ? "Téléchargement en cours…" : "Posez votre question…"}
                    className="settings-ui flex-1 min-h-[44px] max-h-[140px] resize-none border-0 bg-transparent px-2 py-3 text-sm leading-relaxed text-[#2B2B2B] shadow-none placeholder:text-[#A09E99] focus:outline-none focus:ring-0"
                    disabled={isUploading}
                    rows={1}
                />

                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            size="icon"
                            className={cn(`mr-1.5 mb-1.5 h-9 w-9 rounded-2xl transition-all duration-200 ${
                                canSend
                                    ? 'bg-[#0D7377] text-white shadow-sm hover:bg-[#0B6164]'
                                    : 'cursor-not-allowed bg-[#F3F1EC] text-[#C1BFB8]'
                            }`)}
                            onClick={onSend}
                            disabled={!canSend}
                        >
                            <Send className="h-4 w-4" />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>Envoyer</TooltipContent>
                </Tooltip>
            </div>
        </div>
    );
};

export default ChatInputArea;
