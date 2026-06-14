import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    Landmark, TrendingUp, ShieldAlert, HeartPulse, Factory, Radio, Building2,
    ArrowRight, CheckCircle2, X, ChevronRight, Bot, BellRing, FileSearch,
    FileText, Gauge, Network, ClipboardCheck, Search
} from 'lucide-react';
import { Button } from "@/components/ui/button";

/* ── SVG decorative pattern used as section divider ── */
const ZellijPattern = ({ className = "" }: { className?: string }) => (
    <svg className={className} viewBox="0 0 120 12" fill="none" xmlns="http://www.w3.org/2000/svg">
        {[...Array(10)].map((_, i) => (
            <g key={i} transform={`translate(${i * 12}, 0)`}>
                <path d="M6 0L12 6L6 12L0 6Z" fill="currentColor" fillOpacity="0.08" />
                <path d="M6 2L10 6L6 10L2 6Z" stroke="currentColor" strokeOpacity="0.12" strokeWidth="0.5" fill="none" />
            </g>
        ))}
    </svg>
);

const industries = [
    {
        id: "banque",
        icon: <Landmark className="h-7 w-7" />,
        title: "Banque & Assurance",
        tagline: "Pilotage du PNB et maîtrise du risque en temps réel",
        color: "#0D7377",
        desc: "Optimisez la gestion de votre Produit Net Bancaire, surveillez le Coût du Risque et automatisez le provisionnement réglementaire. Qclick corrèle instantanément vos données comptables, commerciales et réglementaires pour une vision unifiée de la performance bancaire.",
        cases: [
            "Analyse de marge nette et suivi du PNB par agence",
            "Surveillance des sinistralités crédits & assurances",
            "Provisionnement réglementaire automatisé (Bâle III/IV)",
            "Détection d'anomalies dans les flux Swift & virements",
            "Tableaux de bord de conformité ACAPS / Bank Al-Maghrib"
        ],
        kpis: ["PNB", "Coût du Risque", "ROE", "Ratio de Solvabilité"],
        illustration: (
            <div className="relative h-full w-full flex items-center justify-center">
                <div className="absolute inset-0 bg-gradient-to-br from-[#0D7377]/10 to-transparent rounded-3xl" />
                <div className="grid grid-cols-3 gap-3 p-6">
                    {["PNB", "CdR", "ROE", "LCR", "NSFR", "RWA"].map((kpi, i) => (
                        <motion.div
                            key={kpi}
                            initial={{ opacity: 0, scale: 0.8 }}
                            animate={{ opacity: 1, scale: 1 }}
                            transition={{ delay: i * 0.08 }}
                            className="h-16 w-20 rounded-xl bg-[#0D7377]/8 border border-[#0D7377]/15 flex items-center justify-center text-[10px] font-black tracking-wider text-[#0D7377]"
                        >
                            {kpi}
                        </motion.div>
                    ))}
                </div>
            </div>
        ),
    },
    {
        id: "controle",
        icon: <TrendingUp className="h-7 w-7" />,
        title: "Contrôle de Gestion",
        tagline: "Clôtures accélérées, écarts maîtrisés",
        color: "#2563EB",
        desc: "Simplifiez vos clôtures mensuelles et analysez les écarts budgétaires en quelques secondes. Qclick réconcilie automatiquement des fichiers comptables hétérogènes issus de multiples systèmes (SAP, Oracle, Excel) et produit des rapports d'analyse des charges d'exploitation.",
        cases: [
            "Réconciliation automatique multi-sources (SAP, Oracle, Excel)",
            "Analyse des écarts budgétaires par centre de coût",
            "Audit des charges d'exploitation et frais généraux",
            "Suivi de la masse salariale et des frais de personnel",
            "Reporting consolidé inter-filiales"
        ],
        kpis: ["EBITDA", "Écart Budget", "BFR", "Ratio Charges"],
        illustration: (
            <div className="relative h-full w-full flex items-center justify-center">
                <div className="absolute inset-0 bg-gradient-to-br from-blue-500/10 to-transparent rounded-3xl" />
                <div className="space-y-2 p-6 w-full">
                    {[85, 62, 91, 45, 78].map((v, i) => (
                        <motion.div
                            key={i}
                            initial={{ width: 0 }}
                            animate={{ width: `${v}%` }}
                            transition={{ delay: i * 0.1, duration: 0.6, ease: "easeOut" }}
                            className="h-5 rounded-full bg-gradient-to-r from-blue-500/20 to-blue-500/40 border border-blue-500/10"
                        />
                    ))}
                </div>
            </div>
        ),
    },
    {
        id: "rgpd",
        icon: <ShieldAlert className="h-7 w-7" />,
        title: "RGPD & Loi 09-08",
        tagline: "Cartographie et protection des données personnelles",
        color: "#7C3AED",
        desc: "Identifiez, cartographiez et protégez les données personnelles hébergées sur vos serveurs. Qclick scanne automatiquement vos bases de données pour détecter les champs contenant des données à caractère personnel (noms, CIN, emails, adresses, données bancaires), génère un registre de traitement conforme à la Loi 09-08 et au RGPD, et produit des rapports d'impact (PIA) pour la CNDP.",
        cases: [
            "Scan automatique et détection des données personnelles (PII)",
            "Cartographie des flux de données inter-systèmes",
            "Registre de traitement conforme Loi 09-08 / RGPD",
            "Analyse d'impact sur la protection des données (PIA/DPIA)",
            "Tableau de bord de conformité et alertes CNDP"
        ],
        kpis: ["PII Détectées", "Flux Cartographiés", "Score Conformité", "Risques"],
        illustration: (
            <div className="relative h-full w-full flex items-center justify-center">
                <div className="absolute inset-0 bg-gradient-to-br from-violet-500/10 to-transparent rounded-3xl" />
                <div className="relative p-6">
                    <motion.div
                        animate={{ rotate: 360 }}
                        transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
                        className="w-28 h-28 rounded-full border-2 border-dashed border-violet-500/20"
                    />
                    <div className="absolute inset-0 flex items-center justify-center">
                        <div className="w-14 h-14 rounded-2xl bg-violet-500/15 border border-violet-500/25 flex items-center justify-center">
                            <ShieldAlert className="h-6 w-6 text-violet-500" />
                        </div>
                    </div>
                    {["CIN", "Email", "IBAN", "Nom"].map((tag, i) => (
                        <motion.div
                            key={tag}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{ delay: 0.3 + i * 0.15 }}
                            className="absolute text-[9px] font-bold text-violet-600 bg-violet-50 dark:bg-violet-500/10 dark:text-violet-400 px-2 py-1 rounded-md border border-violet-200 dark:border-violet-500/20"
                            style={{
                                top: `${20 + Math.sin(i * 1.5) * 30}%`,
                                left: `${i % 2 === 0 ? 5 : 65}%`,
                            }}
                        >
                            {tag}
                        </motion.div>
                    ))}
                </div>
            </div>
        ),
    },
    {
        id: "sante",
        icon: <HeartPulse className="h-7 w-7" />,
        title: "Santé",
        tagline: "Données de santé décomposées, KPIs métiers recomposés",
        color: "#DC2626",
        desc: "Conçu pour les organismes publics de santé (CHU, hôpitaux régionaux, CNSS/CNOPS), les laboratoires pharmaceutiques et les investisseurs privés dans le domaine de la santé. Qclick décompose et recompose les données cliniques, administratives et financières pour produire des KPIs métiers et des dashboards d'activité en temps réel.",
        cases: [
            "Dashboards d'activité hospitalière (taux d'occupation, DMS)",
            "Suivi pharmacovigilance et traçabilité des lots",
            "KPIs métiers : coût par patient, taux de rotation",
            "Consolidation des données CNSS / CNOPS / mutuelles",
            "Reporting réglementaire pour le Ministère de la Santé"
        ],
        kpis: ["DMS", "Taux Occupation", "Coût/Patient", "Activité"],
        illustration: (
            <div className="relative h-full w-full flex items-center justify-center">
                <div className="absolute inset-0 bg-gradient-to-br from-red-500/10 to-transparent rounded-3xl" />
                <svg viewBox="0 0 120 60" className="w-40 text-red-500/30">
                    <motion.polyline
                        points="0,40 15,38 25,42 35,30 45,35 55,15 65,25 75,10 85,20 95,18 105,22 120,20"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        initial={{ pathLength: 0 }}
                        animate={{ pathLength: 1 }}
                        transition={{ duration: 2, ease: "easeInOut" }}
                    />
                    <motion.circle
                        cx="75" cy="10" r="3"
                        fill="currentColor"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: [0, 1, 0] }}
                        transition={{ duration: 2, repeat: Infinity }}
                    />
                </svg>
            </div>
        ),
    },
    {
        id: "industrie",
        icon: <Factory className="h-7 w-7" />,
        title: "Industrie & Énergie",
        tagline: "Performance industrielle et optimisation énergétique",
        color: "#D97706",
        desc: "Pilotez votre performance industrielle en temps réel. Qclick agrège les données de production, maintenance, supply chain et qualité pour optimiser le TRS, réduire les temps d'arrêt et maîtriser la consommation énergétique. Idéal pour les groupes industriels marocains (OCP, ONEE, cimenteries, agroalimentaire).",
        cases: [
            "Suivi du Taux de Rendement Synthétique (TRS/OEE)",
            "Maintenance prédictive et analyse des pannes",
            "Optimisation de la consommation énergétique",
            "Traçabilité supply chain et gestion des stocks",
            "Contrôle qualité et analyse des non-conformités"
        ],
        kpis: ["TRS/OEE", "MTBF", "Conso. kWh", "Rendement"],
        illustration: (
            <div className="relative h-full w-full flex items-center justify-center">
                <div className="absolute inset-0 bg-gradient-to-br from-amber-500/10 to-transparent rounded-3xl" />
                <div className="grid grid-cols-2 gap-2 p-6">
                    {[
                        { label: "TRS", val: "87%" },
                        { label: "MTBF", val: "342h" },
                        { label: "kWh", val: "-12%" },
                        { label: "Qualité", val: "99.2%" },
                    ].map((m, i) => (
                        <motion.div
                            key={m.label}
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: i * 0.1 }}
                            className="h-16 rounded-xl bg-amber-500/8 border border-amber-500/15 flex flex-col items-center justify-center"
                        >
                            <span className="text-xs font-black text-amber-600 dark:text-amber-400">{m.val}</span>
                            <span className="text-[8px] tracking-wider text-amber-600/60 dark:text-amber-400/60 uppercase font-bold">{m.label}</span>
                        </motion.div>
                    ))}
                </div>
            </div>
        ),
    },
    {
        id: "telecom",
        icon: <Radio className="h-7 w-7" />,
        title: "Télécommunications",
        tagline: "Analyse réseau, churn et expérience client",
        color: "#0891B2",
        desc: "Analysez en temps réel la performance réseau, le taux de churn, l'ARPU et la qualité de service. Qclick fusionne les données de facturation, CRM, qualité réseau et réclamations pour offrir aux opérateurs télécoms marocains une vision 360° de leur activité et de l'expérience client.",
        cases: [
            "Analyse du churn et segmentation client prédictive",
            "Suivi ARPU par segment et par région",
            "Monitoring qualité de service (QoS) et couverture réseau",
            "Optimisation du cycle de facturation",
            "Tableau de bord expérience client et NPS"
        ],
        kpis: ["ARPU", "Churn Rate", "QoS", "NPS"],
        illustration: (
            <div className="relative h-full w-full flex items-center justify-center">
                <div className="absolute inset-0 bg-gradient-to-br from-cyan-500/10 to-transparent rounded-3xl" />
                <div className="relative">
                    {[0, 1, 2].map((ring) => (
                        <motion.div
                            key={ring}
                            animate={{ scale: [1, 1.3, 1], opacity: [0.3, 0.05, 0.3] }}
                            transition={{ duration: 2 + ring * 0.5, repeat: Infinity, delay: ring * 0.3 }}
                            className="absolute inset-0 rounded-full border border-cyan-500/20"
                            style={{ margin: `-${ring * 18}px` }}
                        />
                    ))}
                    <div className="w-12 h-12 rounded-full bg-cyan-500/15 border border-cyan-500/25 flex items-center justify-center">
                        <Radio className="h-5 w-5 text-cyan-500" />
                    </div>
                </div>
            </div>
        ),
    },
    {
        id: "public",
        icon: <Building2 className="h-7 w-7" />,
        title: "Secteur Public",
        tagline: "Modernisation et transparence de la gestion publique",
        color: "#059669",
        desc: "Accompagnez la transformation digitale des administrations et établissements publics marocains. Qclick consolide les données budgétaires, de performance et de gestion des ressources humaines pour produire des tableaux de bord de pilotage conformes aux exigences de la Cour des Comptes et du Nouveau Modèle de Développement.",
        cases: [
            "Tableaux de bord budgétaires et suivi d'exécution",
            "Performance des programmes et indicateurs NMD",
            "Consolidation inter-établissements et inter-ministérielle",
            "Gestion prévisionnelle des effectifs et des compétences",
            "Reporting automatisé pour la Cour des Comptes"
        ],
        kpis: ["Exécution Budget", "Taux Réalisation", "GPEC", "Indicateurs NMD"],
        illustration: (
            <div className="relative h-full w-full flex items-center justify-center">
                <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/10 to-transparent rounded-3xl" />
                <div className="flex gap-1 items-end p-6">
                    {[60, 80, 45, 90, 70, 55, 85].map((h, i) => (
                        <motion.div
                            key={i}
                            initial={{ height: 0 }}
                            animate={{ height: `${h}%` }}
                            transition={{ delay: i * 0.08, duration: 0.5, ease: "easeOut" }}
                            className="w-5 rounded-t-md bg-emerald-500/20 border border-emerald-500/15"
                            style={{ maxHeight: `${h}px` }}
                        />
                    ))}
                </div>
            </div>
        ),
    },
];

