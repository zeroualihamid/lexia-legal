import React, { type ChangeEvent, type FormEvent, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mail, Lock, User, ArrowRight } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { signIn, signUp } from '@/lib/auth-client';

type AuthFormMode = 'login' | 'register';

type AuthFormProps = {
    mode?: AuthFormMode;
    onToggle?: () => void;
    onSuccess?: () => void | Promise<void>;
};

type AuthStatus = {
    kind: 'info' | 'error';
    text: string;
};

const AuthForm = ({ mode = 'login', onToggle, onSuccess }: AuthFormProps) => {
    const [isLoading, setIsLoading] = useState(false);
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [name, setName] = useState('');
    const [status, setStatus] = useState<AuthStatus | null>(null);

    const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        setStatus(null);
        setIsLoading(true);
        try {
            if (mode === 'register') {
                const { error } = await signUp.email({
                    email,
                    password,
                    name,
                });
                if (error) throw new Error(error.message || "Impossible de créer le compte");
                setStatus({
                    kind: 'info',
                    text: "Compte créé. Vérifiez votre email avant de vous connecter.",
                });
                return;
            }

            const { error } = await signIn.email({
                email,
                password,
            });
            if (error) {
                if (error.code === 'EMAIL_NOT_VERIFIED' || /verif/i.test(error.message || '')) {
                    setStatus({
                        kind: 'info',
                        text: "Un lien de vérification vous a été envoyé. Validez votre email puis reconnectez-vous.",
                    });
                    return;
                }
                throw new Error(error.message || "Connexion impossible");
            }

            localStorage.removeItem('isAuthenticated');
            await onSuccess?.();
        } catch (err) {
            setStatus({
                kind: 'error',
                text: err instanceof Error ? err.message : "Authentification impossible",
            });
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="w-full max-w-md p-8 rounded-3xl bg-card border border-border/50 shadow-2xl backdrop-blur-xl">
            <div className="text-center mb-8">
                <h2 className="text-3xl font-bold tracking-tight">
                    {mode === 'login' ? 'Bon retour' : 'Créer un compte'}
                </h2>
                <p className="text-muted-foreground mt-2">
                    {mode === 'login'
                        ? 'Entrez vos identifiants pour accéder à vos analyses'
                        : 'Rejoignez Brikz et commencez à analyser vos données comme un pro'}
                </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
                <AnimatePresence mode="wait">
                    {mode === 'register' && (
                        <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                            className="space-y-2"
                        >
                            <label className="text-sm font-medium ml-1">Nom complet</label>
                            <div className="relative">
                                <User className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                                <Input
                                    placeholder="Jean Dupont"
                                    className="pl-10 h-10 bg-muted/20 border-border/40 focus:ring-blue-500/30"
                                    value={name}
                                    onChange={(event: ChangeEvent<HTMLInputElement>) => setName(event.target.value)}
                                    required={mode === 'register'}
                                />
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>

                <div className="space-y-2">
                    <label className="text-sm font-medium ml-1">Adresse Email</label>
                    <div className="relative">
                        <Mail className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                        <Input
                            type="email"
                            placeholder="nom@entreprise.com"
                            className="pl-10 h-10 bg-muted/20 border-border/40 focus:ring-blue-500/30"
                            value={email}
                            onChange={(event: ChangeEvent<HTMLInputElement>) => setEmail(event.target.value)}
                            required
                        />
                    </div>
                </div>

                <div className="space-y-2">
                    <label className="text-sm font-medium ml-1">Mot de passe</label>
                    <div className="relative">
                        <Lock className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                        <Input
                            type="password"
                            placeholder="••••••••"
                            className="pl-10 h-10 bg-muted/20 border-border/40 focus:ring-blue-500/30"
                            value={password}
                            onChange={(event: ChangeEvent<HTMLInputElement>) => setPassword(event.target.value)}
                            minLength={8}
                            required
                        />
                    </div>
                </div>

                <Button
                    className="w-full h-11 bg-blue-600 hover:bg-blue-500 text-white rounded-xl shadow-lg shadow-blue-600/20 mt-4 transition-all duration-300"
                    disabled={isLoading}
                >
                    {isLoading ? (
                        <div className="h-5 w-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    ) : (
                        <span className="flex items-center gap-2">
                            {mode === 'login' ? 'Se connecter' : 'Créer un compte'}
                            <ArrowRight className="h-4 w-4" />
                        </span>
                    )}
                </Button>

                {status ? (
                    <p className={status.kind === 'error' ? 'text-sm text-red-500' : 'text-sm text-muted-foreground'}>
                        {status.text}
                    </p>
                ) : null}
            </form>

            <div className="text-center mt-8">
                <button
                    onClick={onToggle}
                    className="text-sm text-muted-foreground hover:text-blue-500 transition-colors"
                >
                    {mode === 'login'
                        ? "Pas de compte ? S'inscrire"
                        : "Déjà un compte ? Se connecter"}
                </button>
            </div>
        </div>
    );
};

export default AuthForm;
