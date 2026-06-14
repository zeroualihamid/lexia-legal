import SettingsView from '@/components/features/SettingsView';
import AgentChatPanel from '@/components/features/AgentChatPanel';
import ResizableChatLayout from '@/components/features/ResizableChatLayout';

/**
 * Données — full data Studio/Workbench (ported from qclick-chat) at left,
 * with the Claude assistant as an always-visible right column, consistent with
 * the other admin sections. Background follows the neutral admin theme.
 *
 * `SettingsView` runs in embedded single-section mode (its own tab sidebar /
 * close chrome hidden — navigation comes from the admin left menu).
 */
export default function DataView() {
  return (
    <div className="donnees-atelier flex h-full w-full overflow-hidden bg-background">
      <ResizableChatLayout id="data">
        <div className="h-full min-w-0 overflow-hidden">
          <SettingsView embedded initialTab="data" onClose={() => {}} />
        </div>
        <AgentChatPanel
        scope="data"
        title="Analyseur de sources"
        subtitle="Aligne datasources.yaml ⨯ DTO ⨯ parquet ; supprime les orphelins."
        placeholder="Analyser l'alignement, nettoyer les orphelins…"
        suggestions={[
          "Analyse l'alignement des sources (datasources.yaml ⨯ DTO ⨯ parquet).",
          'Y a-t-il des fichiers parquet ou DTO orphelins à supprimer ?',
          'Vérifie que chaque source a bien sa DTO et son parquet.',
          "Affiche l'état des sources de données (tableau récapitulatif).",
        ]}
        />
      </ResizableChatLayout>
    </div>
  );
}