const sectorDeepDives = {
    banque: {
        hook: "Transformez chaque comité risque en cockpit d'arbitrage: marge, liquidité, fraude, conformité et qualité portefeuille visibles au même endroit.",
        dashboard: "Cockpit PNB / risque avec drill-down agence, produit, segment client et canal digital.",
        subagents: [
            "Agent Risk Officer: explique les variations du coût du risque et isole les dossiers atypiques.",
            "Agent Compliance Watch: relie les indicateurs internes aux exigences BAM, ACAPS et Bâle.",
            "Agent Revenue Analyst: décompose PNB, marge d'intérêt, commissions et rentabilité agence.",
        ],
        alerts: [
            "Hausse anormale du taux d'impayés sur une zone ou un segment.",
            "Flux suspects ou rupture de comportement sur virements / cartes / mobile banking.",
            "Seuil de liquidité, provision ou concentration proche de la limite interne.",
        ],
        websearch: "Veille automatique sur communiqués BAM, ACAPS, fraude digitale, cybersécurité et benchmarks marché.",
        reports: "Pack CODIR banque: PNB, coût du risque, anomalies critiques, décisions proposées et annexes d'audit.",
        outcomes: ["Moins de reporting manuel", "Risque détecté plus tôt", "Décisions agence plus rapides"],
        miniKpis: ["PNB +12.8%", "NPL 3.1%", "Alertes 4", "LCR 128%"],
    },
    controle: {
        hook: "Passez de la clôture Excel à une cellule de pilotage continue: écarts, budget, cash et rentabilité expliqués en langage métier.",
        dashboard: "Dashboard budget vs réel avec analyse des écarts par filiale, centre de coût, fournisseur et nature comptable.",
        subagents: [
            "Agent Closing: vérifie cohérence des balances, doublons, cut-off et écritures atypiques.",
            "Agent Budget Owner: génère les explications d'écarts et propose les reforecasts.",
            "Agent Cash Controller: surveille BFR, DSO, DPO et tensions trésorerie.",
        ],
        alerts: [
            "Dépassement budget par centre de coût ou engagement fournisseur.",
            "Variation inhabituelle des charges de personnel ou frais généraux.",
            "Retard de clôture ou fichier source manquant avant reporting mensuel.",
        ],
        websearch: "Recherche de benchmarks sectoriels, inflation, taux, change et indices utiles au reforecast.",
        reports: "Dossier de clôture mensuel: EBITDA, écarts, commentaires, risques et plan d'action par responsable.",
        outcomes: ["Clôture accélérée", "Narratif financier automatique", "Budget piloté en continu"],
        miniKpis: ["EBITDA 18.4%", "Écart -2.7%", "DSO 43j", "Cash +9%"],
    },
    rgpd: {
        hook: "Faites de la conformité CNDP un tableau de bord opérationnel: inventaire PII, finalités, risques, preuves et actions.",
        dashboard: "Cartographie Loi 09-08 / RGPD des traitements, données sensibles, CIN, RIB, santé, transferts et habilitations.",
        subagents: [
            "Agent PII Scanner: détecte données personnelles et sensibles dans bases, fichiers et exports.",
            "Agent DPO: qualifie finalité, base légale, durée de conservation et droits concernés.",
            "Agent Remediation: priorise anonymisation, purge, chiffrement et limitation d'accès.",
        ],
        alerts: [
            "Nouveau champ CIN/RIB/santé détecté dans une source non déclarée.",
            "Interconnexion de fichiers à finalités différentes nécessitant revue.",
            "Export ou transfert hors périmètre souverain à valider avant diffusion.",
        ],
        websearch: "Veille CNDP, DGSSI, textes 09-08, recommandations sécurité et pratiques de notification.",
        reports: "Registre de traitement, matrice risques, DPIA/PIA et dossier de conformité prêt pour audit.",
        outcomes: ["Inventaire PII continu", "Audit mieux documenté", "Risque conformité réduit"],
        miniKpis: ["PII 1,284", "Score 94%", "Actions 12", "Risques 3"],
    },
    sante: {
        hook: "Unifiez activité médicale, facturation, parcours patient et stocks critiques sans exposer la donnée sensible.",
        dashboard: "Cockpit hospitalier: taux d'occupation, DMS, urgences, pharmacie, coût patient et remboursements.",
        subagents: [
            "Agent Parcours Patient: repère goulots d'attente, retards et durées de séjour atypiques.",
            "Agent Pharmacie: surveille lots, péremption, ruptures et consommation par service.",
            "Agent Finance Santé: rapproche actes, facturation, CNSS/CNOPS et restes à recouvrer.",
        ],
        alerts: [
            "Saturation service, DMS anormale ou hausse d'annulations bloc.",
            "Rupture de stock critique ou lot proche péremption.",
            "Écart entre actes réalisés, codage, facturation et remboursement.",
        ],
        websearch: "Veille protocoles, recommandations sanitaires, prix consommables et initiatives de digital health.",
        reports: "Rapport direction médicale: activité, qualité, finance, pharmacie et actions priorisées.",
        outcomes: ["Flux patient lisible", "Stocks mieux anticipés", "Recouvrement sécurisé"],
        miniKpis: ["DMS 4.2j", "Occup. 78%", "Ruptures 2", "Coût -6%"],
    },
    industrie: {
        hook: "Pilotez usine, énergie et maintenance comme un cockpit temps réel, avec des agents qui expliquent les pertes de rendement.",
        dashboard: "Dashboard TRS/OEE, énergie, qualité, maintenance, stock et supply chain par ligne de production.",
        subagents: [
            "Agent Maintenance: détecte signaux faibles, MTBF/MTTR et risques d'arrêt.",
            "Agent Energy Optimizer: explique dérives kWh, pointe, rendement et coûts énergétiques.",
            "Agent Quality Root Cause: relie non-conformités aux lots, équipes, machines et fournisseurs.",
        ],
        alerts: [
            "Baisse TRS ou dérive consommation sur ligne critique.",
            "Risque de panne précoce selon historique et signaux capteurs.",
            "Non-conformité répétée liée à lot, machine ou fournisseur.",
        ],
        websearch: "Veille prix énergie, disponibilité matières, normes qualité et benchmarks industriels.",
        reports: "Daily plant report: TRS, arrêts, énergie, qualité, risques supply et plan d'action atelier.",
        outcomes: ["Arrêts réduits", "Énergie maîtrisée", "Qualité tracée"],
        miniKpis: ["TRS 87%", "MTBF 342h", "kWh -12%", "NC 0.8%"],
    },
    telecom: {
        hook: "Reliez réseau, facturation, CRM, réclamations et 5G pour piloter churn, QoS et investissement couverture.",
        dashboard: "Cockpit opérateur: ARPU, churn, QoS, NPS, couverture 4G/5G, incidents et réclamations.",
        subagents: [
            "Agent Churn: identifie segments à risque et propose actions de rétention.",
            "Agent Network QoS: corrèle incidents, tickets, cellules, débit et expérience client.",
            "Agent 5G Rollout: suit couverture, priorités zones, CAPEX et engagements qualité.",
        ],
        alerts: [
            "Churn probable sur client valeur ou segment régional.",
            "Dégradation QoS après incident cellule ou saturation zone.",
            "Écart entre promesse couverture, réclamations et activation commerciale.",
        ],
        websearch: "Veille ANRT, décisions fibre/5G, concurrence, offres marché et perception client.",
        reports: "Executive network pack: ARPU, churn, QoS, couverture, plaintes et priorités d'investissement.",
        outcomes: ["Churn anticipé", "QoS corrélée au client", "5G pilotée par la donnée"],
        miniKpis: ["ARPU +5%", "Churn 1.9%", "QoS 96%", "NPS +11"],
    },
    public: {
        hook: "Modernisez le pilotage public: budgets, programmes, open data, performance et services citoyens dans un même cockpit souverain.",
        dashboard: "Tableau de bord administration: exécution budgétaire, programmes, délais, RH, indicateurs NMD et qualité service.",
        subagents: [
            "Agent Budget Public: suit engagement, liquidation, paiement et restes à réaliser.",
            "Agent Program Performance: relie objectifs, indicateurs, livrables et retards.",
            "Agent Open Data: prépare jeux de données publiables, anonymisés et documentés.",
        ],
        alerts: [
            "Programme en retard sur jalon, budget ou indicateur d'impact.",
            "Dépense proche seuil ou ligne budgétaire sous-consommée.",
            "Dataset public non anonymisé ou indicateur incomplet avant publication.",
        ],
        websearch: "Veille Digital Morocco 2030, ENNAJAA, open data, textes et décisions institutionnelles.",
        reports: "Rapport performance publique: budget, transparence, indicateurs, risques et actions de redressement.",
        outcomes: ["Transparence renforcée", "Décisions documentées", "Reporting institutionnel accéléré"],
        miniKpis: ["Budget 72%", "Retards 5", "SLA 91%", "Open data 38"],
    },
};

