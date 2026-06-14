import React, { useState, useCallback, useRef, useEffect } from "react";
import { Loader2 } from "lucide-react";
import DomainTabs from "./platform/DomainTabs";
import DomainCardGrid from "./platform/DomainCardGrid";
import CompactDomainChat from "./platform/CompactDomainChat";
import AddSubagentDialog from "./platform/AddSubagentDialog";
import EditSubagentDialog from "./platform/EditSubagentDialog";
import { mapBackendDomain, DEFAULT_DASHBOARD, type DomainConfig } from "./platform/domain-config";
import {
    fetchDomains,
    deleteDomain,
    fetchHiddenDomains,
    restoreDomain,
    type HiddenDomain,
} from "@/lib/domains_api";
import type { DomainCard } from "@/types/cards";

const NSGroupPlatform: React.FC = () => {
    const [domains, setDomains] = useState<DomainConfig[]>([]);
    const [hiddenDomains, setHiddenDomains] = useState<HiddenDomain[]>([]);
    const [activeDomain, setActiveDomain] = useState<string>("");
    const [loading, setLoading] = useState(true);
    const [showAddDialog, setShowAddDialog] = useState(false);
    const [editDomainId, setEditDomainId] = useState<string | null>(null);

    const cardCacheRef = useRef<Map<string, DomainCard[]>>(new Map());
    const cachedCards = activeDomain
        ? cardCacheRef.current.get(activeDomain) || []
        : [];

    const loadDomains = useCallback(async () => {
        try {
            const [raw, hidden] = await Promise.all([
                fetchDomains(),
                fetchHiddenDomains(),
            ]);
            const mapped = raw.map(mapBackendDomain);
            // Ensure Dashboard is always displayed (prepend if missing)
            const hasDashboard = mapped.some((d) => d.id === "dashboard");
            const domainsToShow =
                hasDashboard ? mapped : [DEFAULT_DASHBOARD, ...mapped];
            setDomains(domainsToShow.length > 0 ? domainsToShow : [DEFAULT_DASHBOARD]);
            setHiddenDomains(hidden);

            setActiveDomain((prev) => {
                const domains = domainsToShow.length > 0 ? domainsToShow : [DEFAULT_DASHBOARD];
                if (prev && domains.some((d) => d.id === prev)) return prev;
                return domains.find((d) => d.id === "dashboard")?.id ?? domains[0]?.id ?? "dashboard";
            });
        } catch (e) {
            console.error("Failed to fetch domains:", e);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadDomains();
    }, [loadDomains]);

    const handleRemove = useCallback(
        async (id: string) => {
            if (id === "dashboard") return;
            try {
                await deleteDomain(id);
                cardCacheRef.current.delete(id);
                await loadDomains();
            } catch (e) {
                console.error("Failed to delete domain:", e);
            }
        },
        [loadDomains],
    );

    const handleRestore = useCallback(
        async (id: string) => {
            try {
                await restoreDomain(id);
                await loadDomains();
            } catch (e) {
                console.error("Failed to restore domain:", e);
            }
        },
        [loadDomains],
    );

    const handleDomainCreated = useCallback(async () => {
        setShowAddDialog(false);
        await loadDomains();
    }, [loadDomains]);

    const handleDomainUpdated = useCallback(async () => {
        setEditDomainId(null);
        await loadDomains();
    }, [loadDomains]);

    const handleCardsChange = useCallback(
        (cards: DomainCard[]) => {
            cardCacheRef.current.set(activeDomain, cards);
            setRenderTick((t) => t + 1);
        },
        [activeDomain],
    );

    const [, setRenderTick] = useState(0);

    const handleNewCard = useCallback(
        (card: DomainCard) => {
            const prev = cardCacheRef.current.get(activeDomain) || [];
            const updated = [...prev, card];
            cardCacheRef.current.set(activeDomain, updated);
            setRenderTick((t) => t + 1);
        },
        [activeDomain],
    );

    const activeDomainConfig = domains.find((d) => d.id === activeDomain);

    if (loading) {
        return (
            <div className="w-full h-full flex items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
        );
    }

    return (
        <div className="w-full h-full bg-background flex flex-col overflow-hidden">
            <DomainTabs
                domains={domains}
                activeId={activeDomain}
                onChange={setActiveDomain}
                onRemove={handleRemove}
                onEdit={(id) => setEditDomainId(id)}
                onAdd={() => setShowAddDialog(true)}
                hiddenDomains={hiddenDomains}
                onRestore={handleRestore}
            />

            <div className="flex-1 overflow-hidden">
                {activeDomain && (
                    <DomainCardGrid
                        key={activeDomain}
                        domain={activeDomain}
                        cards={cachedCards}
                        onCardsChange={handleCardsChange}
                    />
                )}
            </div>

            {activeDomain && (
                <CompactDomainChat
                    domain={activeDomain}
                    domainLabel={activeDomainConfig?.label}
                    onNewCard={handleNewCard}
                />
            )}

            <AddSubagentDialog
                open={showAddDialog}
                onOpenChange={setShowAddDialog}
                onCreated={handleDomainCreated}
            />

            <EditSubagentDialog
                open={editDomainId !== null}
                onOpenChange={(open) => !open && setEditDomainId(null)}
                domainId={editDomainId}
                domainLabel={
                    domains.find((d) => d.id === editDomainId)?.label ?? ""
                }
                onUpdated={handleDomainUpdated}
            />
        </div>
    );
};

export default NSGroupPlatform;
