import React from 'react';
import { motion } from "framer-motion";
import { Avatar } from "@/components/ui/avatar";
import { asset } from "@/lib/asset";

const Dot: React.FC<{ delay: number }> = ({ delay }) => (
    <motion.span
        className="inline-block h-1.5 w-1.5 rounded-full bg-[#0D7377]"
        animate={{ y: [0, -4, 0] }}
        transition={{ repeat: Infinity, duration: 0.8, delay, ease: "easeInOut" }}
    />
);

const ChatLoadingIndicator: React.FC = () => (
    <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className="flex items-start gap-3"
    >
        <Avatar className="h-7 w-7 flex-shrink-0 overflow-hidden ring-1 ring-[#0D7377]/20 bg-[#F1FAFA]">
            <img src={asset("logo.png")} alt="qclick" className="h-full w-full object-cover" />
        </Avatar>
        <div className="flex items-center gap-1.5 rounded-2xl rounded-tl-md border border-[#E8E6E1] bg-white px-4 py-3 shadow-sm">
            <Dot delay={0} />
            <Dot delay={0.15} />
            <Dot delay={0.3} />
        </div>
    </motion.div>
);

export default ChatLoadingIndicator;
