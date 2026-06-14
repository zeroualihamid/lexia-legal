import React from 'react';
import { motion } from 'framer-motion';
import {
    FileText,
    ChevronLeft,
    ChevronRight,
    Download,
    CalendarDays,
    Building2,
    BadgeCheck,
    MessageSquare,
    Send,
    Sparkles,
} from 'lucide-react';
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import reportTemplateHtml from '../../../../qclick-agent/data/reporting/templates/model1/report-template.html?raw';
import reportTemplateCss from '../../../../qclick-agent/data/reporting/templates/model1/report.css?raw';

const REPORTS = [
    {
        id: 'banque-q2',
        title: 'Performance Banque Q2',
        sector: 'Banque',
        status: 'Prêt',
        updatedAt: '26 avr. 2026',
        owner: 'Expert Banque & Risque',
        summary: 'Synthèse exécutive de la performance commerciale, du coût du risque et de la rentabilité agence.',
        clientName: 'Banque Atlas Corporate',
        year: '2026',
        periodLabel: 'T2 2026',
        periodDescription: 'Analyse arrêtée au 30 juin 2026, basée sur les données consolidées de production et risque.',
        currentPeriodLabel: 'T2 2026',
        priorPeriodLabel: 'T2 2025',
        scoreGlobal: '92',
        scoreLevel: 'tres-fiable',
        scoreLevelLabel: 'Très fiable',
        scoreTraitement: '95',
        montantTraite: '19,8 M MAD',
        scoreNonTraite: '3',
        montantNonTraite: '620 k MAD',
        scoreAjustement: '2',
        montantAjuste: '410 k MAD',
        totalProduitsN: '48,2 M MAD',
        totalProduitsN1: '44,5 M MAD',
        totalChargesN: '39,8 M MAD',
        totalChargesN1: '37,4 M MAD',
        resultatN: '8,4 M MAD',
        resultatN1: '7,1 M MAD',
        resultatNetN: '6,9 M MAD',
        resultatNetN1: '5,8 M MAD',
        pnlProduitsRows: [
            { lineLabel: 'Marge d’intérêt', amountN: '26,4 M MAD', amountN1: '24,1 M MAD' },
            { lineLabel: 'Commissions & cash management', amountN: '14,7 M MAD', amountN1: '13,2 M MAD' },
            { lineLabel: 'Autres produits bancaires', amountN: '7,1 M MAD', amountN1: '7,2 M MAD' },
        ],
        pnlChargesRows: [
            { lineLabel: 'Charges de personnel', amountN: '18,6 M MAD', amountN1: '17,5 M MAD' },
            { lineLabel: 'Coût du risque', amountN: '9,4 M MAD', amountN1: '8,1 M MAD' },
            { lineLabel: 'Charges d’exploitation', amountN: '11,8 M MAD', amountN1: '11,8 M MAD' },
        ],
        sections: [
            'Executive summary',
            'KPIs PNB, marge et commissions',
            'Analyse du coût du risque',
            'Anomalies agences et segments',
            'Plan d’action 90 jours',
        ],
        highlights: [
            { label: 'Croissance PNB', value: '+8.4%', tone: 'positive' },
            { label: 'Agences sous cible', value: '12', tone: 'warning' },
            { label: 'Alertes risque', value: '4', tone: 'negative' },
        ],
        insights: [
            'La croissance provient principalement du segment PME et des commissions de cash management.',
            'Quatre portefeuilles concentrent la hausse du coût du risque et nécessitent une revue crédit immédiate.',
            'Les agences Casablanca Nord et Rabat Centre surperforment grâce à un mix produits plus profitable.',
        ],
        actions: [
            'Revue ciblée des dossiers sensibles avec l’équipe risque.',
            'Réallocation des objectifs agences sur les segments à meilleure marge.',
            'Préparation d’un reporting comité crédit enrichi par les anomalies détectées.',
        ],
    },
    {
        id: 'gestion-closing',
        title: 'Clôture Gestion Mars',
        sector: 'Contrôle de gestion',
        status: 'En revue',
        updatedAt: '24 avr. 2026',
        owner: 'Expert Contrôle de Gestion',
        summary: 'Rapport d’analyse des écarts budgétaires, tensions de trésorerie et trajectoire de clôture mensuelle.',
        clientName: 'Studio Colonie',
        year: '2026',
        periodLabel: 'Mars 2026',
        periodDescription: 'Synthèse de clôture mensuelle et prévision de trajectoire budgétaire à fin trimestre.',
        currentPeriodLabel: 'Mars 2026',
        priorPeriodLabel: 'Mars 2025',
        scoreGlobal: '84',
        scoreLevel: 'fiable',
        scoreLevelLabel: 'Fiable',
        scoreTraitement: '89',
        montantTraite: '7,3 M MAD',
        scoreNonTraite: '7',
        montantNonTraite: '380 k MAD',
        scoreAjustement: '4',
        montantAjuste: '210 k MAD',
        totalProduitsN: '11,6 M MAD',
        totalProduitsN1: '10,9 M MAD',
        totalChargesN: '10,4 M MAD',
        totalChargesN1: '9,8 M MAD',
        resultatN: '1,2 M MAD',
        resultatN1: '1,1 M MAD',
        resultatNetN: '0,9 M MAD',
        resultatNetN1: '0,8 M MAD',
        pnlProduitsRows: [
            { lineLabel: 'Chiffre d’affaires services', amountN: '8,7 M MAD', amountN1: '8,1 M MAD' },
            { lineLabel: 'Prestations projet', amountN: '2,1 M MAD', amountN1: '2,0 M MAD' },
            { lineLabel: 'Autres produits', amountN: '0,8 M MAD', amountN1: '0,8 M MAD' },
        ],
        pnlChargesRows: [
            { lineLabel: 'Achats & sous-traitance', amountN: '4,6 M MAD', amountN1: '4,3 M MAD' },
            { lineLabel: 'Charges de structure', amountN: '3,1 M MAD', amountN1: '2,9 M MAD' },
            { lineLabel: 'Charges de personnel', amountN: '2,7 M MAD', amountN1: '2,6 M MAD' },
        ],
        sections: [
            'Résumé de clôture',
            'Analyse des écarts budget / réel',
            'Focus BFR et trésorerie',
            'Hypothèses de reforecast',
            'Recommandations de pilotage',
        ],
        highlights: [
            { label: 'Écart OPEX', value: '+5.1%', tone: 'warning' },
            { label: 'Cash conversion', value: '61 j', tone: 'neutral' },
            { label: 'Actions prioritaires', value: '6', tone: 'positive' },
        ],
        insights: [
            'Les surcoûts logistiques expliquent l’essentiel de la dérive OPEX sur mars.',
            'Le DSO progresse plus vite que prévu sur deux filiales commerciales.',
            'Le reforecast trimestriel reste tenable sous réserve d’un plan achats resserré.',
        ],
        actions: [
            'Lancer une revue DSO par client majeur.',
            'Geler les dépenses discrétionnaires sur les centres en dépassement.',
            'Mettre à jour le pack de clôture avec les explications standardisées.',
        ],
    },
    {
        id: 'rgpd-audit',
        title: 'Audit RGPD Données Clients',
        sector: 'RGPD',
        status: 'Brouillon',
        updatedAt: '22 avr. 2026',
        owner: 'Expert RGPD / conformité',
        summary: 'Évaluation de l’exposition des données personnelles, des durées de conservation et des plans de remédiation.',
        clientName: 'Direction Data & Conformité',
        year: '2026',
        periodLabel: 'Avril 2026',
        periodDescription: 'Rapport d’audit des traitements de données clients, exposition des exports et trajectoire de remédiation.',
        currentPeriodLabel: 'Avr. 2026',
        priorPeriodLabel: 'Avr. 2025',
        scoreGlobal: '71',
        scoreLevel: 'acceptable',
        scoreLevelLabel: 'Acceptable',
        scoreTraitement: '76',
        montantTraite: '18 traitements',
        scoreNonTraite: '17',
        montantNonTraite: '3 écarts critiques',
        scoreAjustement: '7',
        montantAjuste: '11 actions',
        totalProduitsN: '18 traitements',
        totalProduitsN1: '15 traitements',
        totalChargesN: '3 écarts critiques',
        totalChargesN1: '2 écarts critiques',
        resultatN: '11 actions planifiées',
        resultatN1: '8 actions planifiées',
        resultatNetN: '71%',
        resultatNetN1: '68%',
        pnlProduitsRows: [
            { lineLabel: 'Traitements cartographiés', amountN: '18', amountN1: '15' },
            { lineLabel: 'Exports sensibles documentés', amountN: '9', amountN1: '7' },
            { lineLabel: 'Bases revues', amountN: '6', amountN1: '5' },
        ],
        pnlChargesRows: [
            { lineLabel: 'Écarts de conservation', amountN: '3', amountN1: '2' },
            { lineLabel: 'Accès à réduire', amountN: '5', amountN1: '4' },
            { lineLabel: 'Actions de remédiation', amountN: '11', amountN1: '8' },
        ],
        sections: [
            'Cartographie des traitements',
            'Données sensibles détectées',
            'Écarts de conformité',
            'Actions de remédiation',
            'Priorisation 30 / 60 / 90 jours',
        ],
        highlights: [
            { label: 'Traitements revus', value: '18', tone: 'neutral' },
            { label: 'Écarts critiques', value: '3', tone: 'negative' },
            { label: 'Actions planifiées', value: '11', tone: 'positive' },
        ],
        insights: [
            'Trois exports métiers exposent des données à caractère personnel sans politique de purge formalisée.',
            'Les traitements marketing disposent d’une documentation incomplète sur la base légale.',
            'La remédiation la plus rapide porte sur la réduction des accès et la suppression d’exports obsolètes.',
        ],
        actions: [
            'Limiter les accès aux exports sensibles par rôle.',
            'Formaliser la durée de conservation par traitement.',
            'Préparer une note DPO de validation avant publication du rapport final.',
        ],
    },
];

