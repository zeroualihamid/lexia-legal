import { useState } from 'react';
import CTEGraphPanel from '@/components/features/CTEGraphPanel';
import AgentChatPanel from '@/components/features/AgentChatPanel';
import ResizableChatLayout from '@/components/features/ResizableChatLayout';

/**
 * CTE Graph section — the full catalog/workspace panel ported from qclick-chat
 * (profiles, ReactFlow viewer, semantic search, query console) in a vertically
 * scrollable workspace, with the Claude assistant as an always-visible column.
 *
 * The panel's root is a plain stacked layout with no internal scroll (it was
 * built to live inside a scrolling page), so the workspace column owns the
 * vertical scroll — otherwise the graph, which sits below the catalog/header,
 * gets clipped out of view.
 */
export default function CTEGraphView() {
  // graph_id of the profile currently selected in the workspace, so the
  // "Assistant CTE" chat binds the agent to THAT graph (and its source).
  const [activeGraphId, setActiveGraphId] = useState<string | null>(null);
  return (
    <div className="flex h-full w-full overflow-hidden bg-background">
      <ResizableChatLayout id="cte">
        {/* Scrollable graph workspace */}
        <div className="h-full min-w-0 overflow-y-auto">
          <div className="mx-auto max-w-[1480px] p-5 lg:p-6">
            <CTEGraphPanel onActiveGraphChange={setActiveGraphId} />
          </div>
        </div>

        <AgentChatPanel
        scope="cte"
        title="Assistant CTE"
        subtitle="Explorer et expliquer la bibliothèque de CTE."
        placeholder="Question sur les CTE…"
        graphId={activeGraphId}
        suggestions={[
          'Liste les CTE disponibles et leur rôle.',
          'Explique une CTE et ses dépendances.',
          'Teste une CTE et montre un échantillon.',
        ]}
        />
      </ResizableChatLayout>
    </div>
  );
}
