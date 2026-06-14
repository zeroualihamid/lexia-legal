import React from "react";
import { motion } from "framer-motion";
import { FileText, Layers3, ArrowRight, Loader2, AlertTriangle, PlusCircle, Upload, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
    createReportTemplate,
    deleteReportTemplate,
    listReportTemplates,
    saveReportCss,
    saveReportTemplateHtml,
    type ReportTemplateInfo,
} from "@/lib/reporting_api";

type ReportsCatalogViewProps = {
    onClose: () => void;
    onOpenTemplate: (templateId: string) => void;
    isAgentWorkspace?: boolean;
};

const ReportsCatalogView: React.FC<ReportsCatalogViewProps> = ({
    onClose,
    onOpenTemplate,
    isAgentWorkspace = true,
}) => {
    const [templates, setTemplates] = React.useState<ReportTemplateInfo[]>([]);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);
    const [showCreateForm, setShowCreateForm] = React.useState(false);
    const [newTemplateId, setNewTemplateId] = React.useState("");
    const [newReportTitle, setNewReportTitle] = React.useState("");
    const [creating, setCreating] = React.useState(false);
    const [htmlFile, setHtmlFile] = React.useState<File | null>(null);
    const [cssFile, setCssFile] = React.useState<File | null>(null);
    const [confirmDeleteTemplateId, setConfirmDeleteTemplateId] = React.useState<string | null>(null);
    const [deletingTemplateId, setDeletingTemplateId] = React.useState<string | null>(null);

    const suggestTemplateId = React.useCallback((filename: string) => {
        return filename
            .replace(/\.[^.]+$/, "")
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, "_")
            .replace(/^_+|_+$/g, "")
            .slice(0, 80);
    }, []);

    const loadTemplates = React.useCallback(() => {
        setLoading(true);
        setError(null);
        return listReportTemplates()
            .then((items) => {
                setTemplates(items);
            })
            .catch((err) => {
                setError(String((err as any)?.message ?? err));
            })
            .finally(() => {
                setLoading(false);
            });
    }, []);

    React.useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        listReportTemplates()
            .then((items) => {
                if (cancelled) return;
                setTemplates(items);
            })
            .catch((err) => {
                if (cancelled) return;
                setError(String((err as any)?.message ?? err));
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const handleCreateTemplate = async () => {
        const template_id = newTemplateId.trim();
        const report_title = newReportTitle.trim();
        if (!template_id) {
            setError("Le champ template_id est obligatoire.");
            return;
        }
        setCreating(true);
        setError(null);
        try {
            const created = await createReportTemplate({
                template_id,
                report_title: report_title || template_id,
            });
            await loadTemplates();
            setShowCreateForm(false);
            setNewTemplateId("");
            setNewReportTitle("");
            onOpenTemplate(created.template_id);
        } catch (err) {
            setError(String((err as any)?.message ?? err));
        } finally {
            setCreating(false);
        }
    };

    const handleHtmlFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0] || null;
        setHtmlFile(file);
        if (!file) return;
        if (!newTemplateId.trim()) {
            setNewTemplateId(suggestTemplateId(file.name));
        }
        if (!newReportTitle.trim()) {
            setNewReportTitle(file.name.replace(/\.[^.]+$/, ""));
        }
    };

    const handleCssFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0] || null;
        setCssFile(file);
    };

    const handleImportTemplate = async () => {
        const template_id = newTemplateId.trim();
        const report_title = newReportTitle.trim();
        if (!template_id) {
            setError("Le champ template_id est obligatoire.");
            return;
        }
        if (!htmlFile) {
            setError("Sélectionnez un fichier HTML à importer.");
            return;
        }
        setCreating(true);
        setError(null);
        try {
            const [htmlText, cssText] = await Promise.all([
                htmlFile.text(),
                cssFile ? cssFile.text() : Promise.resolve(""),
            ]);
            const created = await createReportTemplate({
                template_id,
                report_title: report_title || htmlFile.name.replace(/\.[^.]+$/, ""),
            });
            await saveReportTemplateHtml(created.template_id, htmlText);
            if (cssFile) {
                await saveReportCss(created.template_id, cssText);
            }
            await loadTemplates();
            setShowCreateForm(false);
            setNewTemplateId("");
            setNewReportTitle("");
            setHtmlFile(null);
            setCssFile(null);
            onOpenTemplate(created.template_id);
        } catch (err) {
            setError(String((err as any)?.message ?? err));
        } finally {
            setCreating(false);
        }
    };

    const handleDeleteTemplate = async (templateId: string) => {
        setDeletingTemplateId(templateId);
        setError(null);
        try {
            await deleteReportTemplate(templateId);
            setConfirmDeleteTemplateId((current) => (current === templateId ? null : current));
            await loadTemplates();
        } catch (err) {
            setError(String((err as any)?.message ?? err));
        } finally {
            setDeletingTemplateId((current) => (current === templateId ? null : current));
        }
    };

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className={cn(
                "absolute inset-0 z-50",
                isAgentWorkspace ? "settings-warm-bg" : "bg-background"
            )}
        >
            <div className="h-full overflow-auto">
                <div className="mx-auto min-h-full max-w-[1480px] px-6 pb-20 pt-8 md:px-8 lg:px-10">
                    <div className="rounded-[30px] border border-[#E8E6E1] bg-white/90 p-5 shadow-[0_30px_80px_rgba(15,23,42,0.06)] backdrop-blur md:p-6">
                        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#E8E6E1] pb-5">
                            <div className="max-w-3xl">
                                <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#A09E99]">
                                    Rapports
                                </p>
                                <h2 className="settings-display mt-3 text-3xl tracking-[-0.04em] text-[#2B2B2B]">
                                    Catalogue des rapports disponibles
                                </h2>
                                <p className="mt-3 text-sm leading-relaxed text-[#6B6966]">
                                    Sélectionnez un rapport pour ouvrir l’espace d’édition live, inspecter les blocs HTML/SQL, dialoguer avec l’agent éditeur ou créer un nouveau rapport HTML.
                                </p>
                            </div>
                            <div className="flex flex-wrap items-center gap-3">
                                <Button
                                    variant="ghost"
                                    className="rounded-xl border border-[#E8E6E1] bg-white px-4 text-sm font-medium text-[#0D7377] hover:bg-[#F8F7F4]"
                                    onClick={() => setShowCreateForm((v) => !v)}
                                >
                                    <PlusCircle className="mr-2 h-4 w-4" />
                                    Créer un rapport HTML
                                </Button>
                                <Button
                                    variant="ghost"
                                    className="rounded-xl border border-[#E8E6E1] bg-[#F8F7F4] px-4 text-sm font-medium text-[#2B2B2B] hover:bg-white"
                                    onClick={onClose}
                                >
                                    Retour au chat
                                </Button>
                            </div>
                        </div>

                        {error && (
                            <div className="mt-6 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                                <AlertTriangle className="h-4 w-4 shrink-0" />
                                {error}
                            </div>
                        )}

                        {showCreateForm && (
                            <div className="mt-6 rounded-[26px] border border-[#E8E6E1] bg-[#FCFBF8] p-5">
                                <div className="flex flex-wrap items-start justify-between gap-4">
                                    <div className="max-w-2xl">
                                        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">
                                            Nouveau rapport
                                        </p>
                                        <h3 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-[#2B2B2B]">
                                            Créer un rapport HTML éditable
                                        </h3>
                                        <p className="mt-2 text-sm leading-relaxed text-[#6B6966]">
                                            Vous pouvez soit créer un template vide, soit importer vos propres fichiers <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[12px] text-[#2B2B2B]">HTML</code> et <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[12px] text-[#2B2B2B]">CSS</code>.
                                        </p>
                                    </div>
                                    <div className="rounded-full border border-[#0D7377]/20 bg-[#0D7377]/5 px-3 py-1 text-[11px] font-semibold text-[#0D7377]">
                                        Création / import immédiat
                                    </div>
                                </div>

                                <div className="mt-5 grid gap-4 md:grid-cols-2">
                                    <label className="block">
                                        <span className="mb-2 block text-[10px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                                            Template ID
                                        </span>
                                        <input
                                            value={newTemplateId}
                                            onChange={(e) => setNewTemplateId(e.target.value.trim().replace(/\s+/g, "_"))}
                                            placeholder="rapport_financier_v2"
                                            className="w-full rounded-xl border border-[#E8E6E1] bg-white px-4 py-3 text-sm text-[#2B2B2B] outline-none focus:border-[#0D7377]/40 focus:ring-2 focus:ring-[#0D7377]/10"
                                        />
                                    </label>
                                    <label className="block">
                                        <span className="mb-2 block text-[10px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                                            Titre du rapport
                                        </span>
                                        <input
                                            value={newReportTitle}
                                            onChange={(e) => setNewReportTitle(e.target.value)}
                                            placeholder="Rapport de performance 2026"
                                            className="w-full rounded-xl border border-[#E8E6E1] bg-white px-4 py-3 text-sm text-[#2B2B2B] outline-none focus:border-[#0D7377]/40 focus:ring-2 focus:ring-[#0D7377]/10"
                                        />
                                    </label>
                                </div>

                                <div className="mt-5 grid gap-4 md:grid-cols-2">
                                    <label className="block">
                                        <span className="mb-2 block text-[10px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                                            Fichier HTML
                                        </span>
                                        <input
                                            type="file"
                                            accept=".html,.htm,text/html"
                                            onChange={handleHtmlFileChange}
                                            className="block w-full rounded-xl border border-[#E8E6E1] bg-white px-4 py-3 text-sm text-[#2B2B2B] file:mr-3 file:rounded-lg file:border-0 file:bg-[#0D7377]/10 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-[#0D7377]"
                                        />
                                        <p className="mt-2 text-[12px] text-[#6B6966]">
                                            Obligatoire pour un import. Le fichier sera enregistré comme <span className="font-mono">report-template.html</span>.
                                        </p>
                                        {htmlFile && (
                                            <p className="mt-2 text-[12px] font-medium text-[#2B2B2B]">
                                                Sélectionné: {htmlFile.name}
                                            </p>
                                        )}
                                    </label>
                                    <label className="block">
                                        <span className="mb-2 block text-[10px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                                            Fichier CSS
                                        </span>
                                        <input
                                            type="file"
                                            accept=".css,text/css"
                                            onChange={handleCssFileChange}
                                            className="block w-full rounded-xl border border-[#E8E6E1] bg-white px-4 py-3 text-sm text-[#2B2B2B] file:mr-3 file:rounded-lg file:border-0 file:bg-[#0D7377]/10 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-[#0D7377]"
                                        />
                                        <p className="mt-2 text-[12px] text-[#6B6966]">
                                            Optionnel. Si fourni, il remplacera <span className="font-mono">report.css</span>.
                                        </p>
                                        {cssFile && (
                                            <p className="mt-2 text-[12px] font-medium text-[#2B2B2B]">
                                                Sélectionné: {cssFile.name}
                                            </p>
                                        )}
                                    </label>
                                </div>

                                <div className="mt-5 flex flex-wrap items-center gap-3">
                                    <Button
                                        type="button"
                                        className="rounded-xl bg-[#0D7377] px-4 text-white hover:bg-[#0B6164]"
                                        disabled={creating || !newTemplateId.trim()}
                                        onClick={() => void handleCreateTemplate()}
                                    >
                                        {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PlusCircle className="mr-2 h-4 w-4" />}
                                        Créer et ouvrir
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        className="rounded-xl border border-[#0D7377]/25 bg-white px-4 text-sm font-medium text-[#0D7377] hover:bg-[#F8F7F4]"
                                        disabled={creating || !newTemplateId.trim() || !htmlFile}
                                        onClick={() => void handleImportTemplate()}
                                    >
                                        {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                                        Importer et ouvrir
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        className="rounded-xl border border-[#E8E6E1] bg-white px-4 text-sm font-medium text-[#2B2B2B] hover:bg-[#F8F7F4]"
                                        onClick={() => {
                                            setShowCreateForm(false);
                                            setHtmlFile(null);
                                            setCssFile(null);
                                        }}
                                    >
                                        Annuler
                                    </Button>
                                </div>
                            </div>
                        )}

                        {loading ? (
                            <div className="mt-8 rounded-[26px] border border-[#E8E6E1] bg-[#FCFBF8] px-6 py-14 text-center text-sm text-[#6B6966]">
                                <Loader2 className="mx-auto mb-3 h-5 w-5 animate-spin text-[#0D7377]" />
                                Chargement des rapports disponibles…
                            </div>
                        ) : templates.length === 0 ? (
                            <div className="mt-8 rounded-[26px] border border-dashed border-[#E8E6E1] bg-[#FCFBF8] px-6 py-14 text-center text-sm text-[#6B6966]">
                                Aucun rapport disponible dans <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[12px] text-[#2B2B2B]">data/reporting/templates/</code>.
                            </div>
                        ) : (
                            <div className="mt-8 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
                                {templates.map((template) => {
                                    const isConfirmingDelete = confirmDeleteTemplateId === template.template_id;
                                    const isDeleting = deletingTemplateId === template.template_id;
                                    return (
                                    <div
                                        key={template.template_id}
                                        className="group rounded-[28px] border border-[#E8E6E1] bg-[#FCFBF8] p-5 text-left transition-all hover:-translate-y-1 hover:border-[#0D7377]/30 hover:bg-white hover:shadow-[0_24px_50px_rgba(13,115,119,0.08)]"
                                    >
                                        <div className="flex items-start justify-between gap-4">
                                            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-[#E8E6E1] bg-white text-[#0D7377]">
                                                <FileText className="h-5 w-5" />
                                            </div>
                                            <span className={cn(
                                                "rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em]",
                                                template.has_definitions
                                                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                                    : "border-amber-200 bg-amber-50 text-amber-700"
                                            )}>
                                                {template.has_definitions ? "Amorcé" : "À initialiser"}
                                            </span>
                                        </div>

                                        <button
                                            type="button"
                                            onClick={() => onOpenTemplate(template.template_id)}
                                            className="mt-6 block w-full text-left"
                                        >
                                            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">
                                                Template ID
                                            </p>
                                            <h3 className="settings-display mt-2 text-2xl tracking-[-0.04em] text-[#2B2B2B]">
                                                {template.template_id}
                                            </h3>
                                            <p className="mt-3 text-sm leading-relaxed text-[#6B6966]">
                                                Éditez le HTML, les blocs SQL et le rendu visuel du rapport <span className="font-semibold text-[#2B2B2B]">{template.template_id}</span>.
                                            </p>
                                        </button>

                                        <div className="mt-6 grid gap-3 sm:grid-cols-2">
                                            <div className="rounded-[20px] border border-[#E8E6E1] bg-white px-4 py-3">
                                                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">Version</p>
                                                <p className="mt-2 text-lg font-semibold text-[#2B2B2B]">v{template.version}</p>
                                            </div>
                                            <div className="rounded-[20px] border border-[#E8E6E1] bg-white px-4 py-3">
                                                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">Blocs actifs</p>
                                                <p className="mt-2 text-lg font-semibold text-[#2B2B2B]">{template.blocks_count}</p>
                                            </div>
                                        </div>

                                        <div className="mt-6 flex items-center justify-between border-t border-[#E8E6E1] pt-4">
                                            <div className="flex items-center gap-2 text-xs text-[#6B6966]">
                                                <Layers3 className="h-4 w-4 text-[#0D7377]" />
                                                {template.has_template_html ? "HTML présent" : "HTML manquant"}
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    className="h-10 rounded-xl border border-red-200 bg-red-50 px-3 text-sm font-medium text-red-700 hover:bg-red-100"
                                                    disabled={isDeleting}
                                                    onClick={() =>
                                                        setConfirmDeleteTemplateId((current) =>
                                                            current === template.template_id ? null : template.template_id
                                                        )
                                                    }
                                                >
                                                    {isDeleting ? (
                                                        <Loader2 className="h-4 w-4 animate-spin" />
                                                    ) : (
                                                        <Trash2 className="h-4 w-4" />
                                                    )}
                                                </Button>
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    className="h-10 rounded-xl border border-[#0D7377]/20 bg-white px-3 text-sm font-semibold text-[#0D7377] hover:bg-[#F8F7F4]"
                                                    onClick={() => onOpenTemplate(template.template_id)}
                                                >
                                                    Ouvrir
                                                    <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-1" />
                                                </Button>
                                            </div>
                                        </div>
                                        {isConfirmingDelete && (
                                            <div className="mt-4 rounded-[20px] border border-red-200 bg-red-50/80 px-4 py-4">
                                                <p className="text-sm font-semibold text-[#2B2B2B]">
                                                    Supprimer le rapport <span className="font-mono">{template.template_id}</span> ?
                                                </p>
                                                <p className="mt-1 text-xs leading-relaxed text-[#6B6966]">
                                                    Le dossier du template et ses fichiers HTML/CSS/définitions seront supprimés.
                                                </p>
                                                <div className="mt-3 flex flex-wrap items-center gap-2">
                                                    <Button
                                                        type="button"
                                                        className="rounded-xl bg-red-600 px-4 text-white hover:bg-red-700"
                                                        disabled={isDeleting}
                                                        onClick={() => void handleDeleteTemplate(template.template_id)}
                                                    >
                                                        {isDeleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                                                        Supprimer
                                                    </Button>
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        className="rounded-xl border border-[#E8E6E1] bg-white px-4 text-sm font-medium text-[#2B2B2B] hover:bg-[#F8F7F4]"
                                                        disabled={isDeleting}
                                                        onClick={() => setConfirmDeleteTemplateId(null)}
                                                    >
                                                        Annuler
                                                    </Button>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )})}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </motion.div>
    );
};

export default ReportsCatalogView;
