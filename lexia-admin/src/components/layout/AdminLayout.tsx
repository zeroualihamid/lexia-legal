import { useState } from 'react';
import {
  Database,
  Plug,
  FlaskConical,
  FileText,
  Network,
  MessagesSquare,
  LogOut,
  Moon,
  Sun,
  PanelLeftClose,
  PanelLeftOpen,
  Building2,
  BadgeCheck,
  Car,
  DoorOpen,
  Warehouse,
  Wrench,
  Handshake,
} from 'lucide-react';
import { signOut } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { asset } from '@/lib/asset';
import DataView from '@/components/features/DataView';
import ConnectorsView from '@/components/features/ConnectorsView';
import SkillsView from '@/components/features/SkillsView';
import PromptsView from '@/components/features/PromptsView';
import CTEGraphView from '@/components/features/CTEGraphView';
import ConversationsView from '@/components/features/ConversationsView';
import BuildingView, { type BuildingSectionId } from '@/components/features/BuildingView';

type Section =
  | 'data'
  | 'connectors'
  | 'skills'
  | 'prompts'
  | 'cte'
  | 'conversations'
  | BuildingSectionId;

const BUILDING_SECTIONS: BuildingSectionId[] = [
  'tenant_experience',
  'badges',
  'parking',
  'preneurs',
  'boh',
  'maintenance',
  'prestataires',
];

const NAV_GROUPS: {
  label: string;
  items: { id: Section; label: string; icon: typeof FlaskConical }[];
}[] = [
  {
    label: 'Agent',
    items: [
      { id: 'data', label: 'Données', icon: Database },
      { id: 'connectors', label: 'Connecteurs', icon: Plug },
      { id: 'skills', label: 'Skills', icon: FlaskConical },
      { id: 'prompts', label: 'Prompts', icon: FileText },
      { id: 'cte', label: 'CTE Graph', icon: Network },
      { id: 'conversations', label: 'Conversations', icon: MessagesSquare },
    ],
  },
  {
    label: 'Immeuble',
    items: [
      { id: 'tenant_experience', label: 'Tenant experience', icon: Building2 },
      { id: 'badges', label: 'Badges', icon: BadgeCheck },
      { id: 'parking', label: 'Parking visiteurs', icon: Car },
      { id: 'preneurs', label: 'Espace preneur', icon: DoorOpen },
      { id: 'boh', label: 'Back of house', icon: Warehouse },
      { id: 'maintenance', label: 'Maintenance & OT', icon: Wrench },
      { id: 'prestataires', label: 'Prestataires', icon: Handshake },
    ],
  },
];

export default function AdminLayout({
  isDarkMode,
  toggleTheme,
}: {
  isDarkMode: boolean;
  toggleTheme: () => void;
}) {
  const [section, setSection] = useState<Section>('data');
  const [collapsed, setCollapsed] = useState(false);

  const handleLogout = async () => {
    await signOut();
    window.location.href = '/login';
  };

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
      {/* Left menu */}
      <aside
        className={cn(
          'flex flex-shrink-0 flex-col border-r border-border bg-card transition-[width] duration-200',
          collapsed ? 'w-14' : 'w-56',
        )}
      >
        <div className={cn('flex items-center gap-2 border-b border-border px-3 py-3', collapsed && 'justify-center px-0')}>
          <img src={asset('logo.png')} alt="Brikz" className="h-7 w-7 flex-shrink-0 rounded" />
          {!collapsed && (
            <div className="min-w-0 leading-tight">
              <div className="truncate text-sm font-semibold">Brikz · admin</div>
              <div className="text-[10px] text-muted-foreground">Cross Tower · agent</div>
            </div>
          )}
        </div>

        <nav className="flex-1 space-y-3 overflow-y-auto p-2">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="space-y-1">
              {!collapsed && (
                <div className="px-3 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {group.label}
                </div>
              )}
              {group.items.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => setSection(id)}
                  title={collapsed ? label : undefined}
                  className={cn(
                    'flex w-full items-center rounded-md py-2 text-sm font-medium transition-colors',
                    collapsed ? 'justify-center px-0' : 'gap-2.5 px-3',
                    section === id
                      ? 'bg-primary/10 text-primary'
                      : 'text-foreground/70 hover:bg-muted hover:text-foreground',
                  )}
                >
                  <Icon className="h-4 w-4 flex-shrink-0" />
                  {!collapsed && label}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div
          className={cn(
            'flex items-center border-t border-border p-2',
            collapsed ? 'flex-col gap-1' : 'justify-between',
          )}
        >
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCollapsed((v) => !v)}
            title={collapsed ? 'Déplier le menu' : 'Replier le menu'}
          >
            {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          </Button>
          <Button variant="ghost" size="sm" onClick={toggleTheme} title="Thème">
            {isDarkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
          <Button variant="ghost" size="sm" onClick={handleLogout} title="Se déconnecter">
            <LogOut className="h-4 w-4" />
            {!collapsed && <span className="ml-1.5 text-xs">Quitter</span>}
          </Button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-hidden">
        {section === 'data' && <DataView />}
        {section === 'connectors' && <ConnectorsView />}
        {section === 'skills' && <SkillsView />}
        {section === 'prompts' && <PromptsView />}
        {section === 'cte' && <CTEGraphView />}
        {section === 'conversations' && <ConversationsView />}
        {BUILDING_SECTIONS.includes(section as BuildingSectionId) && (
          <BuildingView key={section} section={section as BuildingSectionId} />
        )}
      </main>
    </div>
  );
}
