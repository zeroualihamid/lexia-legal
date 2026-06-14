import React, { useState, useCallback, useRef, useEffect } from "react";
import { streamChatQuery } from "@/lib/chat_api";
import { v4 as uuidv4 } from "uuid";
import { Send, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import type { DomainConfig } from "./domain-config";
import MessageBubble from "../chat/MessageBubble";
import type { ChatMessage, ChartData, ThinkingStep } from "@/types/chat";

interface DomainChatProps {
    domain: string;
    domainConfig?: DomainConfig;
}

const DomainChat: React.FC<DomainChatProps> = ({ domain, domainConfig }) => {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [charts, setCharts] = useState<ChartData[]>([]);
    const [expandedThinkingIds, setExpandedThinkingIds] = useState<Set<string>>(new Set());
    const [isLoading, setIsLoading] = useState(false);
    const [input, setInput] = useState("");
    const abortRef = useRef<AbortController | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const toggleThinking = useCallback((id: string) => {
        setExpandedThinkingIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const setCurrentChartId = useCallback((_id: string) => {
        // placeholder — charts are rendered inline for domain chat
    }, []);

    useEffect(() => {
        if (domainConfig) {
            setMessages([
                {
                    id: "welcome",
                    role: "assistant",
                    content: domainConfig.welcomeMessage,
                    timestamp: new Date().toISOString(),
                },
            ]);
        }
    }, [domain]);

    useEffect(() => {
        scrollRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    const sendMessage = useCallback(
        async (text: string) => {
            if (!text.trim() || isLoading) return;

            if (abortRef.current) abortRef.current.abort();

            const userMsg: ChatMessage = {
                id: uuidv4(),
                role: "user",
                content: text,
                timestamp: new Date().toISOString(),
            };
            const assistantId = uuidv4();
            const aiMsg: ChatMessage = {
                id: assistantId,
                role: "assistant",
                content: "",
                timestamp: new Date().toISOString(),
                thinking: [],
            };

            setMessages((prev) => [...prev, userMsg, aiMsg]);
            setIsLoading(true);
            setInput("");

            abortRef.current = streamChatQuery(
                { query: text, domain },
                (event) => {
                    switch (event.type) {
                        case "status":
                            setMessages((prev) =>
                                prev.map((msg) => {
                                    if (msg.id !== assistantId) return msg;
                                    const entry: ThinkingStep = {
                                        message: event.message || "Analyse en cours...",
                                        status: event.status || "processing",
                                        progress: typeof event.progress === "number" ? event.progress : null,
                                        timestamp: event.timestamp || new Date().toISOString(),
                                    };
                                    const existing = Array.isArray(msg.thinking) ? msg.thinking : [];
                                    const last = existing[existing.length - 1];
                                    const shouldAppend =
                                        !last ||
                                        last.message !== entry.message ||
                                        last.status !== entry.status;
                                    const nextThinking = shouldAppend ? [...existing, entry] : existing;
                                    const current = msg.content || "";
                                    const statusText = `⏳ ${entry.message}`;
                                    if (!current || current.startsWith("⏳")) {
                                        return { ...msg, content: statusText, thinking: nextThinking };
                                    }
                                    return { ...msg, thinking: nextThinking };
                                })
                            );
                            break;
                        case "chunk":
                            setMessages((prev) =>
                                prev.map((msg) =>
                                    msg.id === assistantId
                                        ? {
                                              ...msg,
                                              content: msg.content?.startsWith("⏳")
                                                  ? event.content
                                                  : msg.content + event.content,
                                          }
                                        : msg
                                )
                            );
                            break;
                        case "chart_data":
                            if (event.chart?.option) {
                                setCharts((prev) => [
                                    ...prev,
                                    {
                                        chartId: event.chartId,
                                        type: event.chart.chartType,
                                        data: event.chart.option,
                                    },
                                ]);
                                setMessages((prev) =>
                                    prev.map((msg) =>
                                        msg.id === assistantId
                                            ? { ...msg, chartId: event.chartId }
                                            : msg
                                    )
                                );
                            }
                            break;
                        case "complete":
                            setIsLoading(false);
                            setMessages((prev) =>
                                prev.map((msg) =>
                                    msg.id === assistantId
                                        ? {
                                              ...msg,
                                              content:
                                                  event.final_markdown ||
                                                  event.result?.response ||
                                                  msg.content,
                                              steps: event.steps || event.result?.step_results || msg.steps || [],
                                          }
                                        : msg
                                )
                            );
                            break;
                        case "error":
                            setIsLoading(false);
                            setMessages((prev) =>
                                prev.map((msg) =>
                                    msg.id === assistantId
                                        ? {
                                              ...msg,
                                              content:
                                                  msg.content +
                                                  "\n\n[Désolé, une erreur est survenue.]",
                                          }
                                        : msg
                                )
                            );
                            break;
                    }
                },
                (error) => {
                    if (error.name !== "AbortError") {
                        console.error("Domain chat error:", error);
                        setIsLoading(false);
                    }
                }
            );
        },
        [domain, isLoading]
    );

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage(input);
        }
    };

    const clearChat = () => {
        if (abortRef.current) abortRef.current.abort();
        setMessages(
            domainConfig
                ? [
                      {
                          id: "welcome",
                          role: "assistant",
                          content: domainConfig.welcomeMessage,
                          timestamp: new Date().toISOString(),
                      },
                  ]
                : []
        );
        setCharts([]);
        setExpandedThinkingIds(new Set());
        setIsLoading(false);
    };

    return (
        <div className="flex flex-col h-full bg-background">
            {/* Sample questions */}
            {messages.length <= 1 && domainConfig && (
                <div className="px-4 pt-4 pb-2 space-y-2">
                    <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                        Questions suggérées
                    </p>
                    <div className="flex flex-wrap gap-2">
                        {domainConfig.sampleQuestions.map((q, i) => (
                            <Badge
                                key={i}
                                variant="outline"
                                className="cursor-pointer hover:bg-accent transition-colors text-xs py-1.5 px-3"
                                onClick={() => sendMessage(q)}
                            >
                                {q}
                            </Badge>
                        ))}
                    </div>
                </div>
            )}

            {/* Messages */}
            <ScrollArea className="flex-1 px-4">
                <div className="space-y-4 py-4">
                    {messages.map((msg) => (
                        <MessageBubble
                            key={msg.id}
                            msg={msg}
                            charts={charts}
                            setCurrentChartId={setCurrentChartId}
                            isThinkingExpanded={expandedThinkingIds.has(msg.id)}
                            toggleThinking={toggleThinking}
                        />
                    ))}
                    <div ref={scrollRef} />
                </div>
            </ScrollArea>

            {/* Input area */}
            <div className="border-t p-3 flex items-end gap-2">
                <Button
                    variant="ghost"
                    size="icon"
                    onClick={clearChat}
                    className="shrink-0"
                    title="Effacer la conversation"
                >
                    <Trash2 className="h-4 w-4" />
                </Button>
                <Textarea
                    ref={textareaRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={`Posez votre question (${domainConfig?.label || domain})...`}
                    className="min-h-[40px] max-h-[120px] resize-none"
                    rows={1}
                    disabled={isLoading}
                />
                <Button
                    onClick={() => sendMessage(input)}
                    disabled={!input.trim() || isLoading}
                    size="icon"
                    className="shrink-0"
                >
                    {isLoading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <Send className="h-4 w-4" />
                    )}
                </Button>
            </div>
        </div>
    );
};

export default DomainChat;
