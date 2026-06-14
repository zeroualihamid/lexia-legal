import React from 'react';
import { motion } from 'framer-motion';
import { Star, MessageSquareQuote } from 'lucide-react';

const Clients = () => {
    const testimonials = [
        {
            name: "Marc Leroux",
            role: "CTO @ TechFlow",
            text: "qclick a transformé notre façon de voir les données. Qclick répond à nos questions plus vite que n'importe quelle équipe de BI.",
            avatar: "https://i.pravatar.cc/150?u=marc"
        },
        {
            name: "Sophie Vallet",
            role: "Directrice Marketing @ Luxuria",
            text: "La clarté des graphiques et la simplicité de l'interface nous ont permis de démocratiser l'accès aux données dans toute l'entreprise.",
            avatar: "https://i.pravatar.cc/150?u=sophie"
        },
        {
            name: "Thomas Dubois",
            role: "Fondateur @ GreenStart",
            text: "Un outil indispensable pour toute startup data-driven. La précision des insights est tout simplement bluffante.",
            avatar: "https://i.pravatar.cc/150?u=thomas"
        }
    ];

    const trustLogos = ["APPLE", "SPACE-X", "DISNEY", "STRIPE", "GOOGLE", "TESLA"];

    return (
        <div className="py-20 px-6 max-w-7xl mx-auto">
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-center mb-20"
            >
                <h1 className="text-4xl md:text-6xl font-bold mb-6">Clients</h1>
                <p className="text-xl text-muted-foreground max-w-3xl mx-auto">
                    Ils nous font confiance pour porter leur vision stratégique grâce aux données.
                </p>
            </motion.div>

            {/* Logo Wall */}
            <div className="mb-32">
                <p className="text-center text-xs font-bold uppercase tracking-[0.3em] text-muted-foreground mb-12">Ils utilisent qclick au quotidien</p>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-12 items-center justify-items-center opacity-40 grayscale group hover:grayscale-0 transition-all duration-1000">
                    {trustLogos.map(logo => (
                        <div key={logo} className="font-black text-2xl tracking-tighter hover:text-blue-500 cursor-default transition-colors">
                            {logo}
                        </div>
                    ))}
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-20">
                {testimonials.map((t, i) => (
                    <motion.div
                        key={i}
                        initial={{ opacity: 0, scale: 0.9 }}
                        whileInView={{ opacity: 1, scale: 1 }}
                        viewport={{ once: true }}
                        transition={{ delay: i * 0.1 }}
                        className="p-10 rounded-[3rem] bg-card border border-border/40 relative"
                    >
                        <MessageSquareQuote className="absolute top-8 right-8 h-8 w-8 text-blue-500/20" />
                        <div className="flex gap-1 mb-6">
                            {[...Array(5)].map((_, j) => <Star key={j} className="h-4 w-4 fill-yellow-500 text-yellow-500" />)}
                        </div>
                        <p className="text-lg italic mb-8 leading-relaxed">
                            "{t.text}"
                        </p>
                        <div className="flex items-center gap-4">
                            <img src={t.avatar} alt={t.name} className="h-12 w-12 rounded-full border-2 border-primary/10" />
                            <div>
                                <h4 className="font-bold">{t.name}</h4>
                                <p className="text-xs text-muted-foreground uppercase tracking-widest">{t.role}</p>
                            </div>
                        </div>
                    </motion.div>
                ))}
            </div>

            <section className="mt-40 text-center bg-foreground text-background p-20 rounded-[4rem] relative overflow-hidden">
                <div className="absolute top-0 right-0 w-64 h-64 bg-blue-500/20 rounded-full blur-[100px]" />
                <h2 className="text-4xl font-bold mb-6">Prêt à rejoindre l'élite ?</h2>
                <p className="text-blue-200 mb-10 text-lg max-w-xl mx-auto opacity-80">
                    95% de nos clients déclarent avoir pris de meilleures décisions stratégiques dès le premier mois d'utilisation.
                </p>
                <button className="h-14 px-10 bg-blue-600 text-white rounded-2xl font-black text-lg hover:scale-105 transition-transform">
                    Commencer maintenant
                </button>
            </section>
        </div>
    );
};

export default Clients;
