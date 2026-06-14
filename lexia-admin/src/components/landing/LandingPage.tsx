import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    Sparkles, BarChart3, ShieldCheck, Zap, ArrowRight, Sun, Moon, X,
    Calendar, CheckCircle2, Clock, ExternalLink, Database, Menu, MessageSquare,
    Landmark, TrendingUp, ShieldAlert, HeartPulse, Factory, Radio, Building2,
    Lock, Server, Flag, Award, Eye, FileText, Mail, Send, Download, Cpu
} from 'lucide-react';
import { Button } from "@/components/ui/button";
import { asset } from "@/lib/asset";
import AuthForm from '../auth/AuthForm';
import Features from './Features';
import Solutions from './Solutions';
import Pricing from './Pricing';

import Payment from './Payment';
import ConnectorsSection from './ConnectorsSection';
import ArchitecturePage from './ArchitecturePage';

/* ─── Decorative Zellig pattern ─── */
const ZellijDivider = ({ className = "" }: { className?: string }) => (
    <svg className={className} viewBox="0 0 200 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        {[...Array(16)].map((_, i) => (
            <g key={i} transform={`translate(${i * 12.5}, 0)`}>
                <path d="M6.25 0L12.5 8L6.25 16L0 8Z" fill="currentColor" fillOpacity="0.06" />
                <path d="M6.25 3L10 8L6.25 13L2.5 8Z" stroke="currentColor" strokeOpacity="0.1" strokeWidth="0.5" fill="none" />
            </g>
        ))}
    </svg>
);

