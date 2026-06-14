import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    Database,
    MessageSquare,
    LineChart,
    Search,
    ChevronDown,
    ChevronUp,
    PieChart,
    ShieldAlert,
    Wallet,
    TrendingUp,
    Briefcase,
    FileSpreadsheet,
    ArrowRight
} from 'lucide-react';
import { BANKING_QUESTIONS, INDUSTRY_SECTORS } from '../../constants/questions';

const DataInsights = ({ onTestQuestion }) => {
    const [searchTerm, setSearchTerm] = useState('');
    const [expandedCategory, setExpandedCategory] = useState(null);

    const iconMap = {
        performance: <PieChart className="h-5 w-5" />,
        produits: <Wallet className="h-5 w-5" />,
        risques: <ShieldAlert className="h-5 w-5" />,
        charges: <TrendingUp className="h-5 w-5" />,
        provisions: <FileSpreadsheet className="h-5 w-5" />,
        tresorerie: <Briefcase className="h-5 w-5" />,
        exceptionnel: <Database className="h-5 w-5" />,
        audit: <Search className="h-5 w-5" />,
        strategique: <TrendingUp className="h-5 w-5" />,
        specifique: <MessageSquare className="h-5 w-5" />,
        gestion: <LineChart className="h-5 w-5" />,
        clientele: <Briefcase className="h-5 w-5" />,
    };

    const categoriesWithIcons = INDUSTRY_SECTORS.map(cat => ({
        ...cat,
        icon: iconMap[cat.icon] || <Database className="h-5 w-5" />
    }));

    const filteredCategories = categoriesWithIcons.map(cat => ({
        ...cat,
        questions: cat.questions.filter(q => q.toLowerCase().includes(searchTerm.toLowerCase()))
    })).filter(cat => cat.questions.length > 0);

    return (
        <div className="py-20 px-6 max-w-7xl mx-auto min-h-screen">
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-center mb-16"
            >
                <h1 className="text-4xl md:text-6xl font-bold mb-6">Données & Insights</h1>
                <p className="text-xl text-muted-foreground max-w-3xl mx-auto">
                    Qclick traite des flux de données complexes pour vous offrir une clarté instantanée. Explorez le type d'analyses que vous pouvez réaliser.
                </p>
            </motion.div>

            {/* Visual Examples */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-24">
                <motion.div
                    initial={{ opacity: 0, x: -20 }}
                    whileInView={{ opacity: 1, x: 0 }}
                    viewport={{ once: true }}
                    className="p-8 rounded-[3rem] bg-card border border-border/40 overflow-hidden relative group"
                >
                    <div className="mb-6 flex items-center gap-3">
                        <div className="p-3 rounded-2xl bg-blue-500/10 text-blue-500">
                            <MessageSquare className="h-6 w-6" />
                        </div>
                        <h3 className="text-2xl font-bold">Analyse Conversationnelle</h3>
                    </div>
                    <p className="text-muted-foreground mb-8">
                        Interrogez vos données en langage naturel. Qclick comprend les nuances bancaires, les termes comptables et les ratios financiers complexes.
                    </p>
                    <div className="bg-background/50 rounded-2xl border border-border/40 p-4 space-y-3">
                        <div className="flex gap-2 bg-blue-500/10 p-3 rounded-xl border border-blue-500/20 text-sm max-w-[90%] font-medium">
                            Quelle est la part du coût du risque dans notre PNB ce trimestre ?
                        </div>
                        <div className="flex gap-2 bg-muted p-3 rounded-xl border border-border/40 text-sm max-w-[90%] ml-auto italic">
                            Le coût du risque représente 12.4% du PNB, en légère hausse de 0.8% par rapport au T2.
                        </div>
                    </div>
                </motion.div>

                <motion.div
                    initial={{ opacity: 0, x: 20 }}
                    whileInView={{ opacity: 1, x: 0 }}
                    viewport={{ once: true }}
                    className="p-8 rounded-[3rem] bg-card border border-border/40 overflow-hidden relative group"
                >
                    <div className="mb-6 flex items-center gap-3">
                        <div className="p-3 rounded-2xl bg-purple-500/10 text-purple-500">
                            <LineChart className="h-6 w-6" />
                        </div>
                        <h3 className="text-2xl font-bold">Visualisation de Graphes</h3>
                    </div>
                    <p className="text-muted-foreground mb-8">
                        Générez instantanément des graphiques interactifs pour visualiser les tendances, les répartitions et les corrélations critiques.
                    </p>
                    <div className="bg-background/50 rounded-2xl border border-border/40 p-6 flex flex-col items-center justify-center min-h-[140px]">
                        <div className="flex items-end gap-2 w-full h-24">
                            {[40, 70, 45, 90, 65, 80, 55].map((h, i) => (
                                <motion.div
                                    key={i}
                                    initial={{ height: 0 }}
                                    whileInView={{ height: `${h}%` }}
                                    className="flex-1 bg-gradient-to-t from-blue-600 to-purple-500 rounded-t-md"
                                />
                            ))}
                        </div>
                        <div className="w-full h-[1px] bg-border mt-2" />
                        <div className="flex justify-between w-full mt-2 text-[10px] text-muted-foreground font-bold">
                            <span>JAN</span><span>FEV</span><span>MAR</span><span>AVR</span><span>MAI</span><span>JUN</span><span>JUL</span>
                        </div>
                    </div>
                </motion.div>
            </div>

            {/* Questions Explorer */}
            <div className="space-y-8 mb-32">
                <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
                    <div>
                        <h2 className="text-3xl font-bold mb-4">Questions types par secteur</h2>
                        <p className="text-muted-foreground">Cliquez sur un secteur d'activité pour découvrir les analyses métiers que vous pouvez automatiser.</p>
                    </div>
                    <div className="relative w-full md:w-80">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <input
                            type="text"
                            placeholder="Rechercher une question..."
                            className="w-full pl-10 pr-4 py-3 rounded-xl bg-card border border-border/40 focus:border-blue-500 transition-all outline-none"
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                        />
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {filteredCategories.map((cat) => (
                        <div
                            key={cat.id}
                            className={`rounded-3xl border border-border/40 overflow-hidden transition-all ${expandedCategory === cat.id ? 'bg-card ring-2 ring-blue-500/20' : 'bg-card/50 hover:bg-card'
                                }`}
                        >
                            <button
                                onClick={() => setExpandedCategory(expandedCategory === cat.id ? null : cat.id)}
                                className="w-full flex items-center justify-between p-6 text-left"
                            >
                                <div className="flex items-center gap-3">
                                    <div className={`p-2 rounded-xl border ${expandedCategory === cat.id ? 'bg-blue-500 border-blue-500 text-white' : 'bg-muted border-border/40 text-muted-foreground'}`}>
                                        {cat.icon}
                                    </div>
                                    <span className="font-bold text-sm">{cat.title}</span>
                                </div>
                                {expandedCategory === cat.id ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                            </button>

                            <AnimatePresence>
                                {expandedCategory === cat.id && (
                                    <motion.div
                                        initial={{ height: 0, opacity: 0 }}
                                        animate={{ height: 'auto', opacity: 1 }}
                                        exit={{ height: 0, opacity: 0 }}
                                        className="border-t border-border/40"
                                    >
                                        <div className="p-6 space-y-4 max-h-80 overflow-y-auto custom-scrollbar">
                                            {cat.questions.map((q, i) => (
                                                <div
                                                    key={i}
                                                    onClick={() => onTestQuestion?.(q)}
                                                    className="group cursor-pointer p-4 rounded-2xl bg-muted/30 hover:bg-blue-500/5 hover:border-blue-500/20 border border-transparent transition-all"
                                                >
                                                    <p className="text-sm leading-relaxed text-muted-foreground group-hover:text-foreground">
                                                        {q}
                                                    </p>
                                                    <div className="mt-3 flex items-center gap-2 text-[10px] font-black text-blue-500 uppercase tracking-widest opacity-0 group-hover:opacity-100 transition-opacity">
                                                        <span>Tester cette question</span>
                                                        <ArrowRight className="h-3 w-3" />
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>
                    ))}
                </div>
            </div>

            {/* Ready to start CTA */}
            <section className="text-center py-20 px-6 rounded-[4rem] bg-gradient-to-b from-blue-600/10 to-transparent border border-blue-500/20">
                <h2 className="text-3xl md:text-5xl font-bold mb-6">Prêt à interroger vos propres données ?</h2>
                <p className="text-muted-foreground max-w-2xl mx-auto mb-10 text-lg">
                    Rejoignez les leaders du marché qui utilisent Qclick pour transformer leurs données hétérogènes en avantages compétitifs immédiats.
                </p>
                <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
                    <button className="h-14 px-8 bg-blue-600 text-white rounded-2xl font-bold hover:scale-105 transition-transform shadow-xl shadow-blue-600/20">
                        Commencer maintenant
                    </button>
                    <button className="h-14 px-8 bg-card border border-border/40 text-foreground rounded-2xl font-bold hover:bg-muted transition-colors">
                        Parler à un expert
                    </button>
                </div>
            </section>
        </div>
    );
};

export default DataInsights;
