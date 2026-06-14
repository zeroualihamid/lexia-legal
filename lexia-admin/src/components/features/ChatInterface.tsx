import React, { useState, useRef, useEffect, useCallback, useDeferredValue } from 'react';
import { AnimatePresence } from "framer-motion";
import { TooltipProvider } from "@/components/ui/tooltip";
import { streamChatQuery } from '@/lib/chat_api';
import { v4 as uuidv4 } from 'uuid';

import ChatHeader from './chat/ChatHeader';
import MessageBubble from './chat/MessageBubble';
import ChatLoadingIndicator from './chat/ChatLoadingIndicator';
import ChatInputArea from './chat/ChatInputArea';
import VoiceInputArea from './chat/VoiceInputArea';
import SaveConversationDialog from './chat/SaveConversationDialog';
import { ChatMessage, ChartData, ThinkingStep } from '@/types/chat';

const EMPTY_CHARTS: ChartData[] = [];
const NOOP_SET_CURRENT_CHART_ID = () => {};

interface ChatMessagesPaneProps {
    messages: ChatMessage[];
    isLoading: boolean;
    charts: ChartData[];
    setCurrentChartId: (id: string) => void;
    expandedThinkingIds: Set<string>;
    onToggleThinking: (id: string) => void;
    scrollRef: React.RefObject<HTMLDivElement>;
    messagesEndRef: React.RefObject<HTMLDivElement>;
    onScroll: (e: React.UIEvent<HTMLDivElement>) => void;
}

const ChatMessagesPane = React.memo(({
    messages,
    isLoading,
    charts,
    setCurrentChartId,
    expandedThinkingIds,
    onToggleThinking,
    scrollRef,
    messagesEndRef,
    onScroll,
}: ChatMessagesPaneProps) => {
    const deferredMessages = useDeferredValue(messages);

    return (
        <div
            className="settings-ui flex-1 min-h-0 overflow-y-auto px-4 py-5 scroll-smooth md:px-6"
            ref={scrollRef}
            onScroll={onScroll}
        >
            <div className="space-y-5">
                <AnimatePresence>
                    {deferredMessages.map((msg) => (
                        <MessageBubble
                            key={msg.id}
                            msg={msg}
                            charts={charts}
                            setCurrentChartId={setCurrentChartId}
                            isThinkingExpanded={expandedThinkingIds.has(msg.id)}
                            toggleThinking={onToggleThinking}
                        />
                    ))}
                </AnimatePresence>
                {isLoading && <ChatLoadingIndicator />}
                <div ref={messagesEndRef} className="h-1" />
            </div>
        </div>
    );
});

ChatMessagesPane.displayName = 'ChatMessagesPane';

interface ChatInterfaceProps {
    autoQuery?: string;
    messages?: ChatMessage[];
    isLoading?: boolean;
    isUploading?: boolean;
    onSend?: (message: string) => void;
    onUpload?: (files: File[]) => void;
    onClear?: () => void;
    onResetMemory?: () => void;
    isResettingMemory?: boolean;
    charts?: ChartData[];
    setCurrentChartId?: (id: string) => void;
    /** Use voice input (TTS, STT, Talk) instead of standard input */
    useVoiceInput?: boolean;
}