const toneClasses = {
    positive: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    warning: 'border-amber-200 bg-amber-50 text-amber-700',
    negative: 'border-red-200 bg-red-50 text-red-700',
    neutral: 'border-[#E8E6E1] bg-white text-[#4A4845]',
};

const buildTemplateRows = (
    blockName: string,
    rows: Array<{ lineLabel: string; amountN: string; amountN1: string }>
) => {
    const blockPattern = new RegExp(
        `<!-- BEGIN:${blockName} -->([\\s\\S]*?)<!-- END:${blockName} -->`,
        'm'
    );

    return (html: string) => html.replace(blockPattern, (_, rowTemplate: string) => (
        rows.map((row) => (
            rowTemplate
                .replaceAll('{{LINE_LABEL}}', row.lineLabel)
                .replaceAll('{{AMOUNT_N}}', row.amountN)
                .replaceAll('{{AMOUNT_N1}}', row.amountN1)
        )).join('\n')
    ));
};

const stripUnusedTemplateBlocks = (html: string) => (
    html
        .replace(/<!-- IF:has_monthly -->[\s\S]*<!-- ENDIF:has_monthly -->/g, '')
        .replace(/<!-- IF:has_pnl_footnote -->[\s\S]*<!-- ENDIF:has_pnl_footnote -->/g, '')
);

