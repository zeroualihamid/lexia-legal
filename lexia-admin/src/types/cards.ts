export interface DomainCardContent {
    // KPI
    value?: string;
    delta?: string;
    delta_direction?: "up" | "down" | "neutral";
    color?: string;
    label?: string;
    // Analysis
    markdown?: string;
    tag?: string;
    tag_type?: string;
    // Chart
    echarts_option?: Record<string, unknown>;
    query?: string;
}

export interface DomainCard {
    card_id: string;
    domain: string;
    card_type: "kpi" | "analysis" | "chart";
    title: string;
    content: DomainCardContent;
    order: number;
    created_at: string;
    updated_at: string;
    pinned: boolean;
    source: "auto" | "user";
    prompt: string;
}

export interface CardsResponse {
    domain: string;
    cards: DomainCard[];
    count: number;
}

export interface CardStatusResponse {
    domain: string;
    last_refresh: string | null;
    is_running: boolean;
    error: string | null;
    card_count?: number;
}

export interface CreateCardResponse {
    domain: string;
    card: DomainCard;
}

export interface RefreshResponse {
    status: "started" | "already_running";
    domain: string;
    message?: string;
}

export interface UpdatePromptResponse {
    domain: string;
    card: DomainCard;
}
