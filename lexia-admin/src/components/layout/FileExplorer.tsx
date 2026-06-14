import React, { useCallback, useEffect, useState } from 'react';
import { History, MessageSquareText, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
    deleteConversation,
    getSavedConversationsMeta,
    createSessionId,
    type SavedConversationRecord,
} from '@/lib/chat_api';

const formatConversationDate = (value: string) => {
    try {
        return new Date(value).toLocaleString([], {
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch {
        return value;
    }
};

interface FileExplorerProps {
    variant?: 'default' | 'settings';
}

const FileExplorer: React.FC<FileExplorerProps> = ({ variant = 'default' }) => {
    const [conversations, setConversations] = useState<SavedConversationRecord[]>([]);
    const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
    const isSettingsVariant = variant === 'settings';

    const refreshConversations = useCallback(() => {
        setConversations(getSavedConversationsMeta());
    }, []);

    useEffect(() => {
        refreshConversations();
        const storedSessionId = localStorage.getItem('qclick_session_id');
        setActiveSessionId(storedSessionId);

        const handleHistoryUpdated = () => refreshConversations();
        const handleSessionChanged = (event: Event) => {
            const customEvent = event as CustomEvent<{ sessionId?: string }>;
            setActiveSessionId(customEvent.detail?.sessionId || localStorage.getItem('qclick_session_id'));
            refreshConversations();
        };

        window.addEventListener('chat-history-updated', handleHistoryUpdated);
        window.addEventListener('chat-session-changed', handleSessionChanged);
        return () => {
            window.removeEventListener('chat-history-updated', handleHistoryUpdated);
            window.removeEventListener('chat-session-changed', handleSessionChanged);
        };
    }, [refreshConversations]);

    const handleNewConversation = () => {
        const sessionId = createSessionId();
        setActiveSessionId(sessionId);
        window.dispatchEvent(new CustomEvent('new-chat-conversation', { detail: { sessionId } }));
        window.dispatchEvent(new CustomEvent('chat-session-changed', { detail: { sessionId } }));
    };

    const handleOpenConversation = (sessionId: string) => {
        setActiveSessionId(sessionId);
        window.dispatchEvent(new CustomEvent('open-chat-history', { detail: { sessionId } }));
    };

    const handleDeleteConversation = async (event: React.MouseEvent, sessionId: string) => {
        event.stopPropagation();
        try {
            await deleteConversation(sessionId);
            refreshConversations();
            if (activeSessionId === sessionId) {
                handleNewConversation();
            }
        } catch (error) {
            console.error('Failed to delete conversation:', error);
        }
    };

    return (
        <div
            className={cn(
                "h-full w-full flex flex-col",
                isSettingsVariant
                    ? "settings-ui bg-white text-[#2B2B2B]"
                    : "bg-muted/10 border-r border-border/40"
            )}
        >
            <div
                className={cn(
                    isSettingsVariant
                        ? "p-4 border-b border-[#E8E6E1] bg-white"
                        : "p-3 border-b border-border/40 bg-muted/20"
                )}
            >
                <div className="flex items-center justify-between gap-2">
                    <div>
                        <div
                            className={cn(
                                "text-xs uppercase",
                                isSettingsVariant
                                    ? "font-semibold tracking-[0.2em] text-[#A09E99]"
                                    : "font-medium tracking-wider text-muted-foreground"
                            )}
                        >
                            Historique
                        </div>
                        <div
                            className={cn(
                                "mt-1 text-xs",
                                isSettingsVariant ? "leading-relaxed text-[#6B6966]" : "text-muted-foreground"
                            )}
                        >
                            Conversations sauvegardées et ré-ouverture de session
                        </div>
                    </div>
                    <div className="flex items-center gap-1">
                        <Button
                            variant="ghost"
                            size="icon"
                            className={cn(
                                "h-7 w-7",
                                isSettingsVariant && "rounded-lg border border-[#E8E6E1] text-[#6B6966] hover:bg-[#F8F7F4] hover:text-[#2B2B2B]"
                            )}
                            onClick={refreshConversations}
                            title="Rafraîchir"
                        >
                            <RefreshCw className="h-4 w-4" />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            className={cn(
                                "h-7 w-7",
                                isSettingsVariant && "rounded-lg border border-[#E8E6E1] text-[#0D7377] hover:bg-[#F1FAFA] hover:text-[#0B6164]"
                            )}
                            onClick={handleNewConversation}
                            title="Nouvelle conversation"
                        >
                            <Plus className="h-4 w-4" />
                        </Button>
                    </div>
                </div>
            </div>

            <ScrollArea className="flex-1">
                <div className={cn("space-y-1", isSettingsVariant ? "p-3" : "p-2")}>
                    {conversations.length === 0 ? (
                        <div
                            className={cn(
                                "rounded-2xl p-4 text-xs",
                                isSettingsVariant
                                    ? "border border-dashed border-[#E8E6E1] bg-[#F8F7F4] text-[#6B6966]"
                                    : "border border-dashed border-border/60 bg-background/40 text-muted-foreground"
                            )}
                        >
                            Aucune conversation sauvegardée pour le moment.
                        </div>
                    ) : (
                        conversations.map((conversation) => (
                            <div
                                key={conversation.sessionId}
                                role="button"
                                tabIndex={0}
                                onClick={() => handleOpenConversation(conversation.sessionId)}
                                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleOpenConversation(conversation.sessionId); } }}
                                className={cn(
                                    "w-full cursor-pointer rounded-2xl border p-3 text-left transition-colors",
                                    isSettingsVariant
                                        ? (
                                            activeSessionId === conversation.sessionId
                                                ? "border-[#0D7377]/20 bg-[#F1FAFA] shadow-sm"
                                                : "border-[#E8E6E1] bg-[#FFFEFC] hover:bg-[#F8F7F4]"
                                        )
                                        : (
                                            activeSessionId === conversation.sessionId
                                                ? "border-primary/40 bg-primary/10"
                                                : "border-border/40 bg-background/40 hover:bg-muted/40"
                                        )
                                )}
                            >
                                <div className="flex items-start gap-3">
                                    <div className={cn(
                                        "mt-0.5 rounded-xl p-2",
                                        isSettingsVariant
                                            ? (
                                                activeSessionId === conversation.sessionId
                                                    ? "bg-[#0D7377]/10 text-[#0D7377]"
                                                    : "bg-[#F8F7F4] text-[#A09E99]"
                                            )
                                            : (
                                                activeSessionId === conversation.sessionId
                                                    ? "bg-primary/15 text-primary"
                                                    : "bg-muted text-muted-foreground"
                                            )
                                    )}>
                                        <MessageSquareText className="h-4 w-4" />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <div
                                            className={cn(
                                                "truncate text-sm font-medium",
                                                isSettingsVariant ? "text-[#2B2B2B]" : "text-foreground"
                                            )}
                                        >
                                            {conversation.name}
                                        </div>
                                        <div
                                            className={cn(
                                                "mt-1 line-clamp-2 text-xs",
                                                isSettingsVariant ? "text-[#6B6966]" : "text-muted-foreground"
                                            )}
                                        >
                                            {conversation.lastMessage || conversation.sessionId}
                                        </div>
                                        <div
                                            className={cn(
                                                "mt-2 flex items-center gap-2 text-[11px]",
                                                isSettingsVariant ? "settings-mono text-[#A09E99]" : "text-muted-foreground"
                                            )}
                                        >
                                            <History className="h-3 w-3" />
                                            <span>{conversation.messageCount} messages</span>
                                            <span>•</span>
                                            <span>{formatConversationDate(conversation.updatedAt)}</span>
                                        </div>
                                    </div>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className={cn(
                                            "h-7 w-7 shrink-0",
                                            isSettingsVariant
                                                ? "rounded-lg text-[#A09E99] hover:bg-[#FFF1ED] hover:text-[#E8725A]"
                                                : "text-muted-foreground hover:text-destructive"
                                        )}
                                        onClick={(event) => handleDeleteConversation(event, conversation.sessionId)}
                                        title="Supprimer la conversation"
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </Button>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </ScrollArea>
        </div>
    );
};

export default FileExplorer;
