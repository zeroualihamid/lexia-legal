import React from 'react';
import { motion } from 'framer-motion';
import {
    CheckCircle2,
    Database,
    Server,
    FileText,
    Code,
    GitBranch,
    Shield,
    Activity,
    Layers,
    Cpu,
    Cloud,
    Zap,
    Search,
    Lock,
    Globe
} from 'lucide-react';
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const ArchitecturePage = () => {
    const deploymentOptions = [
        {
            title: "On-Premise (Sécurité Maximale)",
            desc: "Déploiement intégral derrière votre pare-feu. Vos données ne quittent jamais votre infrastructure physique ou virtuelle.",
            icon: <Shield className="h-10 w-10 text-emerald-500" />,
            details: [
                { title: "Souveraineté Totale", text: "Maîtrise complète de la localisation et de l'accès aux données." },
                { title: "Performance Locale", text: "Accès direct aux bases de données via le réseau interne (latence ultra-faible)." },
                { title: "Zéro Sortie de Flux", text: "Aucune connexion sortante vers des serveurs tiers ou APIs externes." },
                { title: "Intégration Active Directory", text: "Authentification native via vos protocoles d'entreprise." }
            ]
        },
        {
            title: "Cloud Hybrid & Private Cloud",
            desc: "Le meilleur des deux mondes : la puissance du Cloud avec la sécurité du On-Premise via VPN Site-to-Site.",
            icon: <Cloud className="h-10 w-10 text-blue-500" />,
            details: [
                { title: "Tunneling Sécurisé", text: "Connexion cryptée AES-256 entre le Cloud Qclick et votre SI." },
                { title: "Auto-Scaling", text: "Ajustement automatique des ressources selon la charge d'analyse." },
                { title: "Isolation Logique", text: "Instances dédiées et isolées (Single-Tenant) par client." },
                { title: "Backup Géo-Redondant", text: "Résilience maximale face aux pannes d'infrastructure." }
            ]
        }
    ];

    const connectorDetails = [
        {
            name: "SQL Server & Azure SQL",
            capabilities: ["Multi-tables simultanées", "Mise à jour par différentiel", "Schémas Pydantic typés", "Pooling de connexion"],
            icon: <Database className="h-5 w-5" />
        },
        {
            name: "Oracle Database",
            capabilities: ["Requêtes SQL complexes", "Introspection via ALL_TAB_COLUMNS", "Optimisation cx_Oracle", "Support SQL personnalisé"],
            icon: <Server className="h-5 w-5" />
        },
        {
            name: "QlikView (QVD)",
            capabilities: ["Lecture ultrarapide optimisée", "Support legacy maintenu", "Indépendance totale du moteur Qlik", "Conversion Parquet auto"],
            icon: <FileText className="h-5 w-5" />
        },
        {
            name: "Fichiers Plats (CSV/Excel)",
            capabilities: ["Lecture par chunks (>10Go)", "Détection de schémas automatique", "Support encodage multiples", "Typage dynamique (Num/Date)"],
            icon: <FileText className="h-5 w-5" />
        }
    ];

    const pipelineSteps = [
        { step: "Identification", desc: "Configuration des sources via YAML & Variables d'environnement.", icon: <Search className="h-4 w-4" /> },
        { step: "Ingestion & Cache", desc: "Extraction optimisée et mise en cache Parquet avec compression Snappy.", icon: <Zap className="h-4 w-4" /> },
        { step: "Orchestration", desc: "Fusion logique des sources via le ConnectorManager.", icon: <GitBranch className="h-4 w-4" /> },
        { step: "Service IA", desc: "Agent QvdAgent alimenté par un DataFrame unifié et performant.", icon: <Cpu className="h-4 w-4" /> }
    ];

    return (
        <div className="min-h-screen bg-background pt-12 pb-24">
            {/* Context Header */}
            <section className="px-6 max-w-7xl mx-auto mb-20 text-center lg:text-left">
                <div className="flex flex-col lg:flex-row lg:items-center gap-16">
                    <div className="flex-1 space-y-6">
                        <motion.div
                            initial={{ opacity: 0, x: -20 }}
                            animate={{ opacity: 1, x: 0 }}
                            className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-500 text-[10px] font-black uppercase tracking-widest mx-auto lg:mx-0"
                        >
                            <Shield className="h-3 w-3" />
                            Security & Data Architecture
                        </motion.div>
                        <h1 className="text-4xl md:text-7xl font-black tracking-tight leading-[1]">
                            Une infrastructure <br />
                            <span className="text-blue-600">Enterprise-Ready</span>
                        </h1>
                        <p className="text-xl text-muted-foreground leading-relaxed max-w-2xl mx-auto lg:mx-0">
                            Qclick n'est pas seulement une IA ; c'est un moteur d'orchestration de données sécurisé, conçu pour s'intégrer dans les environnements IT les plus exigeants.
                        </p>
                    </div>
                </div>
            </section>

            {/* Deployment Models Deep Dive */}
            <section className="px-6 max-w-7xl mx-auto mb-32">
                <div className="flex items-center gap-4 mb-12">
                    <h2 className="text-3xl font-bold">Modèles de Déploiement</h2>
                    <div className="h-px flex-1 bg-border/40" />
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
                    {deploymentOptions.map((opt, i) => (
                        <Card key={i} className="p-10 rounded-[3.5rem] bg-card border-border/40 overflow-hidden relative group">
                            <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:scale-110 transition-transform">
                                {opt.icon}
                            </div>
                            <div className="mb-8">{opt.icon}</div>
                            <h3 className="text-3xl font-bold mb-4">{opt.title}</h3>
                            <p className="text-muted-foreground mb-10 text-lg leading-relaxed">{opt.desc}</p>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                                {opt.details.map((detail, idx) => (
                                    <div key={idx} className="space-y-1">
                                        <div className="flex items-center gap-2 text-sm font-black uppercase tracking-wider text-foreground">
                                            <CheckCircle2 className="h-4 w-4 text-blue-500" />
                                            {detail.title}
                                        </div>
                                        <p className="text-xs text-muted-foreground leading-relaxed pl-6">
                                            {detail.text}
                                        </p>
                                    </div>
                                ))}
                            </div>
                        </Card>
                    ))}
                </div>
            </section>

            {/* Connectivity Matrix */}
            <section className="px-6 max-w-7xl mx-auto mb-32">
                <div className="p-12 rounded-[3.5rem] bg-muted/20 border border-border/40">
                    <div className="mb-12">
                        <h2 className="text-3xl font-bold mb-4">Moteur de Connectivité (Data Connectors)</h2>
                        <p className="text-muted-foreground">Chaque connecteur est une brique isolée et optimisée pour son système source.</p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
                        {connectorDetails.map((conn, i) => (
                            <div key={i} className="space-y-6 p-6 rounded-[2rem] bg-card border border-border/40 group hover:border-blue-500/50 transition-all">
                                <div className="h-12 w-12 rounded-2xl bg-blue-500/10 text-blue-500 flex items-center justify-center">
                                    {conn.icon}
                                </div>
                                <h3 className="font-bold text-lg">{conn.name}</h3>
                                <ul className="space-y-3">
                                    {conn.capabilities.map((cap, idx) => (
                                        <li key={idx} className="text-xs text-muted-foreground flex items-center gap-2">
                                            <div className="h-1 w-1 rounded-full bg-blue-500" />
                                            {cap}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* Smart Data Pipeline */}
            <section className="px-6 max-w-7xl mx-auto mb-32">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
                    <div className="relative h-[400px] flex items-center justify-center">
                        <div className="absolute inset-0 bg-blue-500/5 rounded-full blur-[100px]" />
                        <div className="relative space-y-6 w-full max-w-md">
                            {pipelineSteps.map((step, i) => (
                                <motion.div
                                    key={i}
                                    initial={{ opacity: 0, x: -20 }}
                                    whileInView={{ opacity: 1, x: 0 }}
                                    transition={{ delay: i * 0.1 }}
                                    className="relative pl-12 py-2"
                                >
                                    {i < pipelineSteps.length - 1 && (
                                        <div className="absolute left-[19px] top-10 w-[2px] h-full bg-gradient-to-b from-blue-500/30 to-transparent" />
                                    )}
                                    <div className="absolute left-0 top-3 h-10 w-10 rounded-xl bg-background border border-border flex items-center justify-center shadow-sm text-blue-500">
                                        {step.icon}
                                    </div>
                                    <div className="font-bold text-sm text-foreground">{step.step}</div>
                                    <div className="text-xs text-muted-foreground">{step.desc}</div>
                                </motion.div>
                            ))}
                        </div>
                    </div>

                    <div className="space-y-8">
                        <h2 className="text-3xl font-bold leading-tight">Mise à jour Intelligente <br />et Cache de Performance</h2>
                        <ul className="space-y-6">
                            {[
                                { title: "Rafraîchissement Incrémental", text: "Qclick ne télécharge que les nouvelles lignes (LastModified), réduisant la charge sur vos serveurs de 90%." },
                                { title: "Cachage Parquet (Snappy)", text: "Les données sont stockées localement en format Parquet compressé pour des temps de réponse instantanés." },
                                { title: "Schémas Dynamiques", text: "Adaptation automatique aux changements de structures dans vos bases de données sans intervention humaine." }
                            ].map((item, i) => (
                                <div key={i} className="p-6 rounded-3xl bg-card border border-border/40">
                                    <h4 className="font-bold mb-2 flex items-center gap-2">
                                        <div className="h-2 w-2 rounded-full bg-blue-500" />
                                        {item.title}
                                    </h4>
                                    <p className="text-sm text-muted-foreground leading-relaxed">{item.text}</p>
                                </div>
                            ))}
                        </ul>
                    </div>
                </div>
            </section>

            {/* Final CTA */}
            <section className="px-6 max-w-4xl mx-auto">
                <div className="p-16 rounded-[4rem] bg-slate-950 text-white relative overflow-hidden text-center shadow-2xl">
                    <div className="absolute top-0 left-0 w-full h-full bg-[radial-gradient(circle_at_0%_0%,rgba(37,99,235,0.15),transparent)]" />
                    <motion.div
                        initial={{ opacity: 0, scale: 0.9 }}
                        whileInView={{ opacity: 1, scale: 1 }}
                        className="relative z-10 space-y-8"
                    >
                        <Lock className="h-16 w-16 mx-auto text-blue-500" />
                        <h2 className="text-4xl font-bold tracking-tight">Sécurité sans compromis</h2>
                        <p className="text-slate-400 text-lg max-w-xl mx-auto leading-relaxed">
                            Nous respectons les standards les plus élevés (RGPD, SOC2) pour garantir que votre patrimoine data est protégé à chaque étape.
                        </p>
                        <div className="flex flex-wrap justify-center gap-4 pt-4">
                            <Button className="h-14 px-10 rounded-2xl bg-blue-600 hover:bg-blue-500 font-bold transition-all hover:scale-105">
                                Consulter le Livre Blanc Sécurité
                            </Button>
                            <Button variant="outline" className="h-14 px-10 rounded-2xl bg-white/5 hover:bg-white/10 font-bold border border-white/10 transition-all">
                                Parler à un Expert Architecture
                            </Button>
                        </div>
                    </motion.div>
                </div>
            </section>
        </div>
    );
};

export default ArchitecturePage;
