import {
    LayoutDashboard,
    Landmark,
    BookOpen,
    Factory,
    Megaphone,
    BarChart3,
    TrendingUp,
    Target,
    Bot,
    Brain,
    Globe,
    Database,
    FileText,
    PieChart,
    Settings,
    Sparkles,
    type LucideIcon,
} from "lucide-react";
import type { BackendDomain } from "@/lib/domains_api";

export interface DomainConfig {
    id: string;
    label: string;
    icon: LucideIcon;
    description: string;
    welcomeMessage: string;
    sampleQuestions: string[];
    custom: boolean;
    removable: boolean;
}

export const ICON_MAP: Record<string, LucideIcon> = {
    LayoutDashboard,
    Landmark,
    BookOpen,
    Factory,
    Megaphone,
    BarChart3,
    TrendingUp,
    Target,
    Bot,
    Brain,
    Globe,
    Database,
    FileText,
    PieChart,
    Settings,
    Sparkles,
};

/** Fallback Dashboard shown when API returns no domains (e.g. fetch error). */
export const DEFAULT_DASHBOARD: DomainConfig = {
    id: "dashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
    description: "Vue consolidée NSFactory + NSMobili",
    welcomeMessage: "Bienvenue sur le Dashboard.",
    sampleQuestions: [],
    custom: false,
    removable: false,
};

export function mapBackendDomain(raw: BackendDomain): DomainConfig {
    return {
        id: raw.domain_id,
        label: raw.name,
        icon: ICON_MAP[raw.icon] ?? Bot,
        description: raw.description,
        welcomeMessage: raw.welcome_message,
        sampleQuestions: raw.sample_questions ?? [],
        custom: raw.custom,
        removable: raw.removable ?? raw.domain_id !== "dashboard",
    };
}

export function getDomainById(
    id: string,
    domains?: DomainConfig[],
): DomainConfig | undefined {
    if (domains) return domains.find((d) => d.id === id);
    return undefined;
}