const inlineReportTemplate = (report: typeof REPORTS[number]) => {
    const replacements: Record<string, string> = {
        REPORT_TITLE: report.title,
        CLIENT_NAME: report.clientName,
        YEAR: report.year,
        PERIOD_LABEL: report.periodLabel,
        PERIOD_DESCRIPTION: report.periodDescription,
        CURRENT_PERIOD_LABEL: report.currentPeriodLabel,
        PRIOR_PERIOD_LABEL: report.priorPeriodLabel,
        SCORE_GLOBAL: report.scoreGlobal,
        SCORE_LEVEL: report.scoreLevel,
        SCORE_LEVEL_LABEL: report.scoreLevelLabel,
        SCORE_TRAITEMENT: report.scoreTraitement,
        MONTANT_TRAITE: report.montantTraite,
        SCORE_NON_TRAITE: report.scoreNonTraite,
        MONTANT_NON_TRAITE: report.montantNonTraite,
        SCORE_AJUSTEMENT: report.scoreAjustement,
        MONTANT_AJUSTE: report.montantAjuste,
        TOTAL_PRODUITS_N: report.totalProduitsN,
        TOTAL_PRODUITS_N1: report.totalProduitsN1,
        TOTAL_CHARGES_N: report.totalChargesN,
        TOTAL_CHARGES_N1: report.totalChargesN1,
        RESULTAT_N: report.resultatN,
        RESULTAT_N1: report.resultatN1,
        RESULTAT_NET_N: report.resultatNetN,
        RESULTAT_NET_N1: report.resultatNetN1,
        PNL_FOOTNOTE: '',
    };

    let html = reportTemplateHtml
        .replace('<link rel="stylesheet" href="report.css">', `<style>${reportTemplateCss}</style>`);

    html = buildTemplateRows('pnl_produits', report.pnlProduitsRows)(html);
    html = buildTemplateRows('pnl_charges', report.pnlChargesRows)(html);
    html = stripUnusedTemplateBlocks(html);

    Object.entries(replacements).forEach(([token, value]) => {
        html = html.replaceAll(`{{${token}}}`, value);
    });

    html = html
        .replaceAll('{{PNL_FOOTNOTE}}', '')
        .replace(/{{[A-Z0-9_]+}}/g, '')
        .replace(/<!-- NARRATIVE:[\s\S]*?-->/g, '');

    return html;
};

