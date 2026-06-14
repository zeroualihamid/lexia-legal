import React from 'react';
import { PanelRightOpen } from 'lucide-react';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { usePersistentState } from '@/hooks/usePersistentState';
import { cn } from '@/lib/utils';

/**
 * Two-pane admin layout: main content on the left, an assistant chat panel on
 * the right, separated by a draggable handle. Shared across the admin sections
 * so every chat panel is consistently wider, user-resizable, and collapsible.
 *
 * Children MUST be exactly [main, chat] in that order. The `main` child should
 * be a full-height container (e.g. `className="flex h-full ..."`); the `chat`
 * child fills its panel (the chat panels render `h-full w-full`).
 *
 * Collapse: the chat child receives an injected `onCollapse` prop (its header
 * renders the collapse button). When collapsed, the main content takes the full
 * width and a thin rail on the right lets the user re-open the assistant. The
 * collapsed state is remembered per `id`.
 */
export default function ResizableChatLayout({
  id,
  className,
  children,
}: {
  id: string;
  className?: string;
  children: React.ReactNode;
}) {
  const [main, chat] = React.Children.toArray(children);
  const [collapsed, setCollapsed] = usePersistentState<boolean>(`chat-collapsed:${id}`, false);

  if (collapsed) {
    return (
      <div className={cn('flex min-w-0 flex-1', className)}>
        <div className="min-w-0 flex-1 overflow-hidden">{main}</div>
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          title="Afficher l'assistant"
          aria-label="Afficher l'assistant"
          className="flex w-9 flex-shrink-0 flex-col items-center gap-2 border-l border-border bg-card py-3 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <PanelRightOpen className="h-4 w-4" />
          <span className="text-[10px] font-medium uppercase tracking-wide [writing-mode:vertical-rl]">
            Assistant
          </span>
        </button>
      </div>
    );
  }

  const chatWithCollapse = React.isValidElement(chat)
    ? React.cloneElement(chat as React.ReactElement<any>, { onCollapse: () => setCollapsed(true) })
    : chat;

  return (
    <ResizablePanelGroup orientation="horizontal" className={cn('min-w-0 flex-1', className)}>
      <ResizablePanel id={`${id}-main`} order={1} defaultSize="60" minSize="30">
        {main}
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel id={`${id}-chat`} order={2} defaultSize="40" minSize="24" maxSize="70">
        {chatWithCollapse}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
