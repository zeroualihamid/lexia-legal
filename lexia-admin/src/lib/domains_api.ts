const BASE = (import.meta.env.VITE_API_URL || "").replace(/\/+$/, "");

async function json<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, {
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        ...init,
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Domains API ${res.status}: ${text}`);
    }
    return res.json();
}

/* ── Domain types ─────────────────────────────────────────────────── */

export interface BackendDomain {
    domain_id: string;
    name: string;
    description: string;
    welcome_message: string;
    sample_questions: string[];
    icon: string;
    custom: boolean;
    removable: boolean;
    primary_sources: string[];
}

export interface HiddenDomain {
    domain_id: string;
    name: string;
    description: string;
    icon: string;
}

export interface CreateDomainPayload {
    name: string;
    system_prompt: string;
    code_prompt?: string;
    description?: string;
    welcome_message?: string;
    sample_questions?: string[];
    icon?: string;
    primary_sources?: string[];
}

export interface DomainDetail extends BackendDomain {
    system_prompt?: string;
    code_prompt?: string;
}

export interface UpdateDomainPayload {
    name?: string;
    system_prompt?: string;
    code_prompt?: string;
    description?: string;
    welcome_message?: string;
    sample_questions?: string[];
    icon?: string;
    primary_sources?: string[];
}

export interface SkillInfo {
    name: string;
    description: string;
    directory_name: string;
}

/* ── API calls ────────────────────────────────────────────────────── */

export async function fetchDomains(): Promise<BackendDomain[]> {
    const data = await json<{ domains: BackendDomain[]; count: number }>(
        `${BASE}/domains`,
    );
    return data.domains;
}

export async function createDomain(
    payload: CreateDomainPayload,
): Promise<BackendDomain> {
    return json<BackendDomain>(`${BASE}/domains`, {
        method: "POST",
        body: JSON.stringify(payload),
    });
}

export async function deleteDomain(domainId: string): Promise<void> {
    await json(`${BASE}/domains/${domainId}`, { method: "DELETE" });
}

export async function fetchSkills(): Promise<SkillInfo[]> {
    const data = await json<{ skills: SkillInfo[]; count: number }>(
        `${BASE}/skills`,
    );
    return data.skills;
}

export async function fetchHiddenDomains(): Promise<HiddenDomain[]> {
    const data = await json<{ domains: HiddenDomain[]; count: number }>(
        `${BASE}/domains/hidden/list`,
    );
    return data.domains;
}

export async function restoreDomain(domainId: string): Promise<void> {
    await json(`${BASE}/domains/${domainId}/restore`, { method: "POST" });
}

export async function resetDomainPrompts(domainId: string): Promise<{
    status: string;
    domain_id: string;
    system_prompt: string;
    code_prompt: string;
}> {
    return json(`${BASE}/domains/${domainId}/reset-prompts`, {
        method: "POST",
    });
}

export async function fetchDomain(domainId: string): Promise<DomainDetail> {
    return json<DomainDetail>(`${BASE}/domains/${domainId}`);
}

export async function updateDomain(
    domainId: string,
    payload: UpdateDomainPayload & { regenerate_cards?: boolean },
): Promise<DomainDetail & { cards_regenerating?: boolean }> {
    return json<DomainDetail & { cards_regenerating?: boolean }>(`${BASE}/domains/${domainId}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
    });
}

export async function refinePrompt(params: {
    current_prompt?: string;
    user_instruction: string;
    domain_id?: string;
}): Promise<{ prompt: string; model: string }> {
    return json<{ prompt: string; model: string }>(`${BASE}/domains/refine-prompt`, {
        method: "POST",
        body: JSON.stringify({
            current_prompt: params.current_prompt ?? "",
            user_instruction: params.user_instruction,
            domain_id: params.domain_id,
        }),
    });
}
