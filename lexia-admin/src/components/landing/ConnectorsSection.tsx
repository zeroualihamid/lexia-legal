import React from 'react';
import { motion } from 'framer-motion';
import { Database, Cloud, FileText, BarChart, ShieldCheck, Zap, Globe, Share2, Server, Layout, CheckCircle2 } from 'lucide-react';
import { asset } from '@/lib/asset';

const ConnectorsSection = () => {
    const connectors = [
        { name: "Microsoft SQL Server", icon: <Database className="h-6 w-6" />, category: "Bases de données" },
        { name: "Oracle Database", icon: <Server className="h-6 w-6" />, category: "Bases de données" },
        { name: "Fichiers Qlik (QVD)", icon: <BarChart className="h-6 w-6" />, category: "BI Legacy" },
        { name: "Excel & CSV", icon: <FileText className="h-6 w-6" />, category: "Fichiers" },
        { name: "SAP & ERP", icon: <Globe className="h-6 w-6" />, category: "Enterprise" },
        { name: "Cloud Storage", icon: <Cloud className="h-6 w-6" />, category: "Modern Stack" }
    ];

    return (
        <section className="py-24 px-6 relative max-w-7xl mx-auto overflow-hidden">
            {/* Background Glow */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[600px] bg-blue-500/5 rounded-full blur-[120px] pointer-events-none" />

            <div className="flex flex-col lg:flex-row items-center gap-16 relative z-10">
                {/* Left side: Sales Copy */}
                <div className="flex-1 space-y-8 text-center lg:text-left">
                    <motion.div
                        initial={{ opacity: 0, x: -20 }}
                        whileInView={{ opacity: 1, x: 0 }}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-600 dark:text-blue-400 text-sm font-bold uppercase tracking-widest"
                    >
                        <Zap className="h-4 w-4" />
                        Connectivité Universelle
                    </motion.div>

                    <h2 className="text-4xl md:text-6xl font-black tracking-tight text-foreground leading-[1.1]">
                        Toutes vos données, <br />
                        <span className="text-blue-600">Une seule intelligence</span>
                    </h2>

                    <p className="text-xl text-muted-foreground leading-relaxed">
                        Ne laissez plus vos données en silos. Qclick se connecte instantanément à vos systèmes existants pour transformer des chiffres dispersés en décisions stratégiques.
                    </p>

                    <div className="space-y-4 pt-4">
                        {[
                            "Installation en moins de 15 minutes",
                            "Synchronisation temps réel sans impact performance",
                            "Sécurité native de bout en bout",
                            "Zéro projet d'intégration long et coûteux"
                        ].map((item, i) => (
                            <motion.div
                                key={i}
                                initial={{ opacity: 0, x: -20 }}
                                whileInView={{ opacity: 1, x: 0 }}
                                transition={{ delay: i * 0.1 }}
                                className="flex items-center gap-3 text-foreground font-medium"
                            >
                                <div className="h-6 w-6 rounded-full bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20">
                                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                                </div>
                                {item}
                            </motion.div>
                        ))}
                    </div>
                </div>

                {/* Right side: Visual Hub Illustration */}
                <div className="flex-1 relative w-full h-[500px] flex items-center justify-center">
                    {/* Central Core */}
                    <motion.div
                        animate={{
                            scale: [1, 1.05, 1],
                            rotate: [0, 360]
                        }}
                        transition={{
                            scale: { duration: 4, repeat: Infinity, ease: "easeInOut" },
                            rotate: { duration: 60, repeat: Infinity, ease: "linear" }
                        }}
                        className="relative z-20 w-32 h-32 rounded-[2.5rem] bg-gradient-to-tr from-blue-600 to-indigo-700 shadow-[0_0_50px_rgba(37,99,235,0.4)] flex items-center justify-center border border-white/20"
                    >
                        <img src={asset("logo.png")} alt="qclick" className="h-16 w-16 brightness-200" />
                        {/* Orbiting particles */}
                        <div className="absolute inset-0 border-2 border-white/10 rounded-[2.5rem] animate-ping opacity-20" />
                    </motion.div>

                    {/* Orbiting Connectors */}
                    {connectors.map((c, i) => {
                        const angle = (i * (360 / connectors.length));
                        const radius = 180;
                        return (
                            <motion.div
                                key={i}
                                initial={{ opacity: 0, scale: 0 }}
                                whileInView={{ opacity: 1, scale: 1 }}
                                transition={{ delay: i * 0.1, type: "spring" }}
                                style={{
                                    position: 'absolute',
                                    x: Math.cos((angle * Math.PI) / 180) * radius,
                                    y: Math.sin((angle * Math.PI) / 180) * radius,
                                }}
                                className="z-30 group"
                            >
                                <div className="p-4 rounded-2xl bg-card border border-border/40 shadow-xl group-hover:border-blue-500/50 transition-all group-hover:scale-110 flex flex-col items-center gap-2">
                                    <div className="p-2 rounded-xl bg-blue-500/10 text-blue-500 group-hover:bg-blue-600 group-hover:text-white transition-colors">
                                        {c.icon}
                                    </div>
                                    <span className="text-[9px] font-black uppercase tracking-widest opacity-0 group-hover:opacity-100 absolute -bottom-8 whitespace-nowrap bg-background px-2 py-1 rounded-md border border-border shadow-sm">
                                        {c.name}
                                    </span>
                                </div>

                                {/* Dynamic connection line to center */}
                                <svg
                                    className="absolute top-1/2 left-1/2 -z-10 w-[200px] h-[200px]"
                                    style={{
                                        transform: `translate(-50%, -50%) rotate(${angle + 180}deg)`,
                                        transformOrigin: '50% 50%'
                                    }}
                                >
                                    <motion.line
                                        x1="100" y1="100" x2="180" y2="100"
                                        stroke="currentColor"
                                        strokeWidth="1.5"
                                        strokeDasharray="4 4"
                                        className="text-blue-500/20"
                                        initial={{ pathLength: 0 }}
                                        whileInView={{ pathLength: 1 }}
                                        transition={{ duration: 1, delay: i * 0.1 }}
                                    />
                                    <motion.circle
                                        r="3"
                                        fill="currentColor"
                                        className="text-blue-500"
                                        animate={{
                                            cx: [180, 100],
                                        }}
                                        transition={{
                                            duration: 2,
                                            repeat: Infinity,
                                            delay: i * 0.5,
                                            ease: "linear"
                                        }}
                                    />
                                </svg>
                            </motion.div>
                        );
                    })}

                    {/* Background rings */}
                    <div className="absolute w-[360px] h-[360px] border border-blue-500/10 rounded-full" />
                    <div className="absolute w-[180px] h-[180px] border border-blue-500/5 rounded-full" />
                </div>
            </div>

            {/* Social Proof Benchmarks */}
            <div className="mt-24 grid grid-cols-2 md:grid-cols-4 gap-8 py-12 border-y border-border/10 bg-muted/10 rounded-[3rem]">
                {[
                    { label: "Systèmes Supportés", val: "50+" },
                    { label: "Temps d'Intégration", val: "< 15 min" },
                    { label: "Uptime Connecteurs", val: "99.9%" },
                    { label: "Volume de Données", val: "Unlimited" }
                ].map((stat, i) => (
                    <div key={i} className="text-center space-y-2 px-4 border-r border-border/10 last:border-0">
                        <div className="text-3xl font-black text-foreground">{stat.val}</div>
                        <div className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground">{stat.label}</div>
                    </div>
                ))}
            </div>
        </section>
    );
};

export default ConnectorsSection;
