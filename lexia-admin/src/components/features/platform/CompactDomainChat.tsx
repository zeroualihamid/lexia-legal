import React, { useState, useCallback, useRef } from "react";
import { Send, Loader2, Plus, MessageCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { streamChatQuery } from "@/lib/chat_api";
import { createCard } from "@/lib/cards_api";
import MarkdownRenderer from "../chat/MarkdownRenderer";
import type { DomainCard } from "@/types/cards";

interface CompactDomainChatProps {
    domain: string;
    domainLabel?: string;
    onNewCard?: (card: DomainCard) => void;
}

interface ChatMsg {
    id: string;
    role: "user" | "assistant";
    content: string;
}

const CompactDomainChat: React.FC<CompactDomainChatProps> = ({
    domain,
    domainLabel,
    onNewCard,
}) => {
    const [input, setInput] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const [messages, setMessages] = useState<ChatMsg[]>([]);
    const [creatingCard, setCreatingCard] = useState(false);
    const abortRef = useRef<AbortController | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    const sendMessage = useCallback(
        async (text: string) => {
            if (!text.trim() || isLoading) return;
            if (abortRef.current) abortRef.current.abort();

            const userMsg: ChatMsg = {
                id: crypto.randomUUID(),
                role: "user",
                content: text,
            };
            const aiId = crypto.randomUUID();
            const aiMsg: ChatMsg = { id: aiId, role: "assistant", content: "" };

            setMessages((prev) => [...prev, userMsg, aiMsg]);
            setIsLoading(true);
            setInput("");
            setExpanded(true);

            abortRef.current = streamChatQuery(
                { query: text, domain },
                (event) => {
                    switch (event.type) {
                        case "chunk":
                            setMessages((prev) =>
                                prev.map((m) =>
                                    m.id === aiId
                                        ? { ...m, content: m.content + event.content }
                                        : m,
                                ),
                            );
                            break;
                        case "complete":
                            setIsLoading(false);
                            setMessages((prev) =>
                                prev.map((m) =>
                                    m.id === aiId
                                        ? {
                                              ...m,
                                              content:
                                                  event.final_markdown ||
                                                  (event as any).result?.response ||
                                                  m.content,
                                          }
                                        : m,
                                ),
                            );
                            break;
                        case "error":
                            setIsLoading(false);
                            break;
                    }
                },
                (err) => {
                    if (err.name !== "AbortError") setIsLoading(false);
                },
            );
        },
        [domain, isLoading],
    );

    const handleCreateCard = useCallback(async () => {
        if (!input.trim()) return;
        setCreatingCard(true);
        try {
            const card = await createCard(domain, input.trim(), "analysis");
            onNewCard?.(card);
            setInput("");
        } catch (e) {
            console.error("Failed to create card:", e);
        } finally {
            setCreatingCard(false);
        }
    }, [domain, input, onNewCard]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage(input);
        }
    };

    return (
        <div className="border-t bg-card/50 backdrop-blur-sm">
            {/* Expandable messages area */}
            {expanded && messages.length > 0 && (
                <div className="relative border-b">
                    <button
                        onClick={() => setExpanded(false)}
                        className="absolute right-2 top-2 z-10 rounded-full p-1 hover:bg-accent"
                    >
                        <X className="h-3.5 w-3.5" />
                    </button>
                    <ScrollArea className="max-h-[240px]">
                        <div className="p-3 space-y-3">
                            {messages.map((msg) => (
                                <div
                                    key={msg.id}
                                    className={cn(
                                        "text-sm",
                                        msg.role === "user"
                                            ? "text-right text-muted-foreground"
                                            : "text-left",
                                    )}
                                >
                                    {msg.role === "user" ? (
                                        <span className="inline-block rounded-lg bg-primary/10 px-3 py-1.5 text-xs">
                                            {msg.content}
                                        </span>
                                    ) : (
                                        <div className="prose prose-sm dark:prose-invert max-w-none text-xs">
                                            <MarkdownRenderer
                                                content={msg.content || "..."}
                                            />
                                        </div>
                                    )}
                                </div>
                            ))}
                            <div ref={scrollRef} />
                        </div>
                    </ScrollArea>
                </div>
            )}

            {/* Input bar */}
            <div className="flex items-end gap-2 p-2.5">
                {messages.length > 0 && !expanded && (
                    <Button
                        variant="ghost"
                        size="icon"
                        className="shrink-0 h-8 w-8"
                        onClick={() => setExpanded(true)}
                        title="Voir la conversation"
                    >
                        <MessageCircle className="h-4 w-4" />
                    </Button>
                )}

                <Textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={`Posez votre question (${domainLabel || domain})...`}
                    className="min-h-[36px] max-h-[80px] resize-none text-sm"
                    rows={1}
                    disabled={isLoading || creatingCard}
                />

                <Button
                    variant="outline"
                    size="icon"
                    className="shrink-0 h-8 w-8"
                    onClick={handleCreateCard}
                    disabled={!input.trim() || isLoading || creatingCard}
                    title="Créer une fiche à partir de cette demande"
                >
                    {creatingCard ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                        <Plus className="h-3.5 w-3.5" />
                    )}
                </Button>

                <Button
                    size="icon"
                    className="shrink-0 h-8 w-8"
                    onClick={() => sendMessage(input)}
                    disabled={!input.trim() || isLoading}
                >
                    {isLoading ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                        <Send className="h-3.5 w-3.5" />
                    )}
                </Button>
            </div>
        </div>
    );
};

export default CompactDomainChat;
