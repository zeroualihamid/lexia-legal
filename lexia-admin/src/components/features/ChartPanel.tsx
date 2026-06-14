import React from 'react';
import ReactECharts from 'echarts-for-react';
import { motion, AnimatePresence } from 'framer-motion';
import { BarChart3, Loader2 } from 'lucide-react';
import { Card } from "@/components/ui/card";

const ChartPanel = ({ chartConfig, isLoading = false }) => {
    if (isLoading && !chartConfig) {
        return (
            <Card className="h-full flex flex-col items-center justify-center p-8 bg-card/50 backdrop-blur-sm border-dashed">
                <div className="relative">
                    <Loader2 className="h-12 w-12 text-blue-500 animate-spin opacity-20" />
                    <BarChart3 className="h-6 w-6 text-blue-500 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
                </div>
                <p className="mt-4 text-sm font-medium text-muted-foreground animate-pulse">
                    Génération de l'analyse visuelle...
                </p>
            </Card>
        );
    }

    if (!chartConfig) {
        return (
            <Card className="h-full flex flex-col items-center justify-center p-8 bg-muted/10 border-dashed border-2">
                <div className="p-4 rounded-full bg-muted/20">
                    <BarChart3 className="h-8 w-8 text-muted-foreground" />
                </div>
                <h3 className="mt-4 font-semibold text-lg text-foreground">Visualisation des données</h3>
                <p className="mt-1 text-sm text-muted-foreground text-center max-w-[250px]">
                    Posez une question d'analyse financière pour voir un graphique interactif apparaître ici.
                </p>
            </Card>
        );
    }

    return (
        <motion.div
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            className="h-full flex flex-col"
        >
            <Card className="flex-1 p-6 relative bg-card/80 backdrop-blur-md border shadow-xl overflow-hidden group">
                <div className="absolute top-0 right-0 p-4 opacity-0 group-hover:opacity-100 transition-opacity">
                    <div className="flex gap-2">
                        <div className="h-2 w-2 rounded-full bg-emerald-500" />
                        <div className="h-2 w-2 rounded-full bg-blue-500" />
                        <div className="h-2 w-2 rounded-full bg-amber-500" />
                    </div>
                </div>

                <ReactECharts
                    option={chartConfig}
                    style={{ height: '100%', width: '100%' }}
                    opts={{ renderer: 'canvas' }}
                    notMerge={true}
                    lazyUpdate={true}
                    theme="light"
                />

                {isLoading && (
                    <div className="absolute inset-0 bg-background/20 backdrop-blur-[1px] flex items-center justify-center">
                        <Loader2 className="h-8 w-8 text-blue-500 animate-spin" />
                    </div>
                )}
            </Card>
        </motion.div>
    );
};

export default ChartPanel;
