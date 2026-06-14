import React from 'react';
import { User, BarChart3 } from 'lucide-react';
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { motion } from "framer-motion";
import ThinkingPanel from './ThinkingPanel';
import MarkdownRenderer from './MarkdownRenderer';
import { cn } from "@/lib/utils";
import { asset } from "@/lib/asset";

import { ChatMessage, ChartData } from '@/types/chat';

interface MessageBubbleProps {
    msg: ChatMessage;
    charts: ChartData[];
    setCurrentChartId: (id: string) => void;
    isThinkingExpanded: boolean;
    toggleThinking: (id: string) => void;
}

const MessageBubble: React.FC<MessageBubbleProps> = ({ msg, charts, setCurrentChartId, isThinkingExpanded, toggleThinking }) => {
    const thinking = Array.isArray(msg.thinking) ? msg.thinking : [];
    const isUser = msg.role === 'user';
    const isLoading = msg.content?.startsWith('⏳');

    return (
        <motion.div
            id={`message-${msg.id}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''}`}
        >
            <Avatar className={`h-7 w-7 mt-1 flex-shrink-0 ring-1 ${
                isUser
                    ? 'ring-[#E8E6E1] bg-[#F8F7F4]'
                    : 'ring-[#0D7377]/20 bg-[#F1FAFA]'
            }`}>
                {!isUser ? (
                    <img src={asset("logo.png")} alt="qclick" className="h-full w-full object-cover" />
                ) : (
                    <AvatarFallback className="text-foreground/60 text-xs">
                        <User size={14} />
                    </AvatarFallback>
                )}
            </Avatar>

            <div className={`flex flex-col gap-2 min-w-0 flex-1 ${isUser ? 'items-end' : 'items-start'}`}>
                {isUser ? (
                    <div className="rounded-2xl rounded-tr-md bg-[#0D7377] px-4 py-2.5 text-sm leading-relaxed text-white shadow-sm">
                        {msg.content}
                    </div>
                ) : (
                    <>
                        {thinking.length > 0 && (
                            <div className="w-full">
                                <ThinkingPanel
                                    thinking={thinking}
                                    messageId={msg.id}
                                    isExpanded={isThinkingExpanded}
                                    onToggle={toggleThinking}
                                />
                            </div>
                        )}

                        {!isLoading && msg.content && (
                            <div className="w-full">
                                <MarkdownRenderer content={msg.content} />
                            </div>
                        )}

                        {msg.chartId && (
                            <button
                                type="button"
                                onClick={() => {
                                    if (msg.chartId) setCurrentChartId(msg.chartId);
                                    const el = document.getElementById(`chart-card-${msg.chartId}`);
                                    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                    const tab = document.querySelector('button[title="Graphes"]') as HTMLButtonElement | null;
                                    if (tab) tab.click();
                                }}
                                className={cn(
                                    "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                                    "border-[#0D7377]/15 bg-[#F1FAFA] text-[#0D7377] hover:bg-[#E7F6F6]"
                                )}
                            >
                                <BarChart3 className="h-3.5 w-3.5" />
                                Voir le graphique #{charts.findIndex(c => c.chartId === msg.chartId) + 1}
                            </button>
                        )}
                    </>
                )}
            </div>
        </motion.div>
    );
};

export default React.memo(MessageBubble);
