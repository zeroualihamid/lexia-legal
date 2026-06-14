import React, { useState, useCallback, useRef, useEffect } from "react";
import {
  ArrowLeft,
  PanelLeftClose,
  PanelLeft,
  FolderOpen,
  BarChart3,
  History,
  Plus,
  X,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import { useChat } from "@/hooks/useChat";
import ChatInterface from "./ChatInterface";
import { ChartGallery } from "./ChartGallery";
import FileExplorer from "@/components/layout/FileExplorer";
import FileMenuSheet, { type GeneratedFile } from "./chat/FileMenuSheet";
import { asset } from "@/lib/asset";

type RightPanel = "charts" | null;

const ChatPage: React.FC = () => {
  const navigate = useNavigate();
  const chat = useChat();

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [rightPanel, setRightPanel] = useState<RightPanel>("charts");
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [generatedFiles] = useState<GeneratedFile[]>([]);

  const handleBack = () => {
    if (window.history.length > 1) navigate(-1);
    else navigate("/agent");
  };

  const handleChartClick = useCallback(
    (chartId: string) => {
      chat.setCurrentChartId(chartId);
      const msg = chat.messages.find((m) => m.chartId === chartId);
      if (msg) {
        const el = document.getElementById(`message-${msg.id}`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.classList.add("ring-2", "ring-blue-500/40");
          setTimeout(() => el.classList.remove("ring-2", "ring-blue-500/40"), 2200);
        }
      }
    },
    [chat.messages, chat.setCurrentChartId]
  );

  const toggleRightPanel = (panel: RightPanel) => {
    setRightPanel((prev) => (prev === panel ? null : panel));
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div className="h-screen w-full flex bg-[#fafaf8] dark:bg-[#0d0d0d] overflow-hidden">
        {/* ─── LEFT: Sidebar ─── */}
        <AnimatePresence mode="wait">
          {sidebarOpen && (
            <motion.aside
              key="sidebar"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 280, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeInOut" }}
              className="shrink-0 h-full flex flex-col border-r border-black/[0.06] dark:border-white/[0.06] bg-[#f5f4f0] dark:bg-[#141414] overflow-hidden"
            >
              {/* Sidebar header */}
              <div className="h-14 flex items-center justify-between px-4 shrink-0">
                <div className="flex items-center gap-2">
                  <div className="h-7 w-7 rounded-lg overflow-hidden">
                    <img src={asset("logo.png")} alt="qclick" className="h-full w-full object-cover" />
                  </div>
                  <span className="text-[13px] font-semibold tracking-tight text-foreground/90">
                    qclick
                  </span>
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground"
                      onClick={() => setSidebarOpen(false)}
                    >
                      <PanelLeftClose className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">Fermer le menu</TooltipContent>
                </Tooltip>
              </div>

              {/* New chat button */}
              <div className="px-3 pb-3 shrink-0">
                <Button
                  variant="outline"
                  className="w-full h-9 justify-start gap-2 rounded-xl border-black/[0.08] dark:border-white/[0.08] bg-white dark:bg-white/5 text-[13px] font-medium shadow-[0_1px_2px_rgba(0,0,0,0.04)] hover:shadow-[0_1px_3px_rgba(0,0,0,0.08)] transition-shadow"
                  onClick={chat.clearHistory}
                >
                  <Plus className="h-4 w-4" />
                  Nouvelle conversation
                </Button>
              </div>

              {/* Conversations */}
              <div className="flex-1 min-h-0 overflow-hidden">
                <FileExplorer />
              </div>

              {/* Sidebar bottom actions */}
              <div className="p-3 border-t border-black/[0.06] dark:border-white/[0.06] flex flex-col gap-1 shrink-0">
                <Button
                  variant="ghost"
                  className="w-full h-9 justify-start gap-2.5 rounded-xl text-[13px] text-muted-foreground hover:text-foreground hover:bg-black/[0.04] dark:hover:bg-white/[0.04]"
                  onClick={() => setFileMenuOpen(true)}
                >
                  <FolderOpen className="h-4 w-4" />
                  Fichiers générés
                </Button>
                <Button
                  variant="ghost"
                  className="w-full h-9 justify-start gap-2.5 rounded-xl text-[13px] text-muted-foreground hover:text-foreground hover:bg-black/[0.04] dark:hover:bg-white/[0.04]"
                  onClick={handleBack}
                >
                  <ArrowLeft className="h-4 w-4" />
                  Retour à l'agent
                </Button>
              </div>
            </motion.aside>
          )}
        </AnimatePresence>

        {/* ─── CENTER: Chat ─── */}
        <main className="flex-1 min-w-0 h-full flex flex-col relative">
          {/* Subtle background texture */}
          <div className="absolute inset-0 pointer-events-none opacity-40 dark:opacity-20">
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(120,119,198,0.08),transparent_50%)]" />
            <div className="absolute bottom-0 left-0 right-0 h-40 bg-gradient-to-t from-[#fafaf8] dark:from-[#0d0d0d] to-transparent" />
          </div>

          {/* Top bar */}
          <div className="relative z-10 h-14 flex items-center gap-2 px-4 shrink-0">
            {!sidebarOpen && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground"
                    onClick={() => setSidebarOpen(true)}
                  >
                    <PanelLeft className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Ouvrir le menu</TooltipContent>
              </Tooltip>
            )}
            <div className="flex-1" />

            {/* Right panel toggles */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={`h-8 w-8 rounded-lg transition-colors ${
                    rightPanel === "charts"
                      ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => toggleRightPanel("charts")}
                >
                  <BarChart3 className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {rightPanel === "charts" ? "Masquer les graphiques" : "Afficher les graphiques"}
              </TooltipContent>
            </Tooltip>
          </div>

          {/* Chat content */}
          <div className="relative z-10 flex-1 min-h-0 overflow-hidden">
            <ChatInterface
              messages={chat.messages}
              isLoading={chat.isLoading}
              isUploading={chat.isUploading}
              onSend={chat.sendMessage}
              onUpload={chat.uploadFiles}
              onClear={chat.clearHistory}
              charts={chat.charts}
              setCurrentChartId={chat.setCurrentChartId}
              useVoiceInput
            />
          </div>
        </main>

        {/* ─── RIGHT: Charts panel ─── */}
        <AnimatePresence mode="wait">
          {rightPanel === "charts" && (
            <motion.aside
              key="charts"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 420, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeInOut" }}
              className="shrink-0 h-full border-l border-black/[0.06] dark:border-white/[0.06] bg-[#f5f4f0] dark:bg-[#141414] overflow-hidden flex flex-col"
            >
              {/* Charts header */}
              <div className="h-14 flex items-center justify-between px-4 shrink-0">
                <div className="flex items-center gap-2">
                  <BarChart3 className="h-4 w-4 text-blue-500" />
                  <span className="text-[13px] font-semibold tracking-tight text-foreground/90">
                    Graphiques
                  </span>
                  {chat.charts.length > 0 && (
                    <span className="text-[11px] font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400 px-2 py-0.5 rounded-full">
                      {chat.charts.length}
                    </span>
                  )}
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground"
                      onClick={() => setRightPanel(null)}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left">Fermer</TooltipContent>
                </Tooltip>
              </div>

              {/* Charts content */}
              <div className="flex-1 min-h-0 overflow-hidden">
                <ChartGallery
                  charts={chat.charts}
                  currentChartId={chat.currentChartId}
                  isLoading={chat.isChartLoading}
                  onChartClick={handleChartClick}
                />
              </div>
            </motion.aside>
          )}
        </AnimatePresence>

        {/* Files sheet */}
        <FileMenuSheet
          open={fileMenuOpen}
          onOpenChange={setFileMenuOpen}
          files={generatedFiles}
        />
      </div>
    </TooltipProvider>
  );
};

export default ChatPage;
