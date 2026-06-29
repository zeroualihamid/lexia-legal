import { useCallback, useEffect, useState } from 'react';
import {
  Plus,
  Trash2,
  RefreshCw,
  Loader2,
  FolderOpen,
  FileText,
  Download,
  Zap,
  ChevronRight,
  ArrowLeft,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { getLexiaToken } from '@/store/authStore';
import {
  createDriveConnector,
  deleteDriveConnector,
  driveConnectorDownloadUrl,
  listDriveConnectorFiles,
  listDriveConnectors,
  testDriveConnector,
  type DriveConnector,
  type DriveFileItem,
} from '@/lib/drive_connectors_api';

type AuthType = 'service_account' | 'access_token';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

export default function GoogleDriveConnectorsPanel() {
  const [connectors, setConnectors] = useState<DriveConnector[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState('');
  const [formFolderId, setFormFolderId] = useState('');
  const [formAuthType, setFormAuthType] = useState<AuthType>('service_account');
  const [formServiceAccountJson, setFormServiceAccountJson] = useState('');
  const [formAccessToken, setFormAccessToken] = useState('');
  const [saving, setSaving] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  const [browseFolderId, setBrowseFolderId] = useState<string | null>(null);
  const [folderStack, setFolderStack] = useState<{ id: string; name: string }[]>([]);
  const [files, setFiles] = useState<DriveFileItem[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | undefined>();
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const active = connectors.find((c) => c.id === activeId) || null;

  const refresh = useCallback(async () => {
    setLoadingList(true);
    setError(null);
    try {
      const rows = await listDriveConnectors();
      setConnectors(rows);
      if (rows.length && !activeId) {
        setActiveId(rows[0].id);
        setBrowseFolderId(rows[0].folder_id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingList(false);
    }
  }, [activeId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (active) {
      setBrowseFolderId(active.folder_id);
      setFolderStack([]);
      setFiles([]);
      setNextPageToken(undefined);
      setTestMsg(null);
    }
  }, [active?.id]);

  const loadFiles = async (folderId: string, pageToken?: string, append = false) => {
    if (!activeId) return;
    setLoadingFiles(true);
    setError(null);
    try {
      const res = await listDriveConnectorFiles(activeId, {
        folderId,
        pageToken,
      });
      setFiles((prev) => (append ? [...prev, ...res.files] : res.files));
      setNextPageToken(res.nextPageToken);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingFiles(false);
    }
  };

  useEffect(() => {
    if (activeId && browseFolderId) {
      void loadFiles(browseFolderId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, browseFolderId]);

  const create = async () => {
    setSaving(true);
    setError(null);
    try {
      const row = await createDriveConnector({
        name: formName.trim(),
        folder_id: formFolderId.trim(),
        auth_type: formAuthType,
        service_account_json: formAuthType === 'service_account' ? formServiceAccountJson : undefined,
        access_token: formAuthType === 'access_token' ? formAccessToken : undefined,
      });
      setShowForm(false);
      setFormName('');
      setFormFolderId('');
      setFormServiceAccountJson('');
      setFormAccessToken('');
      await refresh();
      setActiveId(row.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm('Supprimer ce connecteur Google Drive ?')) return;
    setError(null);
    try {
      await deleteDriveConnector(id);
      if (activeId === id) {
        setActiveId(null);
        setBrowseFolderId(null);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const runTest = async () => {
    if (!activeId) return;
    setTesting(true);
    setTestMsg(null);
    setError(null);
    try {
      const res = await testDriveConnector(activeId);
      setTestMsg(res.message);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  const openFolder = (file: DriveFileItem) => {
    setFolderStack((prev) => [...prev, { id: browseFolderId!, name: file.name }]);
    setBrowseFolderId(file.id);
  };

  const goUp = () => {
    if (folderStack.length === 0 && active) {
      setBrowseFolderId(active.folder_id);
      return;
    }
    const next = [...folderStack];
    const parent = next.pop();
    setFolderStack(next);
    if (parent) setBrowseFolderId(parent.id);
    else if (active) setBrowseFolderId(active.folder_id);
  };

  const downloadFile = async (file: DriveFileItem) => {
    if (!activeId) return;
    setDownloadingId(file.id);
    setError(null);
    try {
      const url = driveConnectorDownloadUrl(activeId, file.id);
      const token = getLexiaToken();
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Téléchargement échoué (${res.status})`);
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = file.name;
      a.click();
      URL.revokeObjectURL(objectUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloadingId(null);
    }
  };

  const formatSize = (bytes?: number) => {
    if (!bytes) return '—';
    if (bytes < 1024) return `${bytes} o`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
  };

  return (
    <div className="flex h-full w-full">
      {/* Connector list */}
      <div className="flex w-64 flex-shrink-0 flex-col border-r border-border">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-sm font-semibold">Google Drive</span>
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" onClick={() => setShowForm((v) => !v)} title="Ajouter">
              <Plus className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void refresh()} title="Rafraîchir">
              <RefreshCw className={cn('h-4 w-4', loadingList && 'animate-spin')} />
            </Button>
          </div>
        </div>

        {showForm && (
          <div className="space-y-2 border-b border-border p-3">
            <Input placeholder="Nom du connecteur" value={formName} onChange={(e) => setFormName(e.target.value)} />
            <Input placeholder="ID dossier Drive" value={formFolderId} onChange={(e) => setFormFolderId(e.target.value)} />
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={formAuthType}
              onChange={(e) => setFormAuthType(e.target.value as AuthType)}
            >
              <option value="service_account">Compte de service (JSON)</option>
              <option value="access_token">Jeton d'accès OAuth</option>
            </select>
            {formAuthType === 'service_account' ? (
              <textarea
                className="min-h-[80px] w-full rounded-md border border-input bg-background p-2 text-xs font-mono"
                placeholder='{"type":"service_account",...}'
                value={formServiceAccountJson}
                onChange={(e) => setFormServiceAccountJson(e.target.value)}
              />
            ) : (
              <Input
                type="password"
                placeholder="Access token"
                value={formAccessToken}
                onChange={(e) => setFormAccessToken(e.target.value)}
              />
            )}
            <Button size="sm" className="w-full" disabled={saving} onClick={() => void create()}>
              {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              Créer
            </Button>
          </div>
        )}

        <ScrollArea className="flex-1">
          <div className="p-2 space-y-1">
            {connectors.map((c) => (
              <div key={c.id} className="flex items-center gap-1">
                <button
                  onClick={() => setActiveId(c.id)}
                  className={cn(
                    'flex min-w-0 flex-1 flex-col rounded-md px-3 py-2 text-left text-sm transition-colors',
                    activeId === c.id ? 'bg-primary/10 text-primary' : 'hover:bg-muted',
                  )}
                >
                  <span className="truncate font-medium">{c.name}</span>
                  <span className="truncate text-[11px] text-muted-foreground">{c.folder_id}</span>
                  {c.last_test_status && (
                    <span
                      className={cn(
                        'mt-0.5 text-[10px]',
                        c.last_test_status === 'success' ? 'text-emerald-500' : 'text-red-500',
                      )}
                    >
                      {c.last_test_status === 'success' ? 'Connecté' : 'Échec test'}
                    </span>
                  )}
                </button>
                <Button variant="ghost" size="sm" onClick={() => void remove(c.id)} title="Supprimer">
                  <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
              </div>
            ))}
            {!loadingList && connectors.length === 0 && (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                Aucun connecteur. Cliquez + pour en ajouter un.
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Detail + file browser */}
      <div className="flex min-w-0 flex-1 flex-col">
        {active ? (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
              <span className="text-sm font-semibold">{active.name}</span>
              <Button size="sm" variant="outline" disabled={testing} onClick={() => void runTest()}>
                {testing ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Zap className="mr-1 h-4 w-4" />}
                Tester la connexion
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={loadingFiles}
                onClick={() => browseFolderId && void loadFiles(browseFolderId)}
              >
                <RefreshCw className={cn('h-4 w-4', loadingFiles && 'animate-spin')} />
              </Button>
            </div>

            {error && (
              <div className="mx-4 mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">
                {error}
              </div>
            )}
            {testMsg && (
              <div className="mx-4 mt-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-600">
                {testMsg}
              </div>
            )}

            <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-sm">
              {(folderStack.length > 0 || browseFolderId !== active.folder_id) && (
                <Button size="sm" variant="ghost" onClick={goUp}>
                  <ArrowLeft className="mr-1 h-4 w-4" />
                  Retour
                </Button>
              )}
              <FolderOpen className="h-4 w-4 text-muted-foreground" />
              <span className="truncate text-muted-foreground">
                {folderStack.length ? folderStack.map((f) => f.name).join(' / ') : 'Dossier racine'}
              </span>
            </div>

            <ScrollArea className="flex-1">
              <div className="divide-y divide-border">
                {files.map((file) => (
                  <div key={file.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/40">
                    {file.mimeType === FOLDER_MIME ? (
                      <FolderOpen className="h-4 w-4 flex-shrink-0 text-amber-500" />
                    ) : (
                      <FileText className="h-4 w-4 flex-shrink-0 text-blue-500" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{file.name}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {formatSize(file.size)}
                        {file.modifiedTime ? ` · ${new Date(file.modifiedTime).toLocaleString('fr-FR')}` : ''}
                      </div>
                    </div>
                    {file.mimeType === FOLDER_MIME ? (
                      <Button size="sm" variant="ghost" onClick={() => openFolder(file)}>
                        Ouvrir
                        <ChevronRight className="ml-1 h-4 w-4" />
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={downloadingId === file.id}
                        onClick={() => void downloadFile(file)}
                      >
                        {downloadingId === file.id ? (
                          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                        ) : (
                          <Download className="mr-1 h-4 w-4" />
                        )}
                        Télécharger
                      </Button>
                    )}
                  </div>
                ))}
                {!loadingFiles && files.length === 0 && (
                  <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                    Dossier vide ou accès refusé. Testez la connexion et vérifiez que le dossier est partagé avec le compte de service.
                  </div>
                )}
              </div>
              {nextPageToken && (
                <div className="p-4">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={loadingFiles}
                    onClick={() => browseFolderId && void loadFiles(browseFolderId, nextPageToken, true)}
                  >
                    Charger plus
                  </Button>
                </div>
              )}
            </ScrollArea>
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Sélectionnez ou créez un connecteur Google Drive.
          </div>
        )}
      </div>
    </div>
  );
}
