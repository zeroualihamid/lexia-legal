export interface ThinkingStep {
    message: string;
    status: string;
    progress: number | null;
    timestamp: string;
}

export interface ChatStep {
    success?: boolean;
    final_success?: boolean;
    [key: string]: any;
}

export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: string;
    thinking?: ThinkingStep[];
    used_tools?: any;
    steps?: ChatStep[];
    chartId?: string;
}

export interface ChartData {
    chartId: string;
    query?: string;
    chartType?: string;
    option?: Record<string, any>;
    timestamp?: string;
    /** @deprecated use chartType / option instead */
    type?: string;
    /** @deprecated use option instead */
    data?: any;
}
