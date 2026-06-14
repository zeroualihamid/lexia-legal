import React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
    Area,
    AreaChart,
    Bar,
    BarChart,
    CartesianGrid,
    Cell,
    Pie,
    PieChart,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis
} from "recharts";
import { ArrowUpRight, ArrowDownRight, Users, DollarSign, Activity, MousePointerClick } from 'lucide-react';
import { motion } from 'framer-motion';

const data = [
    { name: 'Jan', value: 400, uv: 2400, pv: 2400 },
    { name: 'Fév', value: 300, uv: 1398, pv: 2210 },
    { name: 'Mar', value: 200, uv: 9800, pv: 2290 },
    { name: 'Avr', value: 278, uv: 3908, pv: 2000 },
    { name: 'Mai', value: 189, uv: 4800, pv: 2181 },
    { name: 'Juin', value: 239, uv: 3800, pv: 2500 },
    { name: 'Juil', value: 349, uv: 4300, pv: 2100 },
];

const trafficData = [
    { name: 'Direct', value: 400 },
    { name: 'Référent', value: 300 },
    { name: 'Social', value: 300 },
    { name: 'Organique', value: 200 },
];

const COLORS = ['#8b5cf6', '#3b82f6', '#06b6d4', '#10b981'];

const MetricCard = ({ title, value, change, trend, icon: Icon, delay }) => (
    <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay, duration: 0.4 }}
    >
        <Card className="bg-background/40 backdrop-blur-md border-border/40">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
                <Icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
                <div className="text-2xl font-bold">{value}</div>
                <p className={`text-xs flex items-center mt-1 ${trend === 'up' ? 'text-emerald-500' : 'text-rose-500'}`}>
                    {trend === 'up' ? <ArrowUpRight className="h-4 w-4 mr-1" /> : <ArrowDownRight className="h-4 w-4 mr-1" />}
                    {change}
                    <span className="text-muted-foreground ml-1">vs mois dernier</span>
                </p>
            </CardContent>
        </Card>
    </motion.div>
);

const Dashboard = () => {
    return (
        <ScrollArea className="h-full">
            <div className="p-4 space-y-6">
                <div className="flex items-center justify-between">
                    <div>
                        <h2 className="text-xl font-bold tracking-tight text-foreground">Analyse</h2>
                        <p className="text-xs text-muted-foreground mt-1">Métriques en direct de la session active.</p>
                    </div>
                    <div className="flex gap-2">
                        <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                        <span className="text-xs text-muted-foreground uppercase tracking-wider">Direct</span>
                    </div>
                </div>

                <div className="grid gap-3 grid-cols-1 md:grid-cols-2">
                    <MetricCard
                        title="Revenu"
                        value="45k€"
                        change="+20%"
                        trend="up"
                        icon={DollarSign}
                        delay={0.1}
                    />
                    <MetricCard
                        title="Utilisateurs"
                        value="2.3k"
                        change="+180%"
                        trend="up"
                        icon={Users}
                        delay={0.2}
                    />
                </div>

                <motion.div
                    initial={{ opacity: 0, scale: 0.98 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: 0.5 }}
                >
                    <Card className="bg-background/40 border-border/40 shadow-none">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm">Tendance des revenus</CardTitle>
                        </CardHeader>
                        <CardContent className="pl-0 pb-2">
                            <div className="h-[200px] w-full">
                                <ResponsiveContainer width="100%" height="100%">
                                    <AreaChart data={data}>
                                        <defs>
                                            <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                                                <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.3} />
                                                <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                                            </linearGradient>
                                        </defs>
                                        <XAxis dataKey="name" hide />
                                        <YAxis hide />
                                        <Tooltip
                                            contentStyle={{
                                                backgroundColor: 'hsl(var(--popover))',
                                                borderColor: 'hsl(var(--border))',
                                                color: 'hsl(var(--popover-foreground))',
                                                fontSize: '12px',
                                                borderRadius: 'var(--radius)'
                                            }}
                                            itemStyle={{ color: 'hsl(var(--foreground))' }}
                                        />
                                        <Area
                                            type="monotone"
                                            dataKey="value"
                                            stroke="#8b5cf6"
                                            strokeWidth={2}
                                            fillOpacity={1}
                                            fill="url(#colorValue)"
                                            isAnimationActive={false}
                                        />
                                    </AreaChart>
                                </ResponsiveContainer>
                            </div>
                        </CardContent>
                    </Card>
                </motion.div>

                <motion.div
                    initial={{ opacity: 0, scale: 0.98 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: 0.6 }}
                >
                    <Card className="bg-background/40 border-border/40 shadow-none">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm">Sources de trafic</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="h-[180px] w-full">
                                <ResponsiveContainer width="100%" height="100%">
                                    <PieChart>
                                        <Pie
                                            data={trafficData}
                                            cx="50%"
                                            cy="50%"
                                            innerRadius={50}
                                            outerRadius={70}
                                            paddingAngle={5}
                                            dataKey="value"
                                            isAnimationActive={false}
                                        >
                                            {trafficData.map((entry, index) => (
                                                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                                            ))}
                                        </Pie>
                                        <Tooltip
                                            contentStyle={{
                                                backgroundColor: 'hsl(var(--popover))',
                                                borderColor: 'hsl(var(--border))',
                                                color: 'hsl(var(--popover-foreground))',
                                                fontSize: '12px',
                                                borderRadius: 'var(--radius)'
                                            }}
                                            itemStyle={{ color: 'hsl(var(--foreground))' }}
                                        />
                                    </PieChart>
                                </ResponsiveContainer>
                            </div>
                            <div className="grid grid-cols-2 gap-2 mt-2">
                                {trafficData.map((entry, index) => (
                                    <div key={entry.name} className="flex items-center gap-2 text-xs text-muted-foreground">
                                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[index] }} />
                                        {entry.name}
                                    </div>
                                ))}
                            </div>
                        </CardContent>
                    </Card>
                </motion.div>
            </div>
        </ScrollArea>
    );
};

export default Dashboard;
