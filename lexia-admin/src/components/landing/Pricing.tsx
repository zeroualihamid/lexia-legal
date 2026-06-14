import React from 'react';
import { motion } from 'framer-motion';
import { Check, Zap, Rocket, Building2 } from 'lucide-react';
import { Button } from "@/components/ui/button";

const Pricing = ({ onSelectPlan }) => {
    const plans = [
        {
            name: "Starter",
            icon: <Zap className="h-6 w-6 text-yellow-500" />,
            price: "0",
            desc: "Pour les projets personnels et l'exploration.",
            features: [
                "Jusqu'à 10,000 lignes de données",
                "Assistant Qclick standard",
                "3 tableaux de bord",
                "Historique de 7 jours",
                "Support communautaire"
            ],
            button: "Commencer gratuitement",
            popular: false
        },
        {
            name: "Pro",
            icon: <Rocket className="h-6 w-6 text-blue-500" />,
            price: "49",
            desc: "Pour les startups et les équipes en croissance.",
            features: [
                "Données illimitées",
                "Assistant Qclick Prioritaire",
                "Tableaux de bord illimités",
                "Historique illimité",
                "Export PDF & PowerPoint",
                "Support par email 24/7"
            ],
            button: "Essai gratuit de 14 jours",
            popular: true
        },
        {
            name: "Enterprise",
            icon: <Building2 className="h-6 w-6 text-purple-500" />,
            price: "Sur mesure",
            desc: "Pour les organisations aux besoins complexes.",
            features: [
                "Sécurité SSO & SAML",
                "Data scientist dédié",
                "Gouvernance des données",
                "Déploiement sur site possible",
                "SLA & Garantie de temps",
                "Support dédié par téléphone"
            ],
            button: "Contacter les ventes",
            popular: false
        }
    ];

    return (
        <div className="py-20 px-6 max-w-7xl mx-auto">
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-center mb-20"
            >
                <h1 className="text-4xl md:text-6xl font-bold mb-6">Tarifs</h1>
                <p className="text-xl text-muted-foreground max-w-3xl mx-auto">
                    Choisissez le plan qui correspond à vos ambitions. Pas de frais cachés.
                </p>
            </motion.div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {plans.map((plan, i) => (
                    <motion.div
                        key={i}
                        initial={{ opacity: 0, y: 30 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: i * 0.1 }}
                        className={`relative p-8 rounded-[3rem] border ${plan.popular
                            ? 'bg-background border-blue-500 shadow-2xl shadow-blue-500/10'
                            : 'bg-card border-border/40'
                            } flex flex-col`}
                    >
                        {plan.popular && (
                            <div className="absolute -top-4 left-1/2 -translate-x-1/2 px-4 py-1 bg-blue-500 text-white text-xs font-bold rounded-full uppercase tracking-widest">
                                Plus populaire
                            </div>
                        )}

                        <div className="mb-8">
                            <div className="flex items-center gap-3 mb-4">
                                {plan.icon}
                                <h3 className="text-2xl font-bold">{plan.name}</h3>
                            </div>
                            <div className="flex items-baseline gap-1 mb-2">
                                <span className="text-4xl font-bold">{plan.price !== "Sur mesure" ? `${plan.price}€` : plan.price}</span>
                                {plan.price !== "Sur mesure" && <span className="text-muted-foreground">/ mois</span>}
                            </div>
                            <p className="text-sm text-muted-foreground">{plan.desc}</p>
                        </div>

                        <ul className="space-y-4 mb-10 flex-1">
                            {plan.features.map((feature, j) => (
                                <li key={j} className="flex items-start gap-3 text-sm">
                                    <Check className="h-5 w-5 text-emerald-500 shrink-0" />
                                    <span>{feature}</span>
                                </li>
                            ))}
                        </ul>

                        <Button
                            onClick={() => onSelectPlan?.(plan)}
                            className={`w-full h-12 rounded-2xl font-bold transition-all ${plan.popular
                                ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-xl shadow-blue-600/20'
                                : 'bg-muted hover:bg-muted/80 text-foreground'
                                }`}
                        >
                            {plan.button}
                        </Button>
                    </motion.div>
                ))}
            </div>

            <div className="mt-20 text-center text-muted-foreground text-sm">
                Des questions ? <a href="#" className="text-blue-500 underline underline-offset-4">Consultez notre FAQ</a> ou <a href="#" className="text-blue-500 underline underline-offset-4">écrivez-nous</a>.
            </div>
        </div>
    );
};

export default Pricing;
