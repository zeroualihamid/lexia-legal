import type {
    CardsResponse,
    CardStatusResponse,
    CreateCardResponse,
    DomainCard,
    RefreshResponse,
    UpdatePromptResponse,
} from "@/types/cards";

const BASE = (import.meta.env.VITE_API_URL || "").replace(/\/+$/, "");

async function json<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, {
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        ...init,
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Cards API ${res.status}: ${text}`);
    }
    return res.json();
}

export async function fetchCards(domain: string): Promise<DomainCard[]> {
    const data = await json<CardsResponse>(`${BASE}/cards/${domain}`);
    return data.cards;
}

export async function fetchCardStatus(domain: string): Promise<CardStatusResponse> {
    return json<CardStatusResponse>(`${BASE}/cards/${domain}/status`);
}

export async function refreshCards(domain?: string): Promise<RefreshResponse> {
    return json<RefreshResponse>(`${BASE}/cards/refresh`, {
        method: "POST",
        body: JSON.stringify(domain ? { domain } : {}),
    });
}

export async function createCard(
    domain: string,
    userRequest: string,
    cardType: "kpi" | "analysis" = "analysis",
): Promise<DomainCard> {
    const data = await json<CreateCardResponse>(`${BASE}/cards/${domain}`, {
        method: "POST",
        body: JSON.stringify({ user_request: userRequest, card_type: cardType }),
    });
    return data.card;
}

export async function deleteCard(domain: string, cardId: string): Promise<void> {
    await json(`${BASE}/cards/${domain}/${cardId}`, { method: "DELETE" });
}

export async function reorderCards(domain: string, cardIds: string[]): Promise<DomainCard[]> {
    const data = await json<CardsResponse>(`${BASE}/cards/${domain}/reorder`, {
        method: "PATCH",
        body: JSON.stringify({ card_ids: cardIds }),
    });
    return data.cards;
}

export async function updateCardPrompt(
    domain: string,
    cardId: string,
    prompt: string,
): Promise<DomainCard> {
    const data = await json<UpdatePromptResponse>(
        `${BASE}/cards/${domain}/${cardId}/prompt`,
        {
            method: "PATCH",
            body: JSON.stringify({ prompt }),
        },
    );
    return data.card;
}

export async function pinCard(domain: string, cardId: string, pinned: boolean): Promise<void> {
    await json(`${BASE}/cards/${domain}/${cardId}/pin`, {
        method: "PATCH",
        body: JSON.stringify({ pinned }),
    });
}
