import React from 'react';
import { LayoutDashboard, MessageSquare, Settings, Activity, Sun, Moon, LogOut, PanelLeft, ArrowLeft, FlaskConical, FileText } from 'lucide-react';
import { cn } from "@/lib/utils";
import { asset } from "@/lib/asset";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { motion } from 'framer-motion';
import FileExplorer from './FileExplorer';
import SettingsView from '../features/SettingsView';
import PlaygroundView from '../features/playground/PlaygroundView';
import ReportingView from '../features/ReportingView';
import ReportsCatalogView from '../features/ReportsCatalogView';
import { Link, useNavigate, useLocation } from 'react-router-dom';

const MainLayout = ({ children, onLogout, isDarkMode, toggleTheme }) => {
    // Convert children to array to safely access them by index
    const panes = React.Children.toArray(children);
    const navigate = useNavigate();
    const location = useLocation();
    const isPlatformWorkspace = location.pathname === '/platform';
    const hideSecondaryPane = isPlatformWorkspace || location.pathname === '/opencode';
    const isAgentWorkspace = location.pathname === '/agent';

    // Responsive State
    const [isMobile, setIsMobile] = React.useState(false);
    const [isSidebarOpen, setIsSidebarOpen] = React.useState(true);
    const sidebarRef = React.useRef(null);

    React.useEffect(() => {
        const checkMobile = () => {
            setIsMobile(window.innerWidth < 768);
        };

        // Initial check
        checkMobile();

        // Listener
        window.addEventListener('resize', checkMobile);
        return () => window.removeEventListener('resize', checkMobile);
    }, []);

    // Active Tab for Mobile
    const [activeTab, setActiveTab] = React.useState('chat');
    const [activeView, setActiveView] = React.useState('chat'); // 'chat' | 'settings' | 'playground' | 'reports' | 'reporting-live'
    const [selectedReportTemplateId, setSelectedReportTemplateId] = React.useState<string | null>(null);
    const toggleSidebar = () => {
        const panel = sidebarRef.current;
        if (panel) {
            if (panel.isCollapsed()) {
                panel.expand();
            } else {
                panel.collapse();
            }
        }
    };

    return (
        <div
            className={cn(
                "h-screen w-full overflow-hidden flex flex-col",
                isAgentWorkspace
                    ? "settings-ui settings-warm-bg text-[#2B2B2B]"
                    : "bg-background"
            )}
        >
            {/* Header */}
            <div
                className={cn(
                    "shrink-0 flex items-center justify-between px-4",
                    isAgentWorkspace
                        ? "h-14 border-b border-[#E8E6E1] bg-white/90 backdrop-blur-xl"
                        : "h-12 border-b border-border/40 bg-muted/20"
                )}
            >
                <div className="flex items-center gap-3">
                    {!isMobile && !isPlatformWorkspace && (
                        <Button
                            variant="ghost"
                            size="icon"
                            className={cn(
                                isAgentWorkspace
                                    ? "h-9 w-9 rounded-xl border border-[#E8E6E1] text-[#6B6966] hover:bg-[#F8F7F4] hover:text-[#2B2B2B]"
                                    : "h-8 w-8 text-muted-foreground hover:text-foreground",
                                !isSidebarOpen && (isAgentWorkspace ? "bg-[#F8F7F4] text-[#2B2B2B]" : "bg-muted/50 text-foreground")
                            )}
                            onClick={toggleSidebar}
                            title={isSidebarOpen ? "Fermer le menu" : "Ouvrir le menu"}
                        >
                            <PanelLeft className="h-4 w-4" />
                        </Button>
                    )}
                    <Link to="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
                        <div className={cn(
                            "h-8 w-8 overflow-hidden flex items-center justify-center",
                            isAgentWorkspace ? "rounded-xl border border-[#E8E6E1] bg-[#F8F7F4]" : "rounded-lg"
                        )}>
                            <img src={asset("logo.png")} alt="Brikz logo" className="h-full w-full object-cover" />
                        </div>
                        <div>
                            <span className={cn(
                                isAgentWorkspace ? "settings-display text-[18px] tracking-[-0.03em] text-[#2B2B2B]" : "font-bold text-lg tracking-tight"
                            )}>
                                Brikz
                            </span>
                            {isAgentWorkspace && (
                                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">
                                    Workspace Agent
                                </p>
                            )}
                        </div>
                    </Link>
                </div>
                <div className="flex items-center gap-2">
                    {isPlatformWorkspace && (
                        <Button
                            variant="ghost"
                            className="h-9 rounded-xl border border-border/40 px-3 text-sm font-medium text-foreground hover:bg-muted"
                            onClick={() => navigate('/agent')}
                            title="Retour à l'agent"
                        >
                            <ArrowLeft className="h-4 w-4" />
                            Retour agent
                        </Button>
                    )}
                    <Button
                        variant="ghost"
                        size="icon"
                        className={cn(
                            isAgentWorkspace
                                ? "h-9 w-9 rounded-xl border border-[#E8E6E1] text-[#6B6966] hover:bg-[#F8F7F4] hover:text-[#2B2B2B]"
                                : "h-9 w-9 rounded-full hover:bg-muted"
                        )}
                        onClick={toggleTheme}
                        title={isDarkMode ? "Passer au mode clair" : "Passer au mode sombre"}
                    >
                        {isDarkMode ? (
                            <Sun className={cn("h-5 w-5", isAgentWorkspace ? "text-[#E8725A]" : "text-yellow-500")} />
                        ) : (
                            <Moon className={cn("h-5 w-5", isAgentWorkspace ? "text-[#0D7377]" : "text-blue-500")} />
                        )}
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        className={cn(
                            isAgentWorkspace
                                ? "h-9 w-9 rounded-xl border border-[#E8E6E1] text-[#6B6966] hover:bg-[#FFF1ED] hover:text-[#E8725A]"
                                : "h-9 w-9 rounded-full hover:bg-destructive/10 hover:text-destructive"
                        )}
                        onClick={onLogout}
                        title="Déconnexion"
                    >
                        <LogOut className="h-5 w-5" />
                    </Button>
                </div>
            </div>

            {/* Main Content */}
            <div className="flex-1 overflow-hidden relative">
                {activeView === 'settings' ? (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className={cn(
                            "absolute inset-0 z-50",
                            isAgentWorkspace ? "settings-warm-bg" : "bg-background"
                        )}
                    >
                        <SettingsView onClose={() => setActiveView('chat')} />
                    </motion.div>
                ) : null}

                {activeView === 'playground' ? (
                    <PlaygroundView onClose={() => setActiveView('chat')} />
                ) : null}

                {activeView === 'reports' ? (
                    <ReportsCatalogView
                        onClose={() => setActiveView('chat')}
                        onOpenTemplate={(templateId) => {
                            setSelectedReportTemplateId(templateId);
                            setActiveView('reporting-live');
                        }}
                        isAgentWorkspace={isAgentWorkspace}
                    />
                ) : null}

                {activeView === 'reporting-live' ? (
                    <ReportingView
                        onClose={() => setActiveView('reports')}
                        isAgentWorkspace={isAgentWorkspace}
                        initialTemplateId={selectedReportTemplateId}
                    />
                ) : null}

                {!isMobile ? (
                    isPlatformWorkspace ? (
                        <div className="h-full overflow-hidden">
                            {panes[0]}
                        </div>
                    ) : (
                    <ResizablePanelGroup orientation="horizontal">
                        {/* Left Pane: File Explorer */}
                        <ResizablePanel
                            id="sidebar"
                            ref={sidebarRef}
                            defaultSize="20"
                            minSize="15"
                            maxSize="40"
                            collapsible={true}
                            collapsedSize="0"
                            onResize={(size) => {
                                const percentage = typeof size === 'object' ? (size?.asPercentage ?? 0) : (size ?? 0);
                                if (percentage <= 5 && isSidebarOpen) {
                                    setIsSidebarOpen(false);
                                } else if (percentage > 5 && !isSidebarOpen) {
                                    setIsSidebarOpen(true);
                                }
                            }}
                            order={1}
                            className={cn(
                                isAgentWorkspace
                                    ? "bg-white/90 backdrop-blur-sm border-r border-[#E8E6E1]"
                                    : "bg-muted/10 backdrop-blur-sm"
                            )}
                        >
                            <div className="h-full flex flex-col">
                                <FileExplorer variant={isAgentWorkspace ? 'settings' : 'default'} />
                                <div
                                    className={cn(
                                        "mt-auto",
                                        isAgentWorkspace ? "p-3 border-t border-[#E8E6E1] bg-white" : "p-2 border-t border-border/40"
                                    )}
                                >
                                    <Button
                                        variant="ghost"
                                        className={cn(
                                            "w-full justify-start gap-3 h-10 px-3 mb-1 transition-all rounded-xl",
                                            isAgentWorkspace
                                                ? (location.pathname === '/agent'
                                                    ? "border border-[#0D7377]/10 bg-[#0D7377] text-white shadow-sm hover:bg-[#0B6164]"
                                                    : "text-[#6B6966] hover:bg-[#F8F7F4] hover:text-[#2B2B2B]")
                                                : (location.pathname === '/agent' ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted")
                                        )}
                                        onClick={() => navigate('/agent')}
                                    >
                                        <MessageSquare className="h-4 w-4 shrink-0" />
                                        {isSidebarOpen && <span className="text-sm font-medium">Agent Chat</span>}
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        className={cn(
                                            "w-full justify-start gap-3 h-10 px-3 mb-1 transition-all rounded-xl",
                                            isAgentWorkspace
                                                ? (location.pathname === '/platform'
                                                    ? "border border-[#0D7377]/10 bg-[#0D7377] text-white shadow-sm hover:bg-[#0B6164]"
                                                    : "text-[#6B6966] hover:bg-[#F8F7F4] hover:text-[#2B2B2B]")
                                                : (location.pathname === '/platform' ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted")
                                        )}
                                        onClick={() => navigate('/platform')}
                                    >
                                        <LayoutDashboard className="h-4 w-4 shrink-0" />
                                        {isSidebarOpen && <span className="text-sm font-medium">Platform</span>}
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        className={cn(
                                            "w-full justify-start gap-3 h-10 px-3 mb-1 transition-all rounded-xl relative group",
                                            isAgentWorkspace
                                                ? ((activeView === 'reports' || activeView === 'reporting-live')
                                                    ? "border border-[#0D7377]/10 bg-[#0D7377] text-white shadow-sm hover:bg-[#0B6164]"
                                                    : "text-[#6B6966] hover:bg-[#F8F7F4] hover:text-[#2B2B2B]")
                                                : ((activeView === 'reports' || activeView === 'reporting-live') ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted")
                                        )}
                                        onClick={() => setActiveView((activeView === 'reports' || activeView === 'reporting-live') ? 'chat' : 'reports')}
                                        title="Rapports"
                                    >
                                        <FileText className="h-4 w-4 shrink-0" />
                                        {isSidebarOpen && <span className="text-sm font-medium">Rapports</span>}
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        className={cn(
                                            "w-full justify-start gap-3 h-10 px-3 mb-1 transition-all rounded-xl relative group",
                                            isAgentWorkspace
                                                ? (activeView === 'playground'
                                                    ? "border border-[#0D7377]/10 bg-[#0D7377] text-white shadow-sm hover:bg-[#0B6164]"
                                                    : "text-[#6B6966] hover:bg-[#F8F7F4] hover:text-[#2B2B2B]")
                                                : (activeView === 'playground' ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted")
                                        )}
                                        onClick={() => setActiveView(activeView === 'playground' ? 'chat' : 'playground')}
                                        title="Playground"
                                    >
                                        <div className="relative">
                                            <FlaskConical className={cn(
                                                "h-4 w-4 shrink-0 transition-transform duration-500 group-hover:scale-110",
                                            )} />
                                            {activeView === 'playground' && (
                                                <span className="absolute -top-1 -right-1 flex h-2 w-2">
                                                    <span className={cn(
                                                        "animate-ping absolute inline-flex h-full w-full rounded-full opacity-75",
                                                        isAgentWorkspace ? "bg-emerald-400" : "bg-primary"
                                                    )}></span>
                                                    <span className={cn(
                                                        "relative inline-flex rounded-full h-2 w-2",
                                                        isAgentWorkspace ? "bg-emerald-400" : "bg-primary"
                                                    )}></span>
                                                </span>
                                            )}
                                        </div>
                                        {isSidebarOpen && <span className="text-sm font-medium">Playground</span>}
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        className={cn(
                                            "w-full justify-start gap-3 h-10 px-3 transition-all rounded-xl relative group",
                                            isAgentWorkspace
                                                ? (activeView === 'settings'
                                                    ? "border border-[#0D7377]/10 bg-[#0D7377] text-white shadow-sm hover:bg-[#0B6164]"
                                                    : "text-[#6B6966] hover:bg-[#F8F7F4] hover:text-[#2B2B2B]")
                                                : (activeView === 'settings' ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted")
                                        )}
                                        onClick={() => setActiveView(activeView === 'settings' ? 'chat' : 'settings')}
                                        title="Paramètres"
                                    >
                                        <div className="relative">
                                            <Settings className={cn(
                                                "h-4 w-4 shrink-0 transition-transform duration-500 group-hover:rotate-90",
                                                activeView === 'settings' && "animate-spin-slow"
                                            )} />
                                            {activeView === 'settings' && (
                                                <span className="absolute -top-1 -right-1 flex h-2 w-2">
                                                    <span className={cn(
                                                        "animate-ping absolute inline-flex h-full w-full rounded-full opacity-75",
                                                        isAgentWorkspace ? "bg-[#E8725A]" : "bg-primary"
                                                    )}></span>
                                                    <span className={cn(
                                                        "relative inline-flex rounded-full h-2 w-2",
                                                        isAgentWorkspace ? "bg-[#E8725A]" : "bg-primary"
                                                    )}></span>
                                                </span>
                                            )}
                                        </div>
                                        {isSidebarOpen && <span className="text-sm font-medium">Paramètres</span>}
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        className={cn(
                                            "w-full justify-start gap-3 h-10 px-3 mt-1 rounded-xl",
                                            isAgentWorkspace
                                                ? "text-[#6B6966] hover:bg-[#FFF1ED] hover:text-[#E8725A]"
                                                : "text-muted-foreground hover:bg-muted"
                                        )}
                                        onClick={onLogout}
                                    >
                                        <LogOut className="h-4 w-4 shrink-0" />
                                        {isSidebarOpen && <span className="text-sm font-medium">Déconnexion</span>}
                                    </Button>
                                </div>
                            </div>
                        </ResizablePanel>

                        <ResizableHandle
                            withHandle={true}
                            className={cn(
                                isAgentWorkspace
                                    ? "w-1 hover:w-1.5 transition-all duration-200 bg-[#E8E6E1] hover:bg-[#0D7377]/30"
                                    : "w-1 hover:w-1.5 transition-all duration-200 bg-border hover:bg-primary",
                                !isSidebarOpen && (isAgentWorkspace ? "w-2 bg-[#0D7377]/20" : "w-2 bg-primary/40")
                            )}
                        />

                        {/* Center Pane: Agent Chat */}
                        <ResizablePanel id="chat" defaultSize="50" minSize="30" order={2}>
                            <div className={cn(
                                "h-full relative flex flex-col overflow-hidden",
                                isAgentWorkspace ? "settings-warm-bg" : "bg-background"
                            )}>
                                <div
                                    className={cn(
                                        "absolute inset-0 pointer-events-none",
                                        isAgentWorkspace
                                            ? "bg-[radial-gradient(circle_at_top_left,rgba(13,115,119,0.08),transparent_32%),radial-gradient(circle_at_bottom_right,rgba(232,114,90,0.08),transparent_28%)]"
                                            : "bg-gradient-to-tr from-blue-500/5 to-purple-500/5"
                                    )}
                                />
                                {panes[0]}
                            </div>
                        </ResizablePanel>

                        {!hideSecondaryPane && (
                            <>
                                <ResizableHandle
                                    withHandle={true}
                                    className={cn(
                                        isAgentWorkspace
                                            ? "w-1 hover:w-1.5 transition-all duration-200 bg-[#E8E6E1] hover:bg-[#0D7377]/30"
                                            : "w-1 hover:w-1.5 transition-all duration-200 bg-border hover:bg-primary"
                                    )}
                                />

                                {/* Right Pane: Analysis/Graph */}
                                <ResizablePanel id="analysis" defaultSize="30" minSize="25" order={3}>
                                    <div className={cn(
                                        "h-full overflow-hidden",
                                        isAgentWorkspace
                                            ? "border-l border-[#E8E6E1] bg-[#FBFAF7]"
                                            : "bg-muted/5 border-l border-border/40"
                                    )}>
                                        {panes[1]}
                                    </div>
                                </ResizablePanel>
                            </>
                        )}
                    </ResizablePanelGroup>
                    )
                ) : (
                    isPlatformWorkspace ? (
                        <div className="h-full overflow-hidden">
                            {panes[0]}
                        </div>
                    ) : (
                    <div className="h-full flex flex-col">
                        <div className="flex-1 overflow-hidden relative">
                            {activeTab === 'explorer' && (
                                <div className="h-full animate-in fade-in slide-in-from-left-4 duration-300">
                                    <FileExplorer />
                                </div>
                            )}
                            {activeTab === 'chat' && (
                                <div className="h-full animate-in fade-in zoom-in-95 duration-300 relative flex flex-col">
                                    <div className="absolute inset-0 bg-gradient-to-tr from-blue-500/5 to-purple-500/5 pointer-events-none" />
                                    {panes[0]}
                                </div>
                            )}
                            {activeTab === 'dashboard' && (
                                <div className="h-full animate-in fade-in slide-in-from-right-4 duration-300">
                                    {panes[1]}
                                </div>
                            )}
                        </div>

                        {/* Mobile Bottom Navigation */}
                        <div className="h-16 border-t border-border/40 bg-muted/30 backdrop-blur-md flex items-center justify-around px-2 shrink-0">
                            <Button
                                variant="ghost"
                                title="Menu"
                                className={cn(
                                    "flex flex-col gap-1 h-12 w-20 rounded-xl transition-all",
                                    activeTab === 'explorer' ? "text-blue-500 bg-blue-500/10" : "text-muted-foreground"
                                )}
                                onClick={() => setActiveTab('explorer')}
                            >
                                <LayoutDashboard className="h-5 w-5" />
                                <span className="text-[10px] uppercase font-bold tracking-widest">Menu</span>
                            </Button>
                            <Button
                                variant="ghost"
                                title="Chat"
                                className={cn(
                                    "flex flex-col gap-1 h-12 w-20 rounded-xl transition-all",
                                    activeTab === 'chat' ? "text-purple-500 bg-purple-500/10" : "text-muted-foreground"
                                )}
                                onClick={() => setActiveTab('chat')}
                            >
                                <MessageSquare className="h-5 w-5" />
                                <span className="text-[10px] uppercase font-bold tracking-widest">Chat</span>
                            </Button>
                            <Button
                                variant="ghost"
                                title="Graphes"
                                className={cn(
                                    "flex flex-col gap-1 h-12 w-20 rounded-xl transition-all",
                                    activeTab === 'dashboard' ? "text-emerald-500 bg-emerald-500/10" : "text-muted-foreground"
                                )}
                                onClick={() => setActiveTab('dashboard')}
                            >
                                <Activity className="h-5 w-5" />
                                <span className="text-[10px] uppercase font-bold tracking-widest">Graphes</span>
                            </Button>
                        </div>
                    </div>
                    )
                )}
            </div>
        </div >
    );
};

export default MainLayout;