const ChatInterface: React.FC<ChatInterfaceProps> = ({
    autoQuery,
    messages,
    isLoading,
    isUploading,
    onSend,
    onUpload,
    onClear,
    onResetMemory,
    isResettingMemory,
    charts,
    setCurrentChartId,
    useVoiceInput = false,
}) => {
    const [input, setInput] = useState('');
    const [showSaveModal, setShowSaveModal] = useState(false);
    const [saveName, setSaveName] = useState('');
    const [autoScroll, setAutoScroll] = useState(true);
    const [localMessages, setLocalMessages] = useState<ChatMessage[]>([]);
    const [localIsLoading, setLocalIsLoading] = useState(false);
    const [expandedThinkingIds, setExpandedThinkingIds] = useState<Set<string>>(() => new Set());
    const [currentFileName, setCurrentFileName] = useState<string | null>(null);

    const localAbortRef = useRef<AbortController | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    const effectiveMessages = messages ?? localMessages;
    const effectiveIsLoading = typeof isLoading === 'boolean' ? isLoading : localIsLoading;
    const effectiveIsUploading = typeof isUploading === 'boolean' ? isUploading : false;
    const effectiveCharts = charts ?? EMPTY_CHARTS;
    const resolvedSetCurrentChartId = setCurrentChartId ?? NOOP_SET_CURRENT_CHART_ID;

    // Smart auto-scroll logic
    useEffect(() => {
        if (autoScroll) {
            messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
        }
    }, [effectiveMessages, effectiveIsLoading, autoScroll]);

    // Reset auto-scroll when loading starts
    useEffect(() => {
        if (effectiveIsLoading) {
            setAutoScroll(true);
        }
    }, [effectiveIsLoading]);

    // Handle autoQuery from landing page or DataInsights (debounced, single effect)
    useEffect(() => {
        if (autoQuery) {
            const timer = setTimeout(() => {
                handleSend(autoQuery);
            }, 500);
            return () => clearTimeout(timer);
        }
    }, [autoQuery]);

    const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
        const target = e.currentTarget;
        const isNearBottom = target.scrollHeight - target.scrollTop <= target.clientHeight + 100;
        setAutoScroll(isNearBottom);
    }, []);

    const handleClear = () => {
        if (onClear) {
            onClear();
        } else {
            setLocalMessages([]);
            setLocalIsLoading(false);
        }
    };

    const handleSend = (text: string | React.MouseEvent | React.KeyboardEvent = input) => {
        const messageToSend = typeof text === 'string' ? text : input;
        if (!messageToSend.trim()) return;
        if (onSend) {
            onSend(messageToSend);
        } else {
            if (localAbortRef.current) {
                localAbortRef.current.abort();
            }

            const userMessageId = uuidv4();
            const assistantMessageId = uuidv4();
            const timestamp = new Date().toISOString();

            setLocalMessages(prev => [
                ...prev,
                { id: userMessageId, role: 'user', content: messageToSend, timestamp },
                { id: assistantMessageId, role: 'assistant', content: '', timestamp, thinking: [] },
            ]);
            setLocalIsLoading(true);

            localAbortRef.current = streamChatQuery(
                { query: messageToSend },
                (event: any) => {
                    switch (event.type) {
                        case 'status':
                            setLocalMessages(prev => prev.map(msg => {
                                if (msg.id !== assistantMessageId) return msg;
                                const current = msg.content || "";
                                const nextContent = `⏳ ${event.message || "Analyse en cours..."}`;
                                const entry: ThinkingStep = {
                                    message: event.message || "Analyse en cours...",
                                    status: event.status || "processing",
                                    progress: typeof event.progress === "number" ? event.progress : null,
                                    timestamp: event.timestamp || new Date().toISOString()
                                };
                                const existing = Array.isArray(msg.thinking) ? msg.thinking : [];
                                const last = existing[existing.length - 1];
                                const shouldAppend = !last
                                    || last.message !== entry.message
                                    || last.status !== entry.status
                                    || last.progress !== entry.progress;
                                const nextThinking = shouldAppend ? [...existing, entry] : existing;

                                if (!current || current.startsWith('⏳')) {
                                    return { ...msg, content: nextContent, thinking: nextThinking };
                                }
                                return { ...msg, thinking: nextThinking };
                            }));
                            break;
                        case 'chunk':
                            setLocalMessages(prev => prev.map(msg =>
                                msg.id === assistantMessageId
                                    ? {
                                        ...msg,
                                        content: msg.content?.startsWith('⏳')
                                            ? event.content
                                            : msg.content + event.content
                                    }
                                    : msg
                            ));
                            break;
                        case 'complete':
                            setLocalIsLoading(false);
                            setLocalMessages(prev => prev.map(msg =>
                                msg.id === assistantMessageId
                                    ? {
                                        ...msg,
                                        content: event.final_markdown || event.result?.response || msg.content,
                                        used_tools: event.used_tools || msg.used_tools,
                                        steps: event.steps || event.result?.step_results || msg.steps || []
                                    }
                                    : msg
                            ));
                            break;
                        case 'error':
                            setLocalIsLoading(false);
                            setLocalMessages(prev => prev.map(msg =>
                                msg.id === assistantMessageId
                                    ? { ...msg, content: msg.content + "\n\n[Désolé, une erreur est survenue lors de la génération.]" }
                                    : msg
                            ));
                            break;
                        default:
                            break;
                    }
                },
                (error: any) => {
                    if (error.name !== 'AbortError') {
                        setLocalIsLoading(false);
                    }
                }
            );
        }
        setInput('');
    };

    const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []);
        if (files.length > 0 && onUpload) {
            onUpload(files);
            e.target.value = '';
        }
    };

    const handleSave = () => {
        if (!currentFileName) {
            setSaveName(`Chat ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
            setShowSaveModal(true);
        } else {
            window.dispatchEvent(new CustomEvent('save-chat', { detail: { name: currentFileName } }));
        }
    };

    const handleSaveConfirm = (name: string) => {
        setCurrentFileName(name);
        window.dispatchEvent(new CustomEvent('save-chat', { detail: { name } }));
    };

    const toggleThinking = useCallback((messageId: string) => {
        setExpandedThinkingIds(prev => {
            const next = new Set(prev);
            if (next.has(messageId)) {
                next.delete(messageId);
            } else {
                next.add(messageId);
            }
            return next;
        });
    }, []);

    return (
        <TooltipProvider delayDuration={300}>
            <div className="settings-ui h-full w-full relative flex flex-col text-[#2B2B2B]">
                <div className="flex-1 flex flex-col overflow-hidden min-h-0">
                    <ChatHeader
                        onSave={handleSave}
                        onClear={handleClear}
                        onResetMemory={onResetMemory}
                        isResettingMemory={isResettingMemory}
                    />

                    <ChatMessagesPane
                        messages={effectiveMessages}
                        isLoading={effectiveIsLoading}
                        charts={effectiveCharts}
                        setCurrentChartId={resolvedSetCurrentChartId}
                        expandedThinkingIds={expandedThinkingIds}
                        onToggleThinking={toggleThinking}
                        scrollRef={scrollRef}
                        messagesEndRef={messagesEndRef}
                        onScroll={handleScroll}
                    />

                    {useVoiceInput ? (
                        <VoiceInputArea
                            input={input}
                            onInputChange={setInput}
                            onSend={() => handleSend()}
                            onFileUpload={handleFileUpload}
                            isLoading={effectiveIsLoading}
                            isUploading={effectiveIsUploading}
                            textToSpeak={
                                [...effectiveMessages].reverse().find((m) => m.role === "assistant" && m.content?.trim())
                                    ?.content ?? ""
                            }
                        />
                    ) : (
                        <ChatInputArea
                            input={input}
                            onInputChange={setInput}
                            onSend={() => handleSend()}
                            onFileUpload={handleFileUpload}
                            isLoading={effectiveIsLoading}
                            isUploading={effectiveIsUploading}
                        />
                    )}
                </div>

                <SaveConversationDialog
                    open={showSaveModal}
                    onOpenChange={setShowSaveModal}
                    saveName={saveName}
                    onSaveNameChange={setSaveName}
                    onSave={handleSaveConfirm}
                />
            </div>
        </TooltipProvider>
    );
};

export default ChatInterface;