type ReportsWorkspaceProps = {
    onClose: () => void;
    isAgentWorkspace?: boolean;
};

type ReportChatMessage = {
    role: 'assistant' | 'user';
    content: string;
};

const buildInitialChatMessage = (report: typeof REPORTS[number]): ReportChatMessage[] => [
    {
        role: 'assistant',
        content: `Je suis prêt à commenter le rapport "${report.title}". Je peux résumer les KPIs, expliquer les risques, détailler les insights et proposer les prochaines actions à partir des données affichées.`,
    },
];

const buildReportReply = (report: typeof REPORTS[number], rawQuestion: string) => {
    const question = rawQuestion.toLowerCase();

    if (question.includes('kpi') || question.includes('indicateur') || question.includes('chiffre')) {
        return `KPIs principaux pour ${report.title} : ${report.highlights.map((item) => `${item.label} ${item.value}`).join(' ; ')}.`;
    }

    if (question.includes('risque') || question.includes('alerte') || question.includes('attention')) {
        return `Points de vigilance relevés : ${report.insights.join(' ')}`;
    }

    if (question.includes('action') || question.includes('recommand') || question.includes('prochaine étape')) {
        return `Actions recommandées : ${report.actions.join(' ')}`;
    }

    if (question.includes('résum') || question.includes('summary') || question.includes('synth')) {
        return `${report.summary} Les constats clés sont les suivants : ${report.insights.join(' ')}`;
    }

    return `Sur ${report.title}, la synthèse est la suivante : ${report.summary} KPIs suivis : ${report.highlights.map((item) => `${item.label} ${item.value}`).join(' ; ')}. Recommandations prioritaires : ${report.actions.join(' ')}`;
};

