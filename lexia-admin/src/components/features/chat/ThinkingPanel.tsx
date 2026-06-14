import React, { useMemo } from 'react';
import { ChevronRight, Brain, Search, Database, CheckCircle2, RefreshCw, Zap } from 'lucide-react';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { motion, AnimatePresence } from "framer-motion";

import { ThinkingStep } from '@/types/chat';

interface ThinkingPanelProps {
    thinking: ThinkingStep[];
    messageId: string;
    isExpanded: boolean;
    onToggle: (id: string) => void;
}

const STATUS_META: Record<string, { icon: React.ElementType; color: string }> = {
    thinking:       { icon: Brain,        color: "text-[#0D7377]" },
    semantic_match: { icon: Search,       color: "text-amber-500" },
    sql_generated:  { icon: Database,     color: "text-sky-500" },
    sql_result:     { icon: CheckCircle2, color: "text-emerald-500" },
    evaluation:     { icon: Zap,          color: "text-rose-500" },
    iteration:      { icon: RefreshCw,    color: "text-orange-500" },
};

const DEFAULT_META = { icon: Brain, color: "text-[#0D7377]" };

function getMeta(status: string) {
    return STATUS_META[status] ?? DEFAULT_META;
}

const StepLine: React.FC<{ step: ThinkingStep; idx: number }> = ({ step, idx }) => {
    const { icon: Icon, color } = getMeta(step.status);
    return (
        <motion.div
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: idx * 0.03, duration: 0.2 }}
            className="flex items-start gap-2.5 py-1"
        >
            <Icon className={`h-3.5 w-3.5 mt-0.5 flex-shrink-0 ${color}`} />
            <span className="text-[12px] leading-relaxed text-[#4A4845]">
                {step.message}
            </span>
        </motion.div>
    );
};

const ThinkingPanel: React.FC<ThinkingPanelProps> = ({ thinking, messageId, isExpanded, onToggle }) => {
    if (!thinking || thinking.length === 0) return null;

    const latest = thinking[thinking.length - 1];
    const isComplete = latest?.progress != null && latest.progress >= 85;
    const stepCount = thinking.length;

    const previewSteps = useMemo(() => thinking.slice(-2), [thinking]);

    return (
        <Collapsible open={isExpanded} onOpenChange={() => onToggle(messageId)}>
            <div className="overflow-hidden rounded-xl border border-[#E8E6E1] bg-[#FCFBF8]">
                <CollapsibleTrigger asChild>
                    <button
                        type="button"
                        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-[#F8F7F4]"
                    >
                        <div className="relative flex items-center justify-center h-5 w-5">
                            {!isComplete ? (
                                <motion.div
                                    animate={{ rotate: 360 }}
                                    transition={{ repeat: Infinity, duration: 2, ease: "linear" }}
                                >
                                    <Brain className="h-4 w-4 text-[#0D7377]" />
                                </motion.div>
                            ) : (
                                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                            )}
                        </div>
                        <span className="flex-1 text-[12px] font-medium text-[#2B2B2B]">
                            {isComplete ? "Raisonnement terminé" : "Raisonnement en cours…"}
                        </span>
                        <span className="settings-mono text-[11px] text-[#A09E99] tabular-nums">
                            {stepCount} étape{stepCount > 1 ? "s" : ""}
                        </span>
                        <ChevronRight
                            className={`h-3.5 w-3.5 text-[#A09E99] transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
                        />
                    </button>
                </CollapsibleTrigger>

                <AnimatePresence>
                    {!isExpanded && (
                        <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.15 }}
                            className="overflow-hidden"
                        >
                            <div className="space-y-0.5 border-t border-[#E8E6E1] px-3.5 pb-2.5 pt-2">
                                {previewSteps.map((step, idx) => (
                                    <StepLine key={`${messageId}-p-${idx}`} step={step} idx={idx} />
                                ))}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>

                <CollapsibleContent>
                    <div className="max-h-64 space-y-0.5 overflow-y-auto border-t border-[#E8E6E1] px-3.5 pb-3 pt-2">
                        {thinking.map((step, idx) => (
                            <StepLine key={`${messageId}-t-${idx}`} step={step} idx={idx} />
                        ))}
                    </div>
                </CollapsibleContent>
            </div>
        </Collapsible>
    );
};

export default ThinkingPanel;
