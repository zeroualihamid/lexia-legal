import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CreditCard, ShieldCheck, Lock, ArrowLeft, CheckCircle2, ChevronRight, Globe, Zap, Rocket, Building2 } from 'lucide-react';
import { Button } from "@/components/ui/button";

const Payment = ({ plan, onBack, onSuccess }) => {
    const [step, setStep] = useState('checkout'); // 'checkout' | 'processing' | 'success'
    const [paymentMethod, setPaymentMethod] = useState('stripe'); // 'stripe' | 'paypal'
    const [cardName, setCardName] = useState('');
    const [cardNumber, setCardNumber] = useState('');
    const [expiry, setExpiry] = useState('');
    const [cvv, setCvv] = useState('');

    const handlePayment = (e) => {
        if (e) e.preventDefault();
        setStep('processing');
        setTimeout(() => {
            setStep('success');
            setTimeout(() => {
                onSuccess?.();
            }, 3000);
        }, 2000);
    };

    if (step === 'success') {
        return (
            <div className="min-h-[80vh] flex items-center justify-center p-6">
                <motion.div
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="max-w-md w-full text-center"
                >
                    <div className="w-24 h-24 bg-emerald-500/10 text-emerald-500 rounded-full flex items-center justify-center mx-auto mb-8">
                        <CheckCircle2 className="h-12 w-12" />
                    </div>
                    <h1 className="text-4xl font-black mb-4">Paiement Réussi !</h1>
                    <p className="text-xl text-muted-foreground mb-12">
                        Bienvenue chez qclick. Votre accès au plan <span className="text-blue-600 font-bold">{plan.name}</span> est désormais actif via <span className="capitalize">{paymentMethod}</span>.
                    </p>
                    <div className="p-6 rounded-3xl bg-muted/30 border border-border/40 text-left mb-8">
                        <p className="text-sm font-bold mb-4 flex items-center gap-2">
                            <Zap className="h-4 w-4 text-blue-500" />
                            Résumé de l'abonnement
                        </p>
                        <div className="flex justify-between text-sm mb-2">
                            <span className="text-muted-foreground">Plan</span>
                            <span className="font-bold">{plan.name}</span>
                        </div>
                        <div className="flex justify-between text-sm">
                            <span className="text-muted-foreground">Prochaine facturation</span>
                            <span className="font-bold">18 Février 2026</span>
                        </div>
                    </div>
                    <p className="text-sm text-muted-foreground animate-pulse">
                        Redirection vers votre espace de travail...
                    </p>
                </motion.div>
            </div>
        );
    }

    return (
        <div className="py-20 px-6 max-w-6xl mx-auto">
            <Button
                variant="ghost"
                className="mb-12 flex items-center gap-2 text-muted-foreground hover:text-foreground"
                onClick={onBack}
            >
                <ArrowLeft className="h-4 w-4" />
                Retour aux tarifs
            </Button>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-16">
                {/* Order Summary */}
                <motion.div
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                >
                    <h2 className="text-3xl font-black mb-8">Récapitulatif de votre commande</h2>
                    <div className="p-8 rounded-[2.5rem] bg-card border border-border/40 shadow-xl relative overflow-hidden mb-8">
                        <div className="absolute top-0 right-0 p-12 bg-blue-500/5 rounded-full blur-3xl -mr-16 -mt-16" />

                        <div className="flex items-center gap-4 mb-8">
                            <div className="p-4 rounded-3xl bg-blue-500/10 text-blue-500">
                                {plan.icon || <Rocket className="h-8 w-8" />}
                            </div>
                            <div>
                                <h3 className="text-2xl font-bold">{plan.name}</h3>
                                <p className="text-muted-foreground">Abonnement Mensuel</p>
                            </div>
                        </div>

                        <div className="space-y-4 mb-8">
                            {plan.features?.slice(0, 4).map((f, i) => (
                                <div key={i} className="flex items-center gap-3 text-sm">
                                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                                    <span>{f}</span>
                                </div>
                            ))}
                        </div>

                        <div className="pt-8 border-t border-border/40">
                            <div className="flex justify-between items-center mb-6">
                                <span className="text-muted-foreground font-medium">Prix du plan</span>
                                <span className="font-bold">{plan.price}€</span>
                            </div>
                            <div className="flex justify-between items-center p-4 rounded-2xl bg-blue-500/5 border border-blue-500/20">
                                <span className="text-xl font-bold">Total à payer</span>
                                <span className="text-3xl font-black text-blue-600">{plan.price}€</span>
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center gap-6 p-6 rounded-3xl bg-muted/30 border border-border/40">
                        <ShieldCheck className="h-10 w-10 text-blue-500 shrink-0" />
                        <div>
                            <p className="font-bold text-sm">Paiement 100% sécurisé</p>
                            <p className="text-xs text-muted-foreground">Vos données de paiement sont chiffrées selon les normes de sécurité les plus strictes.</p>
                        </div>
                    </div>
                </motion.div>

                {/* Checkout Form */}
                <motion.div
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                >
                    <div className="bg-card border border-border/40 rounded-[3rem] p-8 md:p-12 shadow-2xl shadow-blue-500/5">
                        {/* Selector */}
                        <div className="flex p-1 bg-muted rounded-2xl mb-8">
                            <button
                                onClick={() => setPaymentMethod('stripe')}
                                className={`flex-1 h-12 rounded-xl text-sm font-bold transition-all flex items-center justify-center gap-2 ${paymentMethod === 'stripe' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                            >
                                <CreditCard className="h-4 w-4" />
                                Stripe / Carte
                            </button>
                            <button
                                onClick={() => setPaymentMethod('paypal')}
                                className={`flex-1 h-12 rounded-xl text-sm font-bold transition-all flex items-center justify-center gap-2 ${paymentMethod === 'paypal' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                            >
                                <svg className="h-4 w-4 fill-current" viewBox="0 0 24 24"><path d="M7.076 21.337H2.47a.641.641 0 0 1-.633-.74L4.944 3.723a1.66 1.66 0 0 1 1.64-1.39h7.682c3.076 0 5.321.649 6.706 1.933 1.359 1.259 1.967 3.01 1.811 5.205-.363 5.064-3.46 7.751-7.74 7.751h-2.124a.641.641 0 0 0-.633.54l-.454 2.872a.641.641 0 0 1-.632.541H7.076z" /></svg>
                                PayPal
                            </button>
                        </div>

                        <AnimatePresence mode="wait">
                            {paymentMethod === 'stripe' ? (
                                <motion.form
                                    key="stripe"
                                    initial={{ opacity: 0, y: 10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -10 }}
                                    onSubmit={handlePayment}
                                    className="space-y-6"
                                >
                                    <div>
                                        <label className="block text-sm font-bold mb-2 ml-1">Nom sur la carte</label>
                                        <input
                                            required
                                            type="text"
                                            placeholder="JEAN DUPONT"
                                            value={cardName}
                                            onChange={(e) => setCardName(e.target.value)}
                                            className="w-full h-14 px-6 rounded-2xl bg-muted/50 border border-border/40 focus:border-blue-500 focus:outline-none transition-all uppercase placeholder:normal-case"
                                        />
                                    </div>

                                    <div>
                                        <label className="block text-sm font-bold mb-2 ml-1">Numéro de carte (Stripe)</label>
                                        <div className="relative">
                                            <input
                                                required
                                                type="text"
                                                placeholder="0000 0000 0000 0000"
                                                value={cardNumber}
                                                onChange={(e) => setCardNumber(e.target.value)}
                                                className="w-full h-14 px-6 rounded-2xl bg-muted/50 border border-border/40 focus:border-blue-500 focus:outline-none transition-all"
                                            />
                                            <CreditCard className="absolute right-6 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-2 gap-6">
                                        <div>
                                            <label className="block text-sm font-bold mb-2 ml-1">Date d'expiration</label>
                                            <input
                                                required
                                                type="text"
                                                placeholder="MM / YY"
                                                value={expiry}
                                                onChange={(e) => setExpiry(e.target.value)}
                                                className="w-full h-14 px-6 rounded-2xl bg-muted/50 border border-border/40 focus:border-blue-500 focus:outline-none transition-all"
                                            />
                                        </div>
                                        <div>
                                            <label className="block text-sm font-bold mb-2 ml-1">CVV</label>
                                            <div className="relative">
                                                <input
                                                    required
                                                    type="password"
                                                    placeholder="•••"
                                                    maxLength={3}
                                                    value={cvv}
                                                    onChange={(e) => setCvv(e.target.value)}
                                                    className="w-full h-14 px-6 rounded-2xl bg-muted/50 border border-border/40 focus:border-blue-500 focus:outline-none transition-all"
                                                />
                                                <Lock className="absolute right-6 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                                            </div>
                                        </div>
                                    </div>

                                    <div className="pt-4">
                                        <Button
                                            className="w-full h-16 bg-blue-600 hover:bg-blue-500 text-white rounded-[1.5rem] text-xl font-bold shadow-xl shadow-blue-600/20 transition-all active:scale-95 disabled:opacity-50"
                                            type="submit"
                                            disabled={step === 'processing'}
                                        >
                                            {step === 'processing' ? 'Traitement Stripe...' : `Payer ${plan.price}€ par Carte`}
                                        </Button>
                                    </div>
                                </motion.form>
                            ) : (
                                <motion.div
                                    key="paypal"
                                    initial={{ opacity: 0, y: 10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -10 }}
                                    className="space-y-8 py-4"
                                >
                                    <div className="p-8 rounded-[2rem] bg-yellow-400/5 border border-yellow-400/20 text-center">
                                        <div className="flex justify-center mb-6">
                                            <svg className="h-12 w-12 text-[#003087]" viewBox="0 0 24 24"><path fill="currentColor" d="M7.076 21.337H2.47a.641.641 0 0 1-.633-.74L4.944 3.723a1.66 1.66 0 0 1 1.64-1.39h7.682c3.076 0 5.321.649 6.706 1.933 1.359 1.259 1.967 3.01 1.811 5.205-.363 5.064-3.46 7.751-7.74 7.751h-2.124a.641.641 0 0 0-.633.54l-.454 2.872a.641.641 0 0 1-.632.541H7.076z" /></svg>
                                        </div>
                                        <h4 className="text-xl font-bold mb-2">Payer avec PayPal</h4>
                                        <p className="text-sm text-muted-foreground mb-8">Vous allez être redirigé vers l'interface sécurisée de PayPal pour finaliser votre abonnement.</p>

                                        <Button
                                            onClick={() => handlePayment()}
                                            className="w-full h-16 bg-[#0070ba] hover:bg-[#005ea6] text-white rounded-full text-xl font-bold transition-all active:scale-95 shadow-lg shadow-blue-500/10"
                                            disabled={step === 'processing'}
                                        >
                                            {step === 'processing' ? 'Chargement PayPal...' : 'Continuer vers PayPal'}
                                        </Button>
                                    </div>

                                    <div className="flex items-center gap-4 text-xs text-muted-foreground justify-center">
                                        <ShieldCheck className="h-4 w-4" />
                                        Protection des achats PayPal incluse
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>

                        <p className="text-center text-xs text-muted-foreground mt-8 flex items-center justify-center gap-1">
                            <Globe className="h-3 w-3" />
                            Facturation en EUR. Toutes taxes comprises. Annulable à tout moment.
                        </p>
                    </div>
                </motion.div>
            </div>
        </div>
    );
};

export default Payment;
