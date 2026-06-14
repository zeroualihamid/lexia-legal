import { useState, useCallback, useRef, useEffect } from 'react';
import {
    streamChatQuery,
    uploadDossier,
    getConversationHistory,
    getSessionId,
    setSessionId,
    createSessionId,
    upsertSavedConversationMeta
} from '@/lib/chat_api';
import { v4 as uuidv4 } from 'uuid';

export const useChat = () => {
    const initialGreeting = { id: '1', role: 'assistant', content: "Bonjour ! Je suis votre assistant qclick. Comment puis-je vous aider avec vos données aujourd'hui ?", timestamp: new Date().toISOString() };
    const [messages, setMessages] = useState([
        initialGreeting
    ]);
    const [charts, setCharts] = useState([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isChartLoading, setIsChartLoading] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const [currentChartId, setCurrentChartId] = useState(null);
    const abortControllerRef = useRef(null);

    const buildConversationLabel = useCallback((items) => {
        const firstUserMessage = items.find(msg => msg.role === 'user' && msg.content?.trim());
        const base = firstUserMessage?.content?.trim() || 'Nouvelle conversation';
        return base.length > 60 ? `${base.slice(0, 60)}...` : base;
    }, []);

    const syncConversationMeta = useCallback((items, overrideName) => {
        const visibleMessages = items.filter(msg => msg.role === 'user' || msg.role === 'assistant');
        const meaningfulMessages = visibleMessages.filter(msg => !(msg.role === 'assistant' && msg.id === '1' && visibleMessages.length === 1));
        if (meaningfulMessages.length === 0) {
            return;
        }

        const sessionId = getSessionId();
        const userMessages = meaningfulMessages.filter(msg => msg.role === 'user');
        const lastMessage = meaningfulMessages[meaningfulMessages.length - 1]?.content || '';
        const fallbackCreatedAt = meaningfulMessages[0]?.timestamp || new Date().toISOString();
        upsertSavedConversationMeta({
            sessionId,
            name: overrideName || buildConversationLabel(meaningfulMessages),
            createdAt: fallbackCreatedAt,
            updatedAt: new Date().toISOString(),
            messageCount: meaningfulMessages.length,
            lastMessage: lastMessage.slice(0, 160),
        });
        window.dispatchEvent(new CustomEvent('chat-history-updated'));
        window.dispatchEvent(new CustomEvent('chat-session-changed', { detail: { sessionId } }));
    }, [buildConversationLabel]);

    const sendMessage = useCallback(async (text) => {
        if (!text.trim() || isLoading) return;

        // Abort any existing stream
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }

        const userMessageId = uuidv4();
        const userMsg = {
            id: userMessageId,
            role: 'user',
            content: text,
            timestamp: new Date().toISOString()
        };

        setMessages(prev => [...prev, userMsg]);
        setIsLoading(true);
        setIsChartLoading(true);
        setCurrentChartId(null);

        const assistantMessageId = uuidv4();
        const initialAiMsg = {
            id: assistantMessageId,
            role: 'assistant',
            content: "",
            timestamp: new Date().toISOString(),
            thinking: []
        };

        setMessages(prev => [...prev, initialAiMsg]);

        try {
            abortControllerRef.current = streamChatQuery(
                { query: text },
                (event) => {
                    console.log("Chat event:", event.type, event);
                    switch (event.type) {
                        case 'start':
                            // Stream started, keep loading state
                            break;
                        case 'status':
                            setMessages(prev => prev.map(msg => {
                                if (msg.id !== assistantMessageId) return msg;
                                const current = msg.content || "";
                                const nextContent = `⏳ ${event.message || "Analyse en cours..."}`;
                                const entry = {
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
                            setMessages(prev => prev.map(msg =>
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
                        case 'chart_data':
                            if (event.chart?.option) {
                                const newChart = {
                                    chartId: event.chartId,
                                    query: event.query || text,
                                    chartType: event.chart.chartType,
                                    option: event.chart.option,
                                    timestamp: event.timestamp || new Date().toISOString(),
                                };
                                setCharts(prev => [...prev, newChart]);
                                setCurrentChartId(event.chartId);

                                // Link chart to message
                                setMessages(prev => prev.map(msg =>
                                    msg.id === assistantMessageId
                                        ? { ...msg, chartId: event.chartId }
                                        : msg
                                ));
                            }
                            setIsChartLoading(false);
                            break;
                        case 'complete':
                            setIsLoading(false);
                            setIsChartLoading(false);
                            setMessages(prev => prev.map(msg =>
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
                            setIsLoading(false);
                            setIsChartLoading(false);
                            setMessages(prev => prev.map(msg =>
                                msg.id === assistantMessageId
                                    ? { ...msg, content: msg.content + "\n\n[Désolé, une erreur est survenue lors de la génération.]" }
                                    : msg
                            ));
                            break;
                    }
                },
                (error) => {
                    if (error.name !== 'AbortError') {
                        console.error("Chat Error:", error);
                        setIsLoading(false);
                        setIsChartLoading(false);
                    }
                }
            );
        } catch (error) {
            console.error("Failed to start stream:", error);
            setIsLoading(false);
            setIsChartLoading(false);
        }
    }, [isLoading]);

    const uploadFiles = useCallback(async (files) => {
        if (files.length === 0) return;
        setIsUploading(true);
        try {
            const response = await uploadDossier(files);
            if (response.success) {
                const filenames = files.map(f => f.name).join(', ');
                sendMessage(`J'ai téléchargé les fichiers suivants : ${filenames}. Pouvez-vous les analyser ?`);
            } else {
                throw new Error(response.error || "Erreur inconnue");
            }
        } catch (error) {
            console.error("Upload error:", error);
            alert("Erreur lors du téléchargement: " + error.message);
        } finally {
            setIsUploading(false);
        }
    }, [sendMessage]);

    const clearHistory = useCallback(() => {
        const nextSessionId = createSessionId();
        setSessionId(nextSessionId);
        setMessages([{
            ...initialGreeting,
            timestamp: new Date().toISOString(),
        }]);
        setCharts([]);
        setCurrentChartId(null);
        window.dispatchEvent(new CustomEvent('chat-session-changed', { detail: { sessionId: nextSessionId } }));
    }, []);

    useEffect(() => {
        syncConversationMeta(messages);
    }, [messages, syncConversationMeta]);

    useEffect(() => {
        const handleSaveChat = (event) => {
            const name = event.detail?.name;
            syncConversationMeta(messages, name);
        };

        const handleOpenChatHistory = async (event) => {
            const sessionId = event.detail?.sessionId;
            if (!sessionId) return;

            try {
                const history = await getConversationHistory(sessionId);
                const mappedMessages = (history.messages || [])
                    .filter(msg => msg.role === 'user' || msg.role === 'assistant')
                    .map(msg => ({
                        id: msg.message_id || uuidv4(),
                        role: msg.role,
                        content: msg.content,
                        timestamp: msg.timestamp || new Date().toISOString(),
                    }));

                setSessionId(sessionId);
                setMessages(mappedMessages.length > 0 ? mappedMessages : [{
                    ...initialGreeting,
                    timestamp: new Date().toISOString(),
                }]);
                setCharts([]);
                setCurrentChartId(null);
                window.dispatchEvent(new CustomEvent('chat-session-changed', { detail: { sessionId } }));
            } catch (error) {
                console.error("Failed to open saved conversation:", error);
            }
        };

        const handleNewChatConversation = (event) => {
            const sessionId = event.detail?.sessionId || createSessionId();
            setSessionId(sessionId);
            setMessages([{
                ...initialGreeting,
                timestamp: new Date().toISOString(),
            }]);
            setCharts([]);
            setCurrentChartId(null);
            window.dispatchEvent(new CustomEvent('chat-session-changed', { detail: { sessionId } }));
        };

        window.addEventListener('save-chat', handleSaveChat);
        window.addEventListener('open-chat-history', handleOpenChatHistory);
        window.addEventListener('new-chat-conversation', handleNewChatConversation);
        return () => {
            window.removeEventListener('save-chat', handleSaveChat);
            window.removeEventListener('open-chat-history', handleOpenChatHistory);
            window.removeEventListener('new-chat-conversation', handleNewChatConversation);
        };
    }, [messages, syncConversationMeta]);

    useEffect(() => {
        window.dispatchEvent(new CustomEvent('chat-session-changed', { detail: { sessionId: getSessionId() } }));
    }, []);

    return {
        messages,
        charts,
        isLoading,
        isChartLoading,
        isUploading,
        currentChartId,
        sendMessage,
        uploadFiles,
        clearHistory,
        setCurrentChartId
    };
};
