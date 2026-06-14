import React, { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { Plus, X, ChevronDown, RotateCcw, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DomainConfig } from "./domain-config";
import { ICON_MAP } from "./domain-config";
import type { HiddenDomain } from "@/lib/domains_api";

interface DomainTabsProps {
    domains: DomainConfig[];
    activeId: string;
    onChange: (id: string) => void;
    onRemove?: (id: string) => void;
    onEdit?: (id: string) => void;
    onAdd?: () => void;
    hiddenDomains?: HiddenDomain[];
    onRestore?: (id: string) => void;
}

const DomainTabs: React.FC<DomainTabsProps> = ({
    domains,
    activeId,
    onChange,
    onRemove,
    onEdit,
    onAdd,
    hiddenDomains = [],
    onRestore,
}) => {
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!dropdownOpen) return;
        const handler = (e: MouseEvent) => {
            const target = e.target as Node;
            if (
                dropdownRef.current &&
                !dropdownRef.current.contains(target) &&
                triggerRef.current &&
                !triggerRef.current.contains(target)
            ) {
                setDropdownOpen(false);
            }
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [dropdownOpen]);

    return (
        <div className="border-b bg-card/50 backdrop-blur-sm">
            <nav className="flex overflow-x-auto scrollbar-hide px-2 gap-1 py-1.5 items-center">
                {domains.map((d) => {
                    const Icon = d.icon;
                    const isActive = d.id === activeId;

                    return (
                        <div
                            key={d.id}
                            className="relative group flex items-center"
                        >
                            <button
                                onClick={() => onChange(d.id)}
                                className={cn(
                                    "flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-all",
                                    "hover:bg-accent hover:text-accent-foreground",
                                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                    (onEdit || d.removable) ? "pr-14" : "",
                                    isActive
                                        ? "bg-primary text-primary-foreground shadow-sm"
                                        : "text-muted-foreground",
                                )}
                                title={d.description}
                            >
                                <Icon className="h-4 w-4 shrink-0" />
                                <span className="hidden sm:inline">
                                    {d.label}
                                </span>
                            </button>

                            <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
                                {onEdit && (
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onEdit(d.id);
                                        }}
                                        className={cn(
                                            "rounded-full p-0.5 transition-colors",
                                            "hover:bg-accent",
                                            isActive
                                                ? "text-primary-foreground/70"
                                                : "text-muted-foreground/70",
                                        )}
                                        title={`Modifier ${d.label}`}
                                    >
                                        <Pencil className="h-3 w-3" />
                                    </button>
                                )}
                                {d.removable && onRemove && (
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onRemove(d.id);
                                        }}
                                        className={cn(
                                            "rounded-full p-0.5 transition-colors",
                                            "hover:bg-destructive/20 hover:text-destructive",
                                            isActive
                                                ? "text-primary-foreground/70"
                                                : "text-muted-foreground/70",
                                        )}
                                        title={`Supprimer ${d.label}`}
                                    >
                                        <X className="h-3 w-3" />
                                    </button>
                                )}
                            </div>
                        </div>
                    );
                })}

                {/* Dropdown to browse all subagents + restore hidden ones */}
                <div className="relative">
                    <button
                        ref={triggerRef}
                        onClick={() => setDropdownOpen((o) => !o)}
                        className={cn(
                            "flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-2 text-sm font-medium transition-all",
                            "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        )}
                        title="Voir tous les sous-agents"
                    >
                        <ChevronDown
                            className={cn(
                                "h-4 w-4 transition-transform",
                                dropdownOpen && "rotate-180",
                            )}
                        />
                    </button>

                    {dropdownOpen &&
                        triggerRef.current &&
                        createPortal(
                            <div
                                ref={dropdownRef}
                                className="fixed z-[9999] min-w-[220px] rounded-md border bg-popover p-1 shadow-md"
                                style={{
                                    left: triggerRef.current.getBoundingClientRect().left,
                                    top:
                                        triggerRef.current.getBoundingClientRect().bottom + 4,
                                }}
                            >
                                <p className="px-2 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                    Sous-agents actifs
                                </p>
                                {domains.map((d) => {
                                    const Icon = d.icon;
                                    return (
                                        <button
                                            key={d.id}
                                            onClick={() => {
                                                onChange(d.id);
                                                setDropdownOpen(false);
                                            }}
                                            className={cn(
                                                "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors",
                                                "hover:bg-accent hover:text-accent-foreground",
                                                d.id === activeId &&
                                                    "bg-accent/50 font-medium",
                                            )}
                                        >
                                            <Icon className="h-3.5 w-3.5 shrink-0" />
                                            <span className="truncate">
                                                {d.label}
                                            </span>
                                        </button>
                                    );
                                })}

                                {hiddenDomains.length > 0 && (
                                    <>
                                        <div className="my-1 border-t" />
                                        <p className="px-2 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                            Masqués
                                        </p>
                                        {hiddenDomains.map((h) => {
                                            const Icon =
                                                ICON_MAP[h.icon] ?? ICON_MAP.Bot;
                                            return (
                                                <button
                                                    key={h.domain_id}
                                                    onClick={() => {
                                                        onRestore?.(h.domain_id);
                                                        setDropdownOpen(false);
                                                    }}
                                                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
                                                >
                                                    <Icon className="h-3.5 w-3.5 shrink-0" />
                                                    <span className="truncate">
                                                        {h.name}
                                                    </span>
                                                    <RotateCcw className="h-3 w-3 ml-auto shrink-0 opacity-60" />
                                                </button>
                                            );
                                        })}
                                    </>
                                )}
                            </div>,
                            document.body,
                        )}
                </div>

                {onAdd && (
                    <button
                        onClick={onAdd}
                        className={cn(
                            "flex items-center gap-1 whitespace-nowrap rounded-md px-2.5 py-2 text-sm font-medium transition-all",
                            "border border-dashed border-muted-foreground/30",
                            "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        )}
                        title="Ajouter un sous-agent"
                    >
                        <Plus className="h-4 w-4" />
                        <span className="hidden sm:inline">Ajouter</span>
                    </button>
                )}
            </nav>
        </div>
    );
};

export default DomainTabs;