const featurePillars = [
    { key: "dashboard", label: "Dashboarding avancé", icon: <Gauge className="h-4 w-4" /> },
    { key: "subagents", label: "Sous-agents spécialisés", icon: <Bot className="h-4 w-4" /> },
    { key: "alerts", label: "Alertes intelligentes", icon: <BellRing className="h-4 w-4" /> },
    { key: "websearch", label: "Web search & veille", icon: <Search className="h-4 w-4" /> },
    { key: "reports", label: "Rapports exécutifs", icon: <FileText className="h-4 w-4" /> },
];

const Solutions = () => {
    const [activeSector, setActiveSector] = useState<string | null>(null);
    const activeData = industries.find(s => s.id === activeSector);
    const activeDeepDive = activeData ? sectorDeepDives[activeData.id] : null;

    return (
        <div className="py-20 px-6 max-w-7xl mx-auto">
            {/* Header */}
            <div className="text-center mb-6">
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[#0D7377]/8 border border-[#0D7377]/15 text-[#0D7377] dark:text-[#2DD4BF] text-xs font-black tracking-[0.2em] uppercase mb-6"
                >
                    Solutions Sectorielles
                </motion.div>
                <motion.h1
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="text-4xl md:text-6xl font-black mb-6 leading-[1.1] tracking-tight"
                >
                    7 secteurs.{" "}
                    <span className="bg-gradient-to-r from-[#0D7377] to-[#2DD4BF] bg-clip-text text-transparent">
                        Une seule plateforme.
                    </span>
                </motion.h1>
                <p className="text-lg text-muted-foreground max-w-3xl mx-auto leading-relaxed">
                    Des solutions pré-configurées pour les métiers clés de l'économie marocaine,
                    avec des connecteurs natifs, des KPIs sectoriels et une conformité locale intégrée.
                </p>
            </div>

            <ZellijPattern className="w-full max-w-md mx-auto text-[#0D7377] my-10" />

            {/* Sector Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 mb-16">
                {industries.map((sector, i) => (
                    <motion.button
                        key={sector.id}
                        initial={{ opacity: 0, y: 20 }}
                        whileInView={{ opacity: 1, y: 0 }}
                        viewport={{ once: true }}
                        transition={{ delay: i * 0.05 }}
                        onClick={() => setActiveSector(sector.id)}
                        className={`group relative p-6 rounded-2xl border text-left transition-all duration-300 ${activeSector === sector.id
                            ? 'bg-card border-[#0D7377]/40 shadow-xl shadow-[#0D7377]/5 ring-1 ring-[#0D7377]/20'
                            : 'bg-card/50 border-border/30 hover:border-border/60 hover:bg-card hover:shadow-lg'
                            }`}
                    >
                        <div
                            className="p-3 rounded-xl w-fit mb-4 transition-colors"
                            style={{
                                backgroundColor: `${sector.color}10`,
                                color: sector.color,
                            }}
                        >
                            {sector.icon}
                        </div>
                        <h3 className="text-lg font-bold mb-1.5 text-foreground">{sector.title}</h3>
                        <p className="text-xs text-muted-foreground leading-relaxed">{sector.tagline}</p>

                        <div className="flex items-center gap-1 mt-4 text-xs font-semibold" style={{ color: sector.color }}>
                            Explorer la solution
                            <ChevronRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
                        </div>

                        {/* KPI tags */}
                        <div className="flex flex-wrap gap-1 mt-3">
                            {sector.kpis.map(kpi => (
                                <span key={kpi} className="text-[9px] font-bold tracking-wide px-2 py-0.5 rounded-md bg-muted/50 text-muted-foreground">
                                    {kpi}
                                </span>
                            ))}
                        </div>
                    </motion.button>
                ))}
            </div>

            {/* Sector Detail Modal */}
            <AnimatePresence>
                {activeData && activeDeepDive && (
                    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="absolute inset-0 bg-background/80 backdrop-blur-xl"
                            onClick={() => setActiveSector(null)}
                        />
                        <motion.div
                            key={activeData.id}
                            initial={{ opacity: 0, scale: 0.96, y: 28 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.96, y: 28 }}
                            transition={{ duration: 0.35, ease: "easeOut" }}
                            className="relative max-h-[92vh] w-full max-w-6xl overflow-hidden rounded-[2rem] border border-border/40 bg-background shadow-2xl"
                        >
                            <div className="absolute inset-0 pointer-events-none opacity-70" style={{
                                background: `radial-gradient(circle at 12% 12%, ${activeData.color}18, transparent 32%), radial-gradient(circle at 86% 18%, #2DD4BF18, transparent 28%)`
                            }} />

                            <div className="relative flex items-center justify-between border-b border-border/30 bg-background/85 px-5 py-4 backdrop-blur-xl">
                                <div className="flex min-w-0 items-center gap-3">
                                    <div className="rounded-2xl p-3 text-white shadow-lg" style={{ backgroundColor: activeData.color }}>
                                        {activeData.icon}
                                    </div>
                                    <div className="min-w-0">
                                        <p className="text-[10px] font-black uppercase tracking-[0.22em] text-muted-foreground">Solution sectorielle</p>
                                        <h2 className="truncate text-xl font-black md:text-2xl">{activeData.title}</h2>
                                    </div>
                                </div>
                                <Button variant="ghost" size="icon" className="rounded-full" onClick={() => setActiveSector(null)}>
                                    <X className="h-5 w-5" />
                                </Button>
                            </div>

                            <div className="relative max-h-[calc(92vh-74px)] overflow-y-auto p-5 md:p-8">
                                <div className="grid gap-6 lg:grid-cols-[1fr_0.95fr]">
                                    <div className="space-y-6">
                                        <div>
                                            <div className="mb-4 inline-flex items-center gap-2 rounded-full border px-4 py-2 text-xs font-black uppercase tracking-[0.18em]" style={{ borderColor: `${activeData.color}33`, color: activeData.color, backgroundColor: `${activeData.color}10` }}>
                                                <ClipboardCheck className="h-3.5 w-3.5" />
                                                Pitch stratégique
                                            </div>
                                            <h3 className="text-3xl font-black leading-tight md:text-5xl">
                                                {activeData.tagline}
                                            </h3>
                                            <p className="mt-4 text-base leading-relaxed text-muted-foreground md:text-lg">
                                                {activeDeepDive.hook}
                                            </p>
                                        </div>

                                        <div className="grid gap-3 sm:grid-cols-2">
                                            {featurePillars.map((pillar) => (
                                                <div key={pillar.key} className="rounded-2xl border border-border/30 bg-card/70 p-4">
                                                    <div className="mb-3 flex items-center gap-2 text-sm font-black">
                                                        <span className="rounded-xl p-2 text-white" style={{ backgroundColor: activeData.color }}>
                                                            {pillar.icon}
                                                        </span>
                                                        {pillar.label}
                                                    </div>
                                                    <p className="text-xs leading-relaxed text-muted-foreground">
                                                        {pillar.key === 'dashboard' && activeDeepDive.dashboard}
                                                        {pillar.key === 'subagents' && activeDeepDive.subagents[0]}
                                                        {pillar.key === 'alerts' && activeDeepDive.alerts[0]}
                                                        {pillar.key === 'websearch' && activeDeepDive.websearch}
                                                        {pillar.key === 'reports' && activeDeepDive.reports}
                                                    </p>
                                                </div>
                                            ))}
                                        </div>

                                        <div className="grid gap-4 md:grid-cols-2">
                                            <div className="rounded-[1.75rem] border border-border/30 bg-card/70 p-5">
                                                <h4 className="mb-4 flex items-center gap-2 text-sm font-black">
                                                    <Bot className="h-4 w-4" style={{ color: activeData.color }} />
                                                    Sous-agents recommandés
                                                </h4>
                                                <div className="space-y-3">
                                                    {activeDeepDive.subagents.map((item, index) => (
                                                        <div key={index} className="flex items-start gap-3 text-sm">
                                                            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" style={{ color: activeData.color }} />
                                                            <span className="text-foreground/80">{item}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>

                                            <div className="rounded-[1.75rem] border border-border/30 bg-card/70 p-5">
                                                <h4 className="mb-4 flex items-center gap-2 text-sm font-black">
                                                    <BellRing className="h-4 w-4" style={{ color: activeData.color }} />
                                                    Alertes à haute valeur
                                                </h4>
                                                <div className="space-y-3">
                                                    {activeDeepDive.alerts.map((item, index) => (
                                                        <div key={index} className="rounded-2xl border border-border/30 bg-background/70 p-3 text-sm text-foreground/80">
                                                            {item}
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        </div>

                                        <div className="rounded-[1.75rem] border border-border/30 bg-card/70 p-5">
                                            <h4 className="mb-3 flex items-center gap-2 text-sm font-black">
                                                <FileSearch className="h-4 w-4" style={{ color: activeData.color }} />
                                                Websearch + création de rapport
                                            </h4>
                                            <div className="grid gap-3 md:grid-cols-2">
                                                <p className="rounded-2xl bg-muted/40 p-4 text-sm leading-relaxed text-muted-foreground">{activeDeepDive.websearch}</p>
                                                <p className="rounded-2xl bg-muted/40 p-4 text-sm leading-relaxed text-muted-foreground">{activeDeepDive.reports}</p>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="space-y-5">
                                        <div className="overflow-hidden rounded-[2rem] border border-white/10 bg-[#071D1F] p-5 text-white shadow-2xl">
                                            <div className="mb-5 flex items-center justify-between">
                                                <div>
                                                    <p className="text-[10px] font-black uppercase tracking-[0.22em] text-white/45">Dashboard avancé</p>
                                                    <h3 className="mt-1 text-2xl font-black">Cockpit {activeData.title}</h3>
                                                </div>
                                                <Network className="h-5 w-5 text-[#2DD4BF]" />
                                            </div>

                                            <div className="grid grid-cols-2 gap-3">
                                                {activeDeepDive.miniKpis.map((kpi) => (
                                                    <div key={kpi} className="rounded-2xl border border-white/10 bg-white/[0.07] p-4">
                                                        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/40">KPI</p>
                                                        <p className="mt-2 text-xl font-black">{kpi}</p>
                                                    </div>
                                                ))}
                                            </div>

                                            <div className="mt-4 rounded-[1.5rem] border border-white/10 bg-white/[0.06] p-4">
                                                <div className="mb-4 flex items-center justify-between">
                                                    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/45">Signal métier</p>
                                                    <span className="rounded-full bg-[#2DD4BF]/15 px-3 py-1 text-[10px] font-black text-[#9AF5E8]">Live</span>
                                                </div>
                                                <div className="flex h-32 items-end gap-2">
                                                    {[46, 72, 54, 88, 64, 92, 58, 76, 98].map((height, index) => (
                                                        <motion.span
                                                            key={index}
                                                            initial={{ height: 0 }}
                                                            animate={{ height: `${height}%` }}
                                                            transition={{ delay: index * 0.05, duration: 0.45 }}
                                                            className="flex-1 rounded-t-full"
                                                            style={{ background: `linear-gradient(180deg, ${activeData.color}, ${activeData.color}55)` }}
                                                        />
                                                    ))}
                                                </div>
                                            </div>
                                        </div>

                                        <div className="rounded-[2rem] border border-border/30 bg-card/80 p-5">
                                            <h4 className="mb-4 text-sm font-black uppercase tracking-[0.18em] text-muted-foreground">Résultats attendus</h4>
                                            <div className="grid gap-3">
                                                {activeDeepDive.outcomes.map((outcome) => (
                                                    <div key={outcome} className="flex items-center gap-3 rounded-2xl bg-muted/40 p-3 text-sm font-bold">
                                                        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: activeData.color }} />
                                                        {outcome}
                                                    </div>
                                                ))}
                                            </div>
                                        </div>

                                        <div className="rounded-[2rem] border border-border/30 bg-card/80 p-5">
                                            <h4 className="mb-4 text-sm font-black uppercase tracking-[0.18em] text-muted-foreground">Cas d'usage inclus</h4>
                                            <div className="space-y-2">
                                                {activeData.cases.map((c, j) => (
                                                    <div key={j} className="flex items-start gap-3 text-sm">
                                                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" style={{ color: activeData.color }} />
                                                        <span className="text-foreground/80">{c}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                <div className="mt-6 flex flex-col gap-3 rounded-[1.75rem] border border-border/30 bg-card/80 p-4 sm:flex-row sm:items-center sm:justify-between">
                                    <p className="text-sm text-muted-foreground">
                                        Démo ciblée: nous simulons vos sources, vos seuils d'alerte et le rapport exécutif de ce secteur.
                                    </p>
                                    <Button className="rounded-2xl text-white" style={{ backgroundColor: activeData.color }}>
                                        Demander une démo {activeData.title}
                                        <ArrowRight className="ml-2 h-4 w-4" />
                                    </Button>
                                </div>
                            </div>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>

            {/* Sovereign Trust Banner */}
            <div className="rounded-3xl overflow-hidden relative">
                <div className="absolute inset-0 bg-gradient-to-br from-[#0D7377] via-[#0A5C5F] to-[#064E3B]" />
                <div className="absolute inset-0 opacity-[0.04]" style={{
                    backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='1'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
                }} />
                <div className="relative z-10 p-10 md:p-16 text-center text-white space-y-6">
                    <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/10 border border-white/15 text-white/90 text-xs font-bold tracking-widest uppercase">
                        <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                        Hébergement Souverain Maroc
                    </div>
                    <h2 className="text-3xl md:text-4xl font-black leading-tight max-w-2xl mx-auto">
                        Votre cas d'usage est spécifique ?<br />
                        <span className="text-[#2DD4BF]">Nous l'avons probablement déjà résolu.</span>
                    </h2>
                    <p className="text-white/70 max-w-xl mx-auto">
                        100% conforme aux réglementations marocaines. Données hébergées sur des serveurs souverains au Maroc. Aucune donnée ne quitte le territoire.
                    </p>
                    <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-4">
                        <Button className="h-14 px-10 bg-white text-[#0D7377] hover:bg-white/90 rounded-2xl text-lg font-bold shadow-2xl">
                            En parler avec un expert
                            <ArrowRight className="ml-2 h-5 w-5" />
                        </Button>
                        <Button variant="ghost" className="h-14 px-10 rounded-2xl text-lg font-bold text-white/80 hover:text-white hover:bg-white/10">
                            Consulter la documentation
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default Solutions;
