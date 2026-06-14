import React, { useRef, useEffect } from 'react';
import ReactECharts from 'echarts-for-react';
import { motion, AnimatePresence } from 'framer-motion';
import { BarChart3, Clock, LayoutGrid, Loader2 } from 'lucide-react';
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";

export const ChartGallery = ({
    charts,
    currentChartId,
    isLoading,
    onChartClick,
}) => {
    const scrollRef = useRef(null);
    const currentChartRef = useRef(null);
    const chartInstances = useRef({});

    // Auto-scroll to newest chart
    useEffect(() => {
        if (currentChartRef.current) {
            currentChartRef.current.scrollIntoView({
                behavior: 'smooth',
                block: 'nearest'
            });
        }
    }, [charts.length, currentChartId]);

    // Handle container resize to update ECharts dimensions
    useEffect(() => {
        const resizeObserver = new ResizeObserver(() => {
            Object.values(chartInstances.current).forEach(instance => {
                if (instance) instance.resize();
            });
        });

        if (scrollRef.current) {
            resizeObserver.observe(scrollRef.current);
        }

        return () => resizeObserver.disconnect();
    }, []);

    if (charts.length === 0 && !isLoading) {
        return (
            <div className="settings-ui h-full flex flex-col items-center justify-center p-8 text-center rounded-[28px] border-2 border-dashed border-[#E8E6E1] bg-[#FBFAF7]">
                <div className="mb-4 rounded-full bg-[#F1FAFA] p-4 text-[#0D7377]/35">
                    <BarChart3 className="h-12 w-12" />
                </div>
                <h3 className="settings-display text-lg text-[#2B2B2B]">Bibliothèque d'analyses</h3>
                <p className="mt-2 max-w-[280px] text-sm leading-relaxed text-[#6B6966]">
                    Vos graphiques interactifs apparaîtront ici après chaque analyse financière.
                </p>
            </div>
        );
    }

    return (
        <div className="settings-ui h-full flex flex-col overflow-hidden text-[#2B2B2B]">
            <div className="shrink-0 border-b border-[#E8E6E1] bg-white px-4 py-4">
                <div className="flex items-center gap-2">
                    <LayoutGrid className="h-4 w-4 text-[#0D7377]" />
                    <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">Graphiques ({charts.length})</h3>
                </div>
            </div>

            <ScrollArea className="flex-1" viewportRef={scrollRef}>
                <div className="px-4 py-6 space-y-8 pb-32">
                    <AnimatePresence mode="popLayout">
                        {charts.map((chart, index) => (
                            <motion.div
                                key={chart.chartId}
                                id={`chart-card-${chart.chartId}`}
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                ref={chart.chartId === currentChartId ? currentChartRef : null}
                                className={`group relative ${chart.chartId === currentChartId ? 'z-10' : 'z-0'}`}
                                onClick={() => onChartClick?.(chart.chartId)}
                            >
                                <Card className={`overflow-hidden transition-all duration-300 border shadow-md hover:shadow-xl cursor-pointer bg-card/50 backdrop-blur-sm ${chart.chartId === currentChartId
                                    ? 'border-[#0D7377]/30 ring-2 ring-[#0D7377]/20 scale-[1.01] bg-white'
                                    : 'border-[#E8E6E1] bg-white hover:border-[#0D7377]/20'
                                    }`}>
                                    <div className="flex items-center justify-between border-b border-[#E8E6E1] bg-[#F8F7F4] p-4">
                                        <div className="flex items-center gap-2">
                                            <span className="rounded-full bg-[#0D7377] px-2 py-0.5 text-[10px] font-black text-white">#{index + 1}</span>
                                            <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">{chart.chartType}</span>
                                        </div>
                                        <div className="settings-mono flex items-center gap-1 text-[10px] text-[#A09E99]">
                                            <Clock className="h-3 w-3" />
                                            {new Date(chart.timestamp).toLocaleTimeString('fr-FR')}
                                        </div>
                                    </div>

                                    <div className="p-4">
                                        <p className="mb-4 line-clamp-2 border-l-2 border-[#E8725A]/40 px-2 text-[11px] font-medium italic text-[#6B6966]">
                                            "{chart.query}"
                                        </p>

                                        <div className="h-[280px] w-full rounded-2xl border border-[#E8E6E1] bg-[#FCFBF8]">
                                            <ReactECharts
                                                onChartReady={(instance) => {
                                                    chartInstances.current[chart.chartId] = instance;
                                                }}
                                                option={chart.option}
                                                style={{ height: '100%', width: '100%' }}
                                                opts={{ renderer: 'canvas' }}
                                                notMerge={true}
                                                lazyUpdate={true}
                                            />
                                        </div>
                                    </div>
                                </Card>
                            </motion.div>
                        ))}
                    </AnimatePresence>

                    {isLoading && (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            className="flex flex-col items-center justify-center rounded-[28px] border-2 border-dashed border-[#E8E6E1] bg-[#FBFAF7] p-8"
                        >
                            <div className="relative mb-3">
                                <Loader2 className="h-8 w-8 animate-spin text-[#0D7377]" />
                                <BarChart3 className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 text-[#E8725A] opacity-70" />
                            </div>
                            <p className="animate-pulse text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">Génération de l'analyse...</p>
                        </motion.div>
                    )}
                </div>
            </ScrollArea>
        </div>
    );
};