const ReportsWorkspace: React.FC<ReportsWorkspaceProps> = ({ onClose, isAgentWorkspace = true }) => {
    const [selectedReportId, setSelectedReportId] = React.useState(REPORTS[0].id);
    const [isReportListCollapsed, setIsReportListCollapsed] = React.useState(false);
    const [isChatCollapsed, setIsChatCollapsed] = React.useState(false);
    const [chatInput, setChatInput] = React.useState('');
    const [reportChats, setReportChats] = React.useState<Record<string, ReportChatMessage[]>>(() => (
        Object.fromEntries(
            REPORTS.map((report) => [report.id, buildInitialChatMessage(report)])
        )
    ));

    const selectedReport = REPORTS.find((report) => report.id === selectedReportId) || REPORTS[0];
    const selectedReportHtml = React.useMemo(() => inlineReportTemplate(selectedReport), [selectedReport]);
    const selectedChat = reportChats[selectedReport.id] || buildInitialChatMessage(selectedReport);

    const handleSendMessage = () => {
        const trimmed = chatInput.trim();
        if (!trimmed) return;

        const userMessage: ReportChatMessage = { role: 'user', content: trimmed };
        const assistantMessage: ReportChatMessage = {
            role: 'assistant',
            content: buildReportReply(selectedReport, trimmed),
        };

        setReportChats((prev) => ({
            ...prev,
            [selectedReport.id]: [...(prev[selectedReport.id] || []), userMessage, assistantMessage],
        }));
        setChatInput('');
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
                                <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#A09E99]">Rapports</p>
                                <h2 className="settings-display mt-3 text-3xl tracking-[-0.04em] text-[#2B2B2B]">
                                    Bibliothèque de rapports métiers
                                </h2>
                                <p className="mt-3 text-sm leading-relaxed text-[#6B6966]">
                                    Choisissez un rapport dans le menu gauche pour afficher son contenu au centre, relire les insights et préparer l’export final.
                                </p>
                            </div>
                            <Button
                                variant="ghost"
                                className="rounded-xl border border-[#E8E6E1] bg-[#F8F7F4] px-4 text-sm font-medium text-[#2B2B2B] hover:bg-white"
                                onClick={onClose}
                            >
                                Retour au chat
                            </Button>
                        </div>

                        <div className={cn(
                            "mt-6 grid gap-6",
                            isReportListCollapsed
                                ? "xl:grid-cols-[minmax(0,1fr)]"
                                : "xl:grid-cols-[340px_minmax(0,1fr)]"
                        )}>
                            {!isReportListCollapsed && (
                                <aside className="rounded-[26px] border border-[#E8E6E1] bg-[#FCFBF8] p-4">
                                <div className="flex items-center justify-between gap-3 border-b border-[#E8E6E1] pb-4">
                                    <div>
                                        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">Liste des rapports</p>
                                        <p className="mt-2 text-sm font-semibold text-[#2B2B2B]">{REPORTS.length} disponibles</p>
                                    </div>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-10 w-10 rounded-2xl border border-[#E8E6E1] bg-white text-[#0D7377] hover:bg-[#F8F7F4]"
                                        onClick={() => setIsReportListCollapsed(true)}
                                        title="Masquer la liste"
                                    >
                                        <ChevronLeft className="h-4 w-4" />
                                    </Button>
                                </div>

                                <div className="mt-4 space-y-3">
                                    {REPORTS.map((report) => {
                                        const isActive = report.id === selectedReport.id;
                                        return (
                                            <button
                                                key={report.id}
                                                type="button"
                                                onClick={() => setSelectedReportId(report.id)}
                                                className={cn(
                                                    "w-full rounded-[22px] border px-4 py-4 text-left transition-all",
                                                    isActive
                                                        ? "border-[#0D7377] bg-[#0D7377] text-white shadow-[0_20px_40px_rgba(13,115,119,0.18)]"
                                                        : "border-[#E8E6E1] bg-white text-[#2B2B2B] hover:border-[#D7D3CB] hover:bg-[#FFFDFC]"
                                                )}
                                            >
                                                <div className="flex items-start justify-between gap-3">
                                                    <div className="min-w-0">
                                                        <p className="text-sm font-semibold leading-snug">{report.title}</p>
                                                        <p className={cn(
                                                            "mt-2 inline-flex rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.2em]",
                                                            isActive ? "border-white/20 bg-white/10 text-white" : "border-[#E8E6E1] bg-[#F8F7F4] text-[#6B6966]"
                                                        )}>
                                                            {report.sector}
                                                        </p>
                                                    </div>
                                                    <ChevronRight className={cn("mt-0.5 h-4 w-4 shrink-0", isActive ? "text-white" : "text-[#A09E99]")} />
                                                </div>
                                                <div className="mt-3 flex items-center justify-between gap-3 text-[11px]">
                                                    <span className={cn(
                                                        "rounded-full border px-2 py-1 font-semibold",
                                                        isActive ? "border-white/20 bg-white/10 text-white" : toneClasses[
                                                            report.status === 'Prêt' ? 'positive' : report.status === 'En revue' ? 'warning' : 'neutral'
                                                        ]
                                                    )}>
                                                        {report.status}
                                                    </span>
                                                    <span className={isActive ? "text-white/75" : "text-[#A09E99]"}>
                                                        {report.updatedAt}
                                                    </span>
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>
                                </aside>
                            )}

                            <section className="space-y-5">
                                <div className="flex items-center justify-between gap-3">
                                    <div className="flex items-center gap-3">
                                        <Button
                                            variant="ghost"
                                            className="rounded-xl border border-[#E8E6E1] bg-[#F8F7F4] px-3 text-sm font-medium text-[#2B2B2B] hover:bg-white"
                                            onClick={() => setIsReportListCollapsed((prev) => !prev)}
                                        >
                                            <FileText className="mr-2 h-4 w-4 text-[#0D7377]" />
                                            {isReportListCollapsed ? 'Afficher les rapports' : 'Masquer les rapports'}
                                        </Button>
                                        {isReportListCollapsed && (
                                            <span className="text-xs font-medium text-[#A09E99]">
                                                {REPORTS.length} rapports disponibles
                                            </span>
                                        )}
                                    </div>
                                </div>

                                <div className="rounded-[28px] border border-[#E8E6E1] bg-white p-6">
                                    <div className="flex flex-wrap items-start justify-between gap-4">
                                        <div className="max-w-3xl">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <span className="rounded-full border border-[#E8E6E1] bg-[#F8F7F4] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#6B6966]">
                                                    {selectedReport.sector}
                                                </span>
                                                <span className={cn(
                                                    "rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em]",
                                                    toneClasses[
                                                        selectedReport.status === 'Prêt'
                                                            ? 'positive'
                                                            : selectedReport.status === 'En revue'
                                                                ? 'warning'
                                                                : 'neutral'
                                                    ]
                                                )}>
                                                    {selectedReport.status}
                                                </span>
                                            </div>
                                            <h3 className="settings-display mt-4 text-[34px] leading-none tracking-[-0.05em] text-[#2B2B2B]">
                                                {selectedReport.title}
                                            </h3>
                                            <p className="mt-3 max-w-3xl text-sm leading-relaxed text-[#6B6966]">
                                                {selectedReport.summary}
                                            </p>
                                        </div>

                                        <div className="flex flex-wrap gap-2">
                                            <Button className="rounded-xl bg-[#0D7377] px-4 text-white hover:bg-[#0B6164]">
                                                <Download className="mr-2 h-4 w-4" />
                                                Télécharger
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                className="rounded-xl border border-[#E8E6E1] bg-[#F8F7F4] px-4 text-[#2B2B2B] hover:bg-white"
                                            >
                                                Partager
                                            </Button>
                                        </div>
                                    </div>

                                    <div className="mt-6 grid gap-4 md:grid-cols-3">
                                        <div className="rounded-[22px] border border-[#E8E6E1] bg-[#FCFBF8] p-4">
                                            <div className="flex items-center gap-2 text-[#6B6966]">
                                                <CalendarDays className="h-4 w-4" />
                                                <span className="text-[11px] font-semibold uppercase tracking-[0.18em]">Mis à jour</span>
                                            </div>
                                            <p className="mt-3 text-base font-semibold text-[#2B2B2B]">{selectedReport.updatedAt}</p>
                                        </div>
                                        <div className="rounded-[22px] border border-[#E8E6E1] bg-[#FCFBF8] p-4">
                                            <div className="flex items-center gap-2 text-[#6B6966]">
                                                <Building2 className="h-4 w-4" />
                                                <span className="text-[11px] font-semibold uppercase tracking-[0.18em]">Secteur</span>
                                            </div>
                                            <p className="mt-3 text-base font-semibold text-[#2B2B2B]">{selectedReport.sector}</p>
                                        </div>
                                        <div className="rounded-[22px] border border-[#E8E6E1] bg-[#FCFBF8] p-4">
                                            <div className="flex items-center gap-2 text-[#6B6966]">
                                                <BadgeCheck className="h-4 w-4" />
                                                <span className="text-[11px] font-semibold uppercase tracking-[0.18em]">Responsable</span>
                                            </div>
                                            <p className="mt-3 text-base font-semibold text-[#2B2B2B]">{selectedReport.owner}</p>
                                        </div>
                                    </div>
                                </div>

                                <div className={cn(
                                    "grid gap-5",
                                    isChatCollapsed
                                        ? "grid-cols-[minmax(0,1fr)]"
                                        : "lg:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]"
                                )}>
                                    <div className="rounded-[28px] border border-[#E8E6E1] bg-white p-6">
                                        <div className="flex flex-wrap items-center justify-between gap-3">
                                            <div className="flex flex-wrap items-center gap-3">
                                                <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#A09E99]">Template HTML/CSS</p>
                                                <span className="rounded-full border border-[#E8E6E1] bg-[#F8F7F4] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#6B6966]">
                                                    model1
                                                </span>
                                            </div>
                                            <Button
                                                variant="ghost"
                                                className="rounded-xl border border-[#E8E6E1] bg-[#F8F7F4] px-3 text-sm font-medium text-[#2B2B2B] hover:bg-white"
                                                onClick={() => setIsChatCollapsed((prev) => !prev)}
                                            >
                                                <MessageSquare className="mr-2 h-4 w-4 text-[#0D7377]" />
                                                {isChatCollapsed ? 'Afficher le chat' : 'Masquer le chat'}
                                            </Button>
                                        </div>
                                        <div className="mt-5 overflow-hidden rounded-[24px] border border-[#E8E6E1] bg-[#FCFBF8]">
                                            <iframe
                                                title={`Aperçu du rapport ${selectedReport.title}`}
                                                srcDoc={selectedReportHtml}
                                                className="h-[980px] w-full bg-white"
                                            />
                                        </div>
                                    </div>

                                    {!isChatCollapsed && (
                                        <div className="rounded-[28px] border border-[#E8E6E1] bg-white p-5">
                                        <div className="flex items-center justify-between gap-3 border-b border-[#E8E6E1] pb-4">
                                            <div>
                                                <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#A09E99]">Conversation rapport</p>
                                                <h4 className="mt-2 text-lg font-semibold text-[#2B2B2B]">Chat avec les données du rapport</h4>
                                            </div>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-11 w-11 rounded-2xl border border-[#E8E6E1] bg-[#F8F7F4] text-[#0D7377] hover:bg-white"
                                                onClick={() => setIsChatCollapsed(true)}
                                                title="Masquer le chat"
                                            >
                                                <ChevronRight className="h-5 w-5" />
                                            </Button>
                                        </div>

                                        <div className="mt-4 rounded-[22px] border border-[#E8E6E1] bg-[#FCFBF8] px-4 py-3 text-sm leading-relaxed text-[#6B6966]">
                                            Posez une question sur les KPIs, les écarts, les risques ou les recommandations. Les réponses sont générées à partir du rapport actuellement affiché.
                                        </div>

                                        <div className="mt-4 flex h-[840px] flex-col overflow-hidden rounded-[24px] border border-[#E8E6E1] bg-[#FCFBF8]">
                                            <div className="flex items-center gap-2 border-b border-[#E8E6E1] px-4 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                                                <Sparkles className="h-4 w-4 text-[#0D7377]" />
                                                Assistant Rapport
                                            </div>

                                            <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
                                                {selectedChat.map((message, index) => (
                                                    <div
                                                        key={`${selectedReport.id}-${index}`}
                                                        className={cn(
                                                            "flex",
                                                            message.role === 'user' ? "justify-end" : "justify-start"
                                                        )}
                                                    >
                                                        <div
                                                            className={cn(
                                                                "max-w-[88%] rounded-[22px] px-4 py-3 text-sm leading-relaxed shadow-sm",
                                                                message.role === 'user'
                                                                    ? "bg-[#0D7377] text-white"
                                                                    : "border border-[#E8E6E1] bg-white text-[#2B2B2B]"
                                                            )}
                                                        >
                                                            {message.content}
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>

                                            <div className="border-t border-[#E8E6E1] bg-white p-4">
                                                <div className="flex gap-3">
                                                    <textarea
                                                        value={chatInput}
                                                        onChange={(event) => setChatInput(event.target.value)}
                                                        onKeyDown={(event) => {
                                                            if (event.key === 'Enter' && !event.shiftKey) {
                                                                event.preventDefault();
                                                                handleSendMessage();
                                                            }
                                                        }}
                                                        placeholder="Ex: explique-moi les alertes risque de ce rapport"
                                                        className="min-h-[92px] flex-1 resize-none rounded-[20px] border border-[#E8E6E1] bg-[#F8F7F4] px-4 py-3 text-sm text-[#2B2B2B] outline-none transition-all placeholder:text-[#A09E99] focus:border-[#0D7377]/40 focus:bg-white focus:ring-2 focus:ring-[#0D7377]/10"
                                                    />
                                                    <Button
                                                        className="h-auto min-w-[56px] rounded-[20px] bg-[#0D7377] px-4 text-white hover:bg-[#0B6164]"
                                                        onClick={handleSendMessage}
                                                        disabled={!chatInput.trim()}
                                                    >
                                                        <Send className="h-4 w-4" />
                                                    </Button>
                                                </div>
                                            </div>
                                        </div>
                                        </div>
                                    )}
                                </div>
                            </section>
                        </div>
                    </div>
                </div>
            </div>
        </motion.div>
    );
};

export default ReportsWorkspace;
