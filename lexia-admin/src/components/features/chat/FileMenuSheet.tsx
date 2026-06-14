import React, { useState } from "react";
import {
  FileText,
  Download,
  ExternalLink,
  FolderOpen,
  File,
  Image as ImageIcon,
  X,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

export interface GeneratedFile {
  id: string;
  name: string;
  url: string;
  type: "pdf" | "image" | "other";
  createdAt: string;
}

interface FileMenuSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  files?: GeneratedFile[];
}

const typeIcon = (type: GeneratedFile["type"]) => {
  switch (type) {
    case "pdf":
      return <FileText className="h-4 w-4 text-red-500" />;
    case "image":
      return <ImageIcon className="h-4 w-4 text-blue-500" />;
    default:
      return <File className="h-4 w-4 text-muted-foreground" />;
  }
};

const formatDate = (iso: string) => {
  try {
    return new Date(iso).toLocaleDateString("fr-FR", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
};

const FileMenuSheet: React.FC<FileMenuSheetProps> = ({
  open,
  onOpenChange,
  files = [],
}) => {
  const [selectedFile, setSelectedFile] = useState<GeneratedFile | null>(null);

  const handleDownload = (file: GeneratedFile) => {
    const a = document.createElement("a");
    a.href = file.url;
    a.download = file.name;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.click();
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-2xl flex flex-col p-0 bg-[#fafaf8] dark:bg-[#0d0d0d] border-l border-black/[0.06] dark:border-white/[0.06]"
      >
        {/* Header */}
        <SheetHeader className="px-5 py-4 border-b border-black/[0.06] dark:border-white/[0.06] shrink-0">
          <SheetTitle className="flex items-center gap-2.5 text-[15px] font-semibold">
            <div className="h-8 w-8 rounded-xl bg-blue-500/10 flex items-center justify-center">
              <FolderOpen className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            </div>
            Fichiers générés
          </SheetTitle>
          <SheetDescription className="text-[13px] text-muted-foreground/70">
            Documents, PDFs et exports produits par l'assistant
          </SheetDescription>
        </SheetHeader>

        {/* Content */}
        <div className="flex-1 flex min-h-0">
          {/* File list */}
          <ScrollArea className="w-72 border-r border-black/[0.06] dark:border-white/[0.06] shrink-0">
            <div className="p-3 space-y-1">
              {files.length === 0 ? (
                <div className="flex flex-col items-center gap-3 py-12 px-4 text-center">
                  <div className="h-12 w-12 rounded-2xl bg-muted/40 flex items-center justify-center">
                    <FolderOpen className="h-5 w-5 text-muted-foreground/50" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-muted-foreground/70">
                      Aucun fichier
                    </p>
                    <p className="text-xs text-muted-foreground/50 mt-1">
                      Les fichiers générés apparaîtront ici
                    </p>
                  </div>
                </div>
              ) : (
                files.map((file) => (
                  <button
                    key={file.id}
                    type="button"
                    onClick={() => setSelectedFile(file)}
                    className={`w-full flex items-start gap-3 p-3 rounded-xl text-left transition-all ${
                      selectedFile?.id === file.id
                        ? "bg-blue-500/8 border border-blue-500/20 shadow-[0_0_0_1px_rgba(59,130,246,0.1)]"
                        : "hover:bg-black/[0.03] dark:hover:bg-white/[0.03] border border-transparent"
                    }`}
                  >
                    <div className="mt-0.5 shrink-0">{typeIcon(file.type)}</div>
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-foreground/90">
                        {file.name}
                      </span>
                      <span className="block text-[11px] text-muted-foreground/60 mt-0.5">
                        {formatDate(file.createdAt)}
                      </span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </ScrollArea>

          {/* Preview */}
          <div className="flex-1 flex flex-col min-w-0">
            <AnimatePresence mode="wait">
              {selectedFile ? (
                <motion.div
                  key={selectedFile.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex-1 flex flex-col"
                >
                  <div className="px-4 py-3 border-b border-black/[0.06] dark:border-white/[0.06] flex items-center gap-3 shrink-0">
                    {typeIcon(selectedFile.type)}
                    <span className="truncate text-[13px] font-medium flex-1">
                      {selectedFile.name}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 rounded-lg gap-1.5 text-xs"
                      onClick={() => handleDownload(selectedFile)}
                    >
                      <Download className="h-3.5 w-3.5" />
                      Télécharger
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 rounded-lg gap-1.5 text-xs"
                      onClick={() =>
                        window.open(selectedFile.url, "_blank", "noopener,noreferrer")
                      }
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      Ouvrir
                    </Button>
                  </div>
                  <div className="flex-1 min-h-0 p-3">
                    {selectedFile.type === "pdf" ? (
                      <iframe
                        src={selectedFile.url}
                        title={selectedFile.name}
                        className="w-full h-full rounded-xl border border-black/[0.06] dark:border-white/[0.06] bg-white dark:bg-white/5"
                      />
                    ) : (
                      <div className="h-full flex items-center justify-center rounded-xl bg-muted/20 border border-dashed border-black/[0.06] dark:border-white/[0.06]">
                        <a
                          href={selectedFile.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-2 text-sm"
                        >
                          <ExternalLink className="h-4 w-4" />
                          Ouvrir le fichier
                        </a>
                      </div>
                    )}
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  key="empty"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-8"
                >
                  <div className="h-14 w-14 rounded-2xl bg-muted/30 flex items-center justify-center">
                    <FileText className="h-6 w-6 text-muted-foreground/30" />
                  </div>
                  <p className="text-sm text-muted-foreground/50">
                    Sélectionnez un fichier pour l'afficher
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
};

export default FileMenuSheet;