/* ─── Animated counter ─── */
const Counter = ({ value, suffix = "" }: { value: number; suffix?: string }) => {
    const [display, setDisplay] = React.useState(0);
    React.useEffect(() => {
        let start = 0;
        const end = value;
        const duration = 1500;
        const startTime = Date.now();
        const step = () => {
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            setDisplay(Math.floor(eased * end));
            if (progress < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    }, [value]);
    return <>{display}{suffix}</>;
};

/* ─── Sector icon bar (mini version for hero) ─── */
const sectorIcons = [
    { icon: <Landmark className="h-4 w-4" />, label: "Banque", color: "#0D7377" },
    { icon: <TrendingUp className="h-4 w-4" />, label: "Gestion", color: "#2563EB" },
    { icon: <ShieldAlert className="h-4 w-4" />, label: "RGPD", color: "#7C3AED" },
    { icon: <HeartPulse className="h-4 w-4" />, label: "Santé", color: "#DC2626" },
    { icon: <Factory className="h-4 w-4" />, label: "Industrie", color: "#D97706" },
    { icon: <Radio className="h-4 w-4" />, label: "Télécom", color: "#0891B2" },
    { icon: <Building2 className="h-4 w-4" />, label: "Public", color: "#059669" },
];

const metricCards = [
    { label: "PNB consolidé", value: "82.4M", trend: "+12.8%", color: "#0D7377" },
    { label: "Risque détecté", value: "4", trend: "à traiter", color: "#E8725A" },
    { label: "Sources actives", value: "17", trend: "Oracle, CSV, QVD", color: "#2563EB" },
];

const insightCards = [
    {
        icon: <MessageSquare className="h-4 w-4" />,
        title: "Assistant analytique",
        desc: "Posez une question métier, Qclick génère le SQL, explique les écarts et propose le graphique adapté.",
        question: "Pourquoi le PNB Agadir baisse malgré la hausse du CA ?",
        accent: "#0D7377",
    },
    {
        icon: <ShieldAlert className="h-4 w-4" />,
        title: "Anomalies surveillées",
        desc: "Alertes sur seuils, ruptures de tendance et valeurs incohérentes avant le comité de pilotage.",
        question: "3 agences dépassent le seuil de coût du risque",
        accent: "#E8725A",
    },
    {
        icon: <Database className="h-4 w-4" />,
        title: "Data products gouvernés",
        desc: "Sources, DTOs, colonnes catégorielles et embeddings documentés dans un cockpit exploitable.",
        question: "Score qualité: 96% sur la vue CA Oracle",
        accent: "#2563EB",
    },
    {
        icon: <FileText className="h-4 w-4" />,
        title: "Rapports exécutifs",
        desc: "Synthèses prêtes pour CODIR avec chiffres clés, explications et actions recommandées.",
        question: "Rapport mensuel prêt: Finance, RH, Commercial",
        accent: "#D97706",
    },
];

const MiniBars = ({ color = "#0D7377" }: { color?: string }) => (
    <div className="flex h-24 items-end gap-1.5 rounded-2xl border border-white/10 bg-white/[0.03] p-3">
        {[38, 58, 46, 72, 54, 86, 68, 92].map((height, index) => (
            <span
                key={index}
                className="flex-1 rounded-t-full"
                style={{
                    height: `${height}%`,
                    background: `linear-gradient(180deg, ${color}, ${color}55)`,
                    opacity: 0.55 + index * 0.05,
                }}
            />
        ))}
    </div>
);

const MiniLine = () => (
    <svg viewBox="0 0 240 96" className="h-24 w-full overflow-visible">
        <defs>
            <linearGradient id="qclickLineFill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#0D7377" stopOpacity="0.35" />
                <stop offset="100%" stopColor="#0D7377" stopOpacity="0" />
            </linearGradient>
        </defs>
        <path d="M6 82 C 42 42, 62 62, 92 36 S 142 56, 168 26 S 214 32, 234 14" fill="none" stroke="#2DD4BF" strokeWidth="4" strokeLinecap="round" />
        <path d="M6 82 C 42 42, 62 62, 92 36 S 142 56, 168 26 S 214 32, 234 14 L234 96 L6 96 Z" fill="url(#qclickLineFill)" />
        {[92, 168, 234].map((x, i) => (
            <circle key={x} cx={x} cy={[36, 26, 14][i]} r="5" fill="#0D7377" stroke="#F8F7F4" strokeWidth="3" />
        ))}
    </svg>
);

const DashboardIllustrations = () => (
    <section className="px-6 py-24 relative overflow-hidden">
        <div className="absolute left-1/2 top-10 h-[520px] w-[920px] -translate-x-1/2 rounded-full bg-[#0D7377]/10 blur-[120px]" />
        <div className="relative z-10 mx-auto max-w-7xl">
            <div className="mb-14 flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
                <div className="max-w-3xl">
                    <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-[#0D7377]/15 bg-[#0D7377]/8 px-4 py-2 text-xs font-black uppercase tracking-[0.22em] text-[#0D7377] dark:text-[#2DD4BF]">
                        <Sparkles className="h-3.5 w-3.5" />
                        Tableaux de bord illustratifs
                    </div>
                    <h2 className="text-3xl font-black tracking-tight md:text-6xl">
                        Visualisez ce que Qclick déclenche{" "}
                        <span className="bg-gradient-to-r from-[#0D7377] to-[#2DD4BF] bg-clip-text text-transparent">
                            derrière chaque question.
                        </span>
                    </h2>
                </div>
                <p className="max-w-sm text-sm leading-relaxed text-muted-foreground md:text-base">
                    Des cockpits inspirés des plateformes analytiques modernes, mais adaptés à Qclick: agent IA,
                    connecteurs hétérogènes, conformité locale et reporting exécutif.
                </p>
            </div>

            <div className="grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
                <motion.div
                    initial={{ opacity: 0, y: 24 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.7 }}
                    className="relative overflow-hidden rounded-[2.5rem] border border-white/10 bg-[#071D1F] p-4 text-white shadow-[0_30px_90px_-40px_rgba(13,115,119,0.75)]"
                >
                    <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_10%,rgba(45,212,191,0.28),transparent_32%),radial-gradient(circle_at_80%_20%,rgba(232,114,90,0.18),transparent_26%)]" />
                    <div className="relative rounded-[2rem] border border-white/10 bg-white/[0.06] p-5 backdrop-blur-xl">
                        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
                            <div>
                                <p className="text-xs font-bold uppercase tracking-[0.22em] text-white/45">Cockpit finance</p>
                                <h3 className="mt-2 text-2xl font-black tracking-tight">Vue Direction Générale</h3>
                            </div>
                            <div className="flex items-center gap-2 rounded-full border border-[#2DD4BF]/30 bg-[#2DD4BF]/10 px-3 py-1.5 text-xs font-bold text-[#9AF5E8]">
                                <Eye className="h-3.5 w-3.5" />
                                Live insight
                            </div>
                        </div>

                        <div className="grid gap-3 md:grid-cols-3">
                            {metricCards.map((metric) => (
                                <div key={metric.label} className="rounded-2xl border border-white/10 bg-white/[0.07] p-4">
                                    <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/40">{metric.label}</p>
                                    <div className="mt-3 flex items-end justify-between gap-3">
                                        <span className="text-3xl font-black">{metric.value}</span>
                                        <span className="rounded-full px-2 py-1 text-[10px] font-bold" style={{ backgroundColor: `${metric.color}22`, color: metric.color }}>
                                            {metric.trend}
                                        </span>
                                    </div>
                                </div>
                            ))}
                        </div>

                        <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_0.85fr]">
                            <div className="rounded-[1.75rem] border border-white/10 bg-[#0B2B2E]/80 p-5">
                                <div className="mb-4 flex items-center justify-between">
                                    <div>
                                        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/40">Tendance CA / PNB</p>
                                        <p className="mt-1 text-sm text-white/70">Agrégé depuis Oracle, CSV et QVD</p>
                                    </div>
                                    <BarChart3 className="h-5 w-5 text-[#2DD4BF]" />
                                </div>
                                <MiniLine />
                            </div>
                            <div className="rounded-[1.75rem] border border-white/10 bg-[#0B2B2E]/80 p-5">
                                <div className="mb-4 flex items-center justify-between">
                                    <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/40">Répartition secteur</p>
                                    <span className="text-xs font-bold text-[#2DD4BF]">+18%</span>
                                </div>
                                <MiniBars />
                            </div>
                        </div>
                    </div>
                </motion.div>

                <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-1">
                    {insightCards.slice(0, 2).map((card, index) => (
                        <motion.div
                            key={card.title}
                            initial={{ opacity: 0, y: 24 }}
                            whileInView={{ opacity: 1, y: 0 }}
                            viewport={{ once: true }}
                            transition={{ delay: index * 0.1, duration: 0.6 }}
                            className="group rounded-[2rem] border border-border/30 bg-card/80 p-5 shadow-sm backdrop-blur-sm transition-all hover:-translate-y-1 hover:border-[#0D7377]/25 hover:shadow-xl hover:shadow-[#0D7377]/10"
                        >
                            <div className="mb-5 flex items-center justify-between">
                                <div className="rounded-2xl p-3 text-white" style={{ backgroundColor: card.accent }}>
                                    {card.icon}
                                </div>
                                <span className="rounded-full bg-muted px-3 py-1 text-[10px] font-black uppercase tracking-[0.18em] text-muted-foreground">
                                    Qclick
                                </span>
                            </div>
                            <h3 className="text-xl font-black">{card.title}</h3>
                            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{card.desc}</p>
                            <div className="mt-5 rounded-2xl border border-border/40 bg-muted/30 p-4">
                                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">Signal</p>
                                <p className="mt-2 text-sm font-bold leading-relaxed">{card.question}</p>
                            </div>
                        </motion.div>
                    ))}
                </div>
            </div>

            <div className="mt-5 grid gap-5 md:grid-cols-2">
                {insightCards.slice(2).map((card, index) => (
                    <motion.div
                        key={card.title}
                        initial={{ opacity: 0, y: 24 }}
                        whileInView={{ opacity: 1, y: 0 }}
                        viewport={{ once: true }}
                        transition={{ delay: index * 0.1, duration: 0.6 }}
                        className="rounded-[2rem] border border-border/30 bg-card/70 p-6 backdrop-blur-sm"
                    >
                        <div className="flex flex-col gap-6 md:flex-row md:items-center">
                            <div className="flex-1">
                                <div className="mb-4 flex items-center gap-3">
                                    <span className="rounded-2xl p-3 text-white" style={{ backgroundColor: card.accent }}>
                                        {card.icon}
                                    </span>
                                    <h3 className="text-xl font-black">{card.title}</h3>
                                </div>
                                <p className="text-sm leading-relaxed text-muted-foreground">{card.desc}</p>
                            </div>
                            <div className="min-w-[220px] rounded-[1.5rem] border border-border/30 bg-background p-4">
                                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">{card.question}</p>
                                <div className="mt-4 space-y-2">
                                    {[78, 96, 64].map((width, barIndex) => (
                                        <div key={barIndex} className="h-2 rounded-full bg-muted">
                                            <div
                                                className="h-full rounded-full"
                                                style={{ width: `${width}%`, backgroundColor: card.accent }}
                                            />
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </motion.div>
                ))}
            </div>
        </div>
    </section>
);

const businessWorkflow = [
    {
        icon: <Database className="h-5 w-5" />,
        title: "Upload sécurisé",
        desc: "CSV, Excel, QVD, SQL, Oracle et fichiers métiers sont chargés dans un espace client cloisonné.",
    },
    {
        icon: <Sparkles className="h-5 w-5" />,
        title: "Skills préconstruits",
        desc: "KPIs sectoriels, prompts métiers, dashboards, règles d'alertes et modèles d'analyse sont activés.",
    },
    {
        icon: <BarChart3 className="h-5 w-5" />,
        title: "Insights & dashboards",
        desc: "Qclick produit tableaux de bord, anomalies, explications KPI et recommandations de première lecture.",
    },
    {
        icon: <Award className="h-5 w-5" />,
        title: "Expert Qclick",
        desc: "Un expert humain spécialisé dans le secteur analyse les résultats et challenge les signaux importants.",
    },
    {
        icon: <FileText className="h-5 w-5" />,
        title: "Rapport téléchargeable",
        desc: "Livrable professionnel type cabinet de conseil: diagnostic, graphiques, recommandations et plan d'action.",
    },
];

const expertCards = [
    { label: "Expert Banque & Risque", icon: <Landmark className="h-4 w-4" />, color: "#0D7377" },
    { label: "Expert Contrôle de Gestion", icon: <TrendingUp className="h-4 w-4" />, color: "#2563EB" },
    { label: "Expert RGPD / conformité", icon: <ShieldAlert className="h-4 w-4" />, color: "#7C3AED" },
    { label: "Expert Santé", icon: <HeartPulse className="h-4 w-4" />, color: "#DC2626" },
    { label: "Expert Industrie & énergie", icon: <Factory className="h-4 w-4" />, color: "#D97706" },
    { label: "Expert Télécom", icon: <Radio className="h-4 w-4" />, color: "#0891B2" },
    { label: "Expert Secteur public", icon: <Building2 className="h-4 w-4" />, color: "#059669" },
];

const businessOffers = [
    {
        title: "Self-service analytics",
        desc: "L'entreprise charge ses données, active les skills, explore les dashboards et obtient ses premiers KPI insights.",
    },
    {
        title: "Expert-assisted mission",
        desc: "Un expert Qclick audite les outputs IA, mène une analyse profonde et formalise un rapport professionnel.",
    },
    {
        title: "Enterprise managed service",
        desc: "Monitoring récurrent, alertes, dashboards, revues expertes et rapports périodiques pour le comité de direction.",
    },
];

const infrastructureLayer = [
    { label: "Hébergement souverain", icon: <Server className="h-4 w-4" /> },
    { label: "CPU / GPU", icon: <Cpu className="h-4 w-4" /> },
    { label: "Chiffrement", icon: <Lock className="h-4 w-4" /> },
    { label: "Audit trail", icon: <Eye className="h-4 w-4" /> },
    { label: "Données cloisonnées", icon: <ShieldCheck className="h-4 w-4" /> },
];

const BusinessModelSection = () => (
    <section className="relative overflow-hidden px-6 py-24">
        <div className="absolute left-1/2 top-24 h-[720px] w-[1100px] -translate-x-1/2 rounded-full bg-[#0D7377]/[0.06] blur-[120px]" />
        <div className="relative z-10 mx-auto max-w-7xl">
            <div className="mx-auto mb-12 max-w-4xl text-center">
                <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-[#0D7377]/15 bg-[#0D7377]/8 px-5 py-2.5 text-xs font-black uppercase tracking-[0.22em] text-[#0D7377] dark:text-[#2DD4BF]">
                    <Sparkles className="h-3.5 w-3.5" />
                    Business model
                </div>
                <h2 className="text-4xl font-black tracking-tight md:text-6xl">
                    Le business model Qclick
                </h2>
                <p className="mx-auto mt-5 max-w-3xl text-lg leading-relaxed text-muted-foreground">
                    Une plateforme où l'entreprise charge ses données, active des skills sectoriels, reçoit des dashboards instantanés, puis mandate un expert Qclick pour produire un rapport professionnel.
                </p>
            </div>

            <div className="mb-10 flex flex-wrap items-center justify-center gap-3">
                {sectorIcons.map((sector) => (
                    <motion.div
                        key={sector.label}
                        initial={{ opacity: 0, y: 10 }}
                        whileInView={{ opacity: 1, y: 0 }}
                        viewport={{ once: true }}
                        className="flex items-center gap-2 rounded-full border border-border/40 bg-card/80 px-5 py-3 text-sm font-black text-muted-foreground shadow-sm backdrop-blur-sm"
                    >
                        <span style={{ color: sector.color }}>{sector.icon}</span>
                        {sector.label}
                    </motion.div>
                ))}
            </div>

            <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
                <div className="rounded-[3rem] border border-border/30 bg-card/70 p-5 shadow-[0_30px_90px_-60px_rgba(13,115,119,0.75)] backdrop-blur-sm md:p-7">
                    <div className="grid gap-4 md:grid-cols-5">
                        {businessWorkflow.map((step, index) => (
                            <motion.div
                                key={step.title}
                                initial={{ opacity: 0, y: 18 }}
                                whileInView={{ opacity: 1, y: 0 }}
                                viewport={{ once: true }}
                                transition={{ delay: index * 0.08 }}
                                className="group relative rounded-[1.75rem] border border-border/30 bg-background/80 p-4 transition-all hover:-translate-y-1 hover:border-[#0D7377]/25 hover:shadow-xl hover:shadow-[#0D7377]/10"
                            >
                                <div className="mb-4 flex items-center justify-between">
                                    <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#0D7377]/10 text-[#0D7377]">
                                        {step.icon}
                                    </span>
                                    <span className="text-xs font-black text-muted-foreground/50">0{index + 1}</span>
                                </div>
                                <h3 className="text-sm font-black">{step.title}</h3>
                                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{step.desc}</p>
                                {index < businessWorkflow.length - 1 && (
                                    <ArrowRight className="absolute -right-3 top-1/2 z-10 hidden h-5 w-5 -translate-y-1/2 text-[#0D7377]/30 md:block" />
                                )}
                            </motion.div>
                        ))}
                    </div>

                    <div className="my-8 rounded-[2.25rem] border border-[#0D7377]/15 bg-[#071D1F] p-5 text-white md:p-7">
                        <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                            <div>
                                <p className="text-[10px] font-black uppercase tracking-[0.22em] text-[#9AF5E8]/80">Couche humaine</p>
                                <h3 className="mt-2 text-2xl font-black">Experts métiers Qclick</h3>
                            </div>
                            <p className="max-w-md text-sm leading-relaxed text-white/60">
                                Qclick ne remplace pas l'expert métier: il lui donne une base de travail accélérée, vérifiable et documentée.
                            </p>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                            {expertCards.map((expert, index) => (
                                <motion.div
                                    key={expert.label}
                                    initial={{ opacity: 0, scale: 0.95 }}
                                    whileInView={{ opacity: 1, scale: 1 }}
                                    viewport={{ once: true }}
                                    transition={{ delay: index * 0.05 }}
                                    className="rounded-2xl border border-white/10 bg-white/[0.07] p-4 transition-transform hover:-translate-y-1"
                                >
                                    <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl" style={{ backgroundColor: `${expert.color}22`, color: expert.color }}>
                                        {expert.icon}
                                    </div>
                                    <p className="text-sm font-bold leading-snug">{expert.label}</p>
                                </motion.div>
                            ))}
                        </div>
                    </div>

                    <div className="rounded-[2.25rem] border border-border/30 bg-[#F8F7F4] p-5 dark:bg-muted/20 md:p-7">
                        <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                            <div>
                                <p className="text-[10px] font-black uppercase tracking-[0.22em] text-[#0D7377]">Socle technique</p>
                                <h3 className="mt-2 text-2xl font-black">Infrastructure souveraine</h3>
                            </div>
                            <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
                                Le client garde la maîtrise de ses données; Qclick apporte les skills, l'IA, l'infrastructure souveraine et l'expertise sectorielle.
                            </p>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                            {infrastructureLayer.map((item) => (
                                <div key={item.label} className="flex items-center gap-3 rounded-2xl border border-border/30 bg-background/80 p-4 text-sm font-bold">
                                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#0D7377]/10 text-[#0D7377]">
                                        {item.icon}
                                    </span>
                                    {item.label}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                <div className="space-y-5">
                    <div className="rounded-[2.5rem] border border-border/30 bg-card/80 p-6 shadow-sm backdrop-blur-sm">
                        <p className="text-[10px] font-black uppercase tracking-[0.22em] text-[#0D7377]">Offres</p>
                        <h3 className="mt-2 text-2xl font-black">Du dashboard au rapport</h3>
                        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                            Des analyses instantanées quand il faut aller vite. Des experts humains quand l'enjeu mérite un diagnostic de cabinet de conseil.
                        </p>
                        <div className="mt-5 space-y-3">
                            {businessOffers.map((offer, index) => (
                                <div key={offer.title} className="rounded-2xl border border-border/30 bg-background/70 p-4">
                                    <div className="mb-2 flex items-center gap-2">
                                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#0D7377] text-[10px] font-black text-white">{index + 1}</span>
                                        <h4 className="text-sm font-black">{offer.title}</h4>
                                    </div>
                                    <p className="text-xs leading-relaxed text-muted-foreground">{offer.desc}</p>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="overflow-hidden rounded-[2.5rem] border border-white/10 bg-[#071D1F] p-5 text-white shadow-2xl">
                        <div className="mb-5 flex items-start justify-between gap-4">
                            <div>
                                <p className="text-[10px] font-black uppercase tracking-[0.22em] text-[#9AF5E8]/80">Livrable démonstratif</p>
                                <h3 className="mt-2 text-xl font-black">Rapport stratégique - Performance Banque Q2.pdf</h3>
                            </div>
                            <FileText className="h-6 w-6 text-[#2DD4BF]" />
                        </div>
                        <div className="space-y-2">
                            {["Executive summary", "KPIs", "Anomalies", "Benchmark", "Recommendations", "90-day action plan"].map((section) => (
                                <div key={section} className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm">
                                    <span>{section}</span>
                                    <CheckCircle2 className="h-4 w-4 text-[#2DD4BF]" />
                                </div>
                            ))}
                        </div>
                        <button
                            type="button"
                            className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[#2DD4BF] px-5 py-3 text-sm font-black text-[#071D1F] transition-transform hover:scale-[1.01]"
                            aria-label="Télécharger le rapport démonstratif"
                        >
                            Télécharger le rapport
                            <Download className="h-4 w-4" />
                        </button>
                        <p className="mt-3 text-center text-[11px] leading-relaxed text-white/45">
                            Élément illustratif: le téléchargement réel dépendra du workflow rapport activé pour le client.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    </section>
);

const CompanyPresentation = () => (
    <section className="px-6 py-24">
        <div className="mx-auto max-w-7xl overflow-hidden rounded-[3rem] border border-border/30 bg-card/70 shadow-[0_30px_90px_-60px_rgba(13,115,119,0.75)] backdrop-blur-sm">
            <div className="grid lg:grid-cols-[0.95fr_1.05fr]">
                <div className="relative min-h-[520px] overflow-hidden bg-[#071D1F] p-8 text-white md:p-12">
                    <div className="absolute inset-0 bg-[radial-gradient(circle_at_22%_18%,rgba(45,212,191,0.25),transparent_34%),radial-gradient(circle_at_88%_12%,rgba(232,114,90,0.18),transparent_26%)]" />
                    <div className="relative z-10 flex h-full flex-col justify-between">
                        <div>
                            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 py-2 text-xs font-black uppercase tracking-[0.22em] text-[#9AF5E8]">
                                <Building2 className="h-3.5 w-3.5" />
                                À propos
                            </div>
                            <h2 className="text-4xl font-black leading-[1.02] tracking-tight md:text-6xl">
                                Une entreprise marocaine
                                <span className="block text-[#2DD4BF]">pour l'analytique augmentée.</span>
                            </h2>
                            <p className="mt-6 max-w-xl text-base leading-relaxed text-white/65">
                                Inspiré des meilleures pages corporate data & AI: une vision claire, une mission utile,
                                et une plateforme conçue pour rendre les données fiables, actionnables et accessibles aux décideurs.
                            </p>
                        </div>

                        <div className="mt-10 grid gap-3 sm:grid-cols-3">
                            {[
                                { label: "Vision", value: "Data utile" },
                                { label: "Mission", value: "Décision IA" },
                                { label: "Ancrage", value: "Maroc" },
                            ].map((item) => (
                                <div key={item.label} className="rounded-2xl border border-white/10 bg-white/[0.07] p-4">
                                    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/40">{item.label}</p>
                                    <p className="mt-2 text-lg font-black">{item.value}</p>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                <div className="p-8 md:p-12">
                    <div className="mb-8 grid gap-6 lg:grid-cols-[1fr_220px] lg:items-start">
                        <div>
                            <p className="text-xs font-black uppercase tracking-[0.22em] text-[#0D7377]">Founder</p>
                            <p className="mt-4 max-w-2xl text-muted-foreground leading-relaxed">
                                Entrepreneur marocain engagé dans la création de solutions technologiques utiles aux organisations.
                                Sa vision pour Qclick: rendre l'analyse de données plus directe, souveraine et exploitable par les métiers.
                            </p>
                        </div>
                        <div className="rounded-[2rem] border border-border/30 bg-background/80 p-3 shadow-xl shadow-[#0D7377]/5">
                            <div className="aspect-[4/5] overflow-hidden rounded-[1.5rem] bg-[#071D1F]">
                                <img src={asset("image_founder.png")} alt="ZEROUALI Hamid" className="h-full w-full object-cover" />
                            </div>
                            <div className="px-2 pb-1 pt-4 text-center">
                                <h3 className="text-xl font-black tracking-tight">ZEROUALI Hamid</h3>
                                <a
                                    href="https://www.linkedin.com/in/hamid-zerouali-854a3038/"
                                    target="_blank"
                                    rel="noreferrer"
                                    className="mt-3 inline-flex items-center justify-center gap-2 rounded-full border border-[#0D7377]/20 bg-[#0D7377]/8 px-4 py-2 text-xs font-bold text-[#0D7377] transition-colors hover:bg-[#0D7377] hover:text-white"
                                >
                                    Profil LinkedIn
                                    <ExternalLink className="h-3.5 w-3.5" />
                                </a>
                            </div>
                        </div>
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                        {[
                            {
                                icon: <Award className="h-5 w-5" />,
                                title: "Vision",
                                text: "Aider les organisations à passer d'une donnée dispersée à une décision fiable, explicable et partageable.",
                            },
                            {
                                icon: <ShieldCheck className="h-5 w-5" />,
                                title: "Responsabilité",
                                text: "Construire un produit orienté confiance: gouvernance, confidentialité, traçabilité et souveraineté des usages data.",
                            },
                            {
                                icon: <Database className="h-5 w-5" />,
                                title: "Data foundation",
                                text: "Connecter les systèmes réels: Oracle, SQL, CSV, QVD, fichiers métiers et référentiels existants, sans projet ETL long.",
                            },
                            {
                                icon: <MessageSquare className="h-5 w-5" />,
                                title: "Mission produit",
                                text: "L'objectif n'est pas seulement de discuter avec les données, mais de produire des dashboards, alertes, recherches web et rapports actionnables.",
                            },
                        ].map((item) => (
                            <div key={item.title} className="group rounded-[1.75rem] border border-border/30 bg-background/70 p-5 transition-all hover:-translate-y-1 hover:border-[#0D7377]/25 hover:shadow-xl hover:shadow-[#0D7377]/10">
                                <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-2xl bg-[#0D7377]/10 text-[#0D7377]">
                                    {item.icon}
                                </div>
                                <h4 className="text-lg font-black">{item.title}</h4>
                                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{item.text}</p>
                            </div>
                        ))}
                    </div>

                    <div className="mt-8 rounded-[2rem] border border-dashed border-[#0D7377]/25 bg-[#0D7377]/5 p-6">
                        <p className="text-sm font-bold uppercase tracking-[0.18em] text-[#0D7377]">Positionnement</p>
                        <p className="mt-3 text-lg font-semibold leading-relaxed">
                            NS Factory édite Qclick comme une réponse locale, souveraine et orientée métier aux besoins
                            de pilotage avancé: dashboards, subagents, alertes, websearch et génération de rapports.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    </section>
);

const LandingPage = ({ onLoginSuccess, onLoginWithQuery, isDarkMode, toggleTheme }) => {
    const [authMode, setAuthMode] = useState(null);
    const [initialQuery, setInitialQuery] = useState(null);
    const [showDemo, setShowDemo] = useState(false);
    const [showCalendar, setShowCalendar] = useState(false);
    const [showContact, setShowContact] = useState(false);
    const [bookingSuccess, setBookingSuccess] = useState(false);
    const [activePage, setActivePage] = useState('home');
    const [selectedPlan, setSelectedPlan] = useState(null);
    const [showMobileMenu, setShowMobileMenu] = useState(false);

    const proposedSlots = [
        { day: "Lundi 19 Janvier", time: "10:00 - 11:00", dateCode: "20260119", timeCode: "100000/110000" },
        { day: "Mardi 20 Janvier", time: "14:00 - 15:00", dateCode: "20260120", timeCode: "140000/150000" },
        { day: "Mercredi 21 Janvier", time: "11:00 - 12:00", dateCode: "20260121", timeCode: "110000/120000" },
        { day: "Jeudi 22 Janvier", time: "16:00 - 17:00", dateCode: "20260122", timeCode: "160000/170000" }
    ];

    const handleBooking = (slot) => {
        const baseUrl = "https://calendar.google.com/calendar/u/0/r/eventedit";
        const dates = `${slot.dateCode}T${slot.timeCode.split('/')[0]}/${slot.dateCode}T${slot.timeCode.split('/')[1]}`;
        const details = encodeURIComponent("Démonstration personnalisée de la plateforme Qclick.\n\nSujet : Analyse de données par IA et découverte de l'interface.");
        const title = encodeURIComponent(`Démo Qclick : ${slot.day}`);
        const finalUrl = `${baseUrl}?text=${title}&dates=${dates}&details=${details}`;
        window.open(finalUrl, '_blank');
        setBookingSuccess(true);
    };

    const handleContactSubmit = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        const name = String(formData.get('name') || '').trim();
        const email = String(formData.get('email') || '').trim();
        const phone = String(formData.get('phone') || '').trim();
        const company = String(formData.get('company') || '').trim();
        const message = String(formData.get('message') || '').trim();

        const subject = encodeURIComponent(`Contact Qclick - ${name || 'Demande entrante'}`);
        const body = encodeURIComponent([
            'Bonjour,',
            '',
            'Je souhaite être contacté(e) au sujet de Qclick.',
            '',
            `Nom: ${name || '-'}`,
            `Email: ${email || '-'}`,
            `Téléphone: ${phone || '-'}`,
            `Entreprise: ${company || '-'}`,
            '',
            'Message:',
            message || '-',
        ].join('\n'));

        window.location.href = `mailto:networksystemsmaroc@gmail.com?subject=${subject}&body=${body}`;
        setShowContact(false);
    };

    /* ─── Auth overlay ─── */
    if (authMode) {
        return (
            <div className="min-h-screen bg-background flex items-center justify-center p-4 relative overflow-hidden">
                <div className="absolute top-0 left-0 w-full h-full opacity-30 pointer-events-none">
                    <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-[#0D7377]/10 rounded-full blur-[120px]" />
                    <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-[#2DD4BF]/10 rounded-full blur-[120px]" />
                </div>
                <div className="absolute top-8 left-8 flex items-center gap-2">
                    <img src={asset("logo.png")} alt="qclick" className="h-8 w-8 rounded-lg" />
                    <span className="font-bold text-xl tracking-tight text-foreground">qclick</span>
                </div>
                <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.5 }}
                >
                    <AuthForm
                        mode={authMode}
                        onToggle={() => setAuthMode(authMode === 'login' ? 'register' : 'login')}
                        onSuccess={() => {
                            if (initialQuery) {
                                onLoginWithQuery(initialQuery);
                            } else {
                                onLoginSuccess();
                            }
                        }}
                    />
                </motion.div>
                <div className="absolute top-8 right-8 flex items-center gap-2">
                    <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full hover:bg-muted" onClick={toggleTheme}>
                        {isDarkMode ? <Sun className="h-5 w-5 text-yellow-500" /> : <Moon className="h-5 w-5 text-[#0D7377]" />}
                    </Button>
                    <Button variant="ghost" className="text-muted-foreground hover:text-foreground" onClick={() => setAuthMode(null)}>
                        Retour
                    </Button>
                </div>
            </div>
        );
    }

    const renderContent = () => {
        switch (activePage) {
            case 'features': return <Features />;
            case 'solutions': return <Solutions />;
            case 'pricing': return <Pricing onSelectPlan={(plan) => { setSelectedPlan(plan); setActivePage('payment'); }} />;
            case 'payment': return <Payment plan={selectedPlan} onBack={() => setActivePage('pricing')} onSuccess={() => onLoginSuccess()} />;

            case 'architecture': return <ArchitecturePage />;
            case 'company': return <CompanyPresentation />;
            default: return (
                <>
                    {/* ════════════════════════════════════════════════════
                        HERO SECTION
                    ════════════════════════════════════════════════════ */}
                    <section className="pt-32 pb-16 px-6 relative overflow-hidden">
                        {/* Background decorations */}
                        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[900px] h-[600px] bg-[#0D7377]/[0.04] rounded-full blur-[100px] pointer-events-none" />
                        <div className="absolute top-20 right-0 w-64 h-64 bg-[#2DD4BF]/[0.06] rounded-full blur-[80px] pointer-events-none" />

                        <div className="max-w-6xl mx-auto text-center relative z-10">
                            {/* Sovereign badge */}
                            <motion.div
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.5 }}
                                className="inline-flex items-center gap-3 px-5 py-2.5 rounded-full bg-[#0D7377]/8 border border-[#0D7377]/15 text-[#0D7377] dark:text-[#2DD4BF] text-sm font-bold mb-8"
                            >
                                <span className="flex items-center gap-1.5 text-xs font-black tracking-wider uppercase">
                                    <Flag className="h-3.5 w-3.5" />
                                    Solution 100% Marocaine
                                </span>
                                <span className="w-px h-4 bg-[#0D7377]/20" />
                                <span className="flex items-center gap-1.5 text-xs font-bold">
                                    <Lock className="h-3 w-3" />
                                    Hébergement Souverain
                                </span>
                            </motion.div>

                            <motion.h1
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.5, delay: 0.1 }}
                                className="text-5xl md:text-8xl font-black tracking-tight mb-8 leading-[1.05]"
                            >
                                <span className="bg-gradient-to-b from-foreground to-foreground/70 bg-clip-text text-transparent">
                                    Vos données parlent.
                                </span>
                                <br />
                                <span className="bg-gradient-to-r from-[#0D7377] to-[#2DD4BF] bg-clip-text text-transparent">
                                    Qclick traduit.
                                </span>
                            </motion.h1>

                            <motion.p
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.5, delay: 0.2 }}
                                className="text-xl text-muted-foreground max-w-3xl mx-auto mb-10 leading-relaxed"
                            >
                                La plateforme souveraine d'analytique augmentée par l'IA.
                                Posez vos questions stratégiques en langage naturel et obtenez des insights
                                décisionnels instantanés sur vos données hétérogènes.
                            </motion.p>

                            {/* CTA row */}
                            <motion.div
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.5, delay: 0.3 }}
                                className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-12"
                            >
                                <Button
                                    className="h-14 px-10 bg-[#0D7377] hover:bg-[#0B6164] text-white rounded-2xl text-lg font-bold shadow-2xl shadow-[#0D7377]/20 transition-all hover:scale-[1.02]"
                                    onClick={() => setAuthMode('register')}
                                >
                                    Créer un compte
                                    <ArrowRight className="ml-2 h-5 w-5" />
                                </Button>
                                <Button
                                    variant="outline"
                                    className="h-14 px-8 rounded-2xl text-lg w-full sm:w-auto border-[#0D7377]/20 text-[#0D7377] hover:bg-[#0D7377]/8"
                                    onClick={() => setAuthMode('login')}
                                >
                                    Se connecter
                                </Button>
                                <Button
                                    variant="ghost"
                                    className="h-14 px-8 rounded-2xl text-lg w-full sm:w-auto hover:bg-muted/50 border-border/50 flex items-center gap-2"
                                    onClick={() => { setShowCalendar(true); setBookingSuccess(false); }}
                                >
                                    <Calendar className="h-5 w-5 text-[#0D7377]" />
                                    Réserver une démo
                                </Button>
                            </motion.div>

                            {/* Sector icons strip */}
                            <motion.div
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.5, delay: 0.45 }}
                                className="flex items-center justify-center gap-1.5 flex-wrap"
                            >
                                {sectorIcons.map((s, i) => (
                                    <button
                                        key={i}
                                        onClick={() => setActivePage('solutions')}
                                        className="group flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-muted/40 border border-border/20 hover:border-border/50 hover:bg-muted/70 transition-all text-xs text-muted-foreground hover:text-foreground"
                                    >
                                        <span style={{ color: s.color }}>{s.icon}</span>
                                        <span className="font-medium">{s.label}</span>
                                    </button>
                                ))}
                            </motion.div>
                        </div>
                    </section>

                    {/* ════════════════════════════════════════════════════
                        TRUST BADGES
                    ════════════════════════════════════════════════════ */}
                    <motion.section
                        initial={{ opacity: 0, y: 30 }}
                        whileInView={{ opacity: 1, y: 0 }}
                        viewport={{ once: true }}
                        className="px-6 py-10"
                    >
                        <div className="max-w-5xl mx-auto grid grid-cols-2 md:grid-cols-4 gap-4">
                            {[
                                { icon: <Flag className="h-5 w-5" />, title: "100% Marocaine", sub: "Conception, développement et support local" },
                                { icon: <Server className="h-5 w-5" />, title: "Hébergement Souverain", sub: "Données hébergées au Maroc, aucune fuite territoriale" },
                                { icon: <ShieldCheck className="h-5 w-5" />, title: "100% Compliant", sub: "Conforme Loi 09-08, RGPD, Bank Al-Maghrib" },
                                { icon: <Lock className="h-5 w-5" />, title: "Sécurité Renforcée", sub: "Chiffrement AES-256, TLS 1.3, audit trail complet" },
                            ].map((badge, i) => (
                                <motion.div
                                    key={i}
                                    initial={{ opacity: 0, y: 15 }}
                                    whileInView={{ opacity: 1, y: 0 }}
                                    viewport={{ once: true }}
                                    transition={{ delay: i * 0.08 }}
                                    className="p-5 rounded-2xl bg-card/60 border border-border/30 hover:border-[#0D7377]/20 transition-colors group"
                                >
                                    <div className="p-2.5 rounded-xl bg-[#0D7377]/8 text-[#0D7377] dark:text-[#2DD4BF] w-fit mb-3 group-hover:bg-[#0D7377]/12 transition-colors">
                                        {badge.icon}
                                    </div>
                                    <h4 className="text-sm font-bold mb-1">{badge.title}</h4>
                                    <p className="text-xs text-muted-foreground leading-relaxed">{badge.sub}</p>
                                </motion.div>
                            ))}
                        </div>
                    </motion.section>

                    <DashboardIllustrations />

                    <BusinessModelSection />

                    <ZellijDivider className="w-full max-w-lg mx-auto text-[#0D7377] my-16" />

                    {/* ════════════════════════════════════════════════════
                        VALUE PROPOSITIONS
                    ════════════════════════════════════════════════════ */}
                    <section className="py-20 px-6 relative max-w-6xl mx-auto">
                        <div className="text-center mb-16">
                            <h2 className="text-3xl md:text-5xl font-black tracking-tight mb-4 text-foreground leading-tight">
                                L'alternative souveraine <br className="hidden md:block" />à la BI traditionnelle
                            </h2>
                            <p className="text-muted-foreground max-w-2xl mx-auto text-lg">
                                Conçu pour les décideurs marocains qui exigent des réponses immédiates, une conformité totale et la maîtrise de leurs données.
                            </p>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                            {[
                                {
                                    icon: <MessageSquare className="h-6 w-6 text-[#0D7377]" />,
                                    title: "Agent Conversationnel Métier",
                                    desc: "Posez vos questions en darija, français ou anglais. Obtenez des réponses précises basées sur vos données brutes hétérogènes, sans filtres complexes.",
                                    image: "/feature-1.png"
                                },
                                {
                                    icon: <Database className="h-6 w-6 text-[#7C3AED]" />,
                                    title: "Données Non Structurées",
                                    desc: "Qclick traite vos fichiers RH, comptables, commerciaux et réglementaires tels quels. Zéro structuration préalable, zéro projet ETL de 6 mois.",
                                    image: "/feature-2.png"
                                },
                                {
                                    icon: <Zap className="h-6 w-6 text-[#D97706]" />,
                                    title: "Insight Décisionnel Immédiat",
                                    desc: "De la donnée brute à l'insight en quelques secondes. Conçu pour les comités de direction et les conseils d'administration où chaque minute compte.",
                                    image: "/hero-visual.png"
                                }
                            ].map((f, i) => (
                                <motion.div
                                    key={i}
                                    initial={{ opacity: 0, y: 20 }}
                                    whileInView={{ opacity: 1, y: 0 }}
                                    viewport={{ once: true }}
                                    transition={{ delay: i * 0.1 }}
                                    className="group flex flex-col p-2 rounded-[2.5rem] bg-card border border-border/40 hover:border-[#0D7377]/20 transition-all hover:shadow-lg hover:shadow-[#0D7377]/5"
                                >
                                    <div className="relative h-56 w-full rounded-[2rem] overflow-hidden mb-5">
                                        <img src={f.image} alt={f.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700 opacity-90" />
                                        <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-card to-transparent" />
                                        <div className="absolute bottom-4 left-4 p-3 rounded-2xl bg-background/80 backdrop-blur-md shadow-xl border border-border/40">
                                            {f.icon}
                                        </div>
                                    </div>
                                    <div className="px-5 pb-5">
                                        <h3 className="text-lg font-bold mb-2 text-foreground">{f.title}</h3>
                                        <p className="text-muted-foreground text-sm leading-relaxed">{f.desc}</p>
                                    </div>
                                </motion.div>
                            ))}
                        </div>
                    </section>

                    {/* ════════════════════════════════════════════════════
                        SECTORS STRIP
                    ════════════════════════════════════════════════════ */}
                    <section className="py-20 px-6 max-w-7xl mx-auto">
                        <div className="text-center mb-12">
                            <h2 className="text-3xl md:text-5xl font-black tracking-tight mb-4">
                                7 secteurs.{" "}
                                <span className="bg-gradient-to-r from-[#0D7377] to-[#2DD4BF] bg-clip-text text-transparent">
                                    Des résultats mesurables.
                                </span>
                            </h2>
                            <p className="text-muted-foreground max-w-2xl mx-auto">
                                Des solutions pré-configurées pour les métiers clés de l'économie marocaine.
                            </p>
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
                            {[
                                { icon: <Landmark className="h-6 w-6" />, label: "Banque & Assurance", color: "#0D7377" },
                                { icon: <TrendingUp className="h-6 w-6" />, label: "Contrôle de Gestion", color: "#2563EB" },
                                { icon: <ShieldAlert className="h-6 w-6" />, label: "RGPD & Loi 09-08", color: "#7C3AED" },
                                { icon: <HeartPulse className="h-6 w-6" />, label: "Santé", color: "#DC2626" },
                                { icon: <Factory className="h-6 w-6" />, label: "Industrie & Énergie", color: "#D97706" },
                                { icon: <Radio className="h-6 w-6" />, label: "Télécommunications", color: "#0891B2" },
                                { icon: <Building2 className="h-6 w-6" />, label: "Secteur Public", color: "#059669" },
                            ].map((sector, i) => (
                                <motion.button
                                    key={i}
                                    initial={{ opacity: 0, y: 15 }}
                                    whileInView={{ opacity: 1, y: 0 }}
                                    viewport={{ once: true }}
                                    transition={{ delay: i * 0.05 }}
                                    onClick={() => setActivePage('solutions')}
                                    className="group flex flex-col items-center gap-3 p-5 rounded-2xl bg-card/60 border border-border/30 hover:border-border/60 hover:bg-card hover:shadow-lg transition-all"
                                >
                                    <div
                                        className="p-3 rounded-xl transition-all group-hover:scale-110"
                                        style={{ backgroundColor: `${sector.color}10`, color: sector.color }}
                                    >
                                        {sector.icon}
                                    </div>
                                    <span className="text-xs font-bold text-center leading-tight text-muted-foreground group-hover:text-foreground transition-colors">
                                        {sector.label}
                                    </span>
                                </motion.button>
                            ))}
                        </div>

                        <div className="text-center mt-8">
                            <Button
                                variant="ghost"
                                className="text-[#0D7377] hover:text-[#0B6164] font-bold"
                                onClick={() => setActivePage('solutions')}
                            >
                                Explorer toutes les solutions
                                <ArrowRight className="ml-2 h-4 w-4" />
                            </Button>
                        </div>
                    </section>

                    {/* ════════════════════════════════════════════════════
                        STATS BAR
                    ════════════════════════════════════════════════════ */}
                    <motion.section
                        initial={{ opacity: 0 }}
                        whileInView={{ opacity: 1 }}
                        viewport={{ once: true }}
                        className="px-6 py-16"
                    >
                        <div className="max-w-5xl mx-auto rounded-3xl overflow-hidden relative">
                            <div className="absolute inset-0 bg-gradient-to-r from-[#0D7377] to-[#064E3B]" />
                            <div className="absolute inset-0 opacity-[0.03]" style={{
                                backgroundImage: `url("data:image/svg+xml,%3Csvg width='40' height='40' viewBox='0 0 40 40' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='%23ffffff' fill-opacity='1'%3E%3Cpath d='M20 0L40 20L20 40L0 20Z' fill='none' stroke='white' stroke-width='0.5'/%3E%3C/g%3E%3C/svg%3E")`,
                            }} />
                            <div className="relative z-10 grid grid-cols-2 md:grid-cols-4 gap-8 p-10 md:p-14 text-white text-center">
                                {[
                                    { val: 7, suffix: "", label: "Secteurs Couverts" },
                                    { val: 50, suffix: "+", label: "Connecteurs Natifs" },
                                    { val: 100, suffix: "%", label: "Données au Maroc" },
                                    { val: 15, suffix: " min", label: "Temps d'Intégration" },
                                ].map((stat, i) => (
                                    <div key={i} className="space-y-1">
                                        <div className="text-4xl md:text-5xl font-black text-white">
                                            <Counter value={stat.val} suffix={stat.suffix} />
                                        </div>
                                        <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/60">{stat.label}</div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </motion.section>

                    {/* Connectors */}
                    <ConnectorsSection />

                    <CompanyPresentation />

                    {/* ════════════════════════════════════════════════════
                        SOVEREIGN CTA
                    ════════════════════════════════════════════════════ */}
                    <section className="px-6 py-20">
                        <div className="max-w-5xl mx-auto rounded-[3rem] overflow-hidden relative">
                            <div className="absolute inset-0 bg-gradient-to-br from-foreground via-foreground/95 to-foreground/90" />
                            <div className="absolute inset-0 opacity-[0.02]" style={{
                                backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none'%3E%3Cpath d='M30 0L60 30L30 60L0 30Z' stroke='%23ffffff' stroke-width='0.5'/%3E%3C/g%3E%3C/svg%3E")`,
                            }} />
                            <div className="relative z-10 p-12 md:p-20 text-center space-y-8">
                                <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-[#0D7377]/20 border border-[#0D7377]/30 text-[#2DD4BF] text-xs font-bold tracking-widest uppercase">
                                    <Award className="h-3.5 w-3.5" />
                                    Plateforme Souveraine
                                </div>
                                <h2 className="text-3xl md:text-5xl font-black text-background leading-tight max-w-3xl mx-auto">
                                    Prêt à reprendre le contrôle
                                    <br />de vos données ?
                                </h2>
                                <p className="text-background/50 max-w-xl mx-auto text-lg">
                                    Rejoignez les organisations marocaines qui ont choisi la souveraineté numérique
                                    sans compromis sur la performance.
                                </p>
                                <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
                                    <Button
                                        className="h-14 px-10 bg-[#0D7377] hover:bg-[#0B6164] text-white rounded-2xl text-lg font-bold shadow-xl"
                                        onClick={() => setAuthMode('register')}
                                    >
                                        Commencer gratuitement
                                        <ArrowRight className="ml-2 h-5 w-5" />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        className="h-14 px-8 rounded-2xl text-lg font-bold text-background/60 hover:text-background hover:bg-background/10"
                                        onClick={() => { setShowCalendar(true); setBookingSuccess(false); }}
                                    >
                                        Planifier une démo
                                    </Button>
                                </div>
                            </div>
                        </div>
                    </section>
                </>
            );
        }
    };

    return (
        <div className="min-h-screen bg-background selection:bg-[#0D7377]/20">
            {/* ─── Header ─── */}
            <header className="fixed top-0 w-full z-50 px-6 py-4 flex items-center justify-between backdrop-blur-xl bg-background/80 border-b border-border/10">
                <div className="flex items-center gap-2 cursor-pointer group" onClick={() => setActivePage('home')}>
                    <img src={asset("logo.png")} alt="qclick" className="h-8 w-8 rounded-lg group-hover:scale-110 transition-transform" />
                    <span className="font-bold text-xl tracking-tight text-foreground">qclick</span>
                </div>
                <nav className="hidden md:flex items-center gap-8">
                    {[
                        { id: 'features', label: 'Fonctionnalités' },
                        { id: 'solutions', label: 'Solutions' },
                        { id: 'architecture', label: 'Architecture' },
                        { id: 'pricing', label: 'Tarifs' },
                    ].map(nav => (
                        <button
                            key={nav.id}
                            onClick={() => setActivePage(nav.id)}
                            className={`text-sm font-medium transition-colors ${activePage === nav.id ? 'text-[#0D7377]' : 'text-muted-foreground hover:text-foreground'}`}
                        >
                            {nav.label}
                        </button>
                    ))}
                </nav>
                <div className="flex items-center gap-4">
                    <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full hover:bg-muted" onClick={toggleTheme}>
                        {isDarkMode ? <Sun className="h-5 w-5 text-yellow-500" /> : <Moon className="h-5 w-5 text-[#0D7377]" />}
                    </Button>
                    <Button
                        variant="ghost"
                        className={`hidden sm:inline-flex ${activePage === 'company' ? 'text-[#0D7377]' : ''}`}
                        onClick={() => setActivePage('company')}
                    >
                        Entreprise
                    </Button>
                    <Button variant="ghost" className="hidden sm:inline-flex" onClick={() => setAuthMode('login')}>Connexion</Button>
                    <Button className="bg-[#0D7377] hover:bg-[#0B6164] text-white rounded-xl shadow-lg shadow-[#0D7377]/20" onClick={() => setAuthMode('register')}>Commencer</Button>
                    <Button variant="ghost" size="icon" className="md:hidden h-9 w-9 rounded-full hover:bg-muted" onClick={() => setShowMobileMenu(true)}>
                        <Menu className="h-5 w-5" />
                    </Button>
                </div>
            </header>

            {/* ─── Mobile Menu ─── */}
            <AnimatePresence>
                {showMobileMenu && (
                    <motion.div
                        initial={{ opacity: 0, x: '100%' }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: '100%' }}
                        transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                        className="fixed inset-0 z-[100] bg-background flex flex-col p-6"
                    >
                        <div className="flex items-center justify-between mb-12">
                            <div className="flex items-center gap-2">
                                <img src={asset("logo.png")} alt="qclick" className="h-8 w-8 rounded-lg" />
                                <span className="font-bold text-xl tracking-tight text-foreground">qclick</span>
                            </div>
                            <Button variant="ghost" size="icon" className="h-10 w-10 rounded-full" onClick={() => setShowMobileMenu(false)}>
                                <X className="h-6 w-6" />
                            </Button>
                        </div>
                        <nav className="flex flex-col gap-6">
                            {[
                                { id: 'features', label: 'Fonctionnalités' },
                                { id: 'solutions', label: 'Solutions' },
                                { id: 'company', label: 'Entreprise' },
                                { id: 'architecture', label: 'Architecture' },
                                { id: 'pricing', label: 'Tarifs' }
                            ].map((page) => (
                                <button
                                    key={page.id}
                                    onClick={() => { setActivePage(page.id); setShowMobileMenu(false); }}
                                    className={`text-2xl font-bold text-left py-2 border-b border-border/10 transition-colors ${activePage === page.id ? 'text-[#0D7377]' : 'text-muted-foreground'}`}
                                >
                                    {page.label}
                                </button>
                            ))}
                        </nav>
                        <div className="mt-auto space-y-4">
                            <Button className="w-full h-14 text-lg bg-[#0D7377] hover:bg-[#0B6164] rounded-2xl" onClick={() => { setAuthMode('register'); setShowMobileMenu(false); }}>
                                Commencer
                            </Button>
                            <Button variant="outline" className="w-full h-14 text-lg rounded-2xl" onClick={() => { setAuthMode('login'); setShowMobileMenu(false); }}>
                                Connexion
                            </Button>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* ─── Main ─── */}
            <main className="pt-20">
                <AnimatePresence mode="wait">
                    <motion.div
                        key={activePage}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        transition={{ duration: 0.3 }}
                    >
                        {renderContent()}
                    </motion.div>
                </AnimatePresence>
            </main>

            {/* ─── Footer ─── */}
            <footer className="py-20 px-6 border-t border-border/10 bg-muted/20">
                <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-4 gap-12">
                    <div className="col-span-1 md:col-span-2">
                        <div className="flex items-center gap-2 mb-6">
                            <img src={asset("logo.png")} alt="qclick" className="h-8 w-8 rounded-lg" />
                            <span className="font-bold text-xl tracking-tight">qclick</span>
                        </div>
                        <p className="text-muted-foreground max-w-sm mb-4 leading-relaxed">
                            La plateforme souveraine d'analytique augmentée par l'IA.
                            Solution 100% marocaine avec hébergement souverain.
                        </p>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#0D7377]/8 border border-[#0D7377]/15 text-[#0D7377] dark:text-[#2DD4BF]">
                                <Flag className="h-3 w-3" /> Made in Morocco
                            </div>
                            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-muted/50 border border-border/30">
                                <ShieldCheck className="h-3 w-3" /> 100% Compliant
                            </div>
                        </div>
                    </div>
                    <div>
                        <h4 className="font-bold mb-6 text-sm">Produit</h4>
                        <ul className="space-y-4 text-sm text-muted-foreground">
                            <li><button onClick={() => setActivePage('features')} className="hover:text-[#0D7377] transition-colors">Fonctionnalités</button></li>
                            <li><button onClick={() => setActivePage('solutions')} className="hover:text-[#0D7377] transition-colors">Solutions</button></li>
                            <li><button onClick={() => setActivePage('pricing')} className="hover:text-[#0D7377] transition-colors">Tarifs</button></li>
                            <li><button onClick={() => setActivePage('architecture')} className="hover:text-[#0D7377] transition-colors">Architecture</button></li>
                        </ul>
                    </div>
                    <div>
                        <h4 className="font-bold mb-6 text-sm">Entreprise</h4>
                        <ul className="space-y-4 text-sm text-muted-foreground">
                            <li><button onClick={() => setActivePage('company')} className="hover:text-[#0D7377] transition-colors">À propos</button></li>
                            <li><button onClick={() => setShowContact(true)} className="hover:text-[#0D7377] transition-colors">Contact</button></li>
                            <li><a href="#" className="hover:text-[#0D7377] transition-colors">Conformité & RGPD</a></li>
                        </ul>
                    </div>
                </div>
                <div className="max-w-6xl mx-auto mt-16 pt-8 border-t border-border/10 flex flex-col md:flex-row justify-between items-center gap-4 text-sm text-muted-foreground">
                    <p>&copy; 2026 Qclick AI. Tous droits réservés. Solution souveraine marocaine.</p>
                    <div className="flex items-center gap-8">
                        <a href="#" className="hover:text-[#0D7377] transition-colors">Confidentialité</a>
                        <a href="#" className="hover:text-[#0D7377] transition-colors">Conditions</a>
                        <a href="#" className="hover:text-[#0D7377] transition-colors">Loi 09-08</a>
                    </div>
                </div>
            </footer>

            {/* ─── Calendar Modal ─── */}
            <AnimatePresence>
                {showCalendar && (
                    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="absolute inset-0 bg-background/80 backdrop-blur-xl"
                            onClick={() => setShowCalendar(false)}
                        />
                        <motion.div
                            initial={{ opacity: 0, scale: 0.95, y: 20 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.95, y: 20 }}
                            className="relative w-full max-w-2xl bg-card border border-border shadow-2xl rounded-[2.5rem] overflow-hidden"
                        >
                            <div className="p-8 border-b border-border/40 bg-muted/30">
                                <div className="flex items-center justify-between mb-2">
                                    <h3 className="text-2xl font-bold">Réserver votre créneau</h3>
                                    <Button variant="ghost" size="icon" className="rounded-full" onClick={() => setShowCalendar(false)}>
                                        <X className="h-5 w-5" />
                                    </Button>
                                </div>
                                <p className="text-muted-foreground">Sélectionnez un créneau pour une démonstration personnalisée de Qclick.</p>
                            </div>
                            <div className="p-8">
                                {!bookingSuccess ? (
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                        {proposedSlots.map((slot, i) => (
                                            <button
                                                key={i}
                                                onClick={() => handleBooking(slot)}
                                                className="group p-5 rounded-3xl border border-border/40 bg-muted/20 hover:bg-[#0D7377] hover:border-[#0D7377] transition-all text-left"
                                            >
                                                <div className="flex items-center gap-3 mb-2">
                                                    <div className="p-2 rounded-xl bg-[#0D7377]/10 text-[#0D7377] group-hover:bg-white/20 group-hover:text-white">
                                                        <Clock className="h-4 w-4" />
                                                    </div>
                                                    <span className="font-bold text-sm group-hover:text-white">{slot.day}</span>
                                                </div>
                                                <p className="text-muted-foreground text-sm group-hover:text-white/80 flex items-center justify-between">
                                                    {slot.time}
                                                    <ExternalLink className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                                                </p>
                                            </button>
                                        ))}
                                    </div>
                                ) : (
                                    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="text-center py-12">
                                        <div className="h-20 w-20 bg-emerald-500/10 text-emerald-500 rounded-full flex items-center justify-center mx-auto mb-6">
                                            <CheckCircle2 className="h-10 w-10" />
                                        </div>
                                        <h4 className="text-2xl font-bold mb-2">Réservation en cours...</h4>
                                        <p className="text-muted-foreground mb-8">Veuillez confirmer l'événement dans la fenêtre Google Calendar.</p>
                                        <Button variant="outline" className="rounded-xl px-8" onClick={() => setShowCalendar(false)}>Fermer</Button>
                                    </motion.div>
                                )}
                            </div>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>

            {/* ─── Contact Modal ─── */}
            <AnimatePresence>
                {showContact && (
                    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="absolute inset-0 bg-background/80 backdrop-blur-xl"
                            onClick={() => setShowContact(false)}
                        />
                        <motion.div
                            initial={{ opacity: 0, scale: 0.95, y: 20 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.95, y: 20 }}
                            className="relative w-full max-w-2xl overflow-hidden rounded-[2.5rem] border border-border bg-card shadow-2xl"
                        >
                            <div className="relative overflow-hidden border-b border-border/40 bg-[#071D1F] p-8 text-white">
                                <div className="absolute inset-0 bg-[radial-gradient(circle_at_22%_20%,rgba(45,212,191,0.25),transparent_34%),radial-gradient(circle_at_90%_10%,rgba(232,114,90,0.18),transparent_28%)]" />
                                <div className="relative z-10 flex items-start justify-between gap-4">
                                    <div>
                                        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 py-2 text-xs font-black uppercase tracking-[0.2em] text-[#9AF5E8]">
                                            <Mail className="h-3.5 w-3.5" />
                                            Contact
                                        </div>
                                        <h3 className="text-3xl font-black tracking-tight">Parlez-nous de votre besoin</h3>
                                        <p className="mt-3 max-w-xl text-sm leading-relaxed text-white/65">
                                            Votre message sera préparé pour envoi à networksystemsmaroc@gmail.com avec vos coordonnées.
                                        </p>
                                    </div>
                                    <Button variant="ghost" size="icon" className="rounded-full text-white hover:bg-white/10" onClick={() => setShowContact(false)}>
                                        <X className="h-5 w-5" />
                                    </Button>
                                </div>
                            </div>

                            <form onSubmit={handleContactSubmit} className="space-y-5 p-8">
                                <div className="grid gap-4 md:grid-cols-2">
                                    <label className="space-y-2">
                                        <span className="text-xs font-black uppercase tracking-[0.18em] text-muted-foreground">Nom complet</span>
                                        <input
                                            name="name"
                                            required
                                            className="h-12 w-full rounded-2xl border border-border bg-background px-4 text-sm outline-none transition-colors focus:border-[#0D7377]"
                                            placeholder="Votre nom"
                                        />
                                    </label>
                                    <label className="space-y-2">
                                        <span className="text-xs font-black uppercase tracking-[0.18em] text-muted-foreground">Email</span>
                                        <input
                                            name="email"
                                            type="email"
                                            required
                                            className="h-12 w-full rounded-2xl border border-border bg-background px-4 text-sm outline-none transition-colors focus:border-[#0D7377]"
                                            placeholder="vous@entreprise.com"
                                        />
                                    </label>
                                    <label className="space-y-2">
                                        <span className="text-xs font-black uppercase tracking-[0.18em] text-muted-foreground">Téléphone</span>
                                        <input
                                            name="phone"
                                            className="h-12 w-full rounded-2xl border border-border bg-background px-4 text-sm outline-none transition-colors focus:border-[#0D7377]"
                                            placeholder="+212 ..."
                                        />
                                    </label>
                                    <label className="space-y-2">
                                        <span className="text-xs font-black uppercase tracking-[0.18em] text-muted-foreground">Entreprise</span>
                                        <input
                                            name="company"
                                            className="h-12 w-full rounded-2xl border border-border bg-background px-4 text-sm outline-none transition-colors focus:border-[#0D7377]"
                                            placeholder="Nom de l'organisation"
                                        />
                                    </label>
                                </div>

                                <label className="block space-y-2">
                                    <span className="text-xs font-black uppercase tracking-[0.18em] text-muted-foreground">Message</span>
                                    <textarea
                                        name="message"
                                        required
                                        rows={5}
                                        className="w-full resize-none rounded-2xl border border-border bg-background px-4 py-3 text-sm leading-relaxed outline-none transition-colors focus:border-[#0D7377]"
                                        placeholder="Décrivez votre besoin, votre secteur, vos sources de données ou la démo souhaitée..."
                                    />
                                </label>

                                <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between">
                                    <p className="text-xs leading-relaxed text-muted-foreground">
                                        L'envoi utilise votre client email afin de conserver une trace du message envoyé.
                                    </p>
                                    <Button type="submit" className="h-12 rounded-2xl bg-[#0D7377] px-6 font-bold text-white hover:bg-[#0B6164]">
                                        Préparer l'email
                                        <Send className="ml-2 h-4 w-4" />
                                    </Button>
                                </div>
                            </form>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>

            {/* ─── Demo Video Modal ─── */}
            <AnimatePresence>
                {showDemo && (
                    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 md:p-12">
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="absolute inset-0 bg-background/90 backdrop-blur-2xl"
                            onClick={() => setShowDemo(false)}
                        />
                        <motion.div
                            initial={{ opacity: 0, scale: 0.9, y: 40 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.9, y: 40 }}
                            className="relative w-full max-w-6xl aspect-video bg-black rounded-[2rem] overflow-hidden shadow-2xl border border-white/10"
                        >
                            <Button
                                variant="ghost" size="icon"
                                className="absolute top-6 right-6 z-10 bg-black/40 hover:bg-black/60 text-white rounded-full backdrop-blur-md"
                                onClick={() => setShowDemo(false)}
                            >
                                <X className="h-6 w-6" />
                            </Button>
                            <video src={asset("app-demo.webp")} autoPlay controls className="w-full h-full object-contain" />
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>
        </div>
    );
};

export default LandingPage;
