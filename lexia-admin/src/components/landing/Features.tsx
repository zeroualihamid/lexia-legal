import React from 'react';
import { motion } from 'framer-motion';
import { MessageSquare, Database, Zap, Search, ShieldCheck, BarChart3, ArrowRight, Target, Cpu, Globe, HelpCircle, FileCheck, Layers, FileText } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { asset } from "@/lib/asset";

const Features = () => {
    const features = [
        {
            icon: <MessageSquare className="h-8 w-8 text-blue-500" />,
            title: "Analyse Conversationnelle Intuitive",
            desc: "Ne cherchez plus dans des colonnes infinies. Posez des questions comme : 'Quel est l'impact de nos frais de personnel sur le PNB ce semestre ?' et obtenez une réponse instantanée.",
            benefit: "Élimine le besoin de maîtriser des outils BI complexes."
        },
        {
            icon: <Database className="h-8 w-8 text-purple-500" />,
            title: "Gestion de l'Hétérogénéité des Données",
            desc: "Notre moteur d'IA corrèle automatiquement des sources disparates (Compta, RH, Ventes) sans nécessiter de projets de nettoyage de données de plusieurs mois.",
            benefit: "Valorisez vos données telles qu'elles sont, même imparfaites."
        },
        {
            icon: <Zap className="h-8 w-8 text-yellow-500" />,
            title: "Décisions en Temps Réel",
            desc: "Le passage de la donnée brute à l'insight ne prend que quelques secondes. Parfait pour les comités de direction où chaque minute compte.",
            benefit: "Accélérez votre cycle de décision stratégique."
        },
        {
            icon: <Search className="h-8 w-8 text-emerald-500" />,
            title: "Extraction de Tendances Cachées",
            desc: "L'IA identifie les anomalies et les opportunités que les filtres statiques des tableaux de bord classiques ne voient pas.",
            benefit: "Anticipez les risques avant qu'ils ne deviennent critiques."
        },
        {
            icon: <ShieldCheck className="h-8 w-8 text-rose-500" />,
            title: "Gouvernance et Sécurité",
            desc: "Contrôlez qui accède à quels types de questions. Vos données restent chiffrées et conformes aux exigences du secteur financier.",
            benefit: "Confidentialité totale pour vos données sensibles."
        },
        {
            icon: <BarChart3 className="h-8 w-8 text-indigo-500" />,
            title: "Visualisation à la Demande",
            desc: "Besoin d'un graphique pour votre présentation ? Demandez-le simplement au chatbot et il générera le visuel idéal en un clic.",
            benefit: "Visez juste lors de vos prochaines présentations."
        }
    ];

    const workflowSteps = [
        {
            icon: <Target className="h-6 w-6" />,
            title: "Définition de la Mission",
            desc: "Vous fixez l'objectif stratégique ou le diagnostic à réaliser (ex: 'Audit de rentabilité filiale Ouest').",
            color: "blue"
        },
        {
            icon: <Cpu className="h-6 w-6" />,
            title: "Background Agent",
            desc: "Un agent autonome est lancé en arrière-plan pour traiter la mission sans bloquer votre interface.",
            color: "purple"
        },
        {
            icon: <Layers className="h-6 w-6" />,
            title: "Analyse Multi-Connecteurs",
            desc: "L'agent sollicite simultanément tous vos connecteurs (SQL, Oracle, QVD, CSV) pour une vue exhaustive.",
            color: "indigo"
        },
        {
            icon: <HelpCircle className="h-6 w-6" />,
            title: "Interaction Clarification",
            desc: "Si des données manquent, l'agent vous sollicite directement pour obtenir des précisions ou documents.",
            color: "amber"
        },
        {
            icon: <Globe className="h-6 w-6" />,
            title: "Intelligence Externe",
            desc: "Recherche web intégrée pour comparer vos KPIs avec des benchmarks sectoriels et méthodologies actuelles.",
            color: "emerald"
        },
        {
            icon: <FileCheck className="h-6 w-6" />,
            title: "Rapport Final Actionnable",
            desc: "Production d'un diagnostic complet avec analyse financière, plan d'action et outils de pilotage.",
            color: "rose"
        }
    ];

    return (
        <div className="py-24 px-6 max-w-7xl mx-auto">
            <div className="text-center mb-20">
                <motion.h1
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="text-4xl md:text-6xl font-black mb-6"
                >
                    Une Technologie au Service de <br />
                    <span className="text-blue-600">votre Intuition Décisionnelle</span>
                </motion.h1>
                <p className="text-xl text-muted-foreground max-w-3xl mx-auto leading-relaxed">
                    Nous avons conçu qclick pour les dirigeants qui veulent l'information sans la barrière technique.
                    Un agent conversationnel qui indexe tout, comprend tout, et répond à tout.
                </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                {features.map((f, i) => (
                    <motion.div
                        key={i}
                        initial={{ opacity: 0, scale: 0.9 }}
                        whileInView={{ opacity: 1, scale: 1 }}
                        viewport={{ once: true }}
                        transition={{ delay: i * 0.1 }}
                        className="p-8 rounded-[2.5rem] bg-card border border-border/40 hover:shadow-2xl hover:shadow-blue-500/5 transition-all group"
                    >
                        <div className="p-4 rounded-2xl bg-muted/50 w-fit mb-6 group-hover:bg-blue-500/10 transition-colors">
                            {f.icon}
                        </div>
                        <h3 className="text-2xl font-bold mb-4">{f.title}</h3>
                        <p className="text-muted-foreground mb-6 leading-relaxed">
                            {f.desc}
                        </p>
                        <div className="pt-4 border-t border-border/20">
                            <p className="text-blue-500 text-sm font-semibold flex items-center gap-2">
                                <CheckCircle2 className="h-4 w-4" />
                                {f.benefit}
                            </p>
                        </div>
                    </motion.div>
                ))}
            </div>

            {/* Workflow Section */}
            <div className="mt-40 mb-32">
                <div className="text-center mb-16">
                    <h2 className="text-3xl md:text-5xl font-bold mb-6 italic opacity-80">Cycle de Mission Autonome</h2>
                    <p className="text-muted-foreground max-w-2xl mx-auto">
                        Ne restez pas devant votre écran. Donnez une mission à votre analyste IA et laissez-la construire votre diagnostic stratégique.
                    </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-12 relative">
                    {/* Connection Lines (Desktop hack with absolute div) */}
                    <div className="hidden lg:block absolute top-1/2 left-0 w-full h-px bg-gradient-to-r from-transparent via-border to-transparent -translate-y-1/2 z-0" />

                    {workflowSteps.map((step, i) => (
                        <motion.div
                            key={i}
                            initial={{ opacity: 0, y: 20 }}
                            whileInView={{ opacity: 1, y: 0 }}
                            viewport={{ once: true }}
                            transition={{ delay: i * 0.1 }}
                            className="relative z-10 flex flex-col items-center text-center p-6 bg-background rounded-3xl border border-transparent hover:border-border/40 hover:bg-card/50 transition-all"
                        >
                            <div className={`h-20 w-20 rounded-[2rem] flex items-center justify-center mb-6 shadow-xl rotate-3 group-hover:rotate-0 transition-transform ${step.color === 'blue' ? 'bg-blue-500 text-white shadow-blue-500/20' :
                                step.color === 'purple' ? 'bg-purple-500 text-white shadow-purple-500/20' :
                                    step.color === 'indigo' ? 'bg-indigo-500 text-white shadow-indigo-500/20' :
                                        step.color === 'amber' ? 'bg-amber-500 text-white shadow-amber-500/20' :
                                            step.color === 'emerald' ? 'bg-emerald-500 text-white shadow-emerald-500/20' :
                                                'bg-rose-500 text-white shadow-rose-500/20'
                                }`}>
                                {step.icon}
                            </div>
                            <h4 className="text-xl font-bold mb-3">{step.title}</h4>
                            <p className="text-muted-foreground text-sm leading-relaxed italic">
                                "{step.desc}"
                            </p>
                        </motion.div>
                    ))}
                </div>

                {/* Vertical Illustration for Mobile / Logic Summary */}
                <div className="mt-20 p-8 rounded-[3rem] bg-muted/20 border border-border/40 border-dashed max-w-4xl mx-auto">
                    <div className="flex flex-col md:flex-row items-center gap-12 text-center md:text-left">
                        <div className="relative group">
                            <div className="absolute inset-0 bg-blue-500 blur-2xl opacity-10 group-hover:opacity-20 transition-opacity" />
                            <img
                                src={asset("autonomous-agent-workflow.png")}
                                alt="Autonomous Agent Workflow"
                                className="w-full max-w-lg rounded-[2rem] shadow-[0_0_50px_rgba(37,99,235,0.2)] relative z-10 border border-white/10"
                            />
                        </div>
                        <div className="flex-1 space-y-6">
                            <h3 className="text-2xl font-bold">L'Intelligence en Arrière-Plan</h3>
                            <p className="text-muted-foreground italic">
                                "Le passage de l'analyse ponctuelle à la gestion de projet autonome. Qclick ne répond pas juste à vos questions, il orchestre votre réflexion stratégique."
                            </p>
                            <div className="grid grid-cols-2 gap-4">
                                <div className="p-3 bg-card border border-border/40 rounded-xl text-[10px] font-black uppercase tracking-widest text-blue-500">Rapport Financier</div>
                                <div className="p-3 bg-card border border-border/40 rounded-xl text-[10px] font-black uppercase tracking-widest text-emerald-500">Plan d'Action</div>
                                <div className="p-3 bg-card border border-border/40 rounded-xl text-[10px] font-black uppercase tracking-widest text-purple-500">Diagnostic Complet</div>
                                <div className="p-3 bg-card border border-border/40 rounded-xl text-[10px] font-black uppercase tracking-widest text-rose-500">Pilotage Temps Réel</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div className="mt-24 p-12 rounded-[3.5rem] bg-gradient-to-br from-blue-600 to-indigo-700 text-white overflow-hidden relative">
                <div className="relative z-10 flex flex-col md:flex-row items-center justify-between gap-8">
                    <div className="max-w-2xl">
                        <h2 className="text-3xl md:text-4xl font-bold mb-4">L'IA qui dompte vos données hétérogènes</h2>
                        <p className="text-blue-100 text-lg opacity-90 leading-relaxed">
                            Ne laissez plus vos données en silos. Qclick crée le pont entre tous vos services pour une vision à 360° du Produit Net Bancaire et de la performance opérationnelle.
                        </p>
                    </div>
                    <Button className="h-16 px-10 bg-white text-blue-600 hover:bg-blue-50 rounded-2xl text-xl font-bold">
                        Essayer Qclick gratuitement
                    </Button>
                </div>
                <div className="absolute top-0 right-0 w-64 h-64 bg-white/10 rounded-full blur-3xl -mr-32 -mt-32" />
                <div className="absolute bottom-0 left-0 w-64 h-64 bg-blue-400/20 rounded-full blur-3xl -ml-32 -mb-32" />
            </div>
        </div>
    );
};

// Re-using icon for consistency
const CheckCircle2 = ({ className }) => (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
);

export default Features;
