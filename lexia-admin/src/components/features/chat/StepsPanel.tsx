import React from 'react';

import { ChatStep } from '@/types/chat';

interface StepsPanelProps {
    steps: ChatStep[];
    messageId: string;
}

const StepsPanel: React.FC<StepsPanelProps> = ({ steps, messageId }) => {
    if (!steps || steps.length === 0) return null;

    return (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2">
            <div className="text-[11px] font-semibold text-emerald-600/90 mb-2">Étapes exécutées</div>
            <div className="space-y-1.5">
                {steps.map((step, idx) => (
                    <div key={`${messageId}-step-${idx}`} className="text-[11px] text-muted-foreground flex items-start gap-2">
                        <span className={`mt-1.5 h-1.5 w-1.5 rounded-full ${step?.success || step?.final_success ? 'bg-emerald-500/80' : 'bg-red-500/80'}`} />
                        <span>
                            <span className="font-semibold text-foreground/90">Étape {idx + 1}</span>
                            <span className="ml-1">
                                {step?.success || step?.final_success ? "terminée" : "en échec"}
                            </span>
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
};

export default StepsPanel;
