import React, { useDeferredValue, useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import DownloadPopup from './DownloadPopup';
import EmbeddingPipelinePopup from './EmbeddingPipelinePopup';
import QvdPipelinePopup, { launchQvdPipeline, isPipelineActive } from './QvdPipelinePopup';
import XlsxPipelinePopup, { launchXlsxPipeline, isXlsxPipelineActive } from './XlsxPipelinePopup';
import CTEGraphPanel from './CTEGraphPanel';
import {
    User,
    Bell,
    Lock,
    Shield,
    Eye,
    Globe,
    Database,
    Cloud,
    Cpu,
    CreditCard,
    ChevronRight,
    ChevronLeft,
    Search,
    ArrowLeft,
    Plus,
    RefreshCw,
    Download,
    CheckCircle2,
    AlertCircle,
    Trash2,
    Server,
    Link2,
    Settings as SettingsIcon,
    BookOpen,
    Edit3,
    Save,
    X,
    FileText,
    FileSpreadsheet,
    Tag,
    Sparkles,
    MessageSquare,
    Wand2,
    Send,
    Bot,
    Loader2,
    Zap,
    Network,
} from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { listSources, getParquetHeads, getParquetHead, getColumnEmbeddings, getColumnSchema, saveColumnSchema, suggestColumnSchema, getDataHealth, refreshSource, getDownloadStatus, getSqlSourceConfig, getSourceConfig, listMinioObjects, uploadMinioObject, deleteMinioObject, getOracleSettings, saveOracleSettings, uploadCsvSource, createSupabaseSource, upsertSqlTableConfig, deleteSqlTableConfig, deleteSourceConfig, patchSourceEnabled, saveColumnDefinitions, refineColumnDefinitions, launchCategoricalDistinct, getCategoricalDistinctStatus, listSkills, getSkill, updateSkill, createSkill, deleteSkill, listSkillDtos, listPromptTemplates, getPromptTemplate, updatePromptTemplate, improvePromptTemplate, aiGenerateSkill, listConnectorProviders, getConnectorSettings, saveConnectorSettings, getSqlTableHead, columnEmbeddingSearch, reembedColumnDefinitions } from '@/lib/parquet_api';
import type { DefinitionItem, RefineDefinitionChange } from '@/lib/parquet_api';
import type { ParquetHeadsResponse, SkillSummary, SkillDetail, SkillDto, PromptTemplate, PromptTemplateDetail, OracleConnectorSettingsResponse, ConnectorProvider, ConnectorSettingsResponse, MinioObjectsResponse, SkillChatMessage, SkillDraft } from '@/lib/parquet_api';

const SettingsSection = ({ title, description, children }) => (
    <div className="space-y-6">
        <div>
            <h3 className="settings-display text-xl text-[#2B2B2B]">{title}</h3>
            {description && <p className="text-sm text-[#6B6966] mt-1">{description}</p>}
        </div>
        <div className="grid gap-4">
            {children}
        </div>
    </div>
);

const SettingItem = ({ icon: Icon, title, description, badge, onClick }) => (
    <Card
        className="p-5 hover:bg-[#F8F7F4] transition-all cursor-pointer group border-[#E8E6E1] shadow-none hover:shadow-md hover:shadow-[#0D7377]/5 bg-white"
        onClick={onClick}
    >
        <div className="flex items-center justify-between">
            <div className="flex items-center gap-5">
                <div className="h-11 w-11 rounded-xl bg-[#0D7377]/10 flex items-center justify-center text-[#0D7377] group-hover:bg-[#0D7377] group-hover:text-white transition-all duration-300">
                    <Icon className="h-5 w-5" />
                </div>
                <div>
                    <h4 className="font-semibold text-sm text-[#2B2B2B]">{title}</h4>
                    <p className="text-sm text-[#6B6966]">{description}</p>
                </div>
            </div>
            <div className="flex items-center gap-3">
                {badge && (
                    <span className="px-3 py-1 rounded-full bg-[#0D7377]/10 text-[#0D7377] text-[10px] font-bold uppercase tracking-wider">
                        {badge}
                    </span>
                )}
                <ChevronRight className="h-5 w-5 text-[#A09E99] group-hover:text-[#0D7377] group-hover:translate-x-1 transition-all" />
            </div>
        </div>
    </Card>
);

const ConnectorCard = ({ name, icon: Icon, status, lastSync, description }) => (
    <Card className="p-6 border-[#E8E6E1] bg-white hover:bg-[#F8F7F4] transition-all group">
        <div className="flex flex-col h-full gap-4">
            <div className="flex items-start justify-between">
                <div className={cn(
                    "h-11 w-11 rounded-xl flex items-center justify-center transition-all",
                    status === 'connected' ? "bg-[#0D7377]/10 text-[#0D7377]" : "bg-[#F8F7F4] text-[#A09E99]"
                )}>
                    <Icon className="h-5 w-5" />
                </div>
                <div className={cn(
                    "px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wider",
                    status === 'connected' ? "bg-[#0D7377]/10 text-[#0D7377]" : "bg-[#E8725A]/10 text-[#E8725A]"
                )}>
                    {status === 'connected' ? 'Connecté' : 'Non configuré'}
                </div>
            </div>
            <div>
                <h4 className="font-semibold text-base text-[#2B2B2B]">{name}</h4>
                <p className="text-sm text-[#6B6966] mt-1 line-clamp-2">{description}</p>
            </div>
            <div className="mt-auto pt-4 flex items-center justify-between">
                <span className="text-[10px] text-[#A09E99] font-medium">
                    {lastSync ? `Sync local: ${lastSync}` : 'Jamais synchronisé'}
                </span>
                <Button variant="ghost" size="sm" className="h-8 rounded-lg text-xs font-semibold gap-2 text-[#0D7377] hover:bg-[#0D7377]/10">
                    {status === 'connected' ? (
                        <>
                            <RefreshCw className="h-3 w-3" />
                            Actualiser
                        </>
                    ) : 'Configurer'}
                </Button>
            </div>
        </div>
    </Card>
);

const formatCompactValue = (value) => new Intl.NumberFormat('fr-FR', {
    notation: 'compact',
    maximumFractionDigits: value && value < 1000 ? 0 : 1
}).format(value || 0);

const getSourceTypeLabel = (sourceType?: string) => {
    switch (sourceType) {
        case 'csv':
            return 'CSV';
        case 'supabase':
            return 'Supabase';
        case 'sqlserver':
            return 'SQL Server';
        case 'oracle':
            return 'Oracle';
        case 'minio':
            return 'MinIO';
        case 'parquet':
            return 'Parquet';
        default:
            return sourceType || 'Source';
    }
};

const getSourceToneClasses = (sourceType?: string) => {
    switch (sourceType) {
        case 'csv':
            return 'border-[#0D7377]/25 bg-[#0D7377]/10 text-[#0D7377]';
        case 'supabase':
            return 'border-[#0D7377]/25 bg-[#0D7377]/10 text-[#0D7377]';
        case 'sqlserver':
            return 'border-[#E8725A]/25 bg-[#E8725A]/10 text-[#E8725A]';
        case 'oracle':
            return 'border-[#9A3412]/25 bg-[#FDBA74]/20 text-[#9A3412]';
        case 'minio':
            return 'border-cyan-700/25 bg-cyan-50 text-cyan-800';
        default:
            return 'border-[#E8E6E1] bg-[#F8F7F4] text-[#4A4845]';
    }
};

const parseMaybeJson = (value, fallback = null) => {
    if (value == null) return fallback;
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
};

const formatBytes = (bytes?: number | null) => {
    const value = Number(bytes || 0);
    if (!Number.isFinite(value) || value <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    const amount = value / Math.pow(1024, index);
    return `${amount.toLocaleString('fr-FR', { maximumFractionDigits: amount >= 10 ? 0 : 1 })} ${units[index]}`;
};

const formatMinioDate = (value?: string | null) => {
    if (!value) return 'Non renseigné';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
};

type MinioObjectBrowserProps = {
    response?: MinioObjectsResponse | null;
    isLoading: boolean;
    error?: string | null;
    onRefresh: () => void;
    onUploadClick: () => void;
    onDelete: (objectKey: string) => void;
    isUploading?: boolean;
    deletingObjectKey?: string | null;
};

const MinioObjectBrowser = ({
    response,
    isLoading,
    error,
    onRefresh,
    onUploadClick,
    onDelete,
    isUploading = false,
    deletingObjectKey = null,
}: MinioObjectBrowserProps) => {
    const objects = response?.objects || [];

    return (
        <div className="space-y-5">
            <div className="overflow-hidden rounded-[28px] border border-[#E8E6E1] bg-white">
                <div className="flex flex-col gap-4 border-b border-[#E8E6E1] bg-[#F8F7F4] px-5 py-4 md:flex-row md:items-center md:justify-between">
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full border border-cyan-700/20 bg-cyan-50 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.24em] text-cyan-800">
                                MinIO
                            </span>
                            <span className="settings-mono max-w-full truncate text-[11px] text-[#6B6966]" title={response?.endpoint || ''}>
                                {response?.endpoint || 'Endpoint non chargé'}
                            </span>
                        </div>
                        <h5 className="settings-display mt-3 text-2xl font-semibold tracking-[-0.04em] text-[#2B2B2B]">
                            Objets stockés
                        </h5>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <Button
                            variant="ghost"
                            className="gap-1.5 rounded-xl border border-[#E8E6E1] bg-white px-3 py-1.5 text-[11px] font-medium text-[#2B2B2B] hover:bg-[#F8F7F4]"
                            onClick={onRefresh}
                            disabled={isLoading || isUploading}
                        >
                            <RefreshCw className={cn("h-3.5 w-3.5", isLoading && "animate-spin")} />
                            Rafraîchir
                        </Button>
                        <Button
                            className="gap-1.5 rounded-xl border border-cyan-700 bg-cyan-700 px-4 py-2.5 text-xs font-semibold text-white hover:bg-cyan-800"
                            onClick={onUploadClick}
                            disabled={isLoading || isUploading}
                        >
                            <Plus className={cn("h-3.5 w-3.5", isUploading && "animate-pulse")} />
                            {isUploading ? 'Ajout...' : 'Ajouter fichier'}
                        </Button>
                    </div>
                </div>

                <div className="grid gap-px bg-[#E8E6E1] md:grid-cols-3">
                    <div className="bg-white px-5 py-4">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">Bucket</p>
                        <p className="settings-mono mt-2 truncate text-[13px] font-semibold text-[#2B2B2B]" title={response?.bucket || ''}>
                            {response?.bucket || 'Non chargé'}
                        </p>
                    </div>
                    <div className="bg-white px-5 py-4">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">Objets</p>
                        <p className="settings-display mt-2 text-xl font-semibold text-[#2B2B2B]">{response?.count ?? objects.length}</p>
                    </div>
                    <div className="bg-white px-5 py-4">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">Taille totale</p>
                        <p className="settings-display mt-2 text-xl font-semibold text-[#2B2B2B]">{formatBytes(response?.total_size)}</p>
                    </div>
                </div>
            </div>

            {error && !objects.length && (
                <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {error}
                </div>
            )}

            {isLoading && !objects.length ? (
                <div className="space-y-3">
                    <div className="h-14 animate-pulse rounded-2xl bg-[#E8E6E1]/70" />
                    <div className="h-72 animate-pulse rounded-[28px] bg-[#E8E6E1]/60" />
                </div>
            ) : objects.length ? (
                <div className="overflow-hidden rounded-2xl border border-[#E8E6E1] bg-white">
                    <div className="max-h-[620px] overflow-auto">
                        <table className="w-full min-w-[860px] text-left text-sm">
                            <thead className="sticky top-0 z-10 border-b border-[#E8E6E1] bg-[#F8F7F4]">
                                <tr>
                                    <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">Clé objet</th>
                                    <th className="whitespace-nowrap px-4 py-3 text-right text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">Taille</th>
                                    <th className="whitespace-nowrap px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">Dernière modification</th>
                                    <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">ETag</th>
                                    <th className="px-4 py-3 text-right text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">Action</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-[#E8E6E1]/60">
                                {objects.map((object) => (
                                    <tr key={object.object_key} className="hover:bg-[#F8F7F4]">
                                        <td className="max-w-[420px] px-4 py-3">
                                            <div className="flex min-w-0 items-center gap-2">
                                                <Cloud className="h-3.5 w-3.5 shrink-0 text-cyan-700" />
                                                <span className="settings-mono text-[12px] font-semibold text-[#2B2B2B] [overflow-wrap:anywhere]" title={object.object_key}>
                                                    {object.object_key}
                                                </span>
                                            </div>
                                        </td>
                                        <td className="whitespace-nowrap px-4 py-3 text-right text-[12px] font-semibold tabular-nums text-[#4A4845]">
                                            {formatBytes(object.size)}
                                        </td>
                                        <td className="whitespace-nowrap px-4 py-3 text-[12px] text-[#6B6966]">
                                            {formatMinioDate(object.last_modified)}
                                        </td>
                                        <td className="max-w-[180px] truncate px-4 py-3 settings-mono text-[11px] text-[#A09E99]" title={object.etag || ''}>
                                            {object.etag || 'n/a'}
                                        </td>
                                        <td className="whitespace-nowrap px-4 py-3 text-right">
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="h-8 rounded-lg border border-red-200 bg-red-50 px-2.5 text-[11px] font-semibold text-red-700 hover:bg-red-100"
                                                onClick={() => onDelete(object.object_key)}
                                                disabled={deletingObjectKey === object.object_key || isUploading}
                                                title={`Supprimer ${object.object_key}`}
                                            >
                                                <Trash2 className={cn("mr-1.5 h-3.5 w-3.5", deletingObjectKey === object.object_key && "animate-pulse")} />
                                                {deletingObjectKey === object.object_key ? 'Suppression...' : 'Supprimer'}
                                            </Button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            ) : (
                <div className="rounded-[28px] border border-dashed border-[#E8E6E1] bg-white px-6 py-16 text-center">
                    <Cloud className="mx-auto h-12 w-12 text-[#A09E99]" />
                    <h5 className="mt-5 text-lg font-semibold text-[#2B2B2B]">Aucun objet MinIO trouvé</h5>
                    <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-[#A09E99]">
                        Le bucket sélectionné ne contient aucun objet visible avec ces identifiants.
                    </p>
                </div>
            )}
        </div>
    );
};

const DataMetricCard = ({ eyebrow, value, icon: Icon, accentClass = 'bg-[#0D7377] text-white' }) => (
    <div className="flex items-center gap-2.5">
        <div className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-lg", accentClass)}>
            <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0">
            <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">{eyebrow}</p>
            <p className="settings-display text-base font-semibold leading-tight text-[#2B2B2B]">{value}</p>
        </div>
    </div>
);

const DataInspectorCard = ({ eyebrow, title, body, mono = false }) => (
    <div className="border-b border-[#E8E6E1] py-4 last:border-b-0">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">{eyebrow}</p>
        <p className={cn(
            "mt-3 text-sm font-semibold leading-relaxed text-[#2B2B2B]",
            mono && "settings-mono text-[12px] font-medium"
        )}>
            {title}
        </p>
        {body && <p className="mt-2 text-xs leading-relaxed text-[#6B6966]">{body}</p>}
    </div>
);

const SettingsView = ({ onClose, embedded = false, initialTab = 'data' }) => {
    const [activeTab, setActiveTab] = useState(initialTab);
    const [searchQuery, setSearchQuery] = useState('');
    const [columnSearchQuery, setColumnSearchQuery] = useState('');
    const [dataSample, setDataSample] = useState([]);
    const [isLoadingData, setIsLoadingData] = useState(false);
    const [isLoadingEmbeddings, setIsLoadingEmbeddings] = useState(false);
    const [healthData, setHealthData] = useState(null);
    const [sourcesData, setSourcesData] = useState([]);
    const [allFiles, setAllFiles] = useState([]);
    const [headsResponse, setHeadsResponse] = useState<ParquetHeadsResponse | null>(null);
    const [dataFiles, setDataFiles] = useState<Array<{ file: string; source_id?: string | null; table_id?: string | null; rows: any[]; columns: string[]; total_rows?: number }>>([]);
    const [pageByFile, setPageByFile] = useState<Record<string, number>>({});
    const PAGE_SIZE = 50;

    // New states for selection and visualization
    const [selectedSource, setSelectedSource] = useState(null); // null = all sources
    const [selectedTable, setSelectedTable] = useState(null);
    const [selectedFile, setSelectedFile] = useState<string | null>(null); // specific file when source has multiple
    const [deleteSourceDialog, setDeleteSourceDialog] = useState<{
        open: boolean;
        sourceId: string | null;
        deleteFiles: boolean;
        isDeleting: boolean;
    }>({
        open: false,
        sourceId: null,
        deleteFiles: true,
        isDeleting: false,
    });
    const [dataViewMode, setDataViewMode] = useState('studio'); // 'studio', 'embeddings'
    const [embeddingsData, setEmbeddingsData] = useState(null);
    const [embeddingPreviewHead, setEmbeddingPreviewHead] = useState<any | null>(null);
    const [isColumnsDialogOpen, setIsColumnsDialogOpen] = useState(false);
    const [isColumnPickerOpen, setIsColumnPickerOpen] = useState(false);
    const [isSelectionDetailsOpen, setIsSelectionDetailsOpen] = useState(false);
    const [columnMetadataDrafts, setColumnMetadataDrafts] = useState({});
    const [isLoadingColumnSchema, setIsLoadingColumnSchema] = useState(false);
    const [schemaColumnsData, setSchemaColumnsData] = useState<Record<string, { columns: import('@/lib/parquet_api').ColumnSchemaItem[] }>>({});
    const [isSavingColumnSchema, setIsSavingColumnSchema] = useState(false);
    const [isSuggestingColumnSchema, setIsSuggestingColumnSchema] = useState(false);
    const [distinctJobStatus, setDistinctJobStatus] = useState<string | null>(null);
    const [isSqlTablesDialogOpen, setIsSqlTablesDialogOpen] = useState(false);
    const [isSupabaseDialogOpen, setIsSupabaseDialogOpen] = useState(false);
    const [isLoadingSqlTables, setIsLoadingSqlTables] = useState(false);
    const [sqlSourceConfig, setSqlSourceConfig] = useState(null);
    const [selectedSourceConfig, setSelectedSourceConfig] = useState(null);
    const [isSavingSqlTable, setIsSavingSqlTable] = useState(false);
    const [editingSqlTableId, setEditingSqlTableId] = useState<string | null>(null);
    const [isUploadingCsv, setIsUploadingCsv] = useState(false);
    const [isUploadingQvd, setIsUploadingQvd] = useState(false);
    const [qvdPipelineJobId, setQvdPipelineJobId] = useState<string | null>(null);
    const [qvdPipelineStatus, setQvdPipelineStatus] = useState<string | null>(null);
    const [isUploadingXlsx, setIsUploadingXlsx] = useState(false);
    const [xlsxPipelineStatus, setXlsxPipelineStatus] = useState<string | null>(null);
    const [showXlsxPopup, setShowXlsxPopup] = useState(false);
    const [isCreatingSupabase, setIsCreatingSupabase] = useState(false);
    const [showDownloadPopup, setShowDownloadPopup] = useState(false);
    const [showEmbeddingPopup, setShowEmbeddingPopup] = useState(false);
    const [showQvdPopup, setShowQvdPopup] = useState(false);
    const [togglingSourceId, setTogglingSourceId] = useState<string | null>(null);
    const [oracleSettings, setOracleSettings] = useState<OracleConnectorSettingsResponse | null>(null);
    const [isLoadingOracleSettings, setIsLoadingOracleSettings] = useState(false);
    const [isSavingOracleSettings, setIsSavingOracleSettings] = useState(false);
    const [oracleForm, setOracleForm] = useState({
        user: '',
        password: '',
        host: '',
        port: '1521',
        service_name: '',
        enabled: true,
        description: '',
        source_id: 'oracle_env',
    });

    const [connectorProviders, setConnectorProviders] = useState<ConnectorProvider[]>([]);
    const [connectorStates, setConnectorStates] = useState<Record<string, ConnectorSettingsResponse>>({});
    const [connectorForms, setConnectorForms] = useState<Record<string, Record<string, string>>>({});
    const [connectorMeta, setConnectorMeta] = useState<Record<string, { enabled: boolean; description: string; source_id: string }>>({});
    const [activeConnector, setActiveConnector] = useState<string>('oracle');
    const [isLoadingConnectors, setIsLoadingConnectors] = useState(false);
    const [savingConnector, setSavingConnector] = useState<string | null>(null);
    const [minioObjectsBySource, setMinioObjectsBySource] = useState<Record<string, MinioObjectsResponse>>({});
    const [isLoadingMinioObjects, setIsLoadingMinioObjects] = useState(false);
    const [minioObjectError, setMinioObjectError] = useState<string | null>(null);
    const [uploadingMinioSource, setUploadingMinioSource] = useState<string | null>(null);
    const [deletingMinioObjectKey, setDeletingMinioObjectKey] = useState<string | null>(null);
    const [supabaseForm, setSupabaseForm] = useState({
        source_id: '',
        host: '',
        port: '5432',
        database: '',
        username: '',
        password: '',
        db_schema: 'public',
        description: '',
    });
    const [sqlTableForm, setSqlTableForm] = useState({
        table_id: '',
        table_name: '',
        query: '',
        columns_class: '',
        incremental_column: '',
        enabled: true,
        description: '',
        cache_file: '',
        embeddings_file: '',
        foreign_keys_json: '[]',
    });

    // Skills state
    const [skillsList, setSkillsList] = useState<SkillSummary[]>([]);
    const [isLoadingSkills, setIsLoadingSkills] = useState(false);
    const [editingSkill, setEditingSkill] = useState<SkillDetail | null>(null);
    const [isLoadingSkillDetail, setIsLoadingSkillDetail] = useState(false);
    const [isSavingSkill, setIsSavingSkill] = useState(false);
    const [isCreatingSkill, setIsCreatingSkill] = useState(false);
    // newSkillForm.dtos replaces the old comma-separated `aliases` text field.
    // We persist the selected DTO ``directory_name`` values; on submit they
    // are forwarded to the backend as ``aliases`` so the skill router can
    // still discover the skill by data-source keyword.
    const [newSkillForm, setNewSkillForm] = useState<{ directory_name: string; name: string; description: string; content_body: string; dtos: string[] }>({ directory_name: '', name: '', description: '', content_body: '', dtos: [] });
    const [skillDtosList, setSkillDtosList] = useState<SkillDto[]>([]);
    const [isLoadingSkillDtos, setIsLoadingSkillDtos] = useState(false);
    const [dtoFilter, setDtoFilter] = useState('');

    // AI skill chat state (creation flow)
    const [isAiSkillOpen, setIsAiSkillOpen] = useState(false);
    const [aiSkillMessages, setAiSkillMessages] = useState<SkillChatMessage[]>([]);
    const [aiSkillInput, setAiSkillInput] = useState('');
    const [isAiSkillLoading, setIsAiSkillLoading] = useState(false);
    const [aiSkillDraft, setAiSkillDraft] = useState<SkillDraft | null>(null);
    const [isAiSkillCreating, setIsAiSkillCreating] = useState(false);
    const aiSkillInputRef = useRef<HTMLTextAreaElement>(null);
    const aiChatEndRef = useRef<HTMLDivElement>(null);

    // AI skill chat state (edit flow — scoped to the currently open skill).
    // Kept separate from the creation flow so opening the editor never wipes
    // an in-progress "Créer avec IA" session, and vice versa.
    const [aiEditMessages, setAiEditMessages] = useState<SkillChatMessage[]>([]);
    const [aiEditInput, setAiEditInput] = useState('');
    const [isAiEditLoading, setIsAiEditLoading] = useState(false);
    const [aiEditDraft, setAiEditDraft] = useState<SkillDraft | null>(null);
    const aiEditInputRef = useRef<HTMLTextAreaElement>(null);
    const aiEditChatEndRef = useRef<HTMLDivElement>(null);

    // Prompt templates state
    const [templatesList, setTemplatesList] = useState<PromptTemplate[]>([]);
    const [templateCategories, setTemplateCategories] = useState<string[]>([]);
    const [isLoadingTemplates, setIsLoadingTemplates] = useState(false);
    const [selectedTemplateCategory, setSelectedTemplateCategory] = useState<string | null>(null);
    const [editingTemplate, setEditingTemplate] = useState<PromptTemplateDetail | null>(null);
    const [isLoadingTemplateDetail, setIsLoadingTemplateDetail] = useState(false);
    const [isSavingTemplate, setIsSavingTemplate] = useState(false);
    const [aiInstruction, setAiInstruction] = useState('');
    const [isImprovingPrompt, setIsImprovingPrompt] = useState(false);
    
    const [selectedWorkbenchColumn, setSelectedWorkbenchColumn] = useState<string | null>(null);
    /** Studio table: which column detail popup is open (null = closed) */
    const [columnDetailColumn, setColumnDetailColumn] = useState<string | null>(null);
    const [columnDetailTab, setColumnDetailTab] = useState<'samples' | 'embeddings' | 'search'>('samples');
    /** Per-distinct-value definitions draft for the embeddings tab CRUD */
    const [defDrafts, setDefDrafts] = useState<Record<string, string[]>>({});
    const [defExpanded, setDefExpanded] = useState<Record<string, boolean>>({});
    const [defNewInput, setDefNewInput] = useState<Record<string, string>>({});
    const [defEditIdx, setDefEditIdx] = useState<Record<string, number | null>>({});
    const [defEditText, setDefEditText] = useState('');

    const [isSavingDefs, setIsSavingDefs] = useState(false);
    const [isLoadingDefs, setIsLoadingDefs] = useState(false);
    const [defRefineText, setDefRefineText] = useState('');
    const [defRefineChanges, setDefRefineChanges] = useState<RefineDefinitionChange[]>([]);
    const [defRefineAccepted, setDefRefineAccepted] = useState<Record<string, boolean>>({});
    const [isRefiningDefs, setIsRefiningDefs] = useState(false);
    const [colDetailDistinctStatus, setColDetailDistinctStatus] = useState<string | null>(null);

    // Semantic search within column detail
    const [embSearchQuery, setEmbSearchQuery] = useState('');
    const [embSearchLoading, setEmbSearchLoading] = useState(false);
    const [embSearchResults, setEmbSearchResults] = useState<any[] | null>(null);
    const [reembedLoading, setReembedLoading] = useState(false);
    const [reembedResult, setReembedResult] = useState<{ count: number; error?: string } | null>(null);

    // Request ID to prevent race conditions
    const fetchIdRef = React.useRef(0);
    const csvFileInputRef = React.useRef<HTMLInputElement | null>(null);
    const qvdFileInputRef = React.useRef<HTMLInputElement | null>(null);
    const xlsxFileInputRef = React.useRef<HTMLInputElement | null>(null);
    const minioFileInputRef = React.useRef<HTMLInputElement | null>(null);
    const deferredSearchQuery = useDeferredValue(searchQuery);
    const deferredColumnSearchQuery = useDeferredValue(columnSearchQuery);

    const fetchSchema = async () => {
        const [healthResult, sourcesResult, headsResult] = await Promise.allSettled([
                getDataHealth(),
                listSources(),
            getParquetHeads(100, false),
        ]);

        if (healthResult.status === 'fulfilled') {
            setHealthData(healthResult.value);
        } else {
            console.error('Error fetching health:', healthResult.reason);
        }

        if (sourcesResult.status === 'fulfilled') {
            setSourcesData(sourcesResult.value);
        } else {
            console.error('Error fetching sources:', sourcesResult.reason);
        }

        if (headsResult.status === 'fulfilled') {
            const headsResp = headsResult.value;
            setAllFiles(headsResp.files || []);
            setHeadsResponse(headsResp);
            setDataFiles((headsResp.files || []).map((f: any) => ({
                file: f.file,
                source_id: f.source_id,
                table_id: f.table_id,
                rows: f.rows || [],
                columns: f.columns || [],
                total_rows: f.total_rows,
            })));
        } else {
            console.error('Error fetching heads:', headsResult.reason);
        }
    };

    const fetchData = async (forSource, forTable) => {
        const thisRequestId = ++fetchIdRef.current;

        setDataSample([]);
        setDataFiles([]);
        setPageByFile({});
        setIsLoadingData(true);

        const requestedSourceInfo = forSource
            ? sourcesData.find((source: any) => source.source_id === forSource)
            : null;
        const requestedSourceConfig = selectedSourceConfig?.source_id === forSource ? selectedSourceConfig : null;
        const requestedSourceIsMinio = (requestedSourceInfo?.source_type || requestedSourceConfig?.type) === 'minio';
        if (forSource && !forTable && requestedSourceIsMinio) {
            setEmbeddingsData(null);
            setEmbeddingPreviewHead(null);
            await loadMinioObjects(forSource);
            if (fetchIdRef.current === thisRequestId) {
                setIsLoadingData(false);
            }
            return;
        }

        if (!forSource) {
            setEmbeddingsData(null);
            setEmbeddingPreviewHead(null);
        } else if (dataViewMode === 'samples') {
            setEmbeddingPreviewHead(null);
        }

        // Fetch embeddings for both studio (needs counts) and embeddings view
        if (forSource && (dataViewMode === 'studio' || dataViewMode === 'embeddings')) {
            setIsLoadingEmbeddings(true);
            Promise.allSettled([
                getColumnEmbeddings(forSource, forTable || undefined),
                getParquetHead({
                    source_id: forSource,
                    table_id: forTable || undefined,
                    cache_type: 'embeddings',
                    limit: 500
                })
            ]).then(([embResult, embHeadResult]) => {
                if (fetchIdRef.current !== thisRequestId) return;
                setEmbeddingsData(embResult.status === 'fulfilled' ? embResult.value : null);
                setEmbeddingPreviewHead(embHeadResult.status === 'fulfilled' ? embHeadResult.value : null);
                setIsLoadingEmbeddings(false);
            });
        }

        try {
            let files = [];
            if (forSource && forTable) {
                let res;
                try {
                    res = await getParquetHead({
                    source_id: forSource,
                    table_id: forTable,
                    cache_type: dataViewMode === 'embeddings' ? 'embeddings' : 'data',
                        limit: PAGE_SIZE,
                        offset: 0
                    });
                } catch (headErr: any) {
                    if (headErr?.message?.includes('404')) {
                        res = await getSqlTableHead(forSource, forTable, PAGE_SIZE);
                    } else {
                        throw headErr;
                    }
                }
                if (fetchIdRef.current !== thisRequestId) return;
                files = [res];
                setHeadsResponse({ cache_dir: '', limit: PAGE_SIZE, include_embeddings: dataViewMode === 'embeddings', enabled_only: true, count: 1, files: [res] });
                setDataFiles([{ file: res.file, source_id: res.source_id, table_id: res.table_id, rows: res.rows || [], columns: res.columns || [], total_rows: res.total_rows }]);
            } else if (forSource) {
                const headsResp = await getParquetHeads(PAGE_SIZE, dataViewMode === 'embeddings');
                if (fetchIdRef.current !== thisRequestId) return;
                setHeadsResponse(headsResp);
                files = (headsResp.files || []).filter(f => f.source_id === forSource);
            } else {
                const headsResp = await getParquetHeads(PAGE_SIZE, dataViewMode === 'embeddings');
                if (fetchIdRef.current !== thisRequestId) return;
                setHeadsResponse(headsResp);
                files = headsResp.files || [];
            }

            if (fetchIdRef.current !== thisRequestId) return;

            const fileItems = files.map((f: any) => ({
                file: f.file,
                source_id: f.source_id,
                table_id: f.table_id,
                rows: f.rows || [],
                columns: f.columns || [],
                total_rows: f.total_rows,
            }));
            setDataFiles(fileItems);
            const rows = files.flatMap(file =>
                (file.rows || []).map((row, idx) => ({
                    id: `${file.source_id}-${file.table_id || 'main'}-${idx}`,
                    source_id: file.source_id,
                    table_id: file.table_id,
                    source: file.source_id || file.file,
                    type: file.cache_type || 'data',
                    preview: JSON.stringify(row),
                    raw: row,
                    columns: file.columns
                }))
            );
            setDataSample(rows.slice(0, 100));
        } catch (error) {
            if (fetchIdRef.current === thisRequestId) {
                console.error('Error fetching data from API:', error);
                setDataSample([]);
                setDataFiles([]);
            }
        } finally {
            if (fetchIdRef.current === thisRequestId) {
                setIsLoadingData(false);
            }
        }
    };

    // Fetch schema once when tab becomes active; fetch skills when skills tab active
    useEffect(() => {
        if (activeTab === 'data') {
            fetchSchema();
            fetchData(selectedSource, selectedTable);
        }
        if (activeTab === 'connectors') {
            loadOracleSettings();
            loadAllConnectors();
        }
        if (activeTab === 'skills') {
            fetchSkillsList();
            fetchSkillDtosList();
        }
        if (activeTab === 'prompts') {
            fetchTemplatesList();
        }
    }, [activeTab]);

    // Fetch data when selection changes
    useEffect(() => {
        if (activeTab === 'data') {
            fetchData(selectedSource, selectedTable);
        }
    }, [selectedSource, selectedTable, dataViewMode]);

    useEffect(() => {
        if (!columnDetailColumn || !selectedSource) return;
        const needsEmbData = embeddingsData == null;
        const needsPreview = embeddingPreviewHead == null;
        if (!needsEmbData && !needsPreview) return;
        let cancelled = false;
        if (needsEmbData) setIsLoadingEmbeddings(true);
        const promises: [Promise<any>, Promise<any>] = [
            needsEmbData
                ? getColumnEmbeddings(selectedSource, selectedTable || undefined)
                : Promise.resolve(embeddingsData),
            needsPreview
                ? getParquetHead({
                    source_id: selectedSource,
                    table_id: selectedTable || undefined,
                    cache_type: 'embeddings',
                    limit: 500,
                })
                : Promise.resolve(embeddingPreviewHead),
        ];
        Promise.allSettled(promises).then(([embResult, embHeadResult]) => {
            if (cancelled) return;
            if (needsEmbData) setEmbeddingsData(embResult.status === 'fulfilled' ? embResult.value : null);
            if (needsPreview) setEmbeddingPreviewHead(embHeadResult.status === 'fulfilled' ? embHeadResult.value : null);
            setIsLoadingEmbeddings(false);
        });
        return () => { cancelled = true; };
    }, [columnDetailColumn, selectedSource, selectedTable]);

    const loadMinioObjects = async (sourceId: string) => {
        if (!sourceId) return;
        setIsLoadingMinioObjects(true);
        setMinioObjectError(null);
        try {
            const response = await listMinioObjects(sourceId);
            setMinioObjectsBySource(prev => ({ ...prev, [sourceId]: response }));
        } catch (error) {
            console.error(`Error loading MinIO objects for ${sourceId}:`, error);
            setMinioObjectError(error instanceof Error ? error.message : String(error));
        } finally {
            setIsLoadingMinioObjects(false);
        }
    };

    const handleRefreshSource = async (sourceId: string) => {
        if (!sourceId) return;
        const srcInfo = sourcesData.find((s: any) => s.source_id === sourceId);
        if (srcInfo?.source_type === 'minio') {
            await loadMinioObjects(sourceId);
            return;
        }
        if (srcInfo?.download_in_progress) {
            console.warn(`Cannot refresh ${sourceId} — download in progress`);
            return;
        }
        try {
            const firstResult = await refreshSource(sourceId);
            if ('needs_confirmation' in firstResult && (firstResult as any).needs_confirmation) {
                const confirmed = window.confirm(
                    (firstResult as any).message ||
                    `Les fichiers parquet existants pour "${sourceId}" seront écrasés. Confirmez-vous ?`
                );
                if (!confirmed) return;
                const confirmedResult = await refreshSource(sourceId, false, true, undefined, true);
                if ((confirmedResult as any)?.success !== false) {
                    fetchData(selectedSource, selectedTable);
                } else {
                    console.warn(`Refresh skipped: ${(confirmedResult as any).message}`);
                }
            } else if ((firstResult as any)?.success !== false) {
                fetchData(selectedSource, selectedTable);
            } else {
                console.warn(`Refresh skipped: ${(firstResult as any).message}`);
            }
        } catch (error) {
            console.error(`Error refreshing ${sourceId}:`, error);
        }
    };

    const handleDownloadTable = () => {
        if (!selectedSource || !selectedTable) return;
        setShowDownloadPopup(true);
    };

    const fetchFilePage = async (fileName: string, pageIndex: number) => {
        const offset = pageIndex * PAGE_SIZE;
        setIsLoadingData(true);
        try {
            const res = await getParquetHead({ file: fileName, limit: PAGE_SIZE, offset });
            setDataFiles(prev => prev.map(f => f.file === fileName
                ? { ...f, rows: res.rows || [], total_rows: res.total_rows }
                : f));
            setPageByFile(prev => ({ ...prev, [fileName]: pageIndex }));
        } catch (error) {
            console.error('Error fetching file page:', error);
        } finally {
            setIsLoadingData(false);
        }
    };

    const openCsvPicker = () => {
        csvFileInputRef.current?.click();
    };

    const openQvdPicker = () => {
        qvdFileInputRef.current?.click();
    };

    const openXlsxPicker = () => {
        xlsxFileInputRef.current?.click();
    };

    const openMinioPicker = () => {
        minioFileInputRef.current?.click();
    };

    const resetSupabaseForm = () => {
        setSupabaseForm({
            source_id: '',
            host: '',
            port: '5432',
            database: '',
            username: '',
            password: '',
            db_schema: 'public',
            description: '',
        });
    };

    const loadOracleSettings = async () => {
        setIsLoadingOracleSettings(true);
        try {
            const settings = await getOracleSettings();
            setOracleSettings(settings);
            setOracleForm({
                user: settings.values.user || '',
                password: settings.values.password || '',
                host: settings.values.host || '',
                port: settings.values.port || '1521',
                service_name: settings.values.service_name || '',
                enabled: typeof settings.enabled === 'boolean' ? settings.enabled : true,
                description: settings.description || '',
                source_id: settings.source_id || 'oracle_env',
            });
        } catch (error) {
            console.error('Error loading Oracle settings:', error);
            setOracleSettings(null);
        } finally {
            setIsLoadingOracleSettings(false);
        }
    };

    const handleSaveOracleSettings = async () => {
        const numericPort = Number(oracleForm.port || 1521);
        if (!oracleForm.user.trim() || !oracleForm.password || !oracleForm.host.trim() || !oracleForm.service_name.trim()) {
            alert('Renseignez ORACLE_USER, ORACLE_PASSWORD, ORACLE_HOST et ORACLE_SERVICE_NAME.');
            return;
        }
        if (!Number.isFinite(numericPort)) {
            alert('ORACLE_PORT est invalide.');
            return;
        }

        setIsSavingOracleSettings(true);
        try {
            const result = await saveOracleSettings({
                user: oracleForm.user.trim(),
                password: oracleForm.password,
                host: oracleForm.host.trim(),
                port: numericPort,
                service_name: oracleForm.service_name.trim(),
                enabled: Boolean(oracleForm.enabled),
                description: oracleForm.description.trim(),
                source_id: oracleForm.source_id.trim() || undefined,
            });
            await Promise.all([
                loadOracleSettings(),
                fetchSchema(),
            ]);
            setSelectedSource(result.source_id || oracleForm.source_id);
            alert(`Configuration Oracle enregistrée pour ${result.source_id || oracleForm.source_id}.`);
        } catch (error) {
            console.error('Error saving Oracle settings:', error);
            alert("Erreur lors de la sauvegarde de la configuration Oracle.");
        } finally {
            setIsSavingOracleSettings(false);
        }
    };

    const loadAllConnectors = async () => {
        setIsLoadingConnectors(true);
        try {
            const providers = await listConnectorProviders();
            setConnectorProviders(providers);
            const states: Record<string, ConnectorSettingsResponse> = {};
            const forms: Record<string, Record<string, string>> = {};
            const metas: Record<string, { enabled: boolean; description: string; source_id: string }> = {};
            await Promise.all(providers.map(async (prov) => {
                try {
                    const settings = await getConnectorSettings(prov.id);
                    states[prov.id] = settings;
                    const vals: Record<string, string> = {};
                    for (const f of prov.fields) {
                        vals[f.key] = settings.values[f.key] || '';
                    }
                    forms[prov.id] = vals;
                    metas[prov.id] = {
                        enabled: settings.enabled,
                        description: '',
                        source_id: settings.source_id,
                    };
                } catch {
                    const vals: Record<string, string> = {};
                    for (const f of prov.fields) vals[f.key] = '';
                    forms[prov.id] = vals;
                    metas[prov.id] = { enabled: true, description: '', source_id: prov.default_source_id };
                }
            }));
            setConnectorStates(states);
            setConnectorForms(forms);
            setConnectorMeta(metas);
        } catch (error) {
            console.error('Error loading connector providers:', error);
        } finally {
            setIsLoadingConnectors(false);
        }
    };

    const handleSaveConnector = async (providerId: string) => {
        const form = connectorForms[providerId];
        const meta = connectorMeta[providerId];
        if (!form || !meta) return;

        setSavingConnector(providerId);
        try {
            const result = await saveConnectorSettings(providerId, {
                values: form,
                enabled: meta.enabled,
                description: meta.description,
                source_id: meta.source_id || undefined,
            });
            await loadAllConnectors();
            await fetchSchema();
            alert(`Configuration ${connectorProviders.find(p => p.id === providerId)?.label || providerId} enregistrée.`);
        } catch (error) {
            console.error(`Error saving ${providerId} settings:`, error);
            alert(`Erreur lors de la sauvegarde de la configuration ${providerId}.`);
        } finally {
            setSavingConnector(null);
        }
    };

    const handleCsvFilePicked = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;

        setIsUploadingCsv(true);
        try {
            const result = await uploadCsvSource(file);
            await fetchSchema();
            setSelectedSource(result.source_id);
            setSelectedTable(null);
            await fetchData(result.source_id, null);
            alert(`Source CSV ajoutée: ${result.source_id}`);
        } catch (error) {
            console.error('Error uploading CSV source:', error);
            alert("Erreur lors de l'ajout du fichier CSV.");
        } finally {
            setIsUploadingCsv(false);
        }
    };

    const handleQvdFilePicked = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;

        setIsUploadingQvd(true);
        setQvdPipelineStatus('uploading');
        launchQvdPipeline(file);
        setShowQvdPopup(true);
    };

    const handleXlsxFilesPicked = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const fileList = event.target.files;
        const files = fileList ? Array.from(fileList) : [];
        event.target.value = '';
        if (!files.length) return;

        setIsUploadingXlsx(true);
        setXlsxPipelineStatus('uploading');
        launchXlsxPipeline(files);
        setShowXlsxPopup(true);
    };

    const handleMinioFilePicked = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file || !selectedSource) return;

        const defaultKey = file.name;
        const objectKey = window.prompt('Clé objet MinIO', defaultKey);
        if (objectKey == null) return;
        const normalizedKey = objectKey.trim().replace(/^\/+/, '');
        if (!normalizedKey) {
            alert('La clé objet MinIO est obligatoire.');
            return;
        }

        const existingObjects = minioObjectsBySource[selectedSource]?.objects || [];
        const alreadyExists = existingObjects.some(obj => obj.object_key === normalizedKey);
        if (alreadyExists && !window.confirm(`L'objet "${normalizedKey}" existe déjà. Voulez-vous le remplacer ?`)) {
            return;
        }

        setUploadingMinioSource(selectedSource);
        setMinioObjectError(null);
        try {
            await uploadMinioObject(selectedSource, file, normalizedKey);
            await loadMinioObjects(selectedSource);
        } catch (error) {
            console.error('Error uploading MinIO object:', error);
            const message = error instanceof Error ? error.message : String(error);
            setMinioObjectError(message);
            alert(`Erreur lors de l'ajout du fichier MinIO: ${message}`);
        } finally {
            setUploadingMinioSource(null);
        }
    };

    const handleDeleteMinioObject = async (objectKey: string) => {
        if (!selectedSource || !objectKey) return;
        const confirmed = window.confirm(`Supprimer définitivement "${objectKey}" du bucket MinIO ?`);
        if (!confirmed) return;

        setDeletingMinioObjectKey(objectKey);
        setMinioObjectError(null);
        try {
            await deleteMinioObject(selectedSource, objectKey);
            await loadMinioObjects(selectedSource);
        } catch (error) {
            console.error('Error deleting MinIO object:', error);
            const message = error instanceof Error ? error.message : String(error);
            setMinioObjectError(message);
            alert(`Erreur lors de la suppression MinIO: ${message}`);
        } finally {
            setDeletingMinioObjectKey(null);
        }
    };

    const handleCreateSupabaseSource = async () => {
        setIsCreatingSupabase(true);
        try {
            const result = await createSupabaseSource({
                source_id: supabaseForm.source_id,
                host: supabaseForm.host,
                port: Number(supabaseForm.port || 5432),
                database: supabaseForm.database,
                username: supabaseForm.username,
                password: supabaseForm.password,
                db_schema: supabaseForm.db_schema || 'public',
                description: supabaseForm.description,
                enabled: true,
                refresh_policy: 'manual',
            });
            await fetchSchema();
            setSelectedSource(result.source_id);
            setSelectedTable(null);
            setIsSupabaseDialogOpen(false);
            resetSupabaseForm();
            alert(`Source Supabase ajoutée: ${result.source_id}`);
        } catch (error) {
            console.error('Error creating Supabase source:', error);
            alert("Erreur lors de l'ajout de la source Supabase.");
        } finally {
            setIsCreatingSupabase(false);
        }
    };

    useEffect(() => {
        if (!selectedSource) {
            setSelectedSourceConfig(null);
            return;
        }

        let cancelled = false;
        getSourceConfig(selectedSource)
            .then((config) => {
                if (!cancelled) setSelectedSourceConfig(config);
            })
            .catch((error) => {
                console.error('Error loading source config:', error);
                if (!cancelled) setSelectedSourceConfig(null);
            });

        return () => {
            cancelled = true;
        };
    }, [selectedSource]);

    const selectedSourceInfo = sourcesData.find(s => s.source_id === selectedSource) || null;
    const isSelectedSourceSql = ['sqlserver', 'supabase', 'oracle'].includes(selectedSourceInfo?.source_type || '');
    const isSelectedSourceMinio = (selectedSourceInfo?.source_type || selectedSourceConfig?.type) === 'minio';
    const selectedMinioObjects = selectedSource ? (minioObjectsBySource[selectedSource]?.objects || []) : [];
    const selectedMinioResponse = selectedSource ? minioObjectsBySource[selectedSource] : null;
    const canDeleteSelectedNonSqlSource = Boolean(selectedSource && !selectedTable && !isSelectedSourceSql);

    useEffect(() => {
        if (activeTab !== 'data' || !selectedSource || !isSelectedSourceMinio) return;
        if (minioObjectsBySource[selectedSource]) return;
        void loadMinioObjects(selectedSource);
    }, [activeTab, selectedSource, isSelectedSourceMinio, minioObjectsBySource]);

    const selectedTableFile = allFiles.find(file =>
        file.source_id === selectedSource && file.table_id === selectedTable
    );

    const selectedTableConfig = selectedTable
        ? selectedSourceConfig?.tables?.find(tbl => tbl.table_id === selectedTable) || null
        : null;
    const canEditColumns = Boolean(selectedSource) && !isSelectedSourceMinio;

    const selectedTableColumns = (() => {
        if (!selectedSource) return [];
        const schemaKey = `${selectedSource}::${selectedTable || '__source__'}`;
        const schemaCols = schemaColumnsData[schemaKey]?.columns;
        if (schemaCols?.length) return schemaCols.map(c => c.column_name);
        const rowMatch = dataSample.find(row => {
            if (row.source_id !== selectedSource || !Array.isArray(row.columns)) return false;
            if (selectedTable) return row.table_id === selectedTable;
            return !row.table_id;
        });
        if (rowMatch?.columns?.length) return rowMatch.columns;
        if (selectedTable && selectedTableFile?.columns?.length) return selectedTableFile.columns;
        return [];
    })();

    const selectedTableRows = dataSample
        .filter(row => row.source_id === selectedSource && (selectedTable ? row.table_id === selectedTable : !row.table_id))
        .map(row => row.raw);

    const selectedTableKey = selectedSource ? `${selectedSource}::${selectedTable || '__source__'}` : null;

    const inferColumnType = (columnName) => {
        const values = selectedTableRows
            .map(row => row?.[columnName])
            .filter(value => value !== null && value !== undefined);
        if (!values.length) return 'unknown';
        const nonEmpty = values.find(v => `${v}`.trim() !== '');
        if (nonEmpty === undefined) return 'string';
        if (typeof nonEmpty === 'number') return Number.isInteger(nonEmpty) ? 'integer' : 'number';
        if (typeof nonEmpty === 'boolean') return 'boolean';
        const asString = String(nonEmpty);
        if (!Number.isNaN(Number(asString)) && asString.trim() !== '') return 'number';
        if (!Number.isNaN(Date.parse(asString))) return 'date/datetime';
        return 'string';
    };

    const getColumnPreviewValues = (columnName: string) => {
        const values = selectedTableRows
            .map(row => row?.[columnName])
            .filter(value => value !== null && value !== undefined && `${value}`.trim() !== '');
        if (values.length) return [...new Set(values.map(v => String(v)))].slice(0, 6);
        const schemaKey = `${selectedSource}::${selectedTable || '__source__'}`;
        const schemaCol = schemaColumnsData[schemaKey]?.columns?.find(c => c.column_name === columnName);
        if (schemaCol?.sample_values?.length) return schemaCol.sample_values.slice(0, 6);
        return [];
    };

    const ensureColumnDrafts = () => {
        if (!selectedTableKey || !selectedTableColumns.length) return;
        setColumnMetadataDrafts(prev => {
            const existing = prev[selectedTableKey] || {};
            const initial = {};
            selectedTableColumns.forEach(col => {
                initial[col] = {
                    description: '',
                    is_categorical: false,
                    type: inferColumnType(col),
                    ...(existing[col] || {})
                };
            });
            return { ...prev, [selectedTableKey]: { ...initial, ...existing } };
        });
    };

    const loadDtoColumnSchema = async (sourceId, tableId) => {
        if (!sourceId) return;
        setIsLoadingColumnSchema(true);
        try {
            const schema = await getColumnSchema(sourceId, tableId);
            const tableKey = `${sourceId}::${tableId || '__source__'}`;
            const dtoColumns = Array.isArray(schema?.columns) ? schema.columns : [];
            if (!dtoColumns.length) return;

            setSchemaColumnsData(prev => ({ ...prev, [tableKey]: { columns: dtoColumns } }));

            setColumnMetadataDrafts(prev => {
                const tableDraft = prev[tableKey] || {};
                const nextTableDraft = { ...tableDraft };
                dtoColumns.forEach(col => {
                    const existing = tableDraft[col.column_name] || {};
                    nextTableDraft[col.column_name] = {
                        description: col.description || existing.description || '',
                        type: col.type || existing.type || inferColumnType(col.column_name),
                        is_categorical: typeof col.is_categorical === 'boolean'
                            ? col.is_categorical
                            : Boolean(existing.is_categorical)
                    };
                });
                return { ...prev, [tableKey]: nextTableDraft };
            });
        } catch (error) {
            console.warn('Failed to load DTO column schema metadata:', error);
        } finally {
            setIsLoadingColumnSchema(false);
        }
    };

    useEffect(() => {
        if (activeTab !== 'data' || !canEditColumns) return;
        ensureColumnDrafts();
        loadDtoColumnSchema(selectedSource, selectedTable || undefined);
    }, [activeTab, canEditColumns, selectedSource, selectedTable]);

    useEffect(() => {
        if (!isColumnsDialogOpen && dataViewMode !== 'studio') {
            setColumnSearchQuery('');
        }
    }, [isColumnsDialogOpen, dataViewMode]);

    const openColumnsDialog = () => {
        ensureColumnDrafts();
        if (canEditColumns) {
            loadDtoColumnSchema(selectedSource, selectedTable || undefined);
        }
        setDataViewMode('studio');
    };

    const updateColumnDraft = (columnName, patch) => {
        if (!selectedTableKey) return;
        setColumnMetadataDrafts(prev => {
            const tableDraft = prev[selectedTableKey] || {};
            return {
                ...prev,
                [selectedTableKey]: {
                    ...tableDraft,
                    [columnName]: {
                        description: '',
                        is_categorical: false,
                        type: inferColumnType(columnName),
                        ...(tableDraft[columnName] || {}),
                        ...patch
                    }
                }
            };
        });
    };

    // Apply the same patch to many columns in a single setState — used by the
    // "toggle all categorical" header button so we get one re-render instead
    // of N (one per filtered column).
    const bulkUpdateColumnDrafts = (columnNames, patch) => {
        if (!selectedTableKey || !columnNames || columnNames.length === 0) return;
        setColumnMetadataDrafts(prev => {
            const tableDraft = prev[selectedTableKey] || {};
            const nextTableDraft = { ...tableDraft };
            for (const columnName of columnNames) {
                nextTableDraft[columnName] = {
                    description: '',
                    is_categorical: false,
                    type: inferColumnType(columnName),
                    ...(tableDraft[columnName] || {}),
                    ...patch,
                };
            }
            return {
                ...prev,
                [selectedTableKey]: nextTableDraft,
            };
        });
    };

    const currentColumnDrafts = selectedTableKey ? (columnMetadataDrafts[selectedTableKey] || {}) : {};

    const resetSqlTableForm = (table = null) => {
        setEditingSqlTableId(table?.table_id || null);
        setSqlTableForm({
            table_id: table?.table_id || '',
            table_name: table?.table_name || '',
            query: table?.query || '',
            columns_class: table?.columns_class || '',
            incremental_column: table?.incremental_column || '',
            enabled: typeof table?.enabled === 'boolean' ? table.enabled : true,
            description: table?.description || '',
            cache_file: table?.cache_file || '',
            embeddings_file: table?.embeddings_file || '',
            foreign_keys_json: JSON.stringify(table?.foreign_keys || [], null, 2),
        });
    };

    const loadSqlSourceTables = async (sourceId) => {
        if (!sourceId) return;
        setIsLoadingSqlTables(true);
        try {
            const config = await getSqlSourceConfig(sourceId);
            setSqlSourceConfig(config);
        } catch (error) {
            console.error('Error loading SQL source config:', error);
            setSqlSourceConfig(null);
        } finally {
            setIsLoadingSqlTables(false);
        }
    };

    const openSqlTablesDialog = async () => {
        if (!selectedSource || !isSelectedSourceSql) return;
        setIsSqlTablesDialogOpen(true);
        resetSqlTableForm();
        await loadSqlSourceTables(selectedSource);
    };

    const saveSqlTable = async () => {
        if (!selectedSource) return;
        let foreignKeys = [];
        try {
            foreignKeys = JSON.parse(sqlTableForm.foreign_keys_json || '[]');
            if (!Array.isArray(foreignKeys)) {
                throw new Error('foreign_keys must be an array');
            }
        } catch (e) {
            alert('Le JSON des foreign_keys est invalide.');
            return;
        }

        setIsSavingSqlTable(true);
        try {
            const derivedTableId = (sqlTableForm.table_id.trim() || sqlTableForm.table_name.trim())
                .replace(/[^a-zA-Z0-9]+/g, '_')
                .replace(/^_+|_+$/g, '')
                .toLowerCase();

            if (!derivedTableId) {
                alert('Renseignez au moins table_name (ou table_id).');
                return;
            }

            const saveRes = await upsertSqlTableConfig(selectedSource, {
                table_id: derivedTableId,
                table_name: sqlTableForm.table_name.trim() || null,
                query: sqlTableForm.query.trim() || null,
                columns_class: sqlTableForm.columns_class.trim() || null,
                incremental_column: sqlTableForm.incremental_column.trim() || null,
                enabled: Boolean(sqlTableForm.enabled),
                description: sqlTableForm.description,
                cache_file: sqlTableForm.cache_file.trim() || null,
                embeddings_file: sqlTableForm.embeddings_file.trim() || null,
                foreign_keys: foreignKeys,
            });
            await Promise.all([
                loadSqlSourceTables(selectedSource),
                fetchSchema(),
            ]);
            setSelectedSource(selectedSource);
            setSelectedTable(derivedTableId);
            if (saveRes?.dto_generated) {
                alert(`Table ajoutée. DTO créé automatiquement pour ${derivedTableId}. Ouvrez "Colonnes" pour compléter les descriptions.`);
            }
            resetSqlTableForm();
        } catch (error) {
            console.error('Error saving SQL table config:', error);
            alert('Erreur lors de la sauvegarde de la table SQL.');
        } finally {
            setIsSavingSqlTable(false);
        }
    };

    const handleDeleteSqlTable = async (tableId) => {
        if (!selectedSource || !tableId) return;
        const confirmed = window.confirm(`Supprimer définitivement la table "${tableId}" de la source "${selectedSource}" ?`);
        if (!confirmed) return;
        const deleteFiles = window.confirm(`Supprimer aussi les fichiers cache/parquet associés à "${tableId}" ?`);

        try {
            const result = await deleteSqlTableConfig(selectedSource, tableId, deleteFiles);
            await Promise.all([
                loadSqlSourceTables(selectedSource),
                fetchSchema(),
            ]);

            if (selectedTable === tableId) {
                setSelectedTable(null);
            }
            resetSqlTableForm();
            if (deleteFiles && result?.deleted_files?.length) {
                alert(`Table supprimée. ${result.deleted_files.length} fichier(s) cache supprimé(s).`);
            }
        } catch (error) {
            console.error('Error deleting SQL table config:', error);
            alert('Erreur lors de la suppression de la table SQL.');
        }
    };

    const openDeleteSourceDialog = (sourceId: string, sourceType?: string) => {
        if (!sourceId) return;
        if (['sqlserver', 'supabase', 'oracle'].includes(sourceType || '')) {
            alert('Les sources SQL / Oracle / Supabase se gèrent via « Tables SQL » (suppression par table).');
            return;
        }
        setDeleteSourceDialog({
            open: true,
            sourceId,
            deleteFiles: true,
            isDeleting: false,
        });
    };

    const closeDeleteSourceDialog = () => {
        setDeleteSourceDialog((prev) => (
            prev.isDeleting
                ? prev
                : { open: false, sourceId: null, deleteFiles: true, isDeleting: false }
        ));
    };

    const handleDeleteSelectedSource = () => {
        if (!selectedSource) return;
        openDeleteSourceDialog(selectedSource);
    };

    const confirmDeleteSource = async () => {
        if (!deleteSourceDialog.sourceId) return;
        const { sourceId, deleteFiles } = deleteSourceDialog;

        setDeleteSourceDialog((prev) => ({ ...prev, isDeleting: true }));
        try {
            await deleteSourceConfig(sourceId, deleteFiles);
            await fetchSchema();
            if (selectedSource === sourceId) {
                setSelectedSource(null);
                setSelectedTable(null);
                setSelectedFile(null);
                setSelectedSourceConfig(null);
                setDataSample([]);
            }
            setDeleteSourceDialog({ open: false, sourceId: null, deleteFiles: true, isDeleting: false });
        } catch (error) {
            console.error('Error deleting source config:', error);
            setDeleteSourceDialog((prev) => ({ ...prev, isDeleting: false }));
            alert('Erreur lors de la suppression de la source.');
        }
    };

    const handleToggleSourceEnabled = async (sourceId: string, enabled: boolean) => {
        setTogglingSourceId(sourceId);
        try {
            await patchSourceEnabled(sourceId, enabled);
            await fetchSchema();
        } catch (error) {
            console.error('Error toggling source enabled:', error);
            alert('Impossible de modifier l\'état de la source.');
        } finally {
            setTogglingSourceId(null);
        }
    };

    const handleDeleteSourceById = async (sourceId: string, sourceType?: string) => {
        openDeleteSourceDialog(sourceId, sourceType);
    };

    const buildDefDraftsFromRows = (rows: Array<{ distinctValue: string; definitions: any[] }>) => {
        const drafts: Record<string, string[]> = {};
        const expanded: Record<string, boolean> = {};
        for (const row of rows) {
            drafts[row.distinctValue] = (row.definitions || []).map(String);
            expanded[row.distinctValue] = false;
        }
        return { drafts, expanded };
    };

    const applyDefDrafts = (drafts: Record<string, string[]>, expanded: Record<string, boolean>) => {
        setDefDrafts(drafts);
        setDefExpanded(expanded);
        setDefNewInput({});
        setDefEditIdx({});
        setDefEditText('');
    };

    const initDefDraftsFromPreview = async (
        previewRows: Array<{ distinctValue: string; definitions: any[] }>,
        sourceId: string | null,
        tableId: string | null,
    ) => {
        if (previewRows.length > 0) {
            const { drafts, expanded } = buildDefDraftsFromRows(previewRows);
            applyDefDrafts(drafts, expanded);
            return;
        }
        if (!sourceId) { applyDefDrafts({}, {}); return; }

        setIsLoadingDefs(true);
        try {
            const headData = await getParquetHead({
                source_id: sourceId,
                table_id: tableId || undefined,
                cache_type: 'embeddings',
                limit: 5000,
                column_name: columnDetailColumn || undefined,
            });
            const rows: Array<{ distinctValue: string; definitions: any[] }> = [];
            for (const row of headData.rows || []) {
                if (!row?.column_name || row.column_name !== columnDetailColumn) continue;

                const hasSingular = row.distinct_value !== undefined && row.distinct_value !== null;
                const hasPlural = row.distinct_values !== undefined && row.distinct_values !== null;

                if (hasSingular && !hasPlural) {
                    const defs = parseMaybeJson(row.definition_values, []);
                    rows.push({
                        distinctValue: String(row.distinct_value ?? '-'),
                        definitions: Array.isArray(defs) ? defs : (defs ? [String(defs)] : []),
                    });
                } else {
                    const dvList = parseMaybeJson(hasPlural ? row.distinct_values : row.distinct_value, []);
                    const defList = parseMaybeJson(row.definition_values, []);
                    const dvArr = Array.isArray(dvList) ? dvList : [];
                    const defArr = Array.isArray(defList) ? defList : [];
                    for (let i = 0; i < dvArr.length; i++) {
                        const defs = defArr[i];
                        rows.push({
                            distinctValue: String(dvArr[i] ?? '-'),
                            definitions: Array.isArray(defs) ? defs : (defs ? [String(defs)] : []),
                        });
                    }
                }
            }
            const { drafts, expanded } = buildDefDraftsFromRows(rows);
            applyDefDrafts(drafts, expanded);
        } catch (err) {
            console.error('Error loading embeddings for definitions tab:', err);
            applyDefDrafts({}, {});
        } finally {
            setIsLoadingDefs(false);
        }
    };

    const handleDefAdd = (distinctValue: string) => {
        const text = (defNewInput[distinctValue] || '').trim();
        if (!text) return;
        setDefDrafts(prev => ({ ...prev, [distinctValue]: [...(prev[distinctValue] || []), text] }));
        setDefNewInput(prev => ({ ...prev, [distinctValue]: '' }));
    };

    const handleDefDelete = (distinctValue: string, idx: number) => {
        setDefDrafts(prev => {
            const arr = [...(prev[distinctValue] || [])];
            arr.splice(idx, 1);
            return { ...prev, [distinctValue]: arr };
        });
    };

    const handleDefEditStart = (distinctValue: string, idx: number) => {
        setDefEditIdx(prev => ({ ...prev, [distinctValue]: idx }));
        setDefEditText(defDrafts[distinctValue]?.[idx] || '');
    };

    const handleDefEditConfirm = (distinctValue: string) => {
        const idx = defEditIdx[distinctValue];
        if (idx == null) return;
        setDefDrafts(prev => {
            const arr = [...(prev[distinctValue] || [])];
            arr[idx] = defEditText.trim() || arr[idx];
            return { ...prev, [distinctValue]: arr };
        });
        setDefEditIdx(prev => ({ ...prev, [distinctValue]: null }));
        setDefEditText('');
    };

    const handleDefEditCancel = (distinctValue: string) => {
        setDefEditIdx(prev => ({ ...prev, [distinctValue]: null }));
        setDefEditText('');
    };

    const handleSaveAllDefs = async () => {
        if (!selectedSource || !columnDetailColumn) return;
        setIsSavingDefs(true);
        try {
            const items: DefinitionItem[] = Object.entries(defDrafts).map(([dv, defs]) => ({
                distinct_value: dv,
                definitions: defs,
            }));
            await saveColumnDefinitions(selectedSource, columnDetailColumn, items, selectedTable || undefined);

            const [embResult, embHeadResult] = await Promise.allSettled([
                getColumnEmbeddings(selectedSource, selectedTable || undefined),
                getParquetHead({
                    source_id: selectedSource,
                    table_id: selectedTable || undefined,
                    cache_type: 'embeddings',
                    limit: 500,
                }),
            ]);
            setEmbeddingsData(embResult.status === 'fulfilled' ? embResult.value : null);
            setEmbeddingPreviewHead(embHeadResult.status === 'fulfilled' ? embHeadResult.value : null);

            alert('Définitions enregistrées.');
        } catch (error) {
            console.error('Error saving definitions:', error);
            alert('Erreur lors de la sauvegarde des définitions.');
        } finally {
            setIsSavingDefs(false);
        }
    };

    const handleRefineDefinitions = async () => {
        if (!selectedSource || !columnDetailColumn || !defRefineText.trim()) return;
        setIsRefiningDefs(true);
        try {
            const items: DefinitionItem[] = Object.entries(defDrafts).map(([dv, defs]) => ({
                distinct_value: dv,
                definitions: defs,
            }));
            const res = await refineColumnDefinitions(
                selectedSource,
                columnDetailColumn,
                defRefineText.trim(),
                items,
                selectedTable || undefined,
            );
            const changes: RefineDefinitionChange[] = Array.isArray(res?.changes) ? res.changes : [];
            setDefRefineChanges(changes);
            const accepted: Record<string, boolean> = {};
            changes.forEach(c => { accepted[c.distinct_value] = true; });
            setDefRefineAccepted(accepted);
        } catch (error) {
            console.error('Error refining definitions:', error);
            alert('Erreur lors de l\'analyse IA des définitions.');
        } finally {
            setIsRefiningDefs(false);
        }
    };

    const handleApplyAcceptedChanges = async () => {
        const updatedDrafts = { ...defDrafts };
        const updatedExpanded = { ...defExpanded };

        for (const change of defRefineChanges) {
            if (defRefineAccepted[change.distinct_value] === false) continue;
            if (change.action === 'add' || change.action === 'update') {
                updatedDrafts[change.distinct_value] = [...(change.new_definitions || [])];
            } else if (change.action === 'delete') {
                delete updatedDrafts[change.distinct_value];
            }
        }
        for (const change of defRefineChanges) {
            if (defRefineAccepted[change.distinct_value] === false) continue;
            if (change.action === 'delete') {
                delete updatedExpanded[change.distinct_value];
            } else if (change.action === 'add' && !(change.distinct_value in updatedExpanded)) {
                updatedExpanded[change.distinct_value] = false;
            }
        }

        setDefDrafts(updatedDrafts);
        setDefExpanded(updatedExpanded);
        setDefRefineChanges([]);
        setDefRefineAccepted({});

        if (selectedSource && columnDetailColumn) {
            try {
                const items: DefinitionItem[] = Object.entries(updatedDrafts).map(([dv, defs]) => ({
                    distinct_value: dv,
                    definitions: defs,
                }));
                await saveColumnDefinitions(selectedSource, columnDetailColumn, items, selectedTable || undefined);

                const [embResult, embHeadResult] = await Promise.allSettled([
                    getColumnEmbeddings(selectedSource, selectedTable || undefined),
                    getParquetHead({
                        source_id: selectedSource,
                        table_id: selectedTable || undefined,
                        cache_type: 'embeddings',
                        limit: 500,
                    }),
                ]);
                setEmbeddingsData(embResult.status === 'fulfilled' ? embResult.value : null);
                setEmbeddingPreviewHead(embHeadResult.status === 'fulfilled' ? embHeadResult.value : null);
            } catch (error) {
                console.error('Error persisting applied changes:', error);
                alert('Les changements sont appliqués localement mais la sauvegarde a échoué.');
            }
        }
    };

    const persistCurrentColumnDrafts = async () => {
        if (!selectedSource || !selectedTableColumns.length || !canEditColumns) return;
        const columnsPayload = selectedTableColumns.map((columnName) => {
            const draft = currentColumnDrafts[columnName] || {};
            return {
                column_name: columnName,
                description: draft.description || '',
                type: draft.type || inferColumnType(columnName),
                is_categorical: Boolean(draft.is_categorical),
            };
        });

        setIsSavingColumnSchema(true);
        try {
            await saveColumnSchema(selectedSource, selectedTable || undefined, columnsPayload);
            await loadDtoColumnSchema(selectedSource, selectedTable || undefined);
            alert('Descriptions des colonnes enregistrées dans le DTO.');
            setIsColumnsDialogOpen(false);
        } catch (error) {
            console.error('Error saving column schema DTO:', error);
            alert('Erreur lors de la sauvegarde des descriptions de colonnes.');
        } finally {
            setIsSavingColumnSchema(false);
        }
    };

    const applyAiColumnSuggestions = async () => {
        if (!selectedSource || !selectedTableColumns.length || !canEditColumns) return;

        const payload = selectedTableColumns.map((columnName) => {
            const draft = currentColumnDrafts[columnName] || {};
            return {
                column_name: columnName,
                type: draft.type || inferColumnType(columnName),
                sample_values: getColumnPreviewValues(columnName),
                current_description: draft.description || '',
                is_categorical: Boolean(draft.is_categorical),
            };
        });

        setIsSuggestingColumnSchema(true);
        try {
            const res = await suggestColumnSchema(
                selectedSource,
                selectedTable || undefined,
                selectedTableConfig?.description || selectedSourceConfig?.description || '',
                payload
            );

            const suggestions = Array.isArray(res?.columns) ? res.columns : [];
            if (!suggestions.length) {
                alert("Aucune suggestion IA n'a été générée.");
                return;
            }

            setColumnMetadataDrafts(prev => {
                if (!selectedTableKey) return prev;
                const tableDraft = prev[selectedTableKey] || {};
                const nextTableDraft = { ...tableDraft };

                suggestions.forEach((col) => {
                    const existing = nextTableDraft[col.column_name] || {};
                    nextTableDraft[col.column_name] = {
                        description: col.description || existing.description || '',
                        type: existing.type || inferColumnType(col.column_name),
                        is_categorical: typeof col.is_categorical === 'boolean'
                            ? col.is_categorical
                            : Boolean(existing.is_categorical),
                    };
                });

                return { ...prev, [selectedTableKey]: nextTableDraft };
            });
        } catch (error) {
            console.error('Error generating AI column suggestions:', error);
            alert("Erreur lors de la génération des suggestions IA.");
        } finally {
            setIsSuggestingColumnSchema(false);
        }
    };

    const [isSuggestingSingleColumn, setIsSuggestingSingleColumn] = useState(false);

    const suggestSingleColumnDescription = async (columnName: string) => {
        if (!selectedSource || !columnName) return;
        const draft = currentColumnDrafts[columnName] || {};
        const payload = [{
            column_name: columnName,
            type: draft.type || inferColumnType(columnName),
            sample_values: getColumnPreviewValues(columnName),
            current_description: draft.description || '',
            is_categorical: Boolean(draft.is_categorical),
        }];

        setIsSuggestingSingleColumn(true);
        try {
            const res = await suggestColumnSchema(
                selectedSource,
                selectedTable || undefined,
                selectedTableConfig?.description || selectedSourceConfig?.description || '',
                payload
            );
            const suggestion = (res?.columns || [])[0];
            if (suggestion?.description) {
                updateColumnDraft(columnName, { description: suggestion.description });
                if (typeof suggestion.is_categorical === 'boolean') {
                    updateColumnDraft(columnName, { is_categorical: suggestion.is_categorical });
                }
            } else {
                alert("Aucune suggestion IA générée pour cette colonne.");
            }
        } catch (error) {
            console.error('Error generating AI suggestion for column:', error);
            alert("Erreur lors de la suggestion IA.");
        } finally {
            setIsSuggestingSingleColumn(false);
        }
    };

    const persistSingleColumnDraft = async (columnName: string) => {
        if (!selectedSource || !columnName || !canEditColumns) return;
        const columnsPayload = selectedTableColumns.map((cn) => {
            const d = currentColumnDrafts[cn] || {};
            return {
                column_name: cn,
                description: d.description || '',
                type: d.type || inferColumnType(cn),
                is_categorical: Boolean(d.is_categorical),
            };
        });

        setIsSavingColumnSchema(true);
        try {
            await saveColumnSchema(selectedSource, selectedTable || undefined, columnsPayload);
            await loadDtoColumnSchema(selectedSource, selectedTable || undefined);
        } catch (error) {
            console.error('Error saving column description:', error);
            alert('Erreur lors de la sauvegarde.');
        } finally {
            setIsSavingColumnSchema(false);
        }
    };

    const launchDistinctGeneration = () => {
        if (!selectedSource || !canEditColumns) return;
        const catCols = selectedTableColumns.filter(c => currentColumnDrafts[c]?.is_categorical);
        if (!catCols.length) {
            alert("Aucune colonne catégorielle sélectionnée.");
            return;
        }
        setShowEmbeddingPopup(true);
    };

    const launchSingleColumnDistinct = async (columnName: string) => {
        if (!selectedSource || !columnName) return;

        // If embeddings already exist for this column, just load them
        try {
            const existing = await getColumnEmbeddings(selectedSource, selectedTable || undefined);
            const match = (existing?.columns || []).find((c: any) => c.column_name === columnName);
            if (match && match.distinct_values?.length > 0) {
                setEmbeddingsData(existing);
                const [embHeadResult] = await Promise.allSettled([
                    getParquetHead({
                        source_id: selectedSource,
                        table_id: selectedTable || undefined,
                        cache_type: 'embeddings',
                        limit: 500,
                    }),
                ]);
                setEmbeddingPreviewHead(embHeadResult.status === 'fulfilled' ? embHeadResult.value : null);
                setColDetailDistinctStatus("success");
                setTimeout(() => setColDetailDistinctStatus(null), 3000);
                return;
            }
        } catch {
            // File doesn't exist – proceed with generation
        }

        setColDetailDistinctStatus("queued");
        try {
            const { job_id } = await launchCategoricalDistinct(selectedSource, [columnName], selectedTable ?? undefined);
            const poll = setInterval(async () => {
                try {
                    const status = await getCategoricalDistinctStatus(job_id);
                    setColDetailDistinctStatus(status.status);
                    if (status.status === "success" || status.status === "failed") {
                        clearInterval(poll);
                        if (status.status === "success" && selectedSource) {
                            const [embResult, embHeadResult] = await Promise.allSettled([
                                getColumnEmbeddings(selectedSource, selectedTable || undefined),
                                getParquetHead({
                                    source_id: selectedSource,
                                    table_id: selectedTable || undefined,
                                    cache_type: 'embeddings',
                                    limit: 500,
                                }),
                            ]);
                            setEmbeddingsData(embResult.status === 'fulfilled' ? embResult.value : null);
                            setEmbeddingPreviewHead(embHeadResult.status === 'fulfilled' ? embHeadResult.value : null);
                        }
                        setTimeout(() => setColDetailDistinctStatus(null), 3000);
                    }
                } catch {
                    clearInterval(poll);
                    setColDetailDistinctStatus(null);
                }
            }, 3000);
        } catch (error) {
            console.error('Error launching single column distinct:', error);
            setColDetailDistinctStatus(null);
        }
    };

    // ── Embedding semantic search within column detail ─────────────────────
    const handleEmbeddingSearch = async () => {
        if (!embSearchQuery.trim() || !selectedSource || !columnDetailColumn) return;
        setEmbSearchLoading(true);
        setEmbSearchResults(null);
        try {
            const res = await columnEmbeddingSearch({
                query: embSearchQuery.trim(),
                source_id: selectedSource,
                column_name: columnDetailColumn,
                table_id: selectedTable ?? undefined,
                threshold: 0.15,
                top_k: 30,
            });
            setEmbSearchResults(res.results ?? []);
        } catch (e) {
            console.error('Embedding search failed', e);
            setEmbSearchResults([]);
        } finally {
            setEmbSearchLoading(false);
        }
    };

    // ── Re-embed column definitions ─────────────────────────────────────────
    const handleReembed = async (columnNames?: string[]) => {
        if (!selectedSource) return;
        setReembedLoading(true);
        setReembedResult(null);
        try {
            const res = await reembedColumnDefinitions({
                source_id: selectedSource,
                table_id: selectedTable ?? undefined,
                column_names: columnNames,
            });
            setReembedResult({ count: res.reembedded_count });
        } catch (e: any) {
            console.error('Re-embed failed', e);
            setReembedResult({ count: 0, error: e.message || 'Erreur' });
        } finally {
            setReembedLoading(false);
        }
    };

    // ── Skills helpers ────────────────────────────────────────────────────────

    const fetchSkillsList = async () => {
        setIsLoadingSkills(true);
        try {
            const res = await listSkills();
            setSkillsList(res.skills || []);
        } catch (e) {
            console.error('Failed to load skills', e);
        } finally {
            setIsLoadingSkills(false);
        }
    };

    const resizeSkillChatTextarea = (element: HTMLTextAreaElement | null) => {
        if (!element) return;
        element.style.height = 'auto';
        element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
    };

    const resetSkillChatTextarea = (ref: React.RefObject<HTMLTextAreaElement | null>) => {
        requestAnimationFrame(() => resizeSkillChatTextarea(ref.current));
    };

    const handleSkillChatKeyDown = (
        event: React.KeyboardEvent<HTMLTextAreaElement>,
        send: () => void,
    ) => {
        if (event.key !== 'Enter') return;
        if (event.shiftKey) {
            // Let the textarea insert the newline natively.
            return;
        }
        event.preventDefault();
        send();
    };

    const fetchSkillDtosList = async () => {
        setIsLoadingSkillDtos(true);
        try {
            const res = await listSkillDtos();
            setSkillDtosList(res.dtos || []);
        } catch (e) {
            // Non-fatal: the user can still create a skill, they just won't
            // get the DTO multi-select populated.
            console.error('Failed to load DTOs', e);
            setSkillDtosList([]);
        } finally {
            setIsLoadingSkillDtos(false);
        }
    };

    const openSkillEditor = async (directoryName: string) => {
        // Reset any leftover AI-edit chat from a previous skill so we never
        // mix conversations across skills.
        setAiEditMessages([]);
        setAiEditInput('');
        setAiEditDraft(null);
        setIsLoadingSkillDetail(true);
        try {
            const detail = await getSkill(directoryName);
            setEditingSkill(detail);
        } catch (e) {
            console.error('Failed to load skill detail', e);
        } finally {
            setIsLoadingSkillDetail(false);
        }
    };

    const closeSkillEditor = () => {
        setEditingSkill(null);
        setAiEditMessages([]);
        setAiEditInput('');
        setAiEditDraft(null);
    };

    const handleSaveSkill = async () => {
        if (!editingSkill) return;
        setIsSavingSkill(true);
        try {
            await updateSkill(editingSkill.directory_name, {
                name: editingSkill.name,
                description: editingSkill.description,
                content_body: editingSkill.content_body,
                aliases: editingSkill.aliases,
            });
            setEditingSkill(null);
            fetchSkillsList();
        } catch (e) {
            console.error('Failed to save skill', e);
            alert('Erreur lors de la sauvegarde du skill.');
        } finally {
            setIsSavingSkill(false);
        }
    };

    const handleCreateSkill = async () => {
        if (!newSkillForm.name.trim()) return;
        setIsSavingSkill(true);
        try {
            await createSkill({
                directory_name: newSkillForm.directory_name || newSkillForm.name,
                name: newSkillForm.name,
                description: newSkillForm.description,
                content_body: newSkillForm.content_body,
                // The skill router still matches on ``aliases``; the UI just
                // collects them as a curated DTO multi-select instead of a
                // free-text comma list.
                aliases: newSkillForm.dtos,
            });
            closeCreateSkillDialog();
            await fetchSkillsList();
        } catch (e) {
            console.error('Failed to create skill', e);
            alert('Erreur lors de la création du skill.');
        } finally {
            setIsSavingSkill(false);
        }
    };

    /**
     * Unified "Créer le skill" handler — the one wired to the footer button.
     *
     * Tries hard, in order:
     *   1. If the AI already produced a draft (``aiSkillDraft`` is set),
     *      create directly from it. Form fields with content override the
     *      corresponding draft fields, and selected DTOs always win over
     *      the LLM's alias suggestions.
     *   2. Otherwise, if the user has had a conversation with the
     *      assistant but no draft was parsed (LLM described the skill in
     *      prose without emitting the ``` ​skill block — the symptom the
     *      user reported), call the backend with ``finalize=true`` to
     *      force a final block, then create.
     *   3. Otherwise (no draft, no conversation), fall back to the
     *      form-only creation path.
     *
     * All three paths close the dialog and refresh the skills list on
     * success.
     */
    const handleCreateSkillUnified = async () => {
        const hasFormName = newSkillForm.name.trim().length > 0;
        const pendingPrompt = aiSkillInput.trim();
        const messagesForCreate: SkillChatMessage[] = pendingPrompt
            ? [...aiSkillMessages, { role: 'user', content: pendingPrompt }]
            : aiSkillMessages;
        const hasAssistantConversation = messagesForCreate.some(m => m.content.trim().length > 0);

        const payloadFromDraft = (draft: SkillDraft) => ({
            directory_name: (
                newSkillForm.directory_name.trim()
                || draft.directory_name
                || newSkillForm.name.trim()
                || draft.name
            ),
            name: newSkillForm.name.trim() || draft.name,
            description: newSkillForm.description.trim() || draft.description,
            content_body: newSkillForm.content_body.trim() || draft.content_body,
            aliases: newSkillForm.dtos.length > 0 ? newSkillForm.dtos : (draft.aliases || []),
        });

        // 1. Draft path — preferred when the LLM already emitted a ```skill block.
        if (aiSkillDraft && !pendingPrompt) {
            const merged = payloadFromDraft(aiSkillDraft);
            if (!merged.name?.trim()) {
                alert("Le brouillon de l'IA n'a pas de nom — précisez-le dans le formulaire.");
                return;
            }
            setIsSavingSkill(true);
            try {
                await createSkill(merged);
                closeCreateSkillDialog();
                await fetchSkillsList();
            } catch (e: any) {
                console.error('Failed to create skill from AI draft', e);
                alert("Erreur lors de la création du skill : " + (e?.message || 'erreur inconnue'));
            } finally {
                setIsSavingSkill(false);
            }
            return;
        }

        // 2. Finalize path — there is assistant context, including text still
        //    sitting in the input box. Force a final ```skill block, then
        //    create it with the real CRUD endpoint.
        if (hasAssistantConversation) {
            setIsSavingSkill(true);
            setIsAiSkillLoading(true);
            try {
                if (pendingPrompt) {
                    setAiSkillMessages(messagesForCreate);
                    setAiSkillInput('');
                    resetSkillChatTextarea(aiSkillInputRef);
                }
                const res = await aiGenerateSkill(
                    messagesForCreate,
                    null,
                    newSkillForm.dtos,
                    true,  // finalize
                );
                // Echo the final assistant message into the chat so the user
                // can see what was generated.
                setAiSkillMessages(prev => [
                    ...(pendingPrompt ? messagesForCreate : prev),
                    { role: 'assistant', content: res.message },
                ]);

                if (!res.skill_draft) {
                    alert(
                        "L'assistant n'a pas pu finaliser le skill automatiquement. " +
                        "Demandez-lui explicitement « Génère le skill maintenant » ou " +
                        "remplissez le formulaire à gauche.",
                    );
                    return;
                }
                const merged = payloadFromDraft(res.skill_draft);
                if (!merged.name?.trim()) {
                    alert("Le skill finalisé n'a pas de nom — précisez-le dans le formulaire.");
                    return;
                }
                await createSkill(merged);
                closeCreateSkillDialog();
                await fetchSkillsList();
            } catch (e: any) {
                console.error('Failed to finalize+create skill', e);
                alert('Erreur lors de la finalisation : ' + (e?.message || 'erreur inconnue'));
            } finally {
                setIsAiSkillLoading(false);
                setIsSavingSkill(false);
            }
            return;
        }

        // 3. Form-only path — original behaviour.
        if (!hasFormName) {
            alert(
                "Renseignez au moins le nom du skill, " +
                "ou discutez avec l'assistant IA pour en générer un.",
            );
            return;
        }
        await handleCreateSkill();
    };

    const handleDeleteSkill = async (directoryName: string) => {
        if (!confirm(`Supprimer le skill "${directoryName}" ? Cette action est irréversible.`)) return;
        try {
            await deleteSkill(directoryName);
            if (editingSkill?.directory_name === directoryName) setEditingSkill(null);
            fetchSkillsList();
        } catch (e) {
            console.error('Failed to delete skill', e);
            alert('Erreur lors de la suppression du skill.');
        }
    };

    // ── AI Skill Chat helpers ────────────────────────────────────────────────

    // Open the "Nouveau Skill" dialog. The creation dialog is a full-screen
    // window that holds both the form (left) and the AI creation chat
    // (right), mirroring the edit dialog. We start every session with a
    // clean form *and* a clean AI chat to avoid leaking state from a
    // previously-aborted creation attempt.
    const openCreateSkillDialog = (focusAi: boolean = false) => {
        setIsCreatingSkill(true);
        setEditingSkill(null);
        setIsAiSkillOpen(false);
        setNewSkillForm({ directory_name: '', name: '', description: '', content_body: '', dtos: [] });
        setDtoFilter('');
        setAiSkillMessages([]);
        setAiSkillDraft(null);
        setAiSkillInput('');
        // ``focusAi`` is reserved for the "Créer avec IA" entry-point which
        // wants the chat input focused on open. We schedule the focus after
        // paint so the Dialog has had a chance to mount its inputs. The
        // element is a textarea since the Shift+Enter rework.
        if (focusAi) {
            setTimeout(() => {
                const el = document.querySelector<HTMLTextAreaElement>('[data-skill-create-ai-input]');
                el?.focus();
            }, 50);
        }
    };

    const closeCreateSkillDialog = () => {
        setIsCreatingSkill(false);
        setNewSkillForm({ directory_name: '', name: '', description: '', content_body: '', dtos: [] });
        setDtoFilter('');
        setAiSkillMessages([]);
        setAiSkillDraft(null);
        setAiSkillInput('');
    };

    // Legacy entry-point kept so old callers still work — now just opens
    // the unified creation dialog and focuses the AI chat side.
    const openAiSkillChat = () => openCreateSkillDialog(true);

    const handleAiSkillSend = async () => {
        const text = aiSkillInput.trim();
        if (!text || isAiSkillLoading) return;

        const userMsg: SkillChatMessage = { role: 'user', content: text };
        const updatedMessages = [...aiSkillMessages, userMsg];
        setAiSkillMessages(updatedMessages);
        setAiSkillInput('');
        resetSkillChatTextarea(aiSkillInputRef);
        setIsAiSkillLoading(true);

        try {
            // Forward the user's DTO selection so the backend can ground
            // the LLM in the actual column schemas. ``null`` (not a
            // SkillContext) keeps the assistant in CREATE mode.
            const res = await aiGenerateSkill(
                updatedMessages,
                null,
                newSkillForm.dtos,
            );
            const assistantMsg: SkillChatMessage = { role: 'assistant', content: res.message };
            setAiSkillMessages(prev => [...prev, assistantMsg]);
            if (res.skill_draft) {
                setAiSkillDraft(res.skill_draft);
            }
        } catch (e) {
            console.error('AI skill generation failed', e);
            const errMsg: SkillChatMessage = { role: 'assistant', content: "Erreur lors de la communication avec l'IA. Veuillez réessayer." };
            setAiSkillMessages(prev => [...prev, errMsg]);
        } finally {
            setIsAiSkillLoading(false);
            setTimeout(() => aiChatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
        }
    };

    const handleAiSkillCreate = async () => {
        if (!aiSkillDraft) return;
        setIsAiSkillCreating(true);
        try {
            await createSkill({
                directory_name: aiSkillDraft.directory_name || aiSkillDraft.name,
                name: aiSkillDraft.name,
                description: aiSkillDraft.description,
                content_body: aiSkillDraft.content_body,
                aliases: newSkillForm.dtos.length > 0 ? newSkillForm.dtos : aiSkillDraft.aliases,
            });
            setIsAiSkillOpen(false);
            closeCreateSkillDialog();
            await fetchSkillsList();
        } catch (e) {
            console.error('Failed to create skill from AI draft', e);
            alert("Erreur lors de la création du skill.");
        } finally {
            setIsAiSkillCreating(false);
        }
    };

    // Pull the AI's draft into the visible "Nouveau Skill" form so the
    // user can tweak the fields (rename, prune aliases, edit markdown)
    // before pressing "Créer le skill". Nothing is persisted yet — the
    // dialog stays open and the chat history is preserved.
    //
    // Aliases coming from the LLM are matched against the available DTO
    // ``directory_name`` list so they show up as ticked chips in the
    // multi-select instead of being silently dropped on save.
    const handleAiSkillApply = () => {
        if (!aiSkillDraft) return;
        const validDtoNames = new Set(skillDtosList.map(d => d.directory_name));
        const mappedDtos = (aiSkillDraft.aliases || []).filter(a => validDtoNames.has(a));
        setNewSkillForm({
            directory_name: aiSkillDraft.directory_name || '',
            name: aiSkillDraft.name || '',
            description: aiSkillDraft.description || '',
            content_body: aiSkillDraft.content_body || '',
            dtos: mappedDtos,
        });
        setAiSkillDraft(null);
        const unmatched = (aiSkillDraft.aliases || []).filter(a => !validDtoNames.has(a));
        const suffix = unmatched.length > 0
            ? `\n\n(Note : ${unmatched.length} alias proposés ne correspondent à aucun DTO disponible et ont été ignorés : ${unmatched.join(', ')}. Ajoutez les DTOs concernés depuis "Données" puis re-sélectionnez-les.)`
            : '';
        setAiSkillMessages(prev => [
            ...prev,
            {
                role: 'assistant',
                content: '✓ Brouillon appliqué au formulaire. Vérifiez les champs puis cliquez sur « Créer le skill ».' + suffix,
            },
        ]);
    };

    // ── AI Skill *edit* chat helpers ─────────────────────────────────────────
    //
    // Mirrors the creation flow but anchored on the currently open skill.
    // The backend switches to its "edit" system prompt as soon as
    // ``current_skill`` is present in the payload, and locks the response's
    // ``directory_name`` to the existing one so the apply step is a PUT,
    // never a POST.

    const handleAiEditSend = async () => {
        const text = aiEditInput.trim();
        if (!text || isAiEditLoading || !editingSkill) return;

        const userMsg: SkillChatMessage = { role: 'user', content: text };
        const updatedMessages = [...aiEditMessages, userMsg];
        setAiEditMessages(updatedMessages);
        setAiEditInput('');
        resetSkillChatTextarea(aiEditInputRef);
        setIsAiEditLoading(true);

        try {
            const res = await aiGenerateSkill(updatedMessages, {
                directory_name: editingSkill.directory_name,
                name: editingSkill.name,
                description: editingSkill.description,
                aliases: editingSkill.aliases,
                content_body: editingSkill.content_body,
            });
            const assistantMsg: SkillChatMessage = { role: 'assistant', content: res.message };
            setAiEditMessages(prev => [...prev, assistantMsg]);
            if (res.skill_draft) setAiEditDraft(res.skill_draft);
        } catch (e) {
            console.error('AI skill edit failed', e);
            const errMsg: SkillChatMessage = {
                role: 'assistant',
                content: "Erreur lors de la communication avec l'IA. Veuillez réessayer.",
            };
            setAiEditMessages(prev => [...prev, errMsg]);
        } finally {
            setIsAiEditLoading(false);
            setTimeout(() => aiEditChatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
        }
    };

    // Pull the LLM's draft into the form. We *do not* auto-save: the user
    // reviews the populated fields and presses "Sauvegarder" to commit.
    // ``directory_name`` is enforced server-side so we never accidentally
    // overwrite a different skill.
    const handleAiEditApply = () => {
        if (!aiEditDraft || !editingSkill) return;
        setEditingSkill({
            ...editingSkill,
            name: aiEditDraft.name || editingSkill.name,
            description: aiEditDraft.description || editingSkill.description,
            aliases: aiEditDraft.aliases?.length ? aiEditDraft.aliases : editingSkill.aliases,
            content_body: aiEditDraft.content_body || editingSkill.content_body,
        });
        setAiEditDraft(null);
        setAiEditMessages(prev => [
            ...prev,
            {
                role: 'assistant',
                content: '✓ Modifications appliquées au formulaire. Cliquez sur « Sauvegarder » pour les écrire dans SKILL.md.',
            },
        ]);
    };

    // ── Template helpers ──────────────────────────────────────────────────────

    const fetchTemplatesList = async () => {
        setIsLoadingTemplates(true);
        try {
            const res = await listPromptTemplates(selectedTemplateCategory || undefined);
            setTemplatesList(res.templates || []);
            setTemplateCategories(res.categories || []);
        } catch (e) {
            console.error('Failed to load templates', e);
        } finally {
            setIsLoadingTemplates(false);
        }
    };

    const openTemplateEditor = async (category: string, name: string) => {
        setIsLoadingTemplateDetail(true);
        try {
            const detail = await getPromptTemplate(category, name);
            setEditingTemplate(detail);
        } catch (e) {
            console.error('Failed to load template detail', e);
        } finally {
            setIsLoadingTemplateDetail(false);
        }
    };

    const handleSaveTemplate = async () => {
        if (!editingTemplate) return;
        setIsSavingTemplate(true);
        try {
            await updatePromptTemplate(editingTemplate.category, editingTemplate.name, editingTemplate.content);
            setEditingTemplate(null);
            fetchTemplatesList();
        } catch (e) {
            console.error('Failed to save template', e);
            alert('Erreur lors de la sauvegarde du template.');
        } finally {
            setIsSavingTemplate(false);
        }
    };

    const handleImprovePrompt = async () => {
        if (!editingTemplate) return;
        setIsImprovingPrompt(true);
        try {
            const res = await improvePromptTemplate(editingTemplate.content, aiInstruction);
            setEditingTemplate(prev => prev ? { ...prev, content: res.improved } : null);
            setAiInstruction('');
        } catch (e) {
            console.error('Failed to improve prompt', e);
            alert('Erreur lors de l\'amélioration IA du prompt.');
        } finally {
            setIsImprovingPrompt(false);
        }
    };

    

    useEffect(() => {
        if (activeTab === 'prompts') {
            fetchTemplatesList();
        }
    }, [selectedTemplateCategory]);

    const tabs = [
        { id: 'data', label: 'Données', icon: Database },
        { id: 'connectors', label: 'Connecteurs', icon: Link2 },
        { id: 'skills', label: 'Skills', icon: BookOpen },
        { id: 'prompts', label: 'Prompts', icon: MessageSquare },
        { id: 'cte-graph', label: 'CTE Graph', icon: Network },
        { id: 'subscription', label: 'Abonnement', icon: CreditCard },
        { id: 'general', label: 'Paramètres', icon: SettingsIcon },
    ];

    const effectiveFiles = allFiles.length > 0 ? allFiles : (headsResponse?.files || []);
    const fallbackSources = [...new Set(effectiveFiles.map((file: any) => file.source_id).filter(Boolean))]
        .map((sourceId: string) => ({ source_id: sourceId, source_type: 'parquet', description: '' }));
    const availableSources = sourcesData.length > 0 ? sourcesData : fallbackSources;
    const loweredSearch = deferredSearchQuery.trim().toLowerCase();
    const filteredSources = availableSources.filter((source: { source_id: string; source_type?: string; description?: string }) => {
        if (!loweredSearch) return true;
        const nestedLabels = effectiveFiles
            .filter((file: any) => file.source_id === source.source_id)
            .map((file: any) => `${file.table_id || ''} ${file.file || ''}`.toLowerCase());

        return [
            source.source_id?.toLowerCase(),
            source.description?.toLowerCase(),
            source.source_type?.toLowerCase(),
            ...nestedLabels,
        ].some(value => value?.includes(loweredSearch));
    });

    const rawDataFiles = dataFiles.length > 0
        ? dataFiles
        : (headsResponse?.files || []).map((file: any) => ({
            file: file.file,
            source_id: file.source_id,
            table_id: file.table_id,
            rows: file.rows || [],
            columns: file.columns || [],
            total_rows: file.total_rows,
        }));
    const workbenchFiles = selectedFile
        ? rawDataFiles.filter((file: any) => file.file === selectedFile)
        : rawDataFiles;
    const selectedSourceFiles = effectiveFiles.filter((file: any) => file.source_id === selectedSource);
    const selectedCategoricalCount = selectedTableColumns.filter(columnName => currentColumnDrafts[columnName]?.is_categorical).length;
    const totalRecordsCount = (() => {
        const sourceRowCount = selectedSource
            ? (sourcesData.find(s => s.source_id === selectedSource)?.row_count || 0)
            : sourcesData.reduce((acc, s) => acc + (s.row_count || 0), 0);
        if (sourceRowCount > 0) return sourceRowCount;
        const files = selectedSource
            ? effectiveFiles.filter((f: any) => f.source_id === selectedSource)
            : effectiveFiles;
        return files.reduce((acc, f: any) => acc + (f.total_rows || 0), 0);
    })();
    const activeSelectionLabel = selectedSource
        ? `${selectedSource}${selectedTable ? ` / ${selectedTable}` : ''}`
        : 'Toutes les sources';
    const activeSelectionDescription = selectedTableConfig?.description
        || selectedSourceConfig?.description
        || (selectedSource ? "Aucune description métier renseignée pour cette sélection." : "Sélectionnez une source pour inspecter le cache, les DTOs et les embeddings.");
    const filteredDialogColumns = selectedTableColumns.filter((columnName) => {
        if (!deferredColumnSearchQuery.trim()) return true;
        const loweredColumnSearch = deferredColumnSearchQuery.trim().toLowerCase();
        const draft = currentColumnDrafts[columnName];
        return [
            columnName.toLowerCase(),
            draft?.description?.toLowerCase(),
            draft?.type?.toLowerCase(),
            ...getColumnPreviewValues(columnName).map(value => value.toLowerCase())
        ].some(value => value?.includes(loweredColumnSearch));
    });
    // Aggregate "Cat." state across the *currently visible* (filtered) columns.
    // The header toggle below targets this set, not the full table, so the user
    // can scope a bulk toggle by filtering first.
    const visibleCategoricalCount = filteredDialogColumns.filter(
        (columnName) => currentColumnDrafts[columnName]?.is_categorical
    ).length;
    const allVisibleAreCategorical = filteredDialogColumns.length > 0
        && visibleCategoricalCount === filteredDialogColumns.length;
    const embeddingsColumns = Array.isArray(embeddingsData?.columns) ? embeddingsData.columns : [];
    const embeddingsByColumn = embeddingsColumns.reduce((acc, column) => {
        acc[column.column_name] = column;
        return acc;
    }, {} as Record<string, any>);
    const embeddingPreviewByColumn = (embeddingPreviewHead?.rows || []).reduce((acc, row) => {
        const columnName = row?.column_name;
        if (!columnName) return acc;
        if (!acc[columnName]) acc[columnName] = [];

        const hasSingular = row.distinct_value !== undefined && row.distinct_value !== null;
        const hasPlural = row.distinct_values !== undefined && row.distinct_values !== null;

        if (hasSingular && !hasPlural) {
            const defs = parseMaybeJson(row.definition_values, []);
            const vecCount = row.vector_count ?? 0;
            const vecDim = row.vector_dim ?? 0;
            acc[columnName].push({
                distinctValue: String(row.distinct_value ?? '-'),
                definitions: Array.isArray(defs) ? defs : (defs ? [String(defs)] : []),
                vectorPreview: [],
                fullVector: [],
                vectorCount: vecCount,
                vectorSize: vecDim,
            });
        } else {
            const dvList = parseMaybeJson(hasPlural ? row.distinct_values : row.distinct_value, []);
            const defList = parseMaybeJson(row.definition_values, []);
            const dvArr = Array.isArray(dvList) ? dvList : [];
            const defArr = Array.isArray(defList) ? defList : [];
            for (let i = 0; i < dvArr.length; i++) {
                const defs = defArr[i];
                acc[columnName].push({
                    distinctValue: String(dvArr[i] ?? '-'),
                    definitions: Array.isArray(defs) ? defs : (defs ? [String(defs)] : []),
                    vectorPreview: [],
                    fullVector: [],
                    vectorCount: 0,
                    vectorSize: 0,
                });
            }
        }

        return acc;
    }, {} as Record<string, Array<{ distinctValue: string; definitions: any[]; vectorPreview: any[]; fullVector: any[]; vectorCount: number; vectorSize: number }>>);
    const effectiveWorkbenchColumn = selectedWorkbenchColumn && selectedTableColumns.includes(selectedWorkbenchColumn)
        ? selectedWorkbenchColumn
        : (selectedTableColumns[0] || null);
    const selectedWorkbenchDraft = effectiveWorkbenchColumn
        ? (currentColumnDrafts[effectiveWorkbenchColumn] || {
            description: '',
            is_categorical: false,
            type: inferColumnType(effectiveWorkbenchColumn)
        })
        : null;
    const selectedWorkbenchPreviewValues = effectiveWorkbenchColumn ? getColumnPreviewValues(effectiveWorkbenchColumn) : [];
    const selectedWorkbenchEmbeddings = effectiveWorkbenchColumn ? embeddingsByColumn[effectiveWorkbenchColumn] : null;
    const selectedWorkbenchEmbeddingRows = effectiveWorkbenchColumn ? (embeddingPreviewByColumn[effectiveWorkbenchColumn] || []) : [];
    const selectedWorkbenchDefinitions = selectedWorkbenchEmbeddings?.definition_values
        || selectedWorkbenchEmbeddingRows.flatMap((row) => row.definitions || []);
    const selectedWorkbenchDistinctValues = selectedWorkbenchEmbeddings?.distinct_values
        || selectedWorkbenchEmbeddingRows.map((row) => row.distinctValue);
    const selectedWorkbenchEmbeddedValues = selectedWorkbenchEmbeddings?.embedded_values
        || selectedWorkbenchEmbeddingRows.map((row) => row.fullVector);

    useEffect(() => {
        if (!selectedTableColumns.length) {
            setSelectedWorkbenchColumn(null);
            return;
        }

        if (!selectedWorkbenchColumn || !selectedTableColumns.includes(selectedWorkbenchColumn)) {
            setSelectedWorkbenchColumn(selectedTableColumns[0]);
        }
    }, [selectedTableColumns, selectedWorkbenchColumn, selectedSource, selectedTable]);

    return (
        <motion.div
            initial={embedded ? false : { x: '100%' }}
            animate={embedded ? undefined : { x: 0 }}
            exit={embedded ? undefined : { x: '100%' }}
            transition={embedded ? undefined : { type: 'spring', damping: 25, stiffness: 200 }}
            className={cn(
                "settings-ui flex overflow-hidden text-[#2B2B2B]",
                embedded ? "relative h-full w-full bg-background" : "fixed inset-0 z-[100] pt-12 md:pt-0 settings-warm-bg",
            )}
        >
            {/* Sidebar — Desktop (hidden when embedded: the host app provides navigation) */}
            <aside className={cn("w-[260px] shrink-0 flex-col border-r border-[#E8E6E1] bg-white", embedded ? "hidden" : "hidden md:flex")}>
                <div className="px-6 pt-8 pb-6">
                    <div className="flex items-center gap-3">
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={onClose}
                            className="h-9 w-9 rounded-xl border border-[#E8E6E1] text-[#6B6966] hover:bg-[#F8F7F4] hover:text-[#2B2B2B]"
                    >
                            <ArrowLeft className="h-4 w-4" />
                    </Button>
                        <div>
                            <h2 className="settings-display text-lg text-[#2B2B2B]">Configuration</h2>
                            <span className="text-[10px] font-medium tracking-wide text-[#A09E99]">v4.0.1</span>
                        </div>
                    </div>
                </div>
                <nav className="flex-1 px-3 space-y-1">
                                {tabs.map(tab => (
                                    <button
                                        key={tab.id}
                                        onClick={() => setActiveTab(tab.id)}
                                        className={cn(
                                "flex w-full items-center gap-3 rounded-xl px-4 py-2.5 text-[13px] font-semibold transition-all",
                                activeTab === tab.id
                                    ? "bg-[#0D7377] text-white shadow-sm"
                                    : "text-[#6B6966] hover:bg-[#F8F7F4] hover:text-[#2B2B2B]"
                            )}
                        >
                            <tab.icon className="h-4 w-4" />
                                        {tab.label}
                                    </button>
                                ))}
                </nav>
                <div className="px-4 pb-6">
                    <div className="rounded-xl border border-[#E8E6E1] bg-[#F8F7F4] p-4">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">Pilotage</p>
                        <p className="mt-1.5 text-xs leading-relaxed text-[#6B6966]">Sources, DTOs et embeddings depuis une seule surface.</p>
                            </div>
                        </div>
            </aside>
            {/* Main content area */}
            <div className="flex-1 flex flex-col min-w-0">
            {/* Mobile top bar (hidden when embedded) */}
            <div className={cn("md:hidden sticky top-0 z-20 border-b border-[#E8E6E1] bg-white/95 px-4 py-3 backdrop-blur-xl", embedded && "hidden")}>
                <div className="flex items-center gap-3">
                    <Button variant="ghost" size="icon" onClick={onClose} className="h-9 w-9 rounded-xl border border-[#E8E6E1]">
                        <ArrowLeft className="h-4 w-4" />
                    </Button>
                    <h2 className="settings-display text-base text-[#2B2B2B]">Configuration</h2>
                    </div>
                <div className="mt-3 flex gap-1 overflow-x-auto pb-1">
                    {tabs.map(tab => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            className={cn(
                                "flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-semibold transition-all",
                                activeTab === tab.id
                                    ? "bg-[#0D7377] text-white"
                                    : "text-[#6B6966] hover:bg-[#F8F7F4]"
                            )}
                        >
                            <tab.icon className="h-3 w-3" />
                            {tab.label}
                        </button>
                    ))}
                    </div>
            </div>
            {/* Search bar */}
            <div className={cn("shrink-0 border-b border-[#E8E6E1] bg-white px-6 md:px-10", embedded ? "py-2.5" : "py-4")}>
                <div className="flex items-center justify-between gap-4">
                    <div className="relative flex-1 max-w-md">
                        <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#A09E99]" />
                            <input
                                type="text"
                            value={searchQuery}
                            onChange={(event) => setSearchQuery(event.target.value)}
                            placeholder="Rechercher source, table, cache..."
                            className="w-full rounded-xl border border-[#E8E6E1] bg-[#F8F7F4] py-2.5 pl-10 pr-4 text-sm font-medium text-[#2B2B2B] outline-none transition-all placeholder:text-[#A09E99] focus:border-[#0D7377]/40 focus:bg-white focus:ring-2 focus:ring-[#0D7377]/10"
                            />
                        </div>
                    <Button className="rounded-xl border border-[#0D7377] bg-[#0D7377] px-5 font-semibold text-white hover:bg-[#0B6164] shadow-sm">
                        <Save className="h-4 w-4" />
                        Sauvegarder
                    </Button>
                </div>
            </div>

            <ScrollArea className="relative z-10 flex-1">
                <div className={cn("mx-auto max-w-[1560px] px-6 md:px-8 lg:px-10 2xl:px-12", embedded ? "pb-12 pt-5" : "pb-20 pt-6 md:pt-8 lg:pt-10")}>
                    <AnimatePresence mode="wait">
                        {activeTab === 'general' && (
                            <motion.div
                                key="general"
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                className="space-y-12"
                            >
                                <SettingsSection
                                    title="Compte & Sécurité"
                                    description="Configurez vos informations personnelles et protégez votre accès"
                                >
                                    <SettingItem
                                        icon={User}
                                        title="Profil Professionnel"
                                        description="Hamid Zerouali - Consultant Data"
                                        badge="Vérifié"
                                    />
                                    <SettingItem
                                        icon={Lock}
                                        title="Authentification forte"
                                        description="Activer l'authentification MFA via application mobile"
                                        badge="Recommandé"
                                    />
                                    <SettingItem
                                        icon={Shield}
                                        title="Audit Log"
                                        description="Historique des dernières connexions et actions"
                                    />
                                </SettingsSection>

                                <SettingsSection
                                    title="Interface"
                                    description="Personnalisez votre expérience visuelle"
                                >
                                    <SettingItem
                                        icon={Eye}
                                        title="Thème Dynamique"
                                        description="Actuellement en mode Sombre (système)"
                                    />
                                    <SettingItem
                                        icon={Globe}
                                        title="Région"
                                        description="Français (Europe) - UTC+1"
                                    />
                                </SettingsSection>
                            </motion.div>
                        )}

                        {activeTab === 'connectors' && (
                            <motion.div
                                key="connectors"
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                className="space-y-8"
                            >
                                <div className="flex flex-wrap items-start justify-between gap-4">
                                    <div className="space-y-2">
                                        <h3 className="settings-display text-2xl text-[#2B2B2B]">Connecteurs</h3>
                                        <p className="max-w-2xl text-sm leading-relaxed text-[#6B6966]">
                                            Configurez vos connexions base de données. Les identifiants sont stockés dans le fichier <span className="settings-mono text-[12px]">.env</span> du backend.
                                        </p>
                                    </div>
                                    <span className="rounded-full border border-[#E8E6E1] bg-white px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.22em] text-[#6B6966]">
                                        {Object.values(connectorStates).filter(s => s.configured).length} / {connectorProviders.length} configuré{Object.values(connectorStates).filter(s => s.configured).length > 1 ? 's' : ''}
                                    </span>
                                </div>

                                {connectorProviders.length > 1 && (
                                    <div className="flex flex-wrap gap-2">
                                        {connectorProviders.map(prov => {
                                            const state = connectorStates[prov.id];
                                            const isActive = activeConnector === prov.id;
                                            return (
                                                <button
                                                    key={prov.id}
                                                    onClick={() => setActiveConnector(prov.id)}
                                                    className={cn(
                                                        "flex items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-all",
                                                        isActive
                                                            ? "border-[#0D7377] bg-[#0D7377]/5"
                                                            : "border-[#E8E6E1] bg-white hover:bg-[#F8F7F4]"
                                                    )}
                                                >
                                                    <div className={cn(
                                                        "flex h-9 w-9 items-center justify-center rounded-xl text-sm font-bold",
                                                        isActive ? "bg-[#0D7377] text-white" : "bg-[#F0EFEC] text-[#6B6966]"
                                                    )}>
                                                        {prov.label.charAt(0)}
                                                    </div>
                                                    <div>
                                                        <p className={cn("text-sm font-semibold", isActive ? "text-[#0D7377]" : "text-[#2B2B2B]")}>{prov.label}</p>
                                                        <p className="text-[11px] text-[#A09E99]">
                                                            {state?.registered ? 'Chargé' : state?.configured ? 'Configuré' : 'Non configuré'}
                                                        </p>
                                                    </div>
                                                    {state?.registered ? (
                                                        <span className="ml-1 h-2 w-2 rounded-full bg-[#0D7377]" />
                                                    ) : state?.configured ? (
                                                        <span className="ml-1 h-2 w-2 rounded-full bg-[#FDBA74]" />
                                                    ) : null}
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}

                                {connectorProviders.filter(p => p.id === activeConnector).map(prov => {
                                    const state = connectorStates[prov.id];
                                    const form = connectorForms[prov.id] || {};
                                    const meta = connectorMeta[prov.id] || { enabled: true, description: '', source_id: '' };
                                    return (
                                        <div key={prov.id} className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_320px]">
                                            <Card className="border-[#E8E6E1] bg-white p-6 shadow-none">
                                                <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#E8E6E1] pb-5">
                                                    <div className="flex items-start gap-4">
                                                        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#FDBA74]/25 text-[#9A3412]">
                                                            <Server className="h-5 w-5" />
                                                        </div>
                                                        <div className="space-y-1">
                                                            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#A09E99]">{prov.label}</p>
                                                            <h4 className="settings-display text-xl text-[#2B2B2B]">{meta.source_id || state?.source_id || prov.default_source_id}</h4>
                                                        </div>
                                                    </div>
                                                    <Button
                                                        variant="ghost"
                                                        className="rounded-xl border border-[#E8E6E1] bg-white px-4 py-2 text-xs font-semibold text-[#2B2B2B] hover:bg-[#F8F7F4]"
                                                        onClick={() => {
                                                            setActiveTab('data');
                                                            setSelectedSource(meta.source_id || state?.source_id || prov.default_source_id);
                                                            setSelectedTable(null);
                                                        }}
                                                    >
                                                        Ouvrir dans Données
                                    </Button>
                                </div>

                                                {isLoadingConnectors ? (
                                                    <div className="mt-6 space-y-4">
                                                        <div className="h-12 animate-pulse rounded-2xl bg-[#F0EFEC]" />
                                                        <div className="grid gap-4 md:grid-cols-2">
                                                            <div className="h-24 animate-pulse rounded-2xl bg-[#F8F7F4]" />
                                                            <div className="h-24 animate-pulse rounded-2xl bg-[#F8F7F4]" />
                                                            <div className="h-24 animate-pulse rounded-2xl bg-[#F8F7F4]" />
                                                            <div className="h-24 animate-pulse rounded-2xl bg-[#F8F7F4]" />
                                                        </div>
                                                    </div>
                                                ) : (
                                                    <div className="mt-6 grid gap-4 md:grid-cols-2">
                                                        <div>
                                                            <label className="text-xs font-semibold uppercase tracking-[0.18em] text-[#A09E99]">Source ID</label>
                                                            <Input
                                                                value={meta.source_id}
                                                                onChange={(e) => setConnectorMeta(prev => ({ ...prev, [prov.id]: { ...prev[prov.id], source_id: e.target.value } }))}
                                                                className="mt-2"
                                                                placeholder={prov.default_source_id}
                                                            />
                                                        </div>
                                                        <div>
                                                            <label className="text-xs font-semibold uppercase tracking-[0.18em] text-[#A09E99]">Description</label>
                                                            <Input
                                                                value={meta.description}
                                                                onChange={(e) => setConnectorMeta(prev => ({ ...prev, [prov.id]: { ...prev[prov.id], description: e.target.value } }))}
                                                                className="mt-2"
                                                                placeholder={`Description ${prov.label}`}
                                                            />
                                                        </div>
                                                        {prov.fields.map(field => (
                                                            <div key={field.key} className={prov.fields.length % 2 !== 0 && field === prov.fields[prov.fields.length - 1] ? 'md:col-span-2' : ''}>
                                                                <label className="text-xs font-semibold uppercase tracking-[0.18em] text-[#A09E99]">{field.label}</label>
                                                                <Input
                                                                    type={field.secret ? 'password' : 'text'}
                                                                    value={form[field.key] || ''}
                                                                    onChange={(e) => setConnectorForms(prev => ({ ...prev, [prov.id]: { ...prev[prov.id], [field.key]: e.target.value } }))}
                                                                    className="mt-2"
                                                                    placeholder={field.default || field.label}
                                                                />
                                                            </div>
                                                        ))}
                                                        <div className="md:col-span-2 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#E8E6E1] bg-[#F8F7F4] px-4 py-3">
                                                            <div>
                                                                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#A09E99]">Source activée</p>
                                                                <p className="mt-1 text-sm text-[#6B6966]">Désactivez-la pour la conserver dans le YAML sans la charger côté backend.</p>
                                                            </div>
                                                            <Button
                                                                type="button"
                                                                variant={meta.enabled ? "default" : "outline"}
                                                                className="rounded-xl"
                                                                onClick={() => setConnectorMeta(prev => ({ ...prev, [prov.id]: { ...prev[prov.id], enabled: !prev[prov.id].enabled } }))}
                                                            >
                                                                {meta.enabled ? 'Enabled' : 'Disabled'}
                                                            </Button>
                                                        </div>
                                                    </div>
                                                )}

                                                <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-[#E8E6E1] pt-5">
                                                    <p className="text-xs leading-relaxed text-[#6B6966]">
                                                        Les valeurs sont persistées dans <span className="settings-mono text-[12px]">{state?.env_file || 'qclick-agent/.env'}</span>.
                                                    </p>
                                                    <Button onClick={() => handleSaveConnector(prov.id)} disabled={savingConnector === prov.id} className="rounded-xl font-bold">
                                                        {savingConnector === prov.id ? 'Enregistrement...' : `Enregistrer ${prov.label}`}
                                                    </Button>
                                                </div>
                                            </Card>

                                            <div className="space-y-4">
                                                <Card className="border-[#E8E6E1] bg-white p-5 shadow-none">
                                                    <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#A09E99]">État</p>
                                                    <div className="mt-4 space-y-4">
                                                        <DataInspectorCard
                                                            eyebrow="Source"
                                                            title={state?.source_exists ? (state?.source_id || meta.source_id || prov.default_source_id) : `Source ${prov.label} non créée`}
                                                            body={state?.source_exists
                                                                ? 'La source est enregistrée dans config/datasources.yaml.'
                                                                : 'Enregistrez ce formulaire pour créer automatiquement la source dans le YAML.'}
                                                        />
                                                        <DataInspectorCard
                                                            eyebrow={prov.id === 'minio' ? 'Bucket' : 'Tables'}
                                                            title={prov.id === 'minio'
                                                                ? (form.bucket ? `Bucket ${form.bucket}` : 'Bucket non renseigné')
                                                                : `${state?.tables_count || 0} table(s) ou vue(s) configurée(s)`}
                                                            body={prov.id === 'minio'
                                                                ? 'Les objets du bucket sont listés dans Données.'
                                                                : "Les objets se gèrent dans Données via la même boîte de dialogue que les autres sources SQL."}
                                                        />
                                                        <DataInspectorCard
                                                            eyebrow="Chargement"
                                                            title={state?.registered ? `Connecteur ${prov.label} chargé en mémoire` : 'Connecteur pas encore chargé'}
                                                            body="Après sauvegarde, la source est rechargée côté backend. Si votre serveur ne tourne pas en reload, redémarrez-le."
                                                        />
                                        </div>
                                    </Card>

                                                <Card className="border-[#E8E6E1] bg-[#F8F7F4] p-5 shadow-none">
                                                    <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#A09E99]">Info</p>
                                                    <div className="mt-4 space-y-3 text-sm leading-relaxed text-[#6B6966]">
                                                        <p>Type de source : <span className="settings-mono text-[12px]">{prov.source_type}</span></p>
                                                        <p>Source ID par défaut : <span className="settings-mono text-[12px]">{prov.default_source_id}</span></p>
                                                        <p>Champs configurables : {prov.fields.length}</p>
                                </div>
                                                </Card>
                                            </div>
                                        </div>
                                    );
                                })}
                            </motion.div>
                        )}

                        {activeTab === 'data' && (
                            <motion.div
                                key="data"
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                className="space-y-5"
                            >
                                    <input
                                        ref={csvFileInputRef}
                                        type="file"
                                        accept=".csv,text/csv"
                                        className="hidden"
                                        onChange={handleCsvFilePicked}
                                    />
                                <input
                                    ref={qvdFileInputRef}
                                    type="file"
                                    accept=".qvd,.qvd.gz"
                                    className="hidden"
                                    onChange={handleQvdFilePicked}
                                />
                                <input
                                    ref={xlsxFileInputRef}
                                    type="file"
                                    accept=".xlsx,.xlsm,.xls,.ods,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                                    multiple
                                    className="hidden"
                                    onChange={handleXlsxFilesPicked}
                                />
                                <input
                                    ref={minioFileInputRef}
                                    type="file"
                                    className="hidden"
                                    onChange={handleMinioFilePicked}
                                />

                                {/* Header — compact single bar */}
                                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <h3 className="settings-display text-xl leading-none tracking-[-0.02em] text-[#2B2B2B]">Gestion des données</h3>
                                        <span className="rounded-full bg-[#0D7377] px-2.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-white">
                                            {isSelectedSourceMinio ? 'Objets MinIO' : (dataViewMode === 'studio' ? 'Studio colonnes' : 'Embeddings')}
                                        </span>
                                        {distinctJobStatus && (
                                            <span className="rounded-full border border-[#E8725A]/30 bg-[#E8725A]/10 px-2.5 py-0.5 text-[10px] font-semibold text-[#E8725A]">
                                                Job {distinctJobStatus}
                                            </span>
                                        )}
                                        {qvdPipelineStatus && qvdPipelineStatus !== 'completed' && qvdPipelineStatus !== 'failed' && (
                                            <span className="flex items-center gap-1.5 rounded-full border border-[#0D7377]/30 bg-[#0D7377]/10 px-2.5 py-0.5 text-[10px] font-semibold text-[#0D7377]">
                                                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[#0D7377]" />
                                                QVD {qvdPipelineStatus === 'uploading' ? 'upload…' : 'en cours…'}
                                            </span>
                                        )}
                                        {qvdPipelineStatus === 'failed' && (
                                            <span className="rounded-full border border-red-300 bg-red-50 px-2.5 py-0.5 text-[10px] font-semibold text-red-600">QVD échoué</span>
                                        )}
                                        {xlsxPipelineStatus && xlsxPipelineStatus !== 'completed' && xlsxPipelineStatus !== 'failed' && (
                                            <span className="flex items-center gap-1.5 rounded-full border border-[#0D7377]/30 bg-[#0D7377]/10 px-2.5 py-0.5 text-[10px] font-semibold text-[#0D7377]">
                                                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[#0D7377]" />
                                                Excel {xlsxPipelineStatus === 'uploading' ? 'upload…' : 'en cours…'}
                                            </span>
                                        )}
                                        {xlsxPipelineStatus === 'failed' && (
                                            <span className="rounded-full border border-red-300 bg-red-50 px-2.5 py-0.5 text-[10px] font-semibold text-red-600">Excel échoué</span>
                                        )}
                                    </div>
                                    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                                        <span className="inline-flex items-center gap-1.5 rounded-full border border-[#E8E6E1] bg-white px-2.5 py-1">
                                            <span className="font-semibold uppercase tracking-[0.1em] text-[#A09E99]">Sélection</span>
                                            <span className="max-w-[200px] truncate font-semibold text-[#2B2B2B]">{activeSelectionLabel}</span>
                                        </span>
                                        <span className="inline-flex items-center gap-1.5 rounded-full border border-[#E8E6E1] bg-white px-2.5 py-1">
                                            <span className="font-semibold uppercase tracking-[0.1em] text-[#A09E99]">Sources</span>
                                            <span className="font-semibold text-[#2B2B2B]">{filteredSources.length}</span>
                                        </span>
                                        <span className="inline-flex items-center gap-1.5 rounded-full border border-[#E8E6E1] bg-white px-2.5 py-1" title="Statut API">
                                            <span className={cn("inline-block h-1.5 w-1.5 rounded-full", healthData?.status === 'healthy' ? "bg-emerald-500" : healthData?.status ? "bg-amber-500" : "bg-[#A09E99]")} />
                                            <span className="font-semibold uppercase tracking-[0.04em] text-[#2B2B2B]">{healthData?.status || 'Inconnu'}</span>
                                        </span>
                                    </div>
                                </div>

                                {/* Controls strip — tabs left, actions right */}
                                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E8E6E1] pb-4">
                                    {/* Mode toggle removed — single Studio (colonnes) view. */}
                                    <div />
                                    <div className="flex flex-wrap items-center gap-2">
                                        <Button
                                            variant="ghost"
                                            className="gap-1.5 rounded-xl border border-[#E8E6E1] bg-white px-3 py-1.5 text-[11px] font-medium text-[#2B2B2B] hover:bg-[#F8F7F4]"
                                            onClick={() => {
                                                if (selectedSource && isSelectedSourceMinio) {
                                                    void loadMinioObjects(selectedSource);
                                                } else {
                                                    fetchData(selectedSource, selectedTable);
                                                }
                                            }}
                                        >
                                            <RefreshCw className={cn("h-3.5 w-3.5", (isLoadingData || isLoadingMinioObjects) && "animate-spin")} />
                                            Rafraîchir
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            className="gap-1.5 rounded-xl border border-[#E8E6E1] bg-white px-3 py-1.5 text-[11px] font-medium text-[#2B2B2B] hover:bg-[#F8F7F4]"
                                            onClick={openCsvPicker}
                                            disabled={isUploadingCsv}
                                        >
                                            <Plus className={cn("h-3.5 w-3.5", isUploadingCsv && "animate-pulse")} />
                                            {isUploadingCsv ? 'Ajout CSV...' : 'Ajouter CSV'}
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            className={cn(
                                                "gap-1.5 rounded-xl border px-3 py-1.5 text-[11px] font-medium",
                                                isPipelineActive()
                                                    ? "border-[#0D7377]/40 bg-[#0D7377]/10 text-[#0D7377]"
                                                    : "border-[#E8E6E1] bg-white text-[#2B2B2B] hover:bg-[#F8F7F4]"
                                            )}
                                            onClick={isPipelineActive() ? () => setShowQvdPopup(true) : openQvdPicker}
                                        >
                                            <Plus className={cn("h-3.5 w-3.5", isPipelineActive() && "animate-spin")} />
                                            {isPipelineActive()
                                                ? 'Pipeline QVD…'
                                                : 'Ajouter QVD'}
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            className={cn(
                                                "gap-1.5 rounded-xl border px-3 py-1.5 text-[11px] font-medium",
                                                isXlsxPipelineActive()
                                                    ? "border-[#0D7377]/40 bg-[#0D7377]/10 text-[#0D7377]"
                                                    : "border-[#E8E6E1] bg-white text-[#2B2B2B] hover:bg-[#F8F7F4]"
                                            )}
                                            onClick={isXlsxPipelineActive() ? () => setShowXlsxPopup(true) : openXlsxPicker}
                                            disabled={isUploadingXlsx && !isXlsxPipelineActive()}
                                            title="Importer un ou plusieurs fichiers Excel (.xlsx, .xls, .ods)"
                                        >
                                            <FileSpreadsheet className={cn("h-3.5 w-3.5", isXlsxPipelineActive() && "animate-pulse")} />
                                            {isXlsxPipelineActive()
                                                ? 'Pipeline Excel…'
                                                : 'Ajouter Excel'}
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            className="gap-1.5 rounded-xl border border-[#E8E6E1] bg-white px-3 py-1.5 text-[11px] font-medium text-[#2B2B2B] hover:bg-[#F8F7F4]"
                                            onClick={() => setIsSupabaseDialogOpen(true)}
                                            disabled={isCreatingSupabase}
                                        >
                                            <Plus className={cn("h-3.5 w-3.5", isCreatingSupabase && "animate-pulse")} />
                                            {isCreatingSupabase ? 'Ajout Supabase...' : 'Ajouter Supabase'}
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            className="gap-1.5 rounded-xl border border-[#E8E6E1] bg-white px-3 py-1.5 text-[11px] font-medium text-[#2B2B2B] hover:bg-[#F8F7F4]"
                                            onClick={openColumnsDialog}
                                            disabled={!canEditColumns}
                                            title={!selectedSource ? "Sélectionnez une source" : "Définir les colonnes"}
                                        >
                                            <Database className="h-3.5 w-3.5" />
                                            Atelier colonnes
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            className="gap-1.5 rounded-xl border border-[#E8E6E1] bg-white px-3 py-1.5 text-[11px] font-medium text-[#2B2B2B] hover:bg-[#F8F7F4]"
                                            onClick={() => setIsSelectionDetailsOpen(true)}
                                        >
                                            <SettingsIcon className="h-3.5 w-3.5" />
                                            Infos sélection
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            className="gap-1.5 rounded-xl border border-[#E8E6E1] bg-white px-3 py-1.5 text-[11px] font-medium text-[#2B2B2B] hover:bg-[#F8F7F4]"
                                            onClick={openSqlTablesDialog}
                                            disabled={!selectedSource || !isSelectedSourceSql}
                                            title={!isSelectedSourceSql ? "Sélectionnez une source SQL, Oracle ou Supabase" : "Ajouter / modifier des tables ou vues SQL"}
                                        >
                                            <Server className="h-3.5 w-3.5" />
                                            Tables / vues
                                        </Button>
                                        {(isSelectedSourceSql && selectedTable) ? (
                                            <Button
                                                className="gap-1.5 rounded-xl border border-red-200 bg-red-50 px-3 py-1.5 text-[11px] font-medium text-red-700 hover:bg-red-100"
                                                onClick={() => handleDeleteSqlTable(selectedTable)}
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                                Supprimer la table
                                            </Button>
                                        ) : (
                                            <Button
                                                className="gap-1.5 rounded-xl border border-red-200 bg-red-50 px-3 py-1.5 text-[11px] font-medium text-red-700 hover:bg-red-100"
                                                onClick={handleDeleteSelectedSource}
                                                disabled={!canDeleteSelectedNonSqlSource}
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                                Supprimer la source
                                            </Button>
                                        )}
                                    </div>
                                </div>

                                <div className="grid gap-6 xl:grid-cols-[minmax(360px,440px)_minmax(0,1fr)] xl:gap-8 2xl:grid-cols-[minmax(400px,500px)_minmax(0,1fr)] 2xl:gap-10">
                                    <section className="border-r border-[#E8E6E1] pr-4 xl:pr-6">
                                        <div className="flex items-start justify-between gap-3">
                                            <div>
                                                <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[#A09E99]">Source atlas</p>
                                                <h4 className="settings-display mt-3 text-3xl font-semibold tracking-[-0.05em] text-[#2B2B2B]">
                                                    {filteredSources.length}
                                                </h4>
                                                <p className="mt-1 text-xs leading-relaxed text-[#6B6966]">
                                                    Toutes les sources, tables et fichiers visibles depuis la recherche active.
                                                </p>
                                            </div>
                                            <span className="rounded-full border border-[#E8E6E1] bg-[#2B2B2B]/5 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.24em] text-[#6B6966]">
                                                {availableSources.length} total
                                            </span>
                                        </div>

                                        <div className="mt-5 space-y-2">
                                            <button
                                                onClick={() => { setSelectedSource(null); setSelectedTable(null); setSelectedFile(null); }}
                                                className={cn(
                                                    "flex w-full items-center justify-between rounded-[22px] border px-4 py-3 text-left transition-all",
                                                    !selectedSource
                                                        ? "border-[#0D7377] bg-[#0D7377] text-white shadow-[0_18px_36px_rgba(15,23,42,0.18)]"
                                                        : "border-[#E8E6E1] bg-white text-[#4A4845] hover:border-[#D4D2CD] hover:bg-[#F8F7F4]"
                                                )}
                                            >
                                                <div>
                                                    <p className="text-[10px] font-semibold uppercase tracking-[0.24em] opacity-70">Vision globale</p>
                                                    <p className="mt-1 text-sm font-semibold">Toutes les sources</p>
                                                </div>
                                                <Database className="h-4 w-4" />
                                            </button>

                                            <div className="max-h-[840px] space-y-2 overflow-y-auto pr-1">
                                                {filteredSources.length === 0 && (
                                                    <div className="rounded-[22px] border border-dashed border-[#E8E6E1] bg-white px-4 py-8 text-center">
                                                        <p className="text-sm font-semibold text-[#4A4845]">Aucune source ne correspond à cette recherche.</p>
                                                        <p className="mt-2 text-xs leading-relaxed text-[#A09E99]">Essayez un identifiant de source, un nom de table ou un chemin de cache.</p>
                                                    </div>
                                                )}

                                                {filteredSources.map((source: { source_id: string; source_type?: string; description?: string; enabled?: boolean; tables?: Array<{ table_id: string; table_name?: string | null; enabled?: boolean; description?: string | null; has_cache?: boolean }> | null }) => {
                                                    const sourceFiles = effectiveFiles.filter((file: any) => file.source_id === source.source_id);
                                                    const configTables = source.tables || [];
                                                    const fileTableIds = new Set(sourceFiles.map((f: any) => f.table_id).filter(Boolean));
                                                    const missingConfigTables = configTables.filter(t => !fileTableIds.has(t.table_id));
                                                    const isActiveSource = selectedSource === source.source_id && !selectedTable;
                                                    const sourceEnabled = source.enabled !== false;
                                                    const isSqlLike = ['sqlserver', 'supabase', 'oracle'].includes(source.source_type || '');
                                                    const canDeleteRow = !isSqlLike;

                                                    return (
                                                        <div key={source.source_id} className="border-b border-[#E8E6E1] py-3 last:border-b-0">
                                                            <div className="flex items-start gap-2">
                                                        <button
                                                                    onClick={() => { setSelectedSource(source.source_id); setSelectedTable(null); setSelectedFile(null); }}
                                                            className={cn(
                                                                        "flex-1 rounded-[18px] border px-4 py-3 text-left transition-all",
                                                                        !sourceEnabled && "opacity-60",
                                                                        isActiveSource
                                                                            ? "border-[#0D7377] bg-[#0D7377] text-white"
                                                                            : "border-transparent bg-white/80 text-[#2B2B2B] hover:border-[#E8E6E1] hover:bg-white"
                                                                    )}
                                                                >
                                                                    <div className="flex items-start justify-between gap-3">
                                                                        <div className="min-w-0">
                                                                            <p
                                                                                className="text-sm font-semibold leading-snug [overflow-wrap:anywhere]"
                                                                                title={source.source_id}
                                                                            >
                                                                                {source.source_id}
                                                                            </p>
                                                                            <p className={cn(
                                                                                "mt-2 inline-flex rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.24em]",
                                                                                isActiveSource ? "border-white/15 bg-white/10 text-white" : getSourceToneClasses(source.source_type)
                                                                            )}>
                                                                                {getSourceTypeLabel(source.source_type)}
                                                                            </p>
                                                                        </div>
                                                                        {source.source_type === 'csv' ? (
                                                                            <Database className="mt-0.5 h-4 w-4" />
                                                                        ) : source.source_type === 'minio' ? (
                                                                            <Cloud className="mt-0.5 h-4 w-4" />
                                                                        ) : (
                                                                            <Server className="mt-0.5 h-4 w-4" />
                                                                        )}
                                                                    </div>
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    role="switch"
                                                                    aria-checked={sourceEnabled}
                                                                    disabled={togglingSourceId === source.source_id}
                                                                    title={sourceEnabled ? 'Désactiver la source (reste dans le YAML)' : 'Activer la source'}
                                                                    onClick={(event) => {
                                                                        event.stopPropagation();
                                                                        void handleToggleSourceEnabled(source.source_id, !sourceEnabled);
                                                                    }}
                                                                    className={cn(
                                                                        "shrink-0 rounded-full border px-2.5 py-2 text-[10px] font-semibold uppercase tracking-[0.24em] transition-colors disabled:opacity-50",
                                                                        sourceEnabled
                                                                            ? "border-[#0D7377]/40 bg-[#0D7377]/10 text-[#0D7377]"
                                                                            : "border-[#E8E6E1] bg-[#F8F7F4] text-[#A09E99]"
                                                                    )}
                                                                >
                                                                    {sourceEnabled ? 'On' : 'Off'}
                                                        </button>
                                                                {canDeleteRow && (
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                                        className="h-10 w-10 rounded-2xl border border-red-200 bg-red-50/80 text-red-700 hover:bg-red-100"
                                                                        title="Supprimer la source"
                                                                        onClick={(event) => {
                                                                            event.stopPropagation();
                                                                            void handleDeleteSourceById(source.source_id, source.source_type);
                                                                        }}
                                                                    >
                                                                        <Trash2 className="h-4 w-4" />
                                                                    </Button>
                                                                )}
                                                                <Button
                                                                    variant="ghost"
                                                                    size="icon"
                                                                    className={cn(
                                                                        "h-10 w-10 rounded-2xl border border-[#E8E6E1] bg-white/80 text-[#6B6966] hover:bg-white",
                                                                        (source as any).download_in_progress && "opacity-40 cursor-not-allowed"
                                                                    )}
                                                                    disabled={(source as any).download_in_progress}
                                                                    title={(source as any).download_in_progress ? "Téléchargement en cours" : "Rafraîchir"}
                                                                    onClick={(event) => {
                                                                        event.stopPropagation();
                                                                handleRefreshSource(source.source_id);
                                                            }}
                                                        >
                                                                    <RefreshCw className={cn("h-4 w-4", (isLoadingData && selectedSource === source.source_id) && "animate-spin", (source as any).download_in_progress && "animate-spin text-amber-500")} />
                                                        </Button>
                                                    </div>

                                                            {(sourceFiles.length > 0 || missingConfigTables.length > 0) && (
                                                                <div className="mt-3 space-y-2 border-l border-[#E8E6E1] pl-3">
                                                                    {sourceFiles.map((file: any) => {
                                                                        const subId = file.table_id ?? file.file;
                                                                        const subLabel = file.table_id ?? (file.file?.replace(/\.parquet$/, '') || file.cache_type || 'data');
                                                                        const isSelectedNode = selectedSource === source.source_id && (file.table_id ? selectedTable === file.table_id : selectedFile === file.file);

                                                                        return (
                                                                <button
                                                                                key={`${file.source_id}-${subId}`}
                                                                    onClick={() => {
                                                                        setSelectedSource(source.source_id);
                                                                                    setSelectedTable(file.table_id || undefined);
                                                                                    setSelectedFile(file.table_id ? undefined : file.file);
                                                                    }}
                                                                    className={cn(
                                                                                    "flex w-full items-center gap-3 rounded-[18px] px-3 py-2 text-left transition-all",
                                                                                    isSelectedNode
                                                                                        ? "bg-[#F0EFEC] text-[#2B2B2B]"
                                                                                        : "text-[#6B6966] hover:bg-[#F8F7F4] hover:text-[#2B2B2B]"
                                                                                )}
                                                                            >
                                                                                <Database className="h-3.5 w-3.5 shrink-0 opacity-60" />
                                                                                <span
                                                                                    className="min-w-0 flex-1 text-xs font-semibold leading-snug [overflow-wrap:anywhere]"
                                                                                    title={subLabel}
                                                                                >
                                                                                    {subLabel}
                                                                                </span>
                                                                </button>
                                                                        );
                                                                    })}
                                                                    {missingConfigTables.map((tbl) => {
                                                                        const isSelectedNode = selectedSource === source.source_id && selectedTable === tbl.table_id;
                                                                        return (
                                                                            <button
                                                                                key={`${source.source_id}-cfg-${tbl.table_id}`}
                                                                                onClick={() => {
                                                                                    setSelectedSource(source.source_id);
                                                                                    setSelectedTable(tbl.table_id);
                                                                                    setSelectedFile(undefined);
                                                                                }}
                                                                                className={cn(
                                                                                    "flex w-full items-center gap-3 rounded-[18px] px-3 py-2 text-left transition-all",
                                                                                    isSelectedNode
                                                                                        ? "bg-[#F0EFEC] text-[#2B2B2B]"
                                                                                        : "text-[#A09E99] hover:bg-[#F8F7F4] hover:text-[#6B6966]"
                                                                                )}
                                                                            >
                                                                                <Database className="h-3.5 w-3.5 shrink-0 opacity-40" />
                                                                                <span
                                                                                    className="min-w-0 flex-1 text-xs font-semibold leading-snug [overflow-wrap:anywhere]"
                                                                                    title={tbl.table_id}
                                                                                >
                                                                                    {tbl.table_id}
                                                                                </span>
                                                                                <span className="ml-auto rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-600">
                                                                                    no cache
                                                                                </span>
                                                                            </button>
                                                                        );
                                                                    })}
                                                    </div>
                                                            )}
                                                </div>
                                                    );
                                                })}
                                        </div>
                                    </div>
                                    </section>

                                    <div className="space-y-6">
                                        <div className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-2xl border border-[#E8E6E1] bg-white/60 px-5 py-3">
                                            <DataMetricCard eyebrow="Sources" value={healthData?.total_sources ?? availableSources.length} icon={Server} accentClass="bg-[#0D7377] text-white" />
                                            <div className="hidden h-7 w-px bg-[#E8E6E1] sm:block" />
                                            <DataMetricCard eyebrow="Lignes" value={formatCompactValue(totalRecordsCount)} icon={Database} accentClass="bg-[#F0EFEC] text-[#2B2B2B]" />
                                            <div className="hidden h-7 w-px bg-[#E8E6E1] sm:block" />
                                            <DataMetricCard eyebrow={isSelectedSourceMinio ? 'Objets' : 'Fichiers'} value={isSelectedSourceMinio ? selectedMinioObjects.length : (selectedSource ? selectedSourceFiles.length : workbenchFiles.length)} icon={isSelectedSourceMinio ? Cloud : FileText} accentClass="bg-[#0D7377] text-white" />
                                            <div className="hidden h-7 w-px bg-[#E8E6E1] sm:block" />
                                            <DataMetricCard eyebrow={isSelectedSourceMinio ? 'Stockage' : (dataViewMode === 'studio' ? 'Colonnes' : 'Vecteurs')} value={isSelectedSourceMinio ? formatBytes(selectedMinioResponse?.total_size) : (dataViewMode === 'studio' ? filteredDialogColumns.length : (isLoadingEmbeddings ? '…' : (embeddingsData?.columns?.length || 0)))} icon={Cpu} accentClass="bg-cyan-600 text-white" />
                                            </div>


                                        <section className="overflow-hidden border-t border-[#E8E6E1] pt-6">
                                            <div className="px-0 py-0 md:px-0">
                                                <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                                                    <div>
                                                        <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[#A09E99]">Workbench</p>
                                                        <h4 className="settings-display mt-2 text-3xl font-semibold tracking-[-0.04em] text-[#2B2B2B]">
                                                            {isSelectedSourceMinio ? 'Objets MinIO' : (dataViewMode === 'studio' ? 'Studio colonnes et embeddings' : 'Embeddings catégoriels')}
                                                        </h4>
                                                        <p className="mt-1 text-sm leading-relaxed text-[#6B6966]">
                                                            {activeSelectionDescription}
                                                        </p>
                                                    </div>
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        <span className="rounded-full border border-[#E8E6E1] bg-white px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.24em] text-[#6B6966]">
                                                            {activeSelectionLabel}
                                                        </span>
                                                        {selectedSourceInfo?.source_type && (
                                                            <span className={cn(
                                                                "rounded-full border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.24em]",
                                                                getSourceToneClasses(selectedSourceInfo.source_type)
                                                            )}>
                                                                {getSourceTypeLabel(selectedSourceInfo.source_type)}
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="pt-6">
                                        {isSelectedSourceMinio ? (
                                                    <MinioObjectBrowser
                                                        response={selectedMinioResponse}
                                                        isLoading={isLoadingMinioObjects}
                                                        error={minioObjectError}
                                                        onRefresh={() => {
                                                            if (selectedSource) void loadMinioObjects(selectedSource);
                                                        }}
                                                        onUploadClick={openMinioPicker}
                                                        onDelete={handleDeleteMinioObject}
                                                        isUploading={uploadingMinioSource === selectedSource}
                                                        deletingObjectKey={deletingMinioObjectKey}
                                                    />
                                                ) : dataViewMode === 'samples' ? (
                                                    <div className="space-y-5">
                                                        {isLoadingData ? (
                                                            <div className="space-y-4">
                                                                <div className="h-16 animate-pulse rounded-[24px] bg-[#E8E6E1]/70" />
                                                                <div className="h-72 animate-pulse rounded-[28px] bg-[#E8E6E1]/60" />
                                                            </div>
                                                        ) : workbenchFiles.length > 0 ? (
                                                            workbenchFiles.map((fileData, fileIdx) => {
                                                                const totalRows = fileData.total_rows ?? fileData.rows.length;
                                                                const currentPage = pageByFile[fileData.file] ?? 0;
                                                                const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
                                                                const fromRow = currentPage * PAGE_SIZE + 1;
                                                                const toRow = Math.min((currentPage + 1) * PAGE_SIZE, totalRows);

                                                                return (
                                                                    <div
                                                                        key={`${fileData.source_id ?? fileData.file}-${fileData.table_id ?? 'main'}-${fileIdx}`}
                                                                        className="overflow-hidden rounded-[28px] border border-[#E8E6E1] bg-white"
                                                                    >
                                                                        <div className="flex flex-col gap-4 border-b border-[#E8E6E1] bg-[#F8F7F4] px-4 py-4 md:flex-row md:items-center md:justify-between">
                                                                            <div className="flex flex-wrap items-center gap-2">
                                                                                <span className="rounded-full border border-[#E8E6E1] bg-white px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.24em] text-[#4A4845]">
                                                                                    {fileData.source_id || fileData.file}
                                                                                </span>
                                                                                {fileData.table_id && (
                                                                                    <span className="rounded-full border border-[#E8E6E1] bg-white px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.24em] text-[#4A4845]">
                                                                                        {fileData.table_id}
                                                                                    </span>
                                                                                )}
                                                                                <span className="text-[11px] font-medium text-[#A09E99]">
                                                                                    {totalRows.toLocaleString()} lignes × {fileData.columns.length} colonnes
                                                                                </span>
                                                                            </div>
                                                                            <div className="flex flex-wrap items-center gap-2">
                                                                                <span className="text-[11px] font-medium text-[#A09E99]">
                                                                                    Lignes {fromRow}-{toRow} sur {totalRows.toLocaleString()}
                                                                                </span>
                                                                                <div className="flex items-center gap-1 rounded-full border border-[#E8E6E1] bg-white p-1">
                                                                                    <Button
                                                                                        variant="ghost"
                                                                                        size="sm"
                                                                                        className="h-8 w-8 rounded-full p-0 text-[#6B6966] hover:bg-[#F8F7F4]"
                                                                                        disabled={currentPage <= 0 || isLoadingData}
                                                                                        onClick={() => fetchFilePage(fileData.file, currentPage - 1)}
                                                                                    >
                                                                                        <ChevronLeft className="h-4 w-4" />
                                                                                    </Button>
                                                                                    <span className="min-w-[78px] px-2 text-center text-[10px] font-semibold uppercase tracking-[0.18em] text-[#A09E99]">
                                                                                        Page {currentPage + 1} / {totalPages}
                                                                                    </span>
                                                                                    <Button
                                                                                        variant="ghost"
                                                                                        size="sm"
                                                                                        className="h-8 w-8 rounded-full p-0 text-[#6B6966] hover:bg-[#F8F7F4]"
                                                                                        disabled={currentPage >= totalPages - 1 || isLoadingData}
                                                                                        onClick={() => fetchFilePage(fileData.file, currentPage + 1)}
                                                                                    >
                                                                                        <ChevronRight className="h-4 w-4" />
                                                                                    </Button>
                                                                                </div>
                                                                            </div>
                                                                        </div>

                                                <div className="overflow-x-auto">
                                                                            <table className="min-w-full border-collapse text-left">
                                                                                <thead className="border-b border-[#E8E6E1] bg-[#F8F7F4]">
                                                                                    <tr>
                                                                                        {fileData.columns.map(col => (
                                                                                            <th
                                                                                                key={col}
                                                                                                className="px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.22em] text-[#6B6966]"
                                                                                                title={col}
                                                                                            >
                                                                                                <div className="max-w-[180px] truncate">{col}</div>
                                                                                            </th>
                                                                                        ))}
                                                                                        <th className="w-14 px-4 py-3 text-right text-[10px] font-semibold uppercase tracking-[0.22em] text-[#6B6966]">#</th>
                                                            </tr>
                                                        </thead>
                                                                                <tbody className="divide-y divide-[#E8E6E1]">
                                                                                    {fileData.rows.map((row, rowIdx) => (
                                                                                        <tr key={rowIdx} className="transition-colors hover:bg-[#F8F7F4]">
                                                                                            {fileData.columns.map(col => (
                                                                                                <td
                                                                                                    key={col}
                                                                                                    className="max-w-[180px] truncate px-4 py-3 text-sm text-[#4A4845]"
                                                                                                    title={String(row[col] ?? '-')}
                                                                                                >
                                                                                                    {String(row[col] ?? '-')}
                                                                        </td>
                                                                                            ))}
                                                                                            <td className="px-4 py-3 text-right text-[11px] font-medium text-[#A09E99]">
                                                                                                {(currentPage * PAGE_SIZE) + rowIdx}
                                                                            </td>
                                                                                        </tr>
                                                                                    ))}
                                                                                </tbody>
                                                                            </table>
                                                                        </div>
                                                                    </div>
                                                                );
                                                            })
                                                        ) : (
                                                            <div className="rounded-[28px] border border-dashed border-[#E8E6E1] bg-white px-6 py-16 text-center">
                                                                <Database className="mx-auto h-12 w-12 text-[#A09E99]" />
                                                                <h5 className="mt-5 text-lg font-semibold text-[#2B2B2B]">Aucun échantillon disponible</h5>
                                                                <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-[#A09E99]">
                                                                    Sélectionnez une source ou lancez un rafraîchissement pour charger les fichiers de travail.
                                                                </p>
                                                            </div>
                                                        )}
                                                    </div>
                                                ) : dataViewMode === 'studio' ? (
                                                    <div className="space-y-5">
                                                        {!canEditColumns ? (
                                                            <div className="rounded-[28px] border border-dashed border-[#E8E6E1] bg-white px-6 py-16 text-center">
                                                                <Database className="mx-auto h-12 w-12 text-[#A09E99]" />
                                                                <h5 className="mt-5 text-lg font-semibold text-[#2B2B2B]">Sélectionnez une source</h5>
                                                                <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-[#A09E99]">
                                                                    Le studio colonnes rassemble la documentation DTO, les distincts et les embeddings pour la sélection active.
                                                                </p>
                                                            </div>
                                                        ) : (
                                                            <>
                                                                <div className="flex flex-wrap items-center justify-end gap-2 pb-4">
                                                                    <Button
                                                                        variant="outline"
                                                                        onClick={applyAiColumnSuggestions}
                                                                        disabled={isSuggestingColumnSchema || !selectedTableColumns.length}
                                                                        className="rounded-full border-[#E8E6E1] bg-white px-4 text-xs font-semibold text-[#2B2B2B] hover:bg-[#2B2B2B] hover:text-white"
                                                                    >
                                                                        {isSuggestingColumnSchema ? 'Suggestion IA...' : 'Suggestion IA'}
                                                                    </Button>
                                                                    <Button
                                                                        onClick={persistCurrentColumnDrafts}
                                                                        disabled={isSavingColumnSchema || isSuggestingColumnSchema || !selectedTableColumns.length}
                                                                        className="rounded-full border border-[#0D7377] bg-[#0D7377] px-4 text-xs font-semibold text-white hover:bg-[#0B6164]"
                                                                    >
                                                                        {isSavingColumnSchema ? 'Sauvegarde...' : 'Sauvegarder DTO'}
                                                                    </Button>
                                                                    <Button
                                                                        onClick={launchDistinctGeneration}
                                                                        disabled={
                                                                            isSavingColumnSchema
                                                                            || !selectedTableColumns.some(c => currentColumnDrafts[c]?.is_categorical)
                                                                        }
                                                                        className="rounded-full border border-[#E8725A]/20 bg-[#E8725A] px-4 text-xs font-semibold text-white hover:bg-[#D4613D]"
                                                                    >
                                                                        Lancer embeddings
                                                                    </Button>
                                                                    {selectedTable && isSelectedSourceSql && (
                                                                        <Button
                                                                            onClick={handleDownloadTable}
                                                                            className="rounded-full px-4 text-xs font-semibold border border-[#E8E6E1] bg-white text-[#2B2B2B] hover:bg-[#2B2B2B] hover:text-white"
                                                                        >
                                                                            <Download className="mr-1.5 h-3.5 w-3.5" />
                                                                            Télécharger Parquet
                                                                        </Button>
                                                                    )}
                                                                </div>

                                                                {!filteredDialogColumns.length ? (
                                                                    <div className="rounded-[28px] border border-dashed border-[#E8E6E1] bg-white px-6 py-16 text-center">
                                                                        <Search className="mx-auto h-12 w-12 text-[#A09E99]" />
                                                                        <h5 className="mt-5 text-lg font-semibold text-[#2B2B2B]">Aucune colonne trouvée</h5>
                                                                        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-[#A09E99]">
                                                                            Ajustez votre filtre pour retrouver une colonne, un type ou une valeur d’exemple.
                                                                        </p>
                                                                    </div>
                                                                ) : (
                                                                    <div className="overflow-hidden rounded-2xl border border-[#E8E6E1] bg-white">
                                                                        <div className="overflow-x-auto">
                                                                            <table className="w-full text-left text-sm">
                                                                                <thead className="sticky top-0 z-10 border-b border-[#E8E6E1] bg-[#F8F7F4]">
                                                                                    <tr>
                                                                                        <th className="whitespace-nowrap px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">Colonne</th>
                                                                                        <th className="whitespace-nowrap px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">Description</th>
                                                                                        <th className="whitespace-nowrap px-4 py-3 text-center text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">
                                                                                            <button
                                                                                                type="button"
                                                                                                disabled={filteredDialogColumns.length === 0}
                                                                                                onClick={() => bulkUpdateColumnDrafts(filteredDialogColumns, { is_categorical: !allVisibleAreCategorical })}
                                                                                                title={
                                                                                                    filteredDialogColumns.length === 0
                                                                                                        ? "Aucune colonne visible"
                                                                                                        : allVisibleAreCategorical
                                                                                                            ? `Retirer le flag catégoriel pour ${filteredDialogColumns.length} colonne(s)`
                                                                                                            : `Marquer ${filteredDialogColumns.length} colonne(s) comme catégorielle(s)`
                                                                                                }
                                                                                                className={cn(
                                                                                                    "mx-auto inline-flex items-center gap-2 rounded-full px-2 py-1 transition-colors",
                                                                                                    "hover:bg-[#0D7377]/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0D7377]/30",
                                                                                                    "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                                                                                                )}
                                                                                            >
                                                                                                <span>Cat.</span>
                                                                                                <span
                                                                                                    aria-hidden="true"
                                                                                                    className={cn(
                                                                                                        "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors",
                                                                                                        allVisibleAreCategorical ? "bg-[#0D7377]" : "bg-[#E8E6E1]"
                                                                                                    )}
                                                                                                >
                                                                                                    <span
                                                                                                        className={cn(
                                                                                                            "pointer-events-none inline-block h-3 w-3 rounded-full bg-white shadow-sm transition-transform",
                                                                                                            allVisibleAreCategorical ? "translate-x-[14px]" : "translate-x-[2px]"
                                                                                                        )}
                                                                                                    />
                                                                                                </span>
                                                                                                <span className="sr-only">
                                                                                                    {allVisibleAreCategorical ? "Tout désélectionner" : "Tout sélectionner"}
                                                                                                </span>
                                                                                            </button>
                                                                                        </th>
                                                                                        <th className="whitespace-nowrap px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">Type</th>
                                                                                        <th className="whitespace-nowrap px-4 py-3 text-right text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">Distincts</th>
                                                                                        <th className="whitespace-nowrap px-4 py-3 text-right text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">Définitions</th>
                                                                                        <th className="whitespace-nowrap px-4 py-3 text-right text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">Vecteurs</th>
                                                                </tr>
                                                                                </thead>
                                                                                <tbody className="divide-y divide-[#E8E6E1]/60">
                                                                                    {filteredDialogColumns.map((columnName) => {
                                                                                        const draft = currentColumnDrafts[columnName] || {
                                                                                            description: '',
                                                                                            is_categorical: false,
                                                                                            type: inferColumnType(columnName)
                                                                                        };
                                                                                        const embInfo = embeddingsByColumn[columnName];
                                                                                        const distinctCount = embInfo?.distinct_values?.length || 0;
                                                                                        const definitionCount = embInfo?.definition_values?.length || 0;
                                                                                        const embeddedCount = embInfo?.embedded_vectors_count ?? embInfo?.embedded_values?.length ?? 0;

                                                                                        return (
                                                                                            <tr
                                                                                                key={columnName}
                                                                                                onClick={() => {
                                                                                                    setSelectedWorkbenchColumn(columnName);
                                                                                                    setColumnDetailTab('samples');
                                                                                                    setDefRefineText('');
                                                                                                    setDefRefineChanges([]);
                                                                                                    setDefRefineAccepted({});
                                                                                                    setColumnDetailColumn(columnName);
                                                                                                }}
                                                                                                className={cn(
                                                                                                    "cursor-pointer transition-colors",
                                                                                                    effectiveWorkbenchColumn === columnName
                                                                                                        ? "bg-[#0D7377]/5"
                                                                                                        : "hover:bg-[#F8F7F4]"
                                                                                                )}
                                                                                            >
                                                                                                <td className="whitespace-nowrap px-4 py-2.5">
                                                                                                    <span className="text-[13px] font-semibold text-[#2B2B2B]">{columnName}</span>
                                                                                                </td>
                                                                                                <td className="max-w-[280px] px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                                                                                                    <input
                                                                                                        type="text"
                                                                                                        value={draft.description || ''}
                                                                                                        onChange={(e) => updateColumnDraft(columnName, { description: e.target.value })}
                                                                                                        placeholder="Description métier…"
                                                                                                        className="w-full bg-transparent text-[12px] text-[#6B6966] placeholder:italic placeholder:text-[#C4C2BD] focus:outline-none focus:ring-1 focus:ring-[#0D7377]/30 rounded px-1 py-0.5 -mx-1"
                                                                                                    />
                                                                                                </td>
                                                                                                <td className="px-4 py-2.5 text-center">
                                                                                                    <button
                                                                                                        type="button"
                                                                                                        onClick={(e) => { e.stopPropagation(); updateColumnDraft(columnName, { is_categorical: !draft.is_categorical }); }}
                                                                                                        className={cn(
                                                                                                            "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0D7377]/30",
                                                                                                            draft.is_categorical ? "bg-[#0D7377]" : "bg-[#E8E6E1]"
                                                                                                        )}
                                                                                                    >
                                                                                                        <span
                                                                                                            className={cn(
                                                                                                                "pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform",
                                                                                                                draft.is_categorical ? "translate-x-[18px]" : "translate-x-[3px]"
                                                                                                            )}
                                                                                                        />
                                                                                                    </button>
                                                                                                </td>
                                                                                                <td className="whitespace-nowrap px-4 py-2.5">
                                                                                                    <span className="rounded-full border border-[#E8E6E1] bg-[#F8F7F4] px-2 py-0.5 text-[11px] font-medium text-[#6B6966]">
                                                                                                        {draft.type || inferColumnType(columnName)}
                                                                                                    </span>
                                                                                                </td>
                                                                                                <td className="whitespace-nowrap px-4 py-2.5 text-right">
                                                                                                    <span className={cn("tabular-nums text-[12px] font-medium", distinctCount > 0 ? "text-[#0D7377]" : "text-[#C4C2BD]")}>
                                                                                                        {distinctCount}
                                                                                                    </span>
                                                                                                </td>
                                                                                                <td className="whitespace-nowrap px-4 py-2.5 text-right">
                                                                                                    <span className={cn("tabular-nums text-[12px] font-medium", definitionCount > 0 ? "text-[#E8725A]" : "text-[#C4C2BD]")}>
                                                                                                        {definitionCount}
                                                                                                    </span>
                                                                                                </td>
                                                                                                <td className="whitespace-nowrap px-4 py-2.5 text-right">
                                                                                                    <span className={cn("tabular-nums text-[12px] font-medium", embeddedCount > 0 ? "text-cyan-700" : "text-[#C4C2BD]")}>
                                                                                                        {embeddedCount}
                                                                                                    </span>
                                                                                                </td>
                                                                                            </tr>
                                                                                        );
                                                                                    })}
                                                        </tbody>
                                                    </table>
                                                </div>
                                                                    </div>
                                                                )}
                                                            </>
                                                        )}
                                                    </div>
                                                ) : (
                                                    <div className="space-y-5">
                                                        {(isLoadingData || isLoadingEmbeddings) && !embeddingsData?.columns?.length ? (
                                                            <div className="grid gap-4 md:grid-cols-2">
                                                                {[...Array(4)].map((_, index) => (
                                                                    <div key={index} className="h-40 animate-pulse rounded-[28px] bg-[#E8E6E1]/70" />
                                                                ))}
                                                                <p className="col-span-full text-center text-xs text-[#A09E99]">Chargement des embeddings…</p>
                                                    </div>
                                                        ) : embeddingsData?.columns?.length ? (
                                                            <div className="grid gap-4 md:grid-cols-2">
                                                        {embeddingsData.columns.map(col => (
                                                                    <Card key={col.column_name} className="rounded-[28px] border border-[#E8E6E1] bg-white p-5">
                                                                        <div className="flex items-start justify-between gap-3">
                                                                            <div>
                                                                                <p className="text-[10px] font-semibold uppercase tracking-[0.26em] text-[#A09E99]">Colonne vectorisée</p>
                                                                                <h5 className="mt-2 text-base font-semibold text-[#2B2B2B]">{col.column_name}</h5>
                                                                </div>
                                                                            <span className="rounded-full border border-cyan-500/20 bg-cyan-500/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-cyan-900">
                                                                                Embeddings OK
                                                                            </span>
                                                                        </div>
                                                                        <div className="mt-5 space-y-3">
                                                                            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">
                                                                                Valeurs distinctes ({col.distinct_values?.length || 0})
                                                                            </p>
                                                                            <div className="flex flex-wrap gap-2">
                                                                                {(col.distinct_values || []).slice(0, 10).map((value, index) => (
                                                                                    <span key={index} className="max-w-[170px] truncate rounded-full border border-[#E8E6E1] bg-white px-3 py-1.5 text-[11px] font-medium text-[#4A4845]">
                                                                                        {String(value)}
                                                                                    </span>
                                                                                ))}
                                                                                {col.distinct_values?.length > 10 && (
                                                                                    <span className="self-center text-[11px] font-medium text-[#A09E99]">
                                                                                        +{col.distinct_values.length - 10} autres
                                                                                    </span>
                                                                                )}
                                                                    </div>
                                                                </div>
                                                            </Card>
                                                        ))}
                                                    </div>
                                                ) : (
                                                            <div className="rounded-[28px] border border-dashed border-[#E8E6E1] bg-white px-6 py-16 text-center">
                                                                <Cpu className="mx-auto h-12 w-12 text-[#A09E99]" />
                                                                <h5 className="mt-5 text-lg font-semibold text-[#2B2B2B]">Aucun embedding détecté</h5>
                                                                <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-[#A09E99]">
                                                                    Les vecteurs catégoriels n’ont pas encore été générés pour cette sélection. Ouvrez “Colonnes” pour marquer les champs catégoriels puis lancez la génération.
                                                                </p>
                                                                <Button
                                                                    variant="outline"
                                                                    className="mt-6 rounded-full border-[#E8E6E1] bg-white px-5 font-semibold text-[#2B2B2B] hover:bg-[#2B2B2B] hover:text-white"
                                                                    onClick={openColumnsDialog}
                                                                    disabled={!canEditColumns}
                                                                >
                                                                    Ouvrir l’éditeur de colonnes
                                                                </Button>
                                                        </div>
                                                )}
                                            </div>
                                        )}
                                            </div>
                                        </section>

                                                </div>

                                </div>
                            </motion.div>
                        )}
                        {activeTab === 'skills' && (
                            <motion.div
                                key="skills"
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                className="space-y-8"
                            >
                                <div className="space-y-8">
                                {/* Header */}
                                <div className="flex items-center justify-between">
                                                <div>
                                        <h3 className="settings-display text-2xl text-[#2B2B2B]">Skills</h3>
                                        <p className="text-sm text-[#6B6966] mt-1">
                                            Gérez les compétences spécialisées de l'agent. Chaque skill est un guide Markdown stocké dans <code className="settings-mono text-xs bg-[#F8F7F4] px-1.5 py-0.5 rounded border border-[#E8E6E1]">prompts/skills/</code>.
                                        </p>
                                                </div>
                                    <div className="flex gap-2">
                                        <Button variant="outline" className="rounded-xl font-semibold gap-2 border-[#E8E6E1] text-[#6B6966] hover:bg-[#F8F7F4] hover:text-[#2B2B2B]" onClick={fetchSkillsList} disabled={isLoadingSkills}>
                                            <RefreshCw className={cn("h-4 w-4", isLoadingSkills && "animate-spin")} />
                                            Rafraîchir
                                        </Button>
                                        <Button className="rounded-xl font-semibold gap-2 bg-[#0D7377] text-white hover:bg-[#0B6164]" onClick={() => openCreateSkillDialog(false)}>
                                            <Plus className="h-4 w-4" />
                                            Nouveau skill
                                        </Button>
                                        <Button className="rounded-xl font-semibold gap-2 bg-gradient-to-r from-[#E8725A] to-[#D4613D] text-white hover:from-[#D4613D] hover:to-[#C0512F] shadow-sm" onClick={() => openCreateSkillDialog(true)}>
                                            <Sparkles className="h-4 w-4" />
                                            Créer avec IA
                                        </Button>
                                    </div>
                                </div>

                                {/* Skill creation — opens in a full-screen dialog ("new window"
                                    inside the SPA), mirroring the edit-skill dialog below.
                                    Left column: the regular Nouveau Skill form (name, repertoire,
                                    description, DTO multi-select, markdown).
                                    Right column: the AI creation chat that can produce a draft and
                                    pre-fill the form fields on demand. The form and the chat share
                                    the same dialog so the user can iterate between manual edits
                                    and AI suggestions before pressing "Créer le skill". */}
                                <Dialog open={isCreatingSkill} onOpenChange={(open) => { if (!open) closeCreateSkillDialog(); }}>
                                    <DialogContent
                                        className="!max-w-[1400px] w-[96vw] h-[92vh] p-0 flex flex-col overflow-hidden gap-0"
                                    >
                                        <DialogHeader className="border-b border-[#E8E6E1] bg-gradient-to-r from-[#0D7377]/5 to-transparent px-6 py-4">
                                            <div className="flex items-center justify-between">
                                                <div className="flex items-center gap-3 min-w-0">
                                                    <div className="h-9 w-9 rounded-xl bg-[#0D7377] flex items-center justify-center text-white shrink-0">
                                                        <Plus className="h-4 w-4" />
                                                    </div>
                                                    <div className="min-w-0">
                                                        <DialogTitle className="text-base font-semibold text-[#2B2B2B] truncate">
                                                            Nouveau Skill
                                                        </DialogTitle>
                                                        <DialogDescription className="text-[11px] text-[#6B6966] settings-mono truncate mt-0.5">
                                                            prompts/skills/{newSkillForm.directory_name || newSkillForm.name || '<répertoire>'}/SKILL.md
                                                        </DialogDescription>
                                                    </div>
                                                </div>
                                            </div>
                                        </DialogHeader>

                                        <div className="flex-1 grid grid-cols-1 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] min-h-0 overflow-hidden">
                                            {/* Left: creation form */}
                                            <div className="flex flex-col min-h-0 border-r border-[#E8E6E1]">
                                                <div className="flex-1 overflow-y-auto p-6 space-y-4">
                                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                                        <div>
                                                            <label className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">Nom</label>
                                                            <Input
                                                                value={newSkillForm.name}
                                                                onChange={e => setNewSkillForm(p => ({ ...p, name: e.target.value }))}
                                                                placeholder="mon-nouveau-skill"
                                                                className="mt-1"
                                                            />
                                                        </div>
                                                        <div>
                                                            <label className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">Répertoire</label>
                                                            <Input
                                                                value={newSkillForm.directory_name}
                                                                onChange={e => setNewSkillForm(p => ({ ...p, directory_name: e.target.value }))}
                                                                placeholder="nom_repertoire (optionnel)"
                                                                className="mt-1"
                                                            />
                                                        </div>
                                                    </div>

                                                    <div>
                                                        <label className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">Description</label>
                                                        <Textarea
                                                            value={newSkillForm.description}
                                                            onChange={e => setNewSkillForm(p => ({ ...p, description: e.target.value }))}
                                                            placeholder="Description du skill..."
                                                            className="mt-1 min-h-[80px]"
                                                        />
                                                    </div>

                                                    <div>
                                                        <div className="flex items-center justify-between">
                                                            <label className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">
                                                                DTOs associés
                                                            </label>
                                                            <span className="text-[10px] text-[#A09E99]">
                                                                {newSkillForm.dtos.length > 0
                                                                    ? `${newSkillForm.dtos.length} sélectionné(s)`
                                                                    : 'Aucune sélection'}
                                                            </span>
                                                        </div>

                                                        {newSkillForm.dtos.length > 0 && (
                                                            <div className="flex flex-wrap gap-1.5 mt-2 mb-2">
                                                                {newSkillForm.dtos.map(dirName => {
                                                                    const meta = skillDtosList.find(d => d.directory_name === dirName);
                                                                    const label = meta?.slug || dirName;
                                                                    return (
                                                                        <button
                                                                            key={dirName}
                                                                            type="button"
                                                                            onClick={() => setNewSkillForm(p => ({
                                                                                ...p,
                                                                                dtos: p.dtos.filter(d => d !== dirName),
                                                                            }))}
                                                                            className="inline-flex items-center gap-1.5 rounded-md border border-[#0D7377]/30 bg-[#0D7377]/10 px-2 py-0.5 text-[11px] font-medium text-[#0D7377] hover:bg-[#0D7377]/15"
                                                                            title={`Retirer ${label}`}
                                                                        >
                                                                            {label}
                                                                            <X className="h-3 w-3" />
                                                                        </button>
                                                                    );
                                                                })}
                                                            </div>
                                                        )}

                                                        <div className="mt-1 rounded-lg border border-[#E8E6E1] bg-white overflow-hidden">
                                                            <div className="border-b border-[#E8E6E1] bg-[#F8F7F4] px-3 py-2 flex items-center gap-2">
                                                                <Search className="h-3.5 w-3.5 text-[#A09E99] shrink-0" />
                                                                <input
                                                                    type="text"
                                                                    value={dtoFilter}
                                                                    onChange={e => setDtoFilter(e.target.value)}
                                                                    placeholder={isLoadingSkillDtos ? 'Chargement des DTOs…' : 'Rechercher un DTO…'}
                                                                    className="flex-1 bg-transparent text-[12px] text-[#2B2B2B] placeholder:text-[#A09E99] focus:outline-none"
                                                                />
                                                                {dtoFilter && (
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => setDtoFilter('')}
                                                                        className="text-[10px] text-[#A09E99] hover:text-[#2B2B2B]"
                                                                    >
                                                                        Effacer
                                                                    </button>
                                                                )}
                                                            </div>
                                                            <div className="max-h-[200px] overflow-y-auto divide-y divide-[#E8E6E1]/60">
                                                                {skillDtosList.length === 0 ? (
                                                                    <div className="px-3 py-4 text-center text-[11px] text-[#A09E99]">
                                                                        {isLoadingSkillDtos
                                                                            ? 'Chargement…'
                                                                            : (
                                                                                <>
                                                                                    Aucun DTO disponible.<br />
                                                                                    Configurez d'abord une source dans <span className="font-semibold">Données</span>.
                                                                                </>
                                                                            )}
                                                                    </div>
                                                                ) : (
                                                                    skillDtosList
                                                                        .filter(d => {
                                                                            const q = dtoFilter.trim().toLowerCase();
                                                                            if (!q) return true;
                                                                            return d.slug.toLowerCase().includes(q)
                                                                                || d.directory_name.toLowerCase().includes(q)
                                                                                || (d.file_description || '').toLowerCase().includes(q);
                                                                        })
                                                                        .map(d => {
                                                                            const selected = newSkillForm.dtos.includes(d.directory_name);
                                                                            return (
                                                                                <button
                                                                                    key={d.directory_name}
                                                                                    type="button"
                                                                                    onClick={() => setNewSkillForm(p => ({
                                                                                        ...p,
                                                                                        dtos: selected
                                                                                            ? p.dtos.filter(x => x !== d.directory_name)
                                                                                            : [...p.dtos, d.directory_name],
                                                                                    }))}
                                                                                    className={cn(
                                                                                        "w-full flex items-start gap-2.5 px-3 py-2 text-left transition-colors",
                                                                                        selected
                                                                                            ? "bg-[#0D7377]/8 hover:bg-[#0D7377]/12"
                                                                                            : "hover:bg-[#F8F7F4]"
                                                                                    )}
                                                                                >
                                                                                    <span
                                                                                        className={cn(
                                                                                            "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                                                                                            selected
                                                                                                ? "border-[#0D7377] bg-[#0D7377] text-white"
                                                                                                : "border-[#E8E6E1] bg-white text-transparent"
                                                                                        )}
                                                                                    >
                                                                                        {selected && <CheckCircle2 className="h-3 w-3" />}
                                                                                    </span>
                                                                                    <span className="min-w-0 flex-1">
                                                                                        <span className="block settings-mono text-[12px] font-semibold text-[#2B2B2B] truncate">
                                                                                            {d.slug}
                                                                                        </span>
                                                                                        <span className="block text-[10px] text-[#6B6966] line-clamp-2 leading-snug">
                                                                                            {d.file_description || 'Aucune description renseignée pour ce DTO.'}
                                                                                        </span>
                                                                                    </span>
                                                                                </button>
                                                                            );
                                                                        })
                                                                )}
                                                            </div>
                                                        </div>
                                                        <p className="text-[10px] text-[#A09E99] mt-1.5">
                                                            Les DTOs sélectionnés deviennent les déclencheurs du skill — le routeur le proposera quand l'utilisateur travaille avec ces jeux de données.
                                                        </p>
                                                    </div>

                                                    <div>
                                                        <label className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">Contenu Markdown (SKILL.md)</label>
                                                        <Textarea
                                                            value={newSkillForm.content_body}
                                                            onChange={e => setNewSkillForm(p => ({ ...p, content_body: e.target.value }))}
                                                            placeholder="# Mon Skill&#10;&#10;Guide détaillé..."
                                                            className="mt-1 min-h-[280px] font-mono text-xs leading-relaxed"
                                                        />
                                                    </div>
                                                </div>

                                                <div className="flex items-center justify-between gap-3 border-t border-[#E8E6E1] bg-[#F8F7F4]/60 px-6 py-3">
                                                    <p className="text-[10px] text-[#6B6966] truncate">
                                                        Fichier : <code className="bg-white px-1 rounded border border-[#E8E6E1]">prompts/skills/{newSkillForm.directory_name || newSkillForm.name || '<répertoire>'}/SKILL.md</code>
                                                    </p>
                                                    <div className="flex gap-2 shrink-0">
                                                        <Button variant="ghost" onClick={closeCreateSkillDialog}>Annuler</Button>
                                                        {/* Button is enabled whenever the user has either
                                                            something in the form OR a conversation with the
                                                            assistant. The unified handler picks the best
                                                            available source on click (draft / finalize / form). */}
                                                        <Button
                                                            onClick={handleCreateSkillUnified}
                                                            disabled={
                                                                isSavingSkill
                                                                || isAiSkillLoading
                                                                || (!newSkillForm.name.trim()
                                                                    && !aiSkillDraft
                                                                    && !aiSkillInput.trim()
                                                                    && !aiSkillMessages.some(m => m.content.trim().length > 0))
                                                            }
                                                            className="font-bold gap-2 bg-[#0D7377] hover:bg-[#0B6164] text-white"
                                                        >
                                                            {isSavingSkill || isAiSkillLoading
                                                                ? <Loader2 className="h-4 w-4 animate-spin" />
                                                                : <Save className="h-4 w-4" />}
                                                            {isSavingSkill
                                                                ? 'Création...'
                                                                : isAiSkillLoading
                                                                    ? 'Finalisation...'
                                                                    : aiSkillDraft
                                                                        ? 'Créer (depuis IA)'
                                                                        : (aiSkillInput.trim()
                                                                            || aiSkillMessages.some(m => m.content.trim().length > 0))
                                                                            ? 'Finaliser & créer'
                                                                            : 'Créer le skill'}
                                                        </Button>
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Right: AI creation chat */}
                                            <div className="flex flex-col min-h-0 bg-[#FAFAF8]">
                                                <div className="flex items-start gap-3 px-5 py-3 border-b border-[#E8E6E1] bg-gradient-to-r from-[#E8725A]/5 to-transparent">
                                                    <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-[#E8725A] to-[#D4613D] flex items-center justify-center shrink-0">
                                                        <Sparkles className="h-4 w-4 text-white" />
                                                    </div>
                                                    <div className="min-w-0 flex-1">
                                                        <h4 className="font-semibold text-sm text-[#2B2B2B]">Assistant IA — Création</h4>
                                                        <p className="text-[11px] text-[#6B6966] leading-tight">
                                                            Décrivez votre besoin, l'IA produira un brouillon que vous pourrez appliquer au formulaire.
                                                        </p>
                                                        {/* Grounding indicator: when the user has ticked DTOs in
                                                            the left form, surface them as chips so they can see
                                                            the assistant is actually scoped on those datasets.
                                                            When empty we render a subtle hint to drive the user
                                                            to the multi-select. */}
                                                        {newSkillForm.dtos.length > 0 ? (
                                                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                                                <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.15em] text-[#0D7377]">
                                                                    <Database className="h-3 w-3" />
                                                                    DTOs ciblés
                                                                </span>
                                                                {newSkillForm.dtos.map(dirName => {
                                                                    const meta = skillDtosList.find(d => d.directory_name === dirName);
                                                                    const label = meta?.slug || dirName;
                                                                    return (
                                                                        <span
                                                                            key={dirName}
                                                                            title={meta?.file_description || `${dirName} — ancré dans le prompt système`}
                                                                            className="inline-flex items-center gap-1 rounded-md border border-[#0D7377]/30 bg-[#0D7377]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#0D7377]"
                                                                        >
                                                                            {label}
                                                                        </span>
                                                                    );
                                                                })}
                                                            </div>
                                                        ) : (
                                                            <p className="mt-2 text-[10px] text-[#A09E99] italic">
                                                                Aucun DTO sélectionné — l'IA n'aura aucune connaissance du schéma. Cochez un ou plusieurs DTOs à gauche pour l'ancrer.
                                                            </p>
                                                        )}
                                                    </div>
                                                </div>

                                                <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
                                                    {aiSkillMessages.length === 0 && (
                                                        <div className="flex flex-col items-center justify-center text-center space-y-3 py-6">
                                                            <div className="h-14 w-14 rounded-2xl bg-[#E8725A]/10 flex items-center justify-center">
                                                                <MessageSquare className="h-7 w-7 text-[#E8725A]/60" />
                                                            </div>
                                                            <div>
                                                                <p className="font-semibold text-sm text-[#2B2B2B]">Comment puis-je vous aider ?</p>
                                                                <p className="text-xs text-[#6B6966] mt-1 max-w-sm">
                                                                    {newSkillForm.dtos.length > 0
                                                                        ? "L'IA voit déjà le schéma des DTOs sélectionnés. Décrivez quels axes d'analyse vous voulez."
                                                                        : "Décrivez le cas d'usage. Pour un meilleur résultat, sélectionnez d'abord les DTOs à gauche."}
                                                                </p>
                                                            </div>
                                                            <div className="flex flex-col gap-1.5 w-full max-w-md">
                                                                {(newSkillForm.dtos.length > 0
                                                                    ? [
                                                                        "Construis un skill d'analyse de l'évolution mensuelle des indicateurs principaux.",
                                                                        "Crée un skill orienté segmentation clientèle à partir des colonnes catégorielles.",
                                                                        "Conçois un skill de détection d'anomalies sur les mesures numériques.",
                                                                      ]
                                                                    : [
                                                                        "Créer un skill d'analyse financière pour les comités de direction",
                                                                        "Un skill pour analyser les tendances de vente par région",
                                                                        "Expert en gestion de risque crédit bancaire",
                                                                      ]
                                                                ).map((suggestion, i) => (
                                                                    <button
                                                                        key={i}
                                                                        className="text-left text-xs px-3 py-2 rounded-lg border border-[#E8E6E1] bg-white text-[#6B6966] hover:border-[#E8725A]/40 hover:text-[#E8725A] transition-all"
                                                                        onClick={() => setAiSkillInput(suggestion)}
                                                                    >
                                                                        {suggestion}
                                                                    </button>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    )}

                                                    {aiSkillMessages.map((msg, idx) => (
                                                        <div key={idx} className={cn("flex gap-2", msg.role === 'user' ? "justify-end" : "justify-start")}>
                                                            {msg.role === 'assistant' && (
                                                                <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-[#E8725A] to-[#D4613D] flex items-center justify-center flex-shrink-0 mt-0.5">
                                                                    <Bot className="h-3.5 w-3.5 text-white" />
                                                                </div>
                                                            )}
                                                            <div className={cn(
                                                                "max-w-[88%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed",
                                                                msg.role === 'user'
                                                                    ? "bg-[#0D7377] text-white rounded-br-md"
                                                                    : "bg-white border border-[#E8E6E1] text-[#2B2B2B] rounded-bl-md shadow-sm"
                                                            )}>
                                                                <div className="whitespace-pre-wrap">{msg.content.replace(/```skill[\s\S]*?```/g, '').trim() || msg.content}</div>
                                                            </div>
                                                        </div>
                                                    ))}

                                                    {isAiSkillLoading && (
                                                        <div className="flex gap-2 justify-start">
                                                            <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-[#E8725A] to-[#D4613D] flex items-center justify-center flex-shrink-0 mt-0.5">
                                                                <Bot className="h-3.5 w-3.5 text-white" />
                                                            </div>
                                                            <div className="bg-white border border-[#E8E6E1] rounded-2xl rounded-bl-md px-3.5 py-2.5 shadow-sm">
                                                                <div className="flex gap-1.5">
                                                                    <span className="h-2 w-2 rounded-full bg-[#E8725A]/60 animate-bounce" style={{ animationDelay: '0ms' }} />
                                                                    <span className="h-2 w-2 rounded-full bg-[#E8725A]/60 animate-bounce" style={{ animationDelay: '150ms' }} />
                                                                    <span className="h-2 w-2 rounded-full bg-[#E8725A]/60 animate-bounce" style={{ animationDelay: '300ms' }} />
                                                                </div>
                                                            </div>
                                                        </div>
                                                    )}
                                                    <div ref={aiChatEndRef} />
                                                </div>

                                                {/* Draft apply bar — preview the AI's draft and let the
                                                    user choose between (a) pre-filling the left form for
                                                    manual review (preferred) or (b) one-click creating
                                                    the skill straight from the draft. */}
                                                {aiSkillDraft && (
                                                    <div className="px-5 py-3 border-t border-[#E8E6E1] bg-[#0D7377]/5 space-y-2">
                                                        <div className="flex items-center gap-2">
                                                            <CheckCircle2 className="h-4 w-4 text-[#0D7377]" />
                                                            <span className="font-semibold text-sm text-[#0D7377]">Brouillon prêt</span>
                                                        </div>
                                                        <div className="grid grid-cols-1 gap-1 text-[11px]">
                                                            <div className="truncate">
                                                                <span className="text-[#6B6966]">Nom :</span>{' '}
                                                                <span className="font-medium text-[#2B2B2B]">{aiSkillDraft.name}</span>
                                                            </div>
                                                            <div className="truncate">
                                                                <span className="text-[#6B6966]">Répertoire :</span>{' '}
                                                                <code className="text-[10px] bg-[#F8F7F4] px-1.5 py-0.5 rounded border border-[#E8E6E1]">{aiSkillDraft.directory_name}</code>
                                                            </div>
                                                            {aiSkillDraft.aliases.length > 0 && (
                                                                <div className="flex flex-wrap gap-1 items-center">
                                                                    <span className="text-[#6B6966]">Aliases :</span>
                                                                    {aiSkillDraft.aliases.map((a, i) => (
                                                                        <span key={i} className="px-1.5 py-0.5 rounded bg-[#E8725A]/10 text-[#E8725A] text-[10px] font-medium">{a}</span>
                                                                    ))}
                                                                </div>
                                                            )}
                                                        </div>
                                                        <div className="flex flex-wrap gap-2 pt-1">
                                                            <Button
                                                                onClick={handleAiSkillApply}
                                                                className="font-semibold gap-2 bg-[#0D7377] hover:bg-[#0B6164] text-white"
                                                                size="sm"
                                                            >
                                                                <CheckCircle2 className="h-3.5 w-3.5" />
                                                                Appliquer dans le formulaire
                                                            </Button>
                                                            <Button
                                                                onClick={handleAiSkillCreate}
                                                                disabled={isAiSkillCreating}
                                                                variant="outline"
                                                                className="font-semibold gap-2 border-[#0D7377]/30 text-[#0D7377] hover:bg-[#0D7377]/5"
                                                                size="sm"
                                                            >
                                                                <Save className="h-3.5 w-3.5" />
                                                                {isAiSkillCreating ? 'Création...' : 'Créer directement'}
                                                            </Button>
                                                            <Button
                                                                variant="ghost"
                                                                className="font-semibold text-[#6B6966]"
                                                                onClick={() => setAiSkillDraft(null)}
                                                                size="sm"
                                                            >
                                                                Continuer
                                                            </Button>
                                                        </div>
                                                    </div>
                                                )}

                                                <div className="px-5 py-3 border-t border-[#E8E6E1] bg-white">
                                                    {/* Multi-line chat input. ``<Input>`` is single-line and
                                                        was eating Shift+Enter — swapped to a textarea so:
                                                          - Enter sends (existing behaviour),
                                                          - Shift+Enter inserts a literal newline,
                                                          - the box auto-grows up to a sensible cap
                                                            so long prompts don't shove the rest of the
                                                            chat off-screen. */}
                                                    <div className="flex items-end gap-2">
                                                        <Textarea
                                                            data-skill-create-ai-input
                                                            ref={aiSkillInputRef}
                                                            value={aiSkillInput}
                                                            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setAiSkillInput(e.target.value)}
                                                            onInput={(e: React.FormEvent<HTMLTextAreaElement>) => resizeSkillChatTextarea(e.currentTarget)}
                                                            onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => handleSkillChatKeyDown(e, handleAiSkillSend)}
                                                            placeholder="Décrivez le skill que vous souhaitez créer… (Shift+Entrée pour un saut de ligne)"
                                                            className="flex-1 min-h-[64px] max-h-[180px] resize-none overflow-y-auto rounded-xl border-[#E8E6E1] focus:border-[#E8725A] focus:ring-[#E8725A]/20 leading-snug text-sm"
                                                            rows={2}
                                                            disabled={isAiSkillLoading}
                                                        />
                                                        <Button
                                                            onClick={handleAiSkillSend}
                                                            disabled={isAiSkillLoading || !aiSkillInput.trim()}
                                                            className="rounded-xl bg-[#E8725A] hover:bg-[#D4613D] text-white px-4 h-[42px] shrink-0"
                                                        >
                                                            <Send className="h-4 w-4" />
                                                        </Button>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </DialogContent>
                                </Dialog>

                                {/* Skills list */}
                                {isLoadingSkills ? (
                                    <div className="flex items-center justify-center py-20">
                                        <RefreshCw className="h-6 w-6 animate-spin text-[#0D7377]" />
                                        <span className="ml-3 text-sm text-[#6B6966] font-medium">Chargement des skills...</span>
                                    </div>
                                ) : skillsList.length === 0 ? (
                                    <Card className="p-12 flex flex-col items-center justify-center text-center border-[#E8E6E1] bg-white">
                                        <BookOpen className="h-12 w-12 text-[#A09E99]/40 mb-4" />
                                        <h4 className="font-semibold text-lg text-[#2B2B2B]">Aucun skill configuré</h4>
                                        <p className="text-sm text-[#6B6966] mt-1 max-w-md">
                                            Créez votre premier skill pour enrichir les compétences de l'agent avec des guides spécialisés.
                                        </p>
                                    </Card>
                                ) : (
                                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                        {skillsList.map(skill => (
                                            <Card
                                                key={skill.directory_name}
                                                className={cn(
                                                    "p-5 border-[#E8E6E1] bg-white hover:bg-[#F8F7F4] transition-all cursor-pointer group",
                                                    editingSkill?.directory_name === skill.directory_name && "ring-2 ring-[#0D7377] border-[#0D7377]/40"
                                                )}
                                                onClick={() => openSkillEditor(skill.directory_name)}
                                            >
                                                <div className="flex items-start justify-between gap-3">
                                                    <div className="flex items-start gap-3 min-w-0">
                                                        <div className="h-10 w-10 rounded-xl bg-[#0D7377]/10 flex items-center justify-center text-[#0D7377] shrink-0 group-hover:bg-[#0D7377] group-hover:text-white transition-all">
                                                            <FileText className="h-5 w-5" />
                                                        </div>
                                                        <div className="min-w-0">
                                                            <h4 className="font-semibold text-sm truncate text-[#2B2B2B]">{skill.name}</h4>
                                                            <p className="text-[10px] text-[#A09E99] settings-mono mt-0.5">{skill.directory_name}/</p>
                                                        </div>
                                                    </div>
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        className="h-8 w-8 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-[#E8725A] hover:text-[#E8725A] hover:bg-[#E8725A]/10"
                                                        onClick={e => { e.stopPropagation(); handleDeleteSkill(skill.directory_name); }}
                                                    >
                                                        <Trash2 className="h-4 w-4" />
                                                    </Button>
                                                </div>
                                                <p className="text-xs text-[#6B6966] mt-3 line-clamp-3">{skill.description || 'Aucune description'}</p>
                                                {skill.aliases?.length > 0 && (
                                                    <div className="flex flex-wrap gap-1 mt-3">
                                                        {skill.aliases.map(a => (
                                                            <span key={a} className="px-2 py-0.5 bg-[#F8F7F4] rounded-md text-[10px] font-medium text-[#6B6966] border border-[#E8E6E1]">
                                                                {a}
                                                            </span>
                                                        ))}
                                                    </div>
                                                )}
                                            </Card>
                                        ))}
                                    </div>
                                )}

                                {/* Skill editor — opens in a full-screen dialog ("new window" inside the SPA).
                                    Left column: the existing form fields. Right column: an AI-edit chat
                                    that lets the user instruct the LLM to modify *this* skill (the chat
                                    is anchored on ``editingSkill`` and clears whenever the user closes
                                    the dialog or switches to a different skill). */}
                                <Dialog open={!!editingSkill && !isCreatingSkill} onOpenChange={(open) => { if (!open) closeSkillEditor(); }}>
                                    <DialogContent
                                        className="!max-w-[1400px] w-[96vw] h-[92vh] p-0 flex flex-col overflow-hidden gap-0"
                                    >
                                        <DialogHeader className="border-b border-[#E8E6E1] bg-gradient-to-r from-[#0D7377]/5 to-transparent px-6 py-4">
                                            <div className="flex items-center justify-between">
                                                <div className="flex items-center gap-3 min-w-0">
                                                    <div className="h-9 w-9 rounded-xl bg-[#0D7377] flex items-center justify-center text-white shrink-0">
                                                        <Edit3 className="h-4 w-4" />
                                                    </div>
                                                    <div className="min-w-0">
                                                        <DialogTitle className="text-base font-semibold text-[#2B2B2B] truncate">
                                                            Éditer : {editingSkill?.name || ''}
                                                        </DialogTitle>
                                                        <DialogDescription className="text-[11px] text-[#6B6966] settings-mono truncate mt-0.5">
                                                            prompts/skills/{editingSkill?.directory_name || ''}/SKILL.md
                                                        </DialogDescription>
                                                    </div>
                                                </div>
                                            </div>
                                        </DialogHeader>

                                        {isLoadingSkillDetail || !editingSkill ? (
                                            <div className="flex-1 flex items-center justify-center">
                                                <RefreshCw className="h-5 w-5 animate-spin text-[#0D7377]" />
                                                <span className="ml-2 text-sm text-[#6B6966]">Chargement...</span>
                                            </div>
                                        ) : (
                                            <div className="flex-1 grid grid-cols-1 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] min-h-0 overflow-hidden">
                                                {/* Left: form */}
                                                <div className="flex flex-col min-h-0 border-r border-[#E8E6E1]">
                                                    <div className="flex-1 overflow-y-auto p-6 space-y-4">
                                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                                            <div>
                                                                <label className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">Nom</label>
                                                                <Input
                                                                    value={editingSkill.name}
                                                                    onChange={e => setEditingSkill(prev => prev ? { ...prev, name: e.target.value } : null)}
                                                                    className="mt-1"
                                                                />
                                                            </div>
                                                            <div>
                                                                <label className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">Répertoire</label>
                                                                <Input value={editingSkill.directory_name} disabled className="mt-1 opacity-60" />
                                                            </div>
                                                        </div>

                                                        <div>
                                                            <label className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">Description</label>
                                                            <Textarea
                                                                value={editingSkill.description}
                                                                onChange={e => setEditingSkill(prev => prev ? { ...prev, description: e.target.value } : null)}
                                                                className="mt-1 min-h-[80px]"
                                                            />
                                                        </div>

                                                        <div>
                                                            <label className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">Aliases (séparés par virgule)</label>
                                                            <Input
                                                                value={(editingSkill.aliases || []).join(', ')}
                                                                onChange={e => setEditingSkill(prev => prev ? { ...prev, aliases: e.target.value.split(',').map(a => a.trim()).filter(Boolean) } : null)}
                                                                className="mt-1"
                                                            />
                                                        </div>

                                                        <div>
                                                            <label className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">Contenu Markdown (SKILL.md)</label>
                                                            <Textarea
                                                                value={editingSkill.content_body}
                                                                onChange={e => setEditingSkill(prev => prev ? { ...prev, content_body: e.target.value } : null)}
                                                                className="mt-1 min-h-[420px] font-mono text-xs leading-relaxed"
                                                            />
                                                        </div>
                                                    </div>

                                                    <div className="flex items-center justify-between gap-3 border-t border-[#E8E6E1] bg-[#F8F7F4]/60 px-6 py-3">
                                                        <p className="text-[10px] text-[#6B6966] truncate">
                                                            Fichier : <code className="bg-white px-1 rounded border border-[#E8E6E1]">prompts/skills/{editingSkill.directory_name}/SKILL.md</code>
                                                        </p>
                                                        <div className="flex gap-2 shrink-0">
                                                            <Button variant="ghost" onClick={closeSkillEditor}>Annuler</Button>
                                                            <Button onClick={handleSaveSkill} disabled={isSavingSkill} className="font-bold gap-2 bg-[#0D7377] hover:bg-[#0B6164] text-white">
                                                                <Save className="h-4 w-4" />
                                                                {isSavingSkill ? 'Sauvegarde...' : 'Sauvegarder'}
                                                            </Button>
                                                        </div>
                                                    </div>
                                                </div>

                                                {/* Right: AI edit chat */}
                                                <div className="flex flex-col min-h-0 bg-[#FAFAF8]">
                                                    <div className="flex items-center gap-3 px-5 py-3 border-b border-[#E8E6E1] bg-gradient-to-r from-[#E8725A]/5 to-transparent">
                                                        <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-[#E8725A] to-[#D4613D] flex items-center justify-center shrink-0">
                                                            <Sparkles className="h-4 w-4 text-white" />
                                                        </div>
                                                        <div className="min-w-0">
                                                            <h4 className="font-semibold text-sm text-[#2B2B2B]">Modifier avec IA</h4>
                                                            <p className="text-[11px] text-[#6B6966] leading-tight">
                                                                Demandez à l'IA d'ajouter, retirer ou réécrire des parties de ce skill.
                                                            </p>
                                                        </div>
                                                    </div>

                                                    <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
                                                        {aiEditMessages.length === 0 && (
                                                            <div className="flex flex-col items-center justify-center text-center space-y-3 py-6">
                                                                <div className="h-14 w-14 rounded-2xl bg-[#E8725A]/10 flex items-center justify-center">
                                                                    <MessageSquare className="h-7 w-7 text-[#E8725A]/60" />
                                                                </div>
                                                                <div>
                                                                    <p className="font-semibold text-sm text-[#2B2B2B]">Que voulez-vous modifier ?</p>
                                                                    <p className="text-xs text-[#6B6966] mt-1 max-w-sm">
                                                                        L'IA voit déjà le contenu actuel — décrivez juste la modification souhaitée.
                                                                    </p>
                                                                </div>
                                                                <div className="flex flex-col gap-1.5 w-full max-w-md">
                                                                    {[
                                                                        "Ajoute une section 'Pièges courants' avec 3 exemples.",
                                                                        "Reformule la description pour la rendre plus concise.",
                                                                        "Ajoute l'alias 'reporting' et clarifie le format de sortie.",
                                                                    ].map((suggestion, i) => (
                                                                        <button
                                                                            key={i}
                                                                            className="text-left text-xs px-3 py-2 rounded-lg border border-[#E8E6E1] bg-white text-[#6B6966] hover:border-[#E8725A]/40 hover:text-[#E8725A] transition-all"
                                                                            onClick={() => setAiEditInput(suggestion)}
                                                                        >
                                                                            {suggestion}
                                                                        </button>
                                                                    ))}
                                                                </div>
                                                            </div>
                                                        )}

                                                        {aiEditMessages.map((msg, idx) => (
                                                            <div key={idx} className={cn("flex gap-2", msg.role === 'user' ? "justify-end" : "justify-start")}>
                                                                {msg.role === 'assistant' && (
                                                                    <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-[#E8725A] to-[#D4613D] flex items-center justify-center flex-shrink-0 mt-0.5">
                                                                        <Bot className="h-3.5 w-3.5 text-white" />
                                                                    </div>
                                                                )}
                                                                <div className={cn(
                                                                    "max-w-[88%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed",
                                                                    msg.role === 'user'
                                                                        ? "bg-[#0D7377] text-white rounded-br-md"
                                                                        : "bg-white border border-[#E8E6E1] text-[#2B2B2B] rounded-bl-md shadow-sm"
                                                                )}>
                                                                    <div className="whitespace-pre-wrap">{msg.content.replace(/```skill[\s\S]*?```/g, '').trim() || msg.content}</div>
                                                                </div>
                                                            </div>
                                                        ))}

                                                        {isAiEditLoading && (
                                                            <div className="flex gap-2 justify-start">
                                                                <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-[#E8725A] to-[#D4613D] flex items-center justify-center flex-shrink-0 mt-0.5">
                                                                    <Bot className="h-3.5 w-3.5 text-white" />
                                                                </div>
                                                                <div className="bg-white border border-[#E8E6E1] rounded-2xl rounded-bl-md px-3.5 py-2.5 shadow-sm">
                                                                    <div className="flex gap-1.5">
                                                                        <span className="h-2 w-2 rounded-full bg-[#E8725A]/60 animate-bounce" style={{ animationDelay: '0ms' }} />
                                                                        <span className="h-2 w-2 rounded-full bg-[#E8725A]/60 animate-bounce" style={{ animationDelay: '150ms' }} />
                                                                        <span className="h-2 w-2 rounded-full bg-[#E8725A]/60 animate-bounce" style={{ animationDelay: '300ms' }} />
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        )}
                                                        <div ref={aiEditChatEndRef} />
                                                    </div>

                                                    {/* Draft apply bar */}
                                                    {aiEditDraft && (
                                                        <div className="px-5 py-3 border-t border-[#E8E6E1] bg-[#0D7377]/5 space-y-2">
                                                            <div className="flex items-center gap-2">
                                                                <CheckCircle2 className="h-4 w-4 text-[#0D7377]" />
                                                                <span className="font-semibold text-sm text-[#0D7377]">Modifications prêtes à appliquer</span>
                                                            </div>
                                                            <p className="text-[11px] text-[#6B6966]">
                                                                L'IA propose une nouvelle version du SKILL.md. Cliquez pour pré-remplir le formulaire — rien n'est écrit avant que vous appuyiez sur « Sauvegarder ».
                                                            </p>
                                                            <div className="flex gap-2 pt-1">
                                                                <Button
                                                                    onClick={handleAiEditApply}
                                                                    className="font-semibold gap-2 bg-[#0D7377] hover:bg-[#0B6164] text-white"
                                                                    size="sm"
                                                                >
                                                                    <CheckCircle2 className="h-3.5 w-3.5" />
                                                                    Appliquer dans le formulaire
                                                                </Button>
                                                                <Button
                                                                    variant="outline"
                                                                    className="font-semibold gap-2 border-[#E8E6E1]"
                                                                    onClick={() => setAiEditDraft(null)}
                                                                    size="sm"
                                                                >
                                                                    Continuer la conversation
                                                                </Button>
                                                            </div>
                                                        </div>
                                                    )}

                                                    <div className="px-5 py-3 border-t border-[#E8E6E1] bg-white">
                                                        {/* Multi-line edit chat input (mirrors the creation
                                                            dialog): Enter sends, Shift+Enter inserts a
                                                            newline, auto-grows to a cap. */}
                                                        <div className="flex items-end gap-2">
                                                            <Textarea
                                                                ref={aiEditInputRef}
                                                                value={aiEditInput}
                                                                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setAiEditInput(e.target.value)}
                                                                onInput={(e: React.FormEvent<HTMLTextAreaElement>) => resizeSkillChatTextarea(e.currentTarget)}
                                                                onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => handleSkillChatKeyDown(e, handleAiEditSend)}
                                                                placeholder="Décrivez la modification… (Shift+Entrée pour un saut de ligne)"
                                                                className="flex-1 min-h-[64px] max-h-[180px] resize-none overflow-y-auto rounded-xl border-[#E8E6E1] focus:border-[#E8725A] focus:ring-[#E8725A]/20 leading-snug text-sm"
                                                                rows={2}
                                                                disabled={isAiEditLoading}
                                                            />
                                                            <Button
                                                                onClick={handleAiEditSend}
                                                                disabled={isAiEditLoading || !aiEditInput.trim()}
                                                                className="rounded-xl bg-[#E8725A] hover:bg-[#D4613D] text-white px-4 h-[42px] shrink-0"
                                                            >
                                                                <Send className="h-4 w-4" />
                                                            </Button>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                    </DialogContent>
                                </Dialog>
                                </div>
                            </motion.div>
                        )}

                        {activeTab === 'prompts' && (
                            <motion.div
                                key="prompts"
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                className="space-y-8"
                            >
                                {/* Header */}
                                <div className="flex items-center justify-between">
                                    <div>
                                        <h3 className="settings-display text-2xl text-[#2B2B2B]">Prompt Templates</h3>
                                        <p className="text-sm text-[#6B6966] mt-1">
                                            Éditez les prompts système utilisés par les flows et nodes. Utilisez l'IA pour améliorer vos prompts.
                                        </p>
                                    </div>
                                    <Button variant="outline" className="rounded-xl font-semibold gap-2 border-[#E8E6E1] text-[#6B6966] hover:bg-[#F8F7F4] hover:text-[#2B2B2B]" onClick={fetchTemplatesList} disabled={isLoadingTemplates}>
                                        <RefreshCw className={cn("h-4 w-4", isLoadingTemplates && "animate-spin")} />
                                        Rafraîchir
                                    </Button>
                                </div>

                                {/* Category filter */}
                                {templateCategories.length > 0 && (
                                    <div className="flex flex-wrap gap-2">
                                        <button
                                            onClick={() => setSelectedTemplateCategory(null)}
                                            className={cn(
                                                "rounded-lg px-3 py-1.5 text-xs font-semibold transition-all border",
                                                !selectedTemplateCategory ? "bg-[#0D7377] text-white border-[#0D7377]" : "bg-white text-[#6B6966] border-[#E8E6E1] hover:bg-[#F8F7F4]"
                                            )}
                                        >
                                            Tous
                                        </button>
                                        {templateCategories.map(cat => (
                                            <button
                                                key={cat}
                                                onClick={() => setSelectedTemplateCategory(cat)}
                                                className={cn(
                                                    "rounded-lg px-3 py-1.5 text-xs font-semibold transition-all border",
                                                    selectedTemplateCategory === cat ? "bg-[#0D7377] text-white border-[#0D7377]" : "bg-white text-[#6B6966] border-[#E8E6E1] hover:bg-[#F8F7F4]"
                                                )}
                                            >
                                                {cat}
                                            </button>
                                        ))}
                                    </div>
                                )}

                                {/* Templates list */}
                                {isLoadingTemplates ? (
                                    <div className="flex items-center justify-center py-20">
                                        <RefreshCw className="h-6 w-6 animate-spin text-[#0D7377]" />
                                    </div>
                                ) : templatesList.length === 0 ? (
                                    <Card className="p-12 border-[#E8E6E1] bg-white text-center">
                                        <MessageSquare className="h-10 w-10 text-[#C4C2BD] mx-auto mb-3" />
                                        <p className="text-sm text-[#6B6966]">Aucun template trouvé.</p>
                                    </Card>
                                ) : (
                                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                                        {templatesList.map(tpl => (
                                            <Card
                                                key={`${tpl.category}/${tpl.name}`}
                                                className={cn(
                                                    "p-4 border-[#E8E6E1] bg-white hover:bg-[#F8F7F4] transition-all cursor-pointer group",
                                                    editingTemplate?.category === tpl.category && editingTemplate?.name === tpl.name && "ring-2 ring-[#0D7377] border-[#0D7377]/40"
                                                )}
                                                onClick={() => openTemplateEditor(tpl.category, tpl.name)}
                                            >
                                                <div className="flex items-start justify-between">
                                                    <div className="flex items-center gap-2">
                                                        <FileText className="h-4 w-4 text-[#0D7377] shrink-0" />
                                                        <div>
                                                            <p className="font-semibold text-sm text-[#2B2B2B]">{tpl.name}</p>
                                                            <p className="text-[11px] text-[#A09E99] mt-0.5">{tpl.category}</p>
                                                        </div>
                                                    </div>
                                                    <Edit3 className="h-3.5 w-3.5 text-[#C4C2BD] group-hover:text-[#0D7377] transition-colors" />
                                                </div>
                                            </Card>
                                        ))}
                                    </div>
                                )}

                                {/* Template editor */}
                                {editingTemplate && (
                                    <Card className="p-6 border-[#0D7377]/20 bg-white space-y-4">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-3">
                                                <Edit3 className="h-5 w-5 text-[#0D7377]" />
                                                <h4 className="font-semibold text-lg text-[#2B2B2B]">{editingTemplate.category}/{editingTemplate.name}</h4>
                                            </div>
                                            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => { setEditingTemplate(null); setAiInstruction(''); }}>
                                                <X className="h-4 w-4" />
                                            </Button>
                                        </div>

                                        {isLoadingTemplateDetail ? (
                                            <div className="flex items-center justify-center py-10">
                                                <RefreshCw className="h-5 w-5 animate-spin text-[#0D7377]" />
                                            </div>
                                        ) : (
                                            <>
                                                <Textarea
                                                    value={editingTemplate.content}
                                                    onChange={e => setEditingTemplate(prev => prev ? { ...prev, content: e.target.value } : null)}
                                                    className="min-h-[400px] settings-mono text-xs leading-relaxed border-[#E8E6E1] bg-[#F8F7F4] focus:bg-white"
                                                />

                                                {/* AI Assist */}
                                                <div className="rounded-xl border border-[#E8E6E1] bg-gradient-to-r from-[#F8F7F4] to-[#F0EFEB] p-4 space-y-3">
                                                    <div className="flex items-center gap-2">
                                                        <Sparkles className="h-4 w-4 text-[#0D7377]" />
                                                        <span className="text-sm font-semibold text-[#2B2B2B]">Assistant IA</span>
                                                        <span className="text-[10px] text-[#A09E99]">— décrivez comment améliorer ce prompt</span>
                                                    </div>
                                                    <div className="flex gap-2">
                                                        <Input
                                                            placeholder="Ex: Rendre plus concis, ajouter des exemples, améliorer la structure..."
                                                            value={aiInstruction}
                                                            onChange={e => setAiInstruction(e.target.value)}
                                                            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleImprovePrompt(); } }}
                                                            className="flex-1 text-sm border-[#E8E6E1] bg-white"
                                                            disabled={isImprovingPrompt}
                                                        />
                                                        <Button
                                                            onClick={handleImprovePrompt}
                                                            disabled={isImprovingPrompt}
                                                            className="gap-2 bg-[#0D7377] hover:bg-[#0A5C5F] text-white font-semibold rounded-xl"
                                                        >
                                                            {isImprovingPrompt ? (
                                                                <RefreshCw className="h-4 w-4 animate-spin" />
                                                            ) : (
                                                                <Wand2 className="h-4 w-4" />
                                                            )}
                                                            {isImprovingPrompt ? 'Amélioration...' : 'Améliorer'}
                                                        </Button>
                                                    </div>
                                                    <div className="flex flex-wrap gap-1.5">
                                                        {['Rendre plus concis', 'Ajouter des exemples', 'Améliorer la structure', 'Traduire en français', 'Ajouter des contraintes de format'].map(suggestion => (
                                                            <button
                                                                key={suggestion}
                                                                onClick={() => { setAiInstruction(suggestion); }}
                                                                className="rounded-lg border border-[#E8E6E1] bg-white px-2.5 py-1 text-[11px] text-[#6B6966] hover:bg-[#0D7377] hover:text-white hover:border-[#0D7377] transition-all"
                                                            >
                                                                {suggestion}
                                                            </button>
                                                        ))}
                                                    </div>
                                                </div>

                                                <div className="flex items-center justify-between pt-2">
                                                    <p className="text-[10px] text-[#A09E99]">
                                                        <code className="settings-mono bg-[#F8F7F4] px-1.5 py-0.5 rounded border border-[#E8E6E1]">prompts/templates/{editingTemplate.category}/{editingTemplate.name}.md</code>
                                                        {' · '}Les variables <code className="settings-mono bg-[#F8F7F4] px-1.5 py-0.5 rounded border border-[#E8E6E1]">{'{{variable}}'}</code> sont substituées au runtime.
                                                    </p>
                                                    <div className="flex gap-2">
                                                        <Button variant="ghost" className="text-[#6B6966] hover:bg-[#F8F7F4]" onClick={() => { setEditingTemplate(null); setAiInstruction(''); }}>Annuler</Button>
                                                        <Button onClick={handleSaveTemplate} disabled={isSavingTemplate} className="font-semibold gap-2 bg-[#0D7377] hover:bg-[#0A5C5F] text-white">
                                                            <Save className="h-4 w-4" />
                                                            {isSavingTemplate ? 'Sauvegarde...' : 'Sauvegarder'}
                                                        </Button>
                                                    </div>
                                                </div>
                                            </>
                                        )}
                                    </Card>
                                )}
                            </motion.div>
                        )}

                        {activeTab === 'cte-graph' && (
                            <motion.div
                                key="cte-graph"
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                className="space-y-8"
                            >
                                <CTEGraphPanel />
                            </motion.div>
                        )}

                        {activeTab === 'subscription' && (
                            <motion.div
                                key="subscription"
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                className="space-y-8"
                            >
                                <div className="bg-[#0D7377]/5 border border-[#0D7377]/20 rounded-2xl p-8 flex flex-col md:flex-row items-center justify-between gap-6">
                                    <div className="flex items-center gap-6">
                                        <div className="h-16 w-16 rounded-xl bg-[#0D7377] flex items-center justify-center text-white">
                                            <CreditCard className="h-8 w-8" />
                                        </div>
                                        <div>
                                            <div className="flex items-center gap-3">
                                                <h3 className="settings-display text-2xl text-[#2B2B2B]">Plan Professionnel</h3>
                                                <span className="px-3 py-1 bg-[#0D7377] text-white text-[10px] font-semibold rounded-full uppercase tracking-wider">Actif</span>
                                            </div>
                                            <p className="text-[#6B6966] mt-1 max-w-md">Votre abonnement se renouvelle automatiquement le 15 Mars 2026. Profitez de toutes les fonctionnalités avancées d'analyse.</p>
                                        </div>
                                    </div>
                                    <div className="flex flex-col gap-2 w-full md:w-auto">
                                        <Button className="rounded-xl h-12 px-8 font-semibold bg-[#0D7377] text-white hover:bg-[#0B6164] transition-all shadow-sm">Mettre à jour</Button>
                                        <Button variant="ghost" className="rounded-xl h-10 font-semibold text-[#6B6966] hover:bg-[#F8F7F4]">Gérer le paiement</Button>
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                                    <SettingsSection title="Usage actuel">
                                        <Card className="p-6 space-y-6 border-[#E8E6E1] bg-white">
                                            <div className="space-y-2">
                                                <div className="flex justify-between text-xs font-semibold uppercase tracking-[0.2em] text-[#2B2B2B]">
                                                    <span>Requêtes IA</span>
                                                    <span>850 / 1000</span>
                                                </div>
                                                <div className="h-2 w-full bg-[#F8F7F4] rounded-full overflow-hidden">
                                                    <div className="h-full bg-[#0D7377] w-[85%] rounded-full"></div>
                                                </div>
                                            </div>
                                            <div className="space-y-2">
                                                <div className="flex justify-between text-xs font-semibold uppercase tracking-[0.2em] text-[#2B2B2B]">
                                                    <span>Connecteurs</span>
                                                    <span>4 / 5</span>
                                                </div>
                                                <div className="h-2 w-full bg-[#F8F7F4] rounded-full overflow-hidden">
                                                    <div className="h-full bg-[#0D7377]/60 w-[80%] rounded-full"></div>
                                                </div>
                                            </div>
                                            <div className="space-y-2">
                                                <div className="flex justify-between text-xs font-semibold uppercase tracking-[0.2em] text-[#2B2B2B]">
                                                    <span>Stockage Cloud</span>
                                                    <span>2.4 GB / 10 GB</span>
                                                </div>
                                                <div className="h-2 w-full bg-[#F8F7F4] rounded-full overflow-hidden">
                                                    <div className="h-full bg-[#E8725A] w-[24%] rounded-full"></div>
                                                </div>
                                            </div>
                                        </Card>
                                    </SettingsSection>

                                    <SettingsSection title="Facturation">
                                        <Card className="p-6 space-y-4 border-[#E8E6E1] bg-white">
                                            <div className="flex items-center justify-between py-2 border-b border-[#E8E6E1]">
                                                <span className="text-sm font-medium text-[#2B2B2B]">Janvier 2026</span>
                                                <div className="flex items-center gap-4">
                                                    <span className="text-sm font-bold">€49.00</span>
                                                    <Button variant="ghost" size="sm" className="h-8 w-8 px-0">
                                                        <Download className="h-4 w-4" />
                                                    </Button>
                                                </div>
                                            </div>
                                            <div className="flex items-center justify-between py-2 border-b border-[#E8E6E1]">
                                                <span className="text-sm font-medium text-[#2B2B2B]">Décembre 2025</span>
                                                <div className="flex items-center gap-4">
                                                    <span className="text-sm font-bold">€49.00</span>
                                                    <Button variant="ghost" size="sm" className="h-8 w-8 px-0">
                                                        <Download className="h-4 w-4" />
                                                    </Button>
                                                </div>
                                            </div>
                                            <div className="pt-2">
                                                <Button variant="link" className="text-xs font-semibold p-0 h-auto text-[#0D7377] hover:text-[#0B6164]">Voir tout l'historique</Button>
                                            </div>
                                        </Card>
                                    </SettingsSection>
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>

                    <Dialog open={isSelectionDetailsOpen} onOpenChange={setIsSelectionDetailsOpen}>
                        <DialogContent className="grid h-[78vh] max-w-3xl grid-rows-[auto_minmax(0,1fr)] overflow-hidden border border-[#E8E6E1] bg-white p-0 text-[#2B2B2B] shadow-[0_45px_140px_rgba(15,23,42,0.22)]">
                            <DialogHeader className="border-b border-[#E8E6E1] bg-[#F8F7F4] px-6 pb-5 pt-6">
                                <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
                                    <div className="max-w-2xl">
                                        <p className="text-[10px] font-semibold uppercase tracking-[0.3em] text-[#A09E99]">Infos sélection</p>
                                        <DialogTitle className="settings-display mt-2 text-3xl font-semibold tracking-[-0.04em] text-[#2B2B2B]">
                                            Contexte source et cache
                                        </DialogTitle>
                                        <DialogDescription className="mt-2 text-sm leading-relaxed text-[#6B6966]">
                                            Toutes les informations structurelles de la sélection active, déplacées dans une fenêtre dédiée pour garder le studio plus aéré.
                                        </DialogDescription>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="rounded-full border border-[#E8E6E1] bg-white px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-[#6B6966]">
                                            {activeSelectionLabel}
                                        </span>
                                        <span className="rounded-full border border-[#E8E6E1] bg-white px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-[#6B6966]">
                                            {(healthData?.status || 'Inconnu').toUpperCase()}
                                        </span>
                                    </div>
                                </div>
                            </DialogHeader>

                            <ScrollArea className="min-h-0 px-6 py-5">
                                <div className="grid gap-6 md:grid-cols-2">
                                    <div className="rounded-[28px] border border-[#E8E6E1] bg-white p-5">
                                        <DataInspectorCard
                                            eyebrow="Cible active"
                                            title={selectedSource ? `${getSourceTypeLabel(selectedSourceInfo?.source_type || selectedSourceConfig?.type)}` : 'Aucune sélection'}
                                            body={activeSelectionLabel}
                                        />
                                        <DataInspectorCard
                                            eyebrow="DTO"
                                            title={selectedTableConfig?.columns_class || selectedSourceConfig?.columns_class || '-'}
                                            body={selectedSourceConfig?.path && !selectedTable ? `CSV: ${selectedSourceConfig.path}` : 'Classe de colonnes actuellement configurée.'}
                                            mono
                                        />
                                        <DataInspectorCard
                                            eyebrow="Cache"
                                            title={selectedTableConfig?.cache_file || selectedSourceConfig?.cache_file || '-'}
                                            body={selectedTableConfig?.embeddings_file || selectedSourceConfig?.embeddings_file || 'Aucun fichier d’embeddings configuré.'}
                                            mono
                                        />
                                    </div>

                                    <div className="rounded-[28px] border border-[#E8E6E1] bg-white p-5">
                                        <DataInspectorCard
                                            eyebrow="Relations"
                                            title={`${(selectedTableConfig?.foreign_keys || selectedSourceConfig?.foreign_keys || []).length}`}
                                            body="Relations configurées dans le JSON des clés étrangères."
                                        />
                                        <DataInspectorCard
                                            eyebrow="Colonnes"
                                            title={`${selectedTableColumns.length}`}
                                            body={`${selectedCategoricalCount} colonne(s) catégorielle(s) dans le brouillon courant.`}
                                        />
                                        <DataInspectorCard
                                            eyebrow="Description métier"
                                            title={activeSelectionDescription}
                                            body={selectedSource ? 'Visible également dans le workbench et l’éditeur de colonnes.' : 'Choisissez une source pour compléter la documentation.'}
                                        />
                                        <DataInspectorCard
                                            eyebrow="État service"
                                            title={(healthData?.status || 'Inconnu').toUpperCase()}
                                            body="Résultat remonté par le contrôle de santé du backend."
                                        />
                                    </div>
                                </div>
                            </ScrollArea>
                        </DialogContent>
                    </Dialog>

                    <Dialog
                        open={isColumnPickerOpen}
                        onOpenChange={(open) => {
                            setIsColumnPickerOpen(open);
                            if (!open) setColumnSearchQuery('');
                        }}
                    >
                        <DialogContent className="grid h-[82vh] max-w-3xl grid-rows-[auto_minmax(0,1fr)] overflow-hidden border border-[#E8E6E1] bg-white p-0 text-[#2B2B2B] shadow-[0_45px_140px_rgba(15,23,42,0.22)]">
                            <DialogHeader className="border-b border-[#E8E6E1] bg-[#F8F7F4] px-6 pb-5 pt-6">
                                <div className="flex flex-col gap-5">
                                    <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
                                        <div className="max-w-2xl">
                                            <p className="text-[10px] font-semibold uppercase tracking-[0.3em] text-[#A09E99]">Sélecteur de colonnes</p>
                                            <DialogTitle className="settings-display mt-2 text-3xl font-semibold tracking-[-0.04em] text-[#2B2B2B]">
                                                Liste des colonnes
                                            </DialogTitle>
                                            <DialogDescription className="mt-2 text-sm leading-relaxed text-[#6B6966]">
                                                Ouvrez une colonne dans le studio principal pour éditer le DTO, inspecter les distincts et vérifier les embeddings.
                                            </DialogDescription>
                                        </div>
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="rounded-full border border-[#E8E6E1] bg-white px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-[#6B6966]">
                                                {selectedTableColumns.length} colonnes
                                            </span>
                                            <span className="rounded-full border border-[#E8E6E1] bg-white px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-[#6B6966]">
                                                {selectedCategoricalCount} catégorielles
                                            </span>
                                            {effectiveWorkbenchColumn && (
                                                <span className="rounded-full border border-[#0D7377]/20 bg-[#0D7377]/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-[#0D7377]">
                                                    Active: {effectiveWorkbenchColumn}
                                                </span>
                                            )}
                                        </div>
                                    </div>

                                    <div className="relative">
                                        <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#A09E99]" />
                                        <Input
                                            value={columnSearchQuery}
                                            onChange={(event) => setColumnSearchQuery(event.target.value)}
                                            placeholder="Filtrer par colonne, type, description ou exemple..."
                                            className="h-12 rounded-full border-[#E8E6E1] bg-white pl-11 text-sm focus-visible:ring-[#0D7377]/20"
                                        />
                                    </div>
                                </div>
                            </DialogHeader>

                            <div className="min-h-0 px-6 py-5">
                                {!canEditColumns ? (
                                    <div className="flex h-full items-center justify-center rounded-[28px] border border-dashed border-[#E8E6E1] bg-[#F8F7F4] px-6 text-center">
                                        <div>
                                            <Database className="mx-auto h-12 w-12 text-[#A09E99]" />
                                            <p className="mt-5 text-lg font-semibold text-[#2B2B2B]">Aucune source sélectionnée</p>
                                            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-[#A09E99]">
                                                Sélectionnez une source puis rouvrez cette fenêtre pour choisir une colonne.
                                            </p>
                                        </div>
                                    </div>
                                ) : filteredDialogColumns.length === 0 ? (
                                    <div className="flex h-full items-center justify-center rounded-[28px] border border-dashed border-[#E8E6E1] bg-[#F8F7F4] px-6 text-center">
                                        <div>
                                            <Search className="mx-auto h-12 w-12 text-[#A09E99]" />
                                            <p className="mt-5 text-lg font-semibold text-[#2B2B2B]">Aucune colonne trouvée</p>
                                            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-[#A09E99]">
                                                Ajustez votre filtre pour retrouver une colonne, un type ou une valeur d’exemple.
                                            </p>
                                        </div>
                                    </div>
                                ) : (
                                    <ScrollArea className="h-full pr-3">
                                        <div className="space-y-2">
                                            {filteredDialogColumns.map((columnName, index) => {
                                                const draft = currentColumnDrafts[columnName] || {
                                                    description: '',
                                                    is_categorical: false,
                                                    type: inferColumnType(columnName)
                                                };
                                                const embeddingInfo = embeddingsByColumn[columnName];

                                                return (
                                                    <button
                                                        key={columnName}
                                                        onClick={() => {
                                                            setSelectedWorkbenchColumn(columnName);
                                                            setIsColumnPickerOpen(false);
                                                            setColumnSearchQuery('');
                                                        }}
                                                        className={cn(
                                                            "w-full rounded-[24px] border px-4 py-4 text-left transition-all",
                                                            effectiveWorkbenchColumn === columnName
                                                                ? "border-[#0D7377] bg-[#0D7377] text-white shadow-[0_18px_36px_rgba(15,23,42,0.16)]"
                                                                : "border-[#E8E6E1] bg-white hover:border-[#D4D2CD] hover:bg-[#F8F7F4]"
                                                        )}
                                                    >
                                                        <div className="flex items-start justify-between gap-4">
                                                            <div className="min-w-0">
                                                                <p className="text-[10px] font-semibold uppercase tracking-[0.24em] opacity-70">
                                                                    {String(index + 1).padStart(2, '0')}
                                                                </p>
                                                                <p className="mt-2 truncate text-base font-semibold">{columnName}</p>
                                                                {draft.description && (
                                                                    <p className={cn(
                                                                        "mt-2 line-clamp-2 text-sm leading-relaxed",
                                                                        effectiveWorkbenchColumn === columnName ? "text-white/75" : "text-[#6B6966]"
                                                                    )}>
                                                                        {draft.description}
                                                                    </p>
                                                                )}
                                                            </div>
                                                            <span className={cn(
                                                                "rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.2em]",
                                                                effectiveWorkbenchColumn === columnName
                                                                    ? "border-white/15 bg-white/10 text-white"
                                                                    : "border-[#E8E6E1] bg-[#F8F7F4] text-[#6B6966]"
                                                            )}>
                                                                {draft.type || inferColumnType(columnName)}
                                                            </span>
                                                        </div>
                                                        <div className="mt-3 flex flex-wrap gap-2">
                                                            {draft.is_categorical && (
                                                                <span className={cn(
                                                                    "rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.2em]",
                                                                    effectiveWorkbenchColumn === columnName
                                                                        ? "border-[#E8725A]/30 bg-[#E8725A]/15 text-[#FDE2DA]"
                                                                        : "border-[#E8E6E1] bg-[#F8F7F4] text-[#4A4845]"
                                                                )}>
                                                                    Catégorielle
                                                                </span>
                                                            )}
                                                            {embeddingInfo?.distinct_values?.length > 0 && (
                                                                <span className={cn(
                                                                    "rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.2em]",
                                                                    effectiveWorkbenchColumn === columnName
                                                                        ? "border-cyan-300/20 bg-cyan-400/15 text-cyan-100"
                                                                        : "border-cyan-500/20 bg-cyan-500/10 text-cyan-900"
                                                                )}>
                                                                    {embeddingInfo.distinct_values.length} distincts
                                                                </span>
                                                            )}
                                                        </div>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </ScrollArea>
                                )}
                            </div>
                        </DialogContent>
                    </Dialog>

                    <Dialog
                        open={columnDetailColumn != null}
                        onOpenChange={(open) => {
                            if (!open) {
                                setColumnDetailColumn(null);
                                setEmbSearchQuery('');
                                setEmbSearchResults(null);
                                setReembedResult(null);
                            }
                        }}
                    >
                        <DialogContent className="grid max-h-[88vh] max-w-3xl grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-0 overflow-hidden border border-[#E8E6E1] bg-white p-0 text-[#2B2B2B] shadow-[0_45px_140px_rgba(15,23,42,0.22)]">
                            {columnDetailColumn && (() => {
                                const popDraft = currentColumnDrafts[columnDetailColumn] || {
                                    description: '',
                                    is_categorical: false,
                                    type: inferColumnType(columnDetailColumn)
                                };
                                const popEmb = embeddingsByColumn[columnDetailColumn];
                                const popPreviewRows = embeddingPreviewByColumn[columnDetailColumn] || [];
                                const popDistinct = popEmb?.distinct_values || [];
                                const popDefs = popEmb?.definition_values || [];
                                const popSamples = getColumnPreviewValues(columnDetailColumn);
                                const popVecCount = popEmb?.embedded_vectors_count ?? popEmb?.embedded_values?.length ?? 0;
                                return (
                                    <>
                                        <DialogHeader className="border-b border-[#E8E6E1] bg-[#F8F7F4] px-6 pb-4 pt-6">
                                            <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[#A09E99]">Détail colonne</p>
                                            <DialogTitle className="settings-display mt-2 text-2xl font-semibold tracking-[-0.04em] text-[#2B2B2B]">
                                                {columnDetailColumn}
                                            </DialogTitle>
                                            <div className="mt-3 space-y-2">
                                                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">Description métier</p>
                                                <div className="flex gap-2">
                                                    <Textarea
                                                        value={popDraft.description || ''}
                                                        onChange={(e) => updateColumnDraft(columnDetailColumn!, { description: e.target.value })}
                                                        placeholder="Définition métier de la colonne : sens, unité, format…"
                                                        className="min-h-[56px] flex-1 resize-none rounded-xl border-[#E8E6E1] bg-white px-3 py-2 text-[13px] leading-relaxed text-[#2B2B2B] placeholder:text-[#C4C2BD] focus-visible:ring-[#0D7377]/20"
                                                        rows={2}
                                                    />
                                                    <Button
                                                        type="button"
                                                        variant="outline"
                                                        className="h-auto shrink-0 self-start rounded-xl border-[#E8E6E1] bg-white px-3 py-2 text-[11px] font-semibold text-[#2B2B2B] hover:bg-[#2B2B2B] hover:text-white"
                                                        disabled={isSuggestingSingleColumn}
                                                        onClick={() => suggestSingleColumnDescription(columnDetailColumn!)}
                                                    >
                                                        <Cpu className="mr-1.5 h-3.5 w-3.5" />
                                                        {isSuggestingSingleColumn ? 'IA…' : 'Suggestion IA'}
                                                    </Button>
                                                </div>
                                            </div>
                                            <DialogDescription className="sr-only">Éditer la description de la colonne {columnDetailColumn}</DialogDescription>
                                            <div className="mt-3 flex flex-wrap items-center gap-3">
                                                {(() => {
                                                    const typeOptions = ['integer', 'number', 'float', 'decimal', 'string', 'boolean', 'date', 'datetime', 'date/datetime', 'unknown'];
                                                    const currentType = popDraft.type || inferColumnType(columnDetailColumn);
                                                    const options = typeOptions.includes(currentType)
                                                        ? typeOptions
                                                        : [currentType, ...typeOptions];
                                                    return (
                                                        <label
                                                            className="flex items-center gap-2 rounded-full border border-[#E8E6E1] bg-white px-3 py-1 text-[11px] font-medium text-[#6B6966] focus-within:border-[#0D7377]/40 focus-within:ring-2 focus-within:ring-[#0D7377]/15"
                                                            title="Modifier le type de la colonne"
                                                        >
                                                            <span className="uppercase tracking-[0.12em] text-[#A09E99]">Type</span>
                                                            <select
                                                                value={currentType}
                                                                onChange={(e) => updateColumnDraft(columnDetailColumn!, { type: e.target.value })}
                                                                disabled={!canEditColumns}
                                                                className="cursor-pointer appearance-none border-0 bg-transparent pr-1 text-[11px] font-semibold text-[#2B2B2B] focus:outline-none disabled:cursor-not-allowed disabled:text-[#A09E99]"
                                                            >
                                                                {options.map((opt) => (
                                                                    <option key={opt} value={opt}>{opt}</option>
                                                                ))}
                                                            </select>
                                                        </label>
                                                    );
                                                })()}
                                                <button
                                                    type="button"
                                                    onClick={() => updateColumnDraft(columnDetailColumn!, { is_categorical: !popDraft.is_categorical })}
                                                    className={cn(
                                                        "rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] cursor-pointer transition-colors",
                                                        popDraft.is_categorical ? "border-[#0D7377]/30 bg-[#0D7377]/10 text-[#0D7377] hover:bg-[#0D7377]/20" : "border-[#E8E6E1] bg-white text-[#A09E99] hover:bg-[#F8F7F4]"
                                                    )}
                                                >
                                                    {popDraft.is_categorical ? 'Catégorielle ✓' : 'Non catégorielle'}
                                                </button>
                                                <span className="tabular-nums text-[11px] text-[#6B6966]">
                                                    Distincts {popDistinct.length} · Définitions {popDefs.length} · Vecteurs {popVecCount}
                                                </span>
                                                <Button
                                                    type="button"
                                                    size="sm"
                                                    className="ml-auto gap-1.5 rounded-full bg-[#E8725A] px-4 text-[11px] font-semibold text-white hover:bg-[#D4613D]"
                                                    disabled={!!colDetailDistinctStatus || !!distinctJobStatus}
                                                    onClick={() => launchSingleColumnDistinct(columnDetailColumn!)}
                                                >
                                                    {colDetailDistinctStatus === 'queued' ? (
                                                        <><Loader2 className="h-3 w-3 animate-spin" /> En file…</>
                                                    ) : colDetailDistinctStatus === 'running' ? (
                                                        <><Loader2 className="h-3 w-3 animate-spin" /> Génération…</>
                                                    ) : colDetailDistinctStatus === 'success' ? (
                                                        <><CheckCircle2 className="h-3 w-3" /> Terminé</>
                                                    ) : colDetailDistinctStatus === 'failed' ? (
                                                        <><AlertCircle className="h-3 w-3" /> Échec</>
                                                    ) : (
                                                        <><Zap className="h-3 w-3" /> Générer distinct &amp; embeddings</>
                                                    )}
                                                </Button>
                                            </div>
                                        </DialogHeader>

                                        {/* Tab bar */}
                                        <div className="flex items-center gap-1 border-b border-[#E8E6E1] bg-[#F8F7F4] px-6 py-2">
                                            <button
                                                type="button"
                                                className={cn(
                                                    "rounded-full px-4 py-1.5 text-[11px] font-semibold transition-colors",
                                                    columnDetailTab === 'samples'
                                                        ? "bg-white text-[#2B2B2B] shadow-sm"
                                                        : "text-[#A09E99] hover:bg-white/60 hover:text-[#2B2B2B]"
                                                )}
                                                onClick={() => setColumnDetailTab('samples')}
                                            >
                                                Échantillons (données)
                                            </button>
                                            <button
                                                type="button"
                                                className={cn(
                                                    "rounded-full px-4 py-1.5 text-[11px] font-semibold transition-colors",
                                                    columnDetailTab === 'embeddings'
                                                        ? "bg-white text-[#2B2B2B] shadow-sm"
                                                        : "text-[#A09E99] hover:bg-white/60 hover:text-[#2B2B2B]"
                                                )}
                                                onClick={() => {
                                                    setColumnDetailTab('embeddings');
                                                    void initDefDraftsFromPreview(popPreviewRows, selectedSource, selectedTable);
                                                }}
                                            >
                                                Valeurs distinctes &amp; Définitions
                                            </button>
                                            <button
                                                type="button"
                                                className={cn(
                                                    "flex items-center gap-1.5 rounded-full px-4 py-1.5 text-[11px] font-semibold transition-colors",
                                                    columnDetailTab === 'search'
                                                        ? "bg-white text-[#2B2B2B] shadow-sm"
                                                        : "text-[#A09E99] hover:bg-white/60 hover:text-[#2B2B2B]"
                                                )}
                                                onClick={() => setColumnDetailTab('search')}
                                            >
                                                <Sparkles className="h-3 w-3" />
                                                Recherche sémantique
                                            </button>
                                        </div>

                                        {/* Scrollable content */}
                                        <div className="min-h-0 overflow-y-auto overflow-x-hidden">
                                            <div className="px-6 py-5">
                                                {columnDetailTab === 'samples' ? (
                                                    <div className="space-y-5">
                                                        <div>
                                                            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">
                                                                Échantillons de valeurs
                                                            </p>
                                                            <div className="mt-2 overflow-x-auto">
                                                                <div className="flex flex-wrap gap-2">
                                                                    {popSamples.length > 0 ? popSamples.map((v, i) => (
                                                                        <span key={i} className="settings-mono max-w-[280px] truncate rounded-full border border-[#E8E6E1] bg-[#F8F7F4] px-3 py-1 text-[11px] text-[#4A4845]" title={String(v)}>
                                                                            {String(v)}
                                                                        </span>
                                                                    )) : (
                                                                        <span className="text-xs text-[#A09E99]">Aucun échantillon disponible.</span>
                                                                    )}
                                                                </div>
                                                            </div>
                                                        </div>

                                                        {popPreviewRows.length > 0 && (
                                                            <div>
                                                                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">Aperçu embeddings</p>
                                                                <div className="mt-2 overflow-x-auto rounded-xl border border-[#E8E6E1]">
                                                                    <table className="min-w-[340px] text-left text-[11px]">
                                                                        <thead className="bg-[#F8F7F4]">
                                                                            <tr>
                                                                                <th className="whitespace-nowrap px-3 py-2 font-semibold text-[#A09E99]">Valeur distincte</th>
                                                                                <th className="whitespace-nowrap px-3 py-2 text-right font-semibold text-[#A09E99]">Vecteurs</th>
                                                                                <th className="whitespace-nowrap px-3 py-2 text-right font-semibold text-[#A09E99]">Dimension</th>
                                                                            </tr>
                                                                        </thead>
                                                                        <tbody className="divide-y divide-[#E8E6E1]/60">
                                                                            {popPreviewRows.slice(0, 40).map((row, i) => (
                                                                                <tr key={i} className="hover:bg-[#F8F7F4]/80">
                                                                                    <td className="max-w-[200px] truncate whitespace-nowrap px-3 py-2 font-medium text-[#2B2B2B]" title={row.distinctValue}>{row.distinctValue}</td>
                                                                                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-[#6B6966]">{row.vectorCount || 0}</td>
                                                                                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-[#6B6966]">{row.vectorSize || 0}</td>
                                                                                </tr>
                                                                            ))}
                                                                        </tbody>
                                                                    </table>
                                                                </div>
                                                            </div>
                                                        )}
                                                    </div>
                                                ) : columnDetailTab === 'embeddings' ? (
                                                    <div className="space-y-4">
                                                        {/* Reference text input */}
                                                        <div className="space-y-2">
                                                            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">
                                                                Texte de référence
                                                            </p>
                                                            <Textarea
                                                                placeholder="Collez un texte de référence pour enrichir les définitions (documentation métier, glossaire, extrait de rapport…)"
                                                                value={defRefineText}
                                                                onChange={e => setDefRefineText(e.target.value)}
                                                                className="min-h-[80px] rounded-xl border-[#E8E6E1] bg-white text-[13px] leading-relaxed"
                                                                rows={3}
                                                            />
                                                            <Button
                                                                type="button"
                                                                className="gap-1.5 rounded-full bg-[#0D7377] px-4 py-2 text-xs font-semibold text-white hover:bg-[#0D7377]/90"
                                                                disabled={isRefiningDefs || !defRefineText.trim() || Object.keys(defDrafts).length === 0}
                                                                onClick={handleRefineDefinitions}
                                                            >
                                                                <Cpu className="h-3.5 w-3.5" />
                                                                {isRefiningDefs ? 'Analyse IA en cours…' : 'Analyser avec IA'}
                                                            </Button>
                                                        </div>

                                                        {/* Diff panel */}
                                                        {defRefineChanges.length > 0 && (
                                                            <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50/40 p-4">
                                                                <div className="flex items-center justify-between">
                                                                    <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-amber-700">
                                                                        Changements proposés
                                                                        <span className="ml-2 font-medium normal-case tracking-normal text-amber-600">
                                                                            ({defRefineChanges.length} modifications)
                                                                        </span>
                                                                    </p>
                                                                    <div className="flex items-center gap-1.5">
                                                                        <Button
                                                                            variant="ghost"
                                                                            className="h-7 rounded-lg px-2.5 text-[10px] font-semibold text-[#0D7377] hover:bg-[#0D7377]/10"
                                                                            onClick={() => setDefRefineAccepted(prev => {
                                                                                const next = { ...prev };
                                                                                defRefineChanges.forEach(c => { next[c.distinct_value] = true; });
                                                                                return next;
                                                                            })}
                                                                        >
                                                                            <CheckCircle2 className="mr-1 h-3 w-3" />
                                                                            Accepter tout
                                                                        </Button>
                                                                        <Button
                                                                            variant="ghost"
                                                                            className="h-7 rounded-lg px-2.5 text-[10px] font-semibold text-red-600 hover:bg-red-50"
                                                                            onClick={() => setDefRefineAccepted(prev => {
                                                                                const next = { ...prev };
                                                                                defRefineChanges.forEach(c => { next[c.distinct_value] = false; });
                                                                                return next;
                                                                            })}
                                                                        >
                                                                            <X className="mr-1 h-3 w-3" />
                                                                            Annuler tout
                                                                        </Button>
                                                                        <Button
                                                                            type="button"
                                                                            className="h-7 gap-1 rounded-lg bg-[#0D7377] px-3 text-[10px] font-semibold text-white hover:bg-[#0D7377]/90"
                                                                            disabled={!defRefineChanges.some(c => defRefineAccepted[c.distinct_value] !== false)}
                                                                            onClick={handleApplyAcceptedChanges}
                                                                        >
                                                                            <CheckCircle2 className="h-3 w-3" />
                                                                            Appliquer
                                                                        </Button>
                                                                    </div>
                                                                </div>
                                                                <div className="space-y-2">
                                                                    {defRefineChanges.map((change) => {
                                                                        const accepted = defRefineAccepted[change.distinct_value] !== false;
                                                                        const actionColors = {
                                                                            add: 'border-green-300 bg-green-50 text-green-700',
                                                                            update: 'border-amber-300 bg-amber-50 text-amber-700',
                                                                            delete: 'border-red-300 bg-red-50 text-red-700',
                                                                        };
                                                                        const actionLabels = { add: 'Ajout', update: 'Modif.', delete: 'Suppr.' };
                                                                        return (
                                                                            <div
                                                                                key={change.distinct_value}
                                                                                className={cn(
                                                                                    "rounded-lg border bg-white p-3 transition-opacity",
                                                                                    !accepted && "opacity-40"
                                                                                )}
                                                                            >
                                                                                <div className="flex items-center justify-between gap-2">
                                                                                    <div className="flex min-w-0 items-center gap-2">
                                                                                        <span className="settings-mono truncate text-[13px] font-semibold text-[#2B2B2B]" title={change.distinct_value}>
                                                                                            {change.distinct_value}
                                                                                        </span>
                                                                                        <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider", actionColors[change.action] || '')}>
                                                                                            {actionLabels[change.action] || change.action}
                                                                                        </span>
                                                                                    </div>
                                                                                    <div className="flex shrink-0 items-center gap-1">
                                                                                        <Button
                                                                                            variant="ghost"
                                                                                            size="icon"
                                                                                            className={cn("h-7 w-7 rounded-lg", accepted ? "text-[#0D7377] hover:bg-[#0D7377]/10" : "text-[#A09E99] hover:bg-[#E8E6E1]")}
                                                                                            title={accepted ? 'Accepté' : 'Accepter'}
                                                                                            onClick={() => setDefRefineAccepted(prev => ({ ...prev, [change.distinct_value]: true }))}
                                                                                        >
                                                                                            <CheckCircle2 className="h-4 w-4" />
                                                                                        </Button>
                                                                                        <Button
                                                                                            variant="ghost"
                                                                                            size="icon"
                                                                                            className="h-7 w-7 rounded-lg text-red-500 hover:bg-red-50"
                                                                                            title="Annuler ce changement"
                                                                                            onClick={() => setDefRefineAccepted(prev => ({ ...prev, [change.distinct_value]: false }))}
                                                                                        >
                                                                                            <X className="h-4 w-4" />
                                                                                        </Button>
                                                                                    </div>
                                                                                </div>
                                                                                <div className="mt-2 space-y-1">
                                                                                    {(change.action === 'update' || change.action === 'delete') && change.old_definitions.map((d, i) => (
                                                                                        <div key={`old-${i}`} className="flex items-start gap-2 rounded-md bg-red-50 px-2.5 py-1">
                                                                                            <span className="shrink-0 text-[11px] font-bold text-red-400">-</span>
                                                                                            <span className="text-[12px] leading-relaxed text-red-700 line-through">{d}</span>
                                                                                        </div>
                                                                                    ))}
                                                                                    {(change.action === 'update' || change.action === 'add') && change.new_definitions.map((d, i) => (
                                                                                        <div key={`new-${i}`} className="flex items-start gap-2 rounded-md bg-green-50 px-2.5 py-1">
                                                                                            <span className="shrink-0 text-[11px] font-bold text-green-500">+</span>
                                                                                            <span className="text-[12px] leading-relaxed text-green-700">{d}</span>
                                                                                        </div>
                                                                                    ))}
                                                                                </div>
                                                                            </div>
                                                                        );
                                                                    })}
                                                                </div>
                                                                <div className="mt-3 flex justify-end">
                                                                    <Button
                                                                        type="button"
                                                                        className="gap-1.5 rounded-full bg-[#0D7377] px-4 py-2 text-xs font-semibold text-white hover:bg-[#0D7377]/90"
                                                                        disabled={!defRefineChanges.some(c => defRefineAccepted[c.distinct_value] !== false)}
                                                                        onClick={handleApplyAcceptedChanges}
                                                                    >
                                                                        <CheckCircle2 className="h-3.5 w-3.5" />
                                                                        Appliquer les changements acceptés
                                                                    </Button>
                                                                </div>
                                                            </div>
                                                        )}

                                                        {/* Accordion header */}
                                                        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">
                                                            Valeurs distinctes &amp; définitions
                                                            <span className="ml-2 text-[10px] font-medium normal-case tracking-normal text-[#6B6966]">
                                                                ({Object.keys(defDrafts).length} valeurs)
                                                            </span>
                                                        </p>
                                                        {isLoadingDefs ? (
                                                            <div className="space-y-2">
                                                                {[...Array(4)].map((_, i) => (
                                                                    <div key={i} className="h-12 animate-pulse rounded-xl bg-[#E8E6E1]/60" />
                                                                ))}
                                                            </div>
                                                        ) : Object.keys(defDrafts).length === 0 ? (
                                                            <div className="rounded-xl border border-dashed border-[#E8E6E1] bg-[#F8F7F4] p-6 text-center text-xs text-[#A09E99]">
                                                                Aucune valeur distincte en cache.
                                                            </div>
                                                        ) : (
                                                            <div className="space-y-2">
                                                                {Object.entries(defDrafts).map(([dv, defs]) => {
                                                                    const isOpen = defExpanded[dv];
                                                                    const editingIdx = defEditIdx[dv] ?? null;
                                                                    return (
                                                                        <div key={dv} className="overflow-hidden rounded-xl border border-[#E8E6E1] bg-white">
                                                                            <button
                                                                                type="button"
                                                                                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-[#F8F7F4]"
                                                                                onClick={() => setDefExpanded(prev => ({ ...prev, [dv]: !prev[dv] }))}
                                                                            >
                                                                                <div className="flex min-w-0 items-center gap-2.5">
                                                                                    <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-[#A09E99] transition-transform", isOpen && "rotate-90")} />
                                                                                    <span className="settings-mono truncate text-[13px] font-semibold text-[#2B2B2B]" title={dv}>{dv}</span>
                                                                                </div>
                                                                                <span className="shrink-0 rounded-full bg-[#F0EFEC] px-2.5 py-0.5 text-[10px] font-semibold tabular-nums text-[#6B6966]">
                                                                                    {defs.length} déf.
                                                                                </span>
                                                                            </button>
                                                                            {isOpen && (
                                                                                <div className="border-t border-[#E8E6E1] bg-[#F8F7F4]/60 px-4 py-3">
                                                                                    {defs.length === 0 && (
                                                                                        <p className="mb-2 text-xs italic text-[#A09E99]">Aucune définition pour cette valeur.</p>
                                                                                    )}
                                                                                    <div className="space-y-1.5">
                                                                                        {defs.map((def, idx) => (
                                                                                            <div key={idx} className="group flex items-start gap-2">
                                                                                                <span className="mt-1.5 shrink-0 font-mono text-[10px] tabular-nums text-[#A09E99]">{idx + 1}.</span>
                                                                                                {editingIdx === idx ? (
                                                                                                    <div className="flex flex-1 items-center gap-1.5">
                                                                                                        <Input
                                                                                                            value={defEditText}
                                                                                                            onChange={e => setDefEditText(e.target.value)}
                                                                                                            onKeyDown={e => { if (e.key === 'Enter') handleDefEditConfirm(dv); if (e.key === 'Escape') handleDefEditCancel(dv); }}
                                                                                                            className="h-7 flex-1 rounded-lg border-[#E8E6E1] bg-white text-[12px]"
                                                                                                            autoFocus
                                                                                                        />
                                                                                                        <Button variant="ghost" size="icon" className="h-7 w-7 rounded-lg text-[#0D7377] hover:bg-[#0D7377]/10" onClick={() => handleDefEditConfirm(dv)}>
                                                                                                            <CheckCircle2 className="h-3.5 w-3.5" />
                                                                                                        </Button>
                                                                                                        <Button variant="ghost" size="icon" className="h-7 w-7 rounded-lg text-[#A09E99] hover:bg-[#E8E6E1]" onClick={() => handleDefEditCancel(dv)}>
                                                                                                            <X className="h-3.5 w-3.5" />
                                                                                                        </Button>
                                                                                                    </div>
                                                                                                ) : (
                                                                                                    <>
                                                                                                        <p className="flex-1 text-[13px] leading-relaxed text-[#2B2B2B]">{def}</p>
                                                                                                        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                                                                                                            <Button variant="ghost" size="icon" className="h-6 w-6 rounded-md text-[#6B6966] hover:bg-white" title="Modifier" onClick={() => handleDefEditStart(dv, idx)}>
                                                                                                                <Edit3 className="h-3 w-3" />
                                                                                                            </Button>
                                                                                                            <Button variant="ghost" size="icon" className="h-6 w-6 rounded-md text-red-500 hover:bg-red-50" title="Supprimer" onClick={() => handleDefDelete(dv, idx)}>
                                                                                                                <Trash2 className="h-3 w-3" />
                                                                                                            </Button>
                                                                                                        </div>
                                                                                                    </>
                                                                                                )}
                                                                                            </div>
                                                                                        ))}
                                                                                    </div>
                                                                                    <div className="mt-2.5 flex items-center gap-1.5">
                                                                                        <Input
                                                                                            placeholder="Ajouter une définition…"
                                                                                            value={defNewInput[dv] || ''}
                                                                                            onChange={e => setDefNewInput(prev => ({ ...prev, [dv]: e.target.value }))}
                                                                                            onKeyDown={e => { if (e.key === 'Enter') handleDefAdd(dv); }}
                                                                                            className="h-8 flex-1 rounded-lg border-[#E8E6E1] bg-white text-[12px]"
                                                                                        />
                                                                                        <Button
                                                                                            variant="ghost"
                                                                                            size="icon"
                                                                                            className="h-8 w-8 rounded-lg border border-[#E8E6E1] bg-white text-[#0D7377] hover:bg-[#0D7377]/10"
                                                                                            onClick={() => handleDefAdd(dv)}
                                                                                        >
                                                                                            <Plus className="h-3.5 w-3.5" />
                                                                                        </Button>
                                                                                    </div>
                                                                                </div>
                                                                            )}
                                                                        </div>
                                                                    );
                                                                })}
                                                            </div>
                                                        )}
                                                    </div>
                                                ) : (
                                                    /* ── Search tab ─────────────────────── */
                                                    <div className="space-y-5">
                                                        <div className="space-y-3">
                                                            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">
                                                                Requête de recherche
                                                            </p>
                                                            <div className="flex items-center gap-2">
                                                                <Input
                                                                    placeholder="Entrez un texte à comparer avec les embeddings de cette colonne…"
                                                                    value={embSearchQuery}
                                                                    onChange={e => setEmbSearchQuery(e.target.value)}
                                                                    onKeyDown={e => { if (e.key === 'Enter') handleEmbeddingSearch(); }}
                                                                    className="h-9 flex-1 rounded-xl border-[#E8E6E1] bg-white text-[13px] placeholder:text-[#C4C2BD] focus-visible:ring-[#0D7377]/20"
                                                                />
                                                                <Button
                                                                    type="button"
                                                                    className="gap-1.5 rounded-full bg-[#0D7377] px-4 py-2 text-xs font-semibold text-white hover:bg-[#0B6164]"
                                                                    disabled={embSearchLoading || !embSearchQuery.trim()}
                                                                    onClick={handleEmbeddingSearch}
                                                                >
                                                                    {embSearchLoading ? (
                                                                        <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Recherche…</>
                                                                    ) : (
                                                                        <><Search className="h-3.5 w-3.5" /> Comparer</>
                                                                    )}
                                                                </Button>
                                                            </div>
                                                            <p className="text-[11px] leading-relaxed text-[#A09E99]">
                                                                Votre texte sera converti en embedding puis comparé (similarité cosinus) aux valeurs distinctes et définitions existantes de la colonne.
                                                            </p>
                                                        </div>

                                                        {/* Re-embed action */}
                                                        <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3">
                                                            <div className="flex items-center justify-between gap-3">
                                                                <div className="min-w-0">
                                                                    <p className="text-[12px] font-semibold text-amber-800">Re-générer les embeddings</p>
                                                                    <p className="mt-0.5 text-[11px] leading-relaxed text-amber-600">
                                                                        Recalculer les vecteurs d'embedding à partir des définitions actuelles de cette colonne.
                                                                    </p>
                                                                </div>
                                                                <Button
                                                                    type="button"
                                                                    variant="outline"
                                                                    className="shrink-0 gap-1.5 rounded-full border-amber-300 bg-white px-3 py-1.5 text-[11px] font-semibold text-amber-700 hover:bg-amber-100"
                                                                    disabled={reembedLoading}
                                                                    onClick={() => handleReembed(columnDetailColumn ? [columnDetailColumn] : undefined)}
                                                                >
                                                                    {reembedLoading ? (
                                                                        <><Loader2 className="h-3 w-3 animate-spin" /> En cours…</>
                                                                    ) : (
                                                                        <><RefreshCw className="h-3 w-3" /> Re-embed</>
                                                                    )}
                                                                </Button>
                                                            </div>
                                                            {reembedResult && (
                                                                <p className={cn(
                                                                    "mt-2 text-[11px] font-medium",
                                                                    reembedResult.error ? "text-red-600" : "text-emerald-700"
                                                                )}>
                                                                    {reembedResult.error
                                                                        ? `Erreur : ${reembedResult.error}`
                                                                        : `${reembedResult.count} lignes re-embedées avec succès.`}
                                                                </p>
                                                            )}
                                                        </div>

                                                        {embSearchResults !== null && (
                                                            <div className="space-y-3">
                                                                <div className="flex items-center justify-between">
                                                                    <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">
                                                                        Résultats
                                                                        <span className="ml-2 text-[10px] font-medium normal-case tracking-normal text-[#6B6966]">
                                                                            ({embSearchResults.length} correspondance{embSearchResults.length !== 1 ? 's' : ''})
                                                                        </span>
                                                                    </p>
                                                                    {embSearchResults.length > 0 && (
                                                                        <Button
                                                                            variant="ghost"
                                                                            className="h-7 rounded-lg px-2.5 text-[10px] font-semibold text-[#A09E99] hover:text-[#2B2B2B]"
                                                                            onClick={() => setEmbSearchResults(null)}
                                                                        >
                                                                            <X className="mr-1 h-3 w-3" /> Effacer
                                                                        </Button>
                                                                    )}
                                                                </div>

                                                                {embSearchResults.length === 0 ? (
                                                                    <div className="rounded-xl border border-dashed border-[#E8E6E1] bg-[#F8F7F4] p-8 text-center">
                                                                        <Search className="mx-auto h-8 w-8 text-[#C4C2BD]" />
                                                                        <p className="mt-3 text-sm font-medium text-[#6B6966]">Aucune correspondance trouvée</p>
                                                                        <p className="mt-1 text-xs text-[#A09E99]">Essayez une requête différente ou vérifiez que les embeddings ont été générés.</p>
                                                                    </div>
                                                                ) : (
                                                                    <div className="space-y-1.5">
                                                                        {embSearchResults.map((r: any, i: number) => {
                                                                            const score = r.similarity ?? 0;
                                                                            const pct = Math.round(score * 100);
                                                                            const namePct = Math.round((r.name_similarity ?? 0) * 100);
                                                                            const defPct = Math.round((r.definition_similarity ?? 0) * 100);
                                                                            const barColor = pct >= 70 ? 'bg-emerald-500' : pct >= 40 ? 'bg-amber-400' : 'bg-red-400';
                                                                            const defs: string[] = Array.isArray(r.definitions) ? r.definitions : [];
                                                                            return (
                                                                                <div key={i} className="rounded-xl border border-[#E8E6E1] bg-white px-4 py-3 transition-colors hover:bg-[#F8F7F4]">
                                                                                    <div className="flex items-center gap-3">
                                                                                        <div className="min-w-0 flex-1">
                                                                                            <p className="settings-mono truncate text-[13px] font-semibold text-[#2B2B2B]" title={r.distinct_value || ''}>
                                                                                                {r.distinct_value || '—'}
                                                                                            </p>
                                                                                        </div>
                                                                                        <div className="flex shrink-0 items-center gap-2">
                                                                                            <div className="h-1.5 w-16 overflow-hidden rounded-full bg-[#E8E6E1]">
                                                                                                <div className={cn("h-full rounded-full transition-all", barColor)} style={{ width: `${pct}%` }} />
                                                                                            </div>
                                                                                            <span className={cn(
                                                                                                "w-10 text-right tabular-nums text-[12px] font-bold",
                                                                                                pct >= 70 ? "text-emerald-600" : pct >= 40 ? "text-amber-600" : "text-red-500"
                                                                                            )}>
                                                                                                {pct}%
                                                                                            </span>
                                                                                        </div>
                                                                                    </div>
                                                                                    <div className="mt-1 flex gap-3 text-[10px] text-[#A09E99]">
                                                                                        <span>nom: <span className="font-semibold text-[#6B6966]">{namePct}%</span></span>
                                                                                        <span>définition: <span className="font-semibold text-[#6B6966]">{defPct}%</span></span>
                                                                                    </div>
                                                                                    {defs.length > 0 && (
                                                                                        <div className="mt-1.5 space-y-0.5 border-t border-[#E8E6E1]/60 pt-1.5">
                                                                                            {defs.map((d: string, di: number) => (
                                                                                                <p key={di} className="text-[11px] leading-relaxed text-[#6B6966]">
                                                                                                    <span className="mr-1 text-[10px] text-[#A09E99]">{di + 1}.</span>
                                                                                                    {d}
                                                                                                </p>
                                                                                            ))}
                                                                                        </div>
                                                                                    )}
                                                                                </div>
                                                                            );
                                                                        })}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        </div>

                                        <DialogFooter className="border-t border-[#E8E6E1] bg-[#F8F7F4] px-6 py-4">
                                            <div className="flex w-full items-center justify-between">
                                                <Button
                                                    type="button"
                                                    variant="outline"
                                                    className="rounded-full border-[#E8E6E1] font-semibold"
                                                    onClick={() => setColumnDetailColumn(null)}
                                                >
                                                    Fermer
                                                </Button>
                                                <div className="flex items-center gap-2">
                                                    <Button
                                                        type="button"
                                                        className="gap-1.5 rounded-full border border-[#0D7377] bg-[#0D7377] px-4 font-semibold text-white hover:bg-[#0B6164]"
                                                        disabled={isSavingColumnSchema}
                                                        onClick={() => persistSingleColumnDraft(columnDetailColumn!)}
                                                    >
                                                        <Save className="h-3.5 w-3.5" />
                                                        {isSavingColumnSchema ? 'Sauvegarde…' : 'Sauvegarder DTO'}
                                                    </Button>
                                                    {columnDetailTab === 'embeddings' && Object.keys(defDrafts).length > 0 && (
                                                        <Button
                                                            type="button"
                                                            className="gap-1.5 rounded-full bg-[#E8725A] px-5 font-semibold text-white hover:bg-[#D4613D]"
                                                            disabled={isSavingDefs}
                                                            onClick={handleSaveAllDefs}
                                                        >
                                                            <Save className="h-3.5 w-3.5" />
                                                            {isSavingDefs ? 'Enregistrement…' : 'Enregistrer les définitions'}
                                                        </Button>
                                                    )}
                                                </div>
                                            </div>
                                        </DialogFooter>
                                    </>
                                );
                            })()}
                        </DialogContent>
                    </Dialog>

                    <Dialog open={isColumnsDialogOpen} onOpenChange={setIsColumnsDialogOpen}>
                        <DialogContent className="grid h-[88vh] max-w-6xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden border border-[#E8E6E1] bg-[#F8F7F4] p-0 text-[#2B2B2B] shadow-[0_45px_140px_rgba(15,23,42,0.35)]">
                            <DialogHeader className="relative overflow-hidden border-b border-[#E8E6E1] bg-[#0D7377] px-6 pb-5 pt-6 text-white">
                                <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(245,158,11,0.24),_transparent_32%),radial-gradient(circle_at_80%_20%,_rgba(14,165,233,0.18),_transparent_24%),linear-gradient(135deg,_rgba(255,255,255,0.08)_1px,_transparent_1px)] [background-size:auto,auto,28px_28px]" />
                                <div className="relative flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
                                    <div className="max-w-3xl">
                                        <p className="text-[10px] font-semibold uppercase tracking-[0.32em] text-white/60">Éditeur de colonnes</p>
                                        <DialogTitle className="settings-display mt-3 text-4xl font-semibold tracking-[-0.05em] text-white">
                                    Colonnes de la table
                                </DialogTitle>
                                        <DialogDescription className="mt-3 max-w-2xl text-sm leading-relaxed text-white/70">
                                    {canEditColumns
                                                ? `${selectedSource}${selectedTable ? ` / ${selectedTable}` : ''} · Définissez la description métier, le type et le statut catégoriel directement dans le DTO.`
                                                : "Sélectionnez une source pour configurer ses colonnes."}
                                </DialogDescription>
                                    </div>
                                    <div className="grid gap-3 sm:grid-cols-3">
                                        <div className="rounded-[22px] border border-white/10 bg-white/5 px-4 py-3">
                                            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-white/60">Sélection</p>
                                            <p className="mt-2 text-sm font-semibold text-white">{activeSelectionLabel}</p>
                                        </div>
                                        <div className="rounded-[22px] border border-white/10 bg-white/5 px-4 py-3">
                                            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-white/60">Catégorielles</p>
                                            <p className="mt-2 text-sm font-semibold text-white">{selectedCategoricalCount}</p>
                                        </div>
                                        <div className="rounded-[22px] border border-white/10 bg-white/5 px-4 py-3">
                                            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-white/60">Colonnes</p>
                                            <p className="mt-2 text-sm font-semibold text-white">{selectedTableColumns.length}</p>
                                        </div>
                                    </div>
                                </div>
                            </DialogHeader>

                            <div className="min-h-0 overflow-y-auto px-6 py-5">
                                {!canEditColumns ? (
                                    <Card className="rounded-[28px] border border-dashed border-[#E8E6E1] bg-white/75 p-10 text-center shadow-[0_20px_60px_rgba(15,23,42,0.06)]">
                                        <Database className="mx-auto h-12 w-12 text-[#A09E99]" />
                                        <p className="mt-5 text-lg font-semibold text-[#2B2B2B]">Aucune source sélectionnée</p>
                                        <p className="mt-2 text-sm leading-relaxed text-[#A09E99]">
                                            Sélectionnez une source dans la colonne de gauche, puis rouvrez cette fenêtre pour éditer les colonnes.
                                        </p>
                                    </Card>
                                ) : selectedTableColumns.length === 0 ? (
                                    <Card className="rounded-[28px] border border-dashed border-[#E8E6E1] bg-white/75 p-10 text-center shadow-[0_20px_60px_rgba(15,23,42,0.06)]">
                                        <AlertCircle className="mx-auto h-12 w-12 text-[#A09E99]" />
                                        <p className="mt-5 text-lg font-semibold text-[#2B2B2B]">Colonnes introuvables</p>
                                        <p className="mt-2 text-sm leading-relaxed text-[#A09E99]">
                                            Rafraîchissez la sélection pour charger un échantillon ou vérifier la configuration DTO.
                                        </p>
                                    </Card>
                                ) : (
                                    <div className="space-y-5">
                                        <div className="sticky top-0 z-10 rounded-[28px] border border-[#E8E6E1] bg-[#fbf7ef]/95 p-4 shadow-[0_18px_45px_rgba(15,23,42,0.06)] backdrop-blur">
                                            <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                                            <div>
                                                    <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[#A09E99]">Source sélectionnée</p>
                                                    <p className="mt-2 text-sm font-semibold text-[#2B2B2B]">{selectedSource}{selectedTable ? ` / ${selectedTable}` : ''}</p>
                                                    <p className="mt-1 text-xs leading-relaxed text-[#A09E99]">
                                                    {isLoadingColumnSchema
                                                            ? "Chargement des définitions existantes depuis la classe DTO..."
                                                            : "Les descriptions, types et drapeaux catégoriels proviennent du DTO lorsqu’il est déjà configuré."}
                                                </p>
                                            </div>
                                                <div className="w-full max-w-md">
                                                    <div className="relative">
                                                        <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#A09E99]" />
                                                        <Input
                                                            value={columnSearchQuery}
                                                            onChange={(event) => setColumnSearchQuery(event.target.value)}
                                                            placeholder="Filtrer par colonne, type ou exemple..."
                                                            className="h-11 rounded-full border-[#E8E6E1] bg-white pl-11 text-sm focus-visible:ring-[#0D7377]/20"
                                                        />
                                                    </div>
                                                </div>
                                            </div>
                                        </div>

                                        <div className="grid gap-4">
                                            {filteredDialogColumns.map((columnName, index) => {
                                                const draft = currentColumnDrafts[columnName] || {
                                                    description: '',
                                                    is_categorical: false,
                                                    type: inferColumnType(columnName)
                                                };
                                                const previewValues = getColumnPreviewValues(columnName);

                                                return (
                                                    <Card
                                                        key={columnName}
                                                        className={cn(
                                                            "overflow-hidden rounded-[28px] border bg-white/85 shadow-[0_18px_50px_rgba(15,23,42,0.05)] transition-all",
                                                            draft.is_categorical
                                                                ? "border-[#E8725A]/25"
                                                                : "border-[#E8E6E1]"
                                                        )}
                                                    >
                                                        <div className="grid gap-0 xl:grid-cols-[260px_minmax(0,1fr)]">
                                                            <div className={cn(
                                                                "border-b border-[#E8E6E1] p-5 xl:border-b-0 xl:border-r",
                                                                draft.is_categorical ? "bg-[#E8725A]/[0.09]" : "bg-[#f8f4ec]"
                                                            )}>
                                                                <div className="flex items-start justify-between gap-3">
                                                                    <div>
                                                                        <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[#A09E99]">
                                                                            Colonne {String(index + 1).padStart(2, '0')}
                                                                        </p>
                                                                        <h5 className="mt-2 text-base font-semibold text-[#2B2B2B]">{columnName}</h5>
                                                                    </div>
                                                                    <span className="rounded-full border border-[#E8E6E1] bg-white px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-[#6B6966]">
                                                                        {draft.type || inferColumnType(columnName)}
                                                                    </span>
                                                                </div>

                                                                <div className="mt-5 flex flex-wrap gap-2">
                                                                    {draft.is_categorical ? (
                                                                        <span className="rounded-full border border-[#E8725A]/20 bg-[#E8725A]/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-[#E8725A]">
                                                                            Catégorielle
                                                                        </span>
                                                                    ) : (
                                                                        <span className="rounded-full border border-[#E8E6E1] bg-white px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">
                                                                            Non catégorielle
                                                                        </span>
                                                                    )}
                                                                </div>

                                                                {previewValues.length > 0 && (
                                                                    <div className="mt-5 space-y-2">
                                                                        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A09E99]">Exemples</p>
                                                                        <div className="flex flex-wrap gap-2">
                                                                            {previewValues.map((value, previewIndex) => (
                                                                        <span
                                                                                    key={`${columnName}-preview-${previewIndex}`}
                                                                                    className="settings-mono max-w-[200px] truncate rounded-full border border-[#E8E6E1] bg-white px-3 py-1.5 text-[11px] font-medium text-[#4A4845]"
                                                                            title={value}
                                                                        >
                                                                            {value}
                                                                        </span>
                                                                            ))}
                                                                        </div>
                                                                    </div>
                                                                    )}
                                                                </div>

                                                            <div className="space-y-4 p-5">
                                                                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                                                                    <div>
                                                                        <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[#A09E99]">Documentation métier</p>
                                                                        <p className="mt-1 text-xs leading-relaxed text-[#A09E99]">
                                                                            Décrivez le sens métier, les unités, les règles et les valeurs attendues.
                                                                        </p>
                                                                    </div>
                                                                    <Button
                                                                        type="button"
                                                                        variant="ghost"
                                                                        size="sm"
                                                                        className={cn(
                                                                            "h-10 rounded-full border px-4 text-[10px] font-semibold uppercase tracking-[0.24em]",
                                                                            draft.is_categorical
                                                                                ? "border-[#E8725A]/20 bg-[#E8725A]/10 text-[#E8725A] hover:bg-[#E8725A]/15"
                                                                                : "border-[#E8E6E1] bg-white text-[#6B6966] hover:bg-[#F8F7F4]"
                                                                        )}
                                                                        onClick={() => updateColumnDraft(columnName, { is_categorical: !draft.is_categorical })}
                                                                    >
                                                                        {draft.is_categorical ? "Retirer le flag" : "Marquer catégorielle"}
                                                                    </Button>
                                                            </div>

                                                                <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_220px]">
                                                                <Textarea
                                                                    value={draft.description || ''}
                                                                        onChange={(event) => updateColumnDraft(columnName, { description: event.target.value })}
                                                                        placeholder="Définition métier de la colonne : sens, unité, règles, interprétation..."
                                                                        className="min-h-[132px] rounded-[24px] border-[#E8E6E1] bg-[#fffdf8] px-4 py-3 text-sm leading-relaxed text-[#2B2B2B] focus-visible:ring-[#0D7377]/20"
                                                                    />
                                                                    <div className="rounded-[24px] border border-[#E8E6E1] bg-[#f8f4ec] p-4">
                                                                        <label className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[#A09E99]">Type</label>
                                                                        <Input
                                                                            value={draft.type || ''}
                                                                            onChange={(event) => updateColumnDraft(columnName, { type: event.target.value })}
                                                                            className="mt-3 h-11 rounded-full border-[#E8E6E1] bg-white px-4 text-sm focus-visible:ring-[#0D7377]/20"
                                                                            placeholder="string"
                                                                        />
                                                                        <p className="mt-4 text-xs leading-relaxed text-[#A09E99]">
                                                                            Modifiez le type si l’inférence initiale n’est pas correcte.
                                                                        </p>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </Card>
                                                );
                                            })}
                                        </div>

                                        {filteredDialogColumns.length === 0 && (
                                            <Card className="rounded-[28px] border border-dashed border-[#E8E6E1] bg-white/75 p-10 text-center shadow-[0_20px_60px_rgba(15,23,42,0.06)]">
                                                <Search className="mx-auto h-10 w-10 text-[#A09E99]" />
                                                <p className="mt-4 text-lg font-semibold text-[#2B2B2B]">Aucune colonne trouvée</p>
                                                <p className="mt-2 text-sm leading-relaxed text-[#A09E99]">
                                                    Ajustez votre recherche pour retrouver une colonne, un type ou une valeur d’exemple.
                                                </p>
                                            </Card>
                                        )}
                                    </div>
                                )}
                            </div>

                            <DialogFooter className="border-t border-[#E8E6E1] bg-[#fbf7ef] px-6 py-4">
                                <div className="flex w-full flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                                    <p className="text-xs leading-relaxed text-[#A09E99]">
                                        Les changements sont enregistrés dans la classe DTO configurée pour la sélection courante.
                                    </p>
                                    <div className="flex flex-wrap items-center justify-end gap-2">
                                        <Button
                                            variant="ghost"
                                            className="rounded-full border border-[#E8E6E1] bg-white px-4 font-semibold text-[#4A4845] hover:bg-[#F8F7F4]"
                                            onClick={() => setIsColumnsDialogOpen(false)}
                                        >
                                            Fermer
                                        </Button>
                                        <Button
                                            variant="outline"
                                            onClick={applyAiColumnSuggestions}
                                            disabled={isSuggestingColumnSchema || !canEditColumns || !selectedTableColumns.length}
                                            className="rounded-full border-[#E8E6E1] bg-white px-4 font-semibold text-[#2B2B2B] hover:bg-[#2B2B2B] hover:text-white"
                                        >
                                            {isSuggestingColumnSchema ? 'Suggestion IA...' : 'Suggestion IA'}
                                        </Button>
                                        <Button
                                            onClick={persistCurrentColumnDrafts}
                                            disabled={isSavingColumnSchema || isSuggestingColumnSchema || !canEditColumns || !selectedTableColumns.length}
                                            className="rounded-full border border-[#0D7377] bg-[#0D7377] px-4 font-semibold text-white hover:bg-[#0B6164]"
                                        >
                                            {isSavingColumnSchema ? 'Sauvegarde...' : 'Enregistrer dans le DTO'}
                                        </Button>
                                        <Button
                                            onClick={launchDistinctGeneration}
                                            disabled={
                                                isSavingColumnSchema
                                                || !canEditColumns
                                                || !selectedTableColumns.some(c => currentColumnDrafts[c]?.is_categorical)
                                            }
                                            className="rounded-full border border-[#E8725A]/20 bg-[#E8725A] text-[#2B2B2B] px-4 font-semibold hover:bg-[#D4613D]"
                                        >
                                            Générer embeddings catégoriels
                                        </Button>
                                    </div>
                                </div>
                            </DialogFooter>
                        </DialogContent>
                    </Dialog>

                    <Dialog open={isSupabaseDialogOpen} onOpenChange={setIsSupabaseDialogOpen}>
                        <DialogContent className="max-w-2xl">
                            <DialogHeader>
                                <DialogTitle>Ajouter Supabase</DialogTitle>
                                <DialogDescription>
                                    Créez une source Supabase/PostgreSQL, puis ajoutez ses tables et descriptions de colonnes comme pour SQL Server.
                                </DialogDescription>
                            </DialogHeader>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <div>
                                    <label className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">source_id</label>
                                    <Input value={supabaseForm.source_id} onChange={(e) => setSupabaseForm(prev => ({ ...prev, source_id: e.target.value }))} className="mt-1" placeholder="supabase_finance" />
                                </div>
                                <div>
                                    <label className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">host</label>
                                    <Input value={supabaseForm.host} onChange={(e) => setSupabaseForm(prev => ({ ...prev, host: e.target.value }))} className="mt-1" placeholder="db.xxxxx.supabase.co" />
                                </div>
                                <div>
                                    <label className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">port</label>
                                    <Input value={supabaseForm.port} onChange={(e) => setSupabaseForm(prev => ({ ...prev, port: e.target.value }))} className="mt-1" placeholder="5432" />
                                </div>
                                <div>
                                    <label className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">database</label>
                                    <Input value={supabaseForm.database} onChange={(e) => setSupabaseForm(prev => ({ ...prev, database: e.target.value }))} className="mt-1" placeholder="postgres" />
                                </div>
                                <div>
                                    <label className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">username</label>
                                    <Input value={supabaseForm.username} onChange={(e) => setSupabaseForm(prev => ({ ...prev, username: e.target.value }))} className="mt-1" placeholder="postgres.xxxxx" />
                                </div>
                                <div>
                                    <label className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">password</label>
                                    <Input type="password" value={supabaseForm.password} onChange={(e) => setSupabaseForm(prev => ({ ...prev, password: e.target.value }))} className="mt-1" placeholder="Mot de passe base" />
                                </div>
                                <div>
                                    <label className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">schema</label>
                                    <Input value={supabaseForm.db_schema} onChange={(e) => setSupabaseForm(prev => ({ ...prev, db_schema: e.target.value }))} className="mt-1" placeholder="public" />
                                </div>
                                <div>
                                    <label className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">description</label>
                                    <Input value={supabaseForm.description} onChange={(e) => setSupabaseForm(prev => ({ ...prev, description: e.target.value }))} className="mt-1" placeholder="Source Supabase finance" />
                                </div>
                            </div>
                            <DialogFooter>
                                <Button variant="ghost" onClick={() => setIsSupabaseDialogOpen(false)}>Fermer</Button>
                                <Button onClick={handleCreateSupabaseSource} disabled={isCreatingSupabase} className="font-bold">
                                    {isCreatingSupabase ? 'Création...' : 'Ajouter Supabase'}
                                </Button>
                            </DialogFooter>
                        </DialogContent>
                    </Dialog>

                    <Dialog open={isSqlTablesDialogOpen} onOpenChange={setIsSqlTablesDialogOpen}>
                        <DialogContent className="max-w-6xl h-[88vh] p-0 overflow-hidden grid grid-rows-[auto_minmax(0,1fr)_auto]">
                            <DialogHeader className="px-6 pt-6 pb-3 border-b border-border/30">
                                <DialogTitle className="text-xl font-black uppercase tracking-tight">Gestion des tables SQL</DialogTitle>
                                <DialogDescription>
                                    {selectedSource ? `Source SQL / Oracle / Supabase: ${selectedSource}. Ajoutez des tables, vues ou requêtes, gérez enabled/disabled et les foreign_keys (persisté dans config/datasources.yaml).` : 'Sélectionnez une source SQL, Oracle ou Supabase.'}
                                </DialogDescription>
                            </DialogHeader>

                            <div className="min-h-0 overflow-y-auto px-6 py-4 grid grid-cols-1 xl:grid-cols-2 gap-6">
                                <div className="space-y-3">
                                    <div className="flex items-center justify-between">
                                        <h4 className="text-xs font-black uppercase tracking-widest text-[#6B6966]">Tables configurées</h4>
                                        <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => resetSqlTableForm()}>
                                            Nouvelle table
                                        </Button>
                                    </div>
                                    {isLoadingSqlTables ? (
                                        <Card className="p-6 text-sm text-[#6B6966]">Chargement...</Card>
                                    ) : (sqlSourceConfig?.tables?.length ? (
                                        <div className="space-y-2">
                                            {sqlSourceConfig.tables.map((tbl) => (
                                                <Card key={tbl.table_id} className="p-4 border-[#E8E6E1] bg-[#F8F7F4]/5">
                                                    <div className="flex items-start justify-between gap-3">
                                                        <div className="min-w-0">
                                                            <p className="font-black text-sm">{tbl.table_id}</p>
                                                            <p className="text-xs text-[#6B6966] truncate">{tbl.table_name || 'Custom query'}</p>
                                                            <p className="text-[10px] text-[#6B6966] mt-1">
                                                                {tbl.enabled ? 'Enabled' : 'Disabled'} · FK: {(tbl.foreign_keys || []).length}
                                                            </p>
                                                        </div>
                                                        <div className="flex gap-2">
                                                            <Button
                                                                variant="outline"
                                                                size="sm"
                                                                className="h-8 text-xs"
                                                                onClick={() => resetSqlTableForm(tbl)}
                                                            >
                                                                Éditer
                                                            </Button>
                                                            <Button
                                                                variant={tbl.enabled ? "outline" : "default"}
                                                                size="sm"
                                                                className="h-8 text-xs"
                                                                onClick={async () => {
                                                                    resetSqlTableForm({ ...tbl, enabled: !tbl.enabled });
                                                                    try {
                                                                        await upsertSqlTableConfig(selectedSource, { ...tbl, enabled: !tbl.enabled });
                                                                        await Promise.all([loadSqlSourceTables(selectedSource), fetchSchema()]);
                                                                    } catch (error) {
                                                                        console.error('Error toggling SQL table enabled:', error);
                                                                        alert('Erreur lors du changement de statut.');
                                                                    }
                                                                }}
                                                            >
                                                                {tbl.enabled ? 'Désactiver' : 'Activer'}
                                                            </Button>
                                                            <Button
                                                                variant="default"
                                                                size="sm"
                                                                className="h-8 text-xs bg-red-600 text-white hover:bg-red-700"
                                                                onClick={() => handleDeleteSqlTable(tbl.table_id)}
                                                            >
                                                                <Trash2 className="h-3.5 w-3.5 mr-1" />
                                                                Supprimer
                                                            </Button>
                                                        </div>
                                                    </div>
                                                </Card>
                                            ))}
                                        </div>
                                    ) : (
                                        <Card className="p-6 text-sm text-[#6B6966] border-dashed">
                                            Aucune table SQL configurée pour cette source.
                                        </Card>
                                    ))}
                                </div>

                                <div className="space-y-4">
                                    <h4 className="text-xs font-black uppercase tracking-widest text-[#6B6966]">Ajouter / modifier une table</h4>
                                    <Card className="p-4 border-[#E8E6E1] bg-background/50 space-y-4">
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                            <div>
                                                <label className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">table_id (optionnel)</label>
                                                <Input value={sqlTableForm.table_id} onChange={(e) => setSqlTableForm(prev => ({ ...prev, table_id: e.target.value }))} placeholder="commande_entete (auto si vide)" className="mt-1" />
                                            </div>
                                            <div>
                                                <label className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">table_name (requis)</label>
                                                <Input value={sqlTableForm.table_name} onChange={(e) => setSqlTableForm(prev => ({ ...prev, table_name: e.target.value }))} placeholder="RqtCmdEntete" className="mt-1" />
                                            </div>
                                        </div>

                                        <div>
                                            <label className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">query (optionnel, remplace table_name)</label>
                                            <Textarea value={sqlTableForm.query} onChange={(e) => setSqlTableForm(prev => ({ ...prev, query: e.target.value }))} className="mt-1 min-h-[90px] font-mono text-xs" placeholder="SELECT ... FROM ..." />
                                        </div>

                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                            <div>
                                                <label className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">columns_class (_dto)</label>
                                                <Input value={sqlTableForm.columns_class} onChange={(e) => setSqlTableForm(prev => ({ ...prev, columns_class: e.target.value }))} placeholder="Laisser vide pour auto-générer le _dto" className="mt-1" />
                                            </div>
                                            <div>
                                                <label className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">incremental_column</label>
                                                <Input value={sqlTableForm.incremental_column} onChange={(e) => setSqlTableForm(prev => ({ ...prev, incremental_column: e.target.value }))} placeholder="LastModified" className="mt-1" />
                                            </div>
                                        </div>

                                        <div>
                                            <label className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">description</label>
                                            <Input value={sqlTableForm.description} onChange={(e) => setSqlTableForm(prev => ({ ...prev, description: e.target.value }))} placeholder="RqtCmdEntete table" className="mt-1" />
                                        </div>

                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                            <div>
                                                <label className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">cache_file</label>
                                                <Input value={sqlTableForm.cache_file} onChange={(e) => setSqlTableForm(prev => ({ ...prev, cache_file: e.target.value }))} placeholder={`${selectedSource || 'sql_source'}_table.parquet`} className="mt-1" />
                                            </div>
                                            <div>
                                                <label className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">embeddings_file</label>
                                                <Input value={sqlTableForm.embeddings_file} onChange={(e) => setSqlTableForm(prev => ({ ...prev, embeddings_file: e.target.value }))} placeholder={`${selectedSource || 'sql_source'}_table_embeddings.parquet`} className="mt-1" />
                                            </div>
                                        </div>

                                        <div className="flex items-center justify-between rounded-lg border border-border/30 px-3 py-2">
                                            <div>
                                                <p className="text-xs font-bold">Table activée</p>
                                                <p className="text-[10px] text-[#6B6966]">Persisté dans `config/datasources.yaml` (sections `data_sources` et `datasources`)</p>
                                            </div>
                                            <Button
                                                type="button"
                                                variant={sqlTableForm.enabled ? "default" : "outline"}
                                                size="sm"
                                                className="h-8 text-xs"
                                                onClick={() => setSqlTableForm(prev => ({ ...prev, enabled: !prev.enabled }))}
                                            >
                                                {sqlTableForm.enabled ? 'Enabled' : 'Disabled'}
                                            </Button>
                                        </div>

                                        <div>
                                            <label className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">foreign_keys (JSON array)</label>
                                            <Textarea
                                                value={sqlTableForm.foreign_keys_json}
                                                onChange={(e) => setSqlTableForm(prev => ({ ...prev, foreign_keys_json: e.target.value }))}
                                                className="mt-1 min-h-[170px] font-mono text-xs"
                                                placeholder={`[\n  {\n    "local_column": "CodeBC",\n    "ref_table_id": "commande_entete",\n    "ref_column": "CodeBC",\n    "enabled": true\n  }\n]`}
                                            />
                                        </div>
                                    </Card>
                                </div>
                            </div>

                            <DialogFooter className="px-6 py-4 border-t border-border/30 bg-background">
                                <div className="w-full flex items-center justify-between gap-3">
                                    <p className="text-xs text-[#6B6966]">
                                        Les changements mettent à jour `qclick-agent/config/datasources.yaml`.
                                    </p>
                                    <div className="flex gap-2">
                                        <Button variant="ghost" onClick={() => setIsSqlTablesDialogOpen(false)}>Fermer</Button>
                                        {editingSqlTableId && (
                                            <Button
                                                variant="outline"
                                                onClick={() => handleDeleteSqlTable(editingSqlTableId)}
                                                className="font-bold text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700"
                                            >
                                                Supprimer
                                            </Button>
                                        )}
                                        <Button onClick={saveSqlTable} disabled={isSavingSqlTable || !selectedSource} className="font-bold">
                                            {isSavingSqlTable ? 'Sauvegarde...' : 'Sauvegarder la table'}
                                        </Button>
                                    </div>
                                </div>
                            </DialogFooter>
                        </DialogContent>
                    </Dialog>

                    {!embedded && (
                    <div className="mt-20 pt-10 border-t border-[#E8E6E1] flex flex-col md:flex-row justify-between items-center gap-6 text-[10px] text-[#6B6966] font-black uppercase tracking-widest">
                        <div className="flex items-center gap-2">
                            <AlertCircle className="h-3 w-3" />
                            <span>Statut infrastructure: <span className="text-[#0D7377]">Opérationnel</span></span>
                        </div>
                        <div className="flex gap-8">
                            <a href="#" className="hover:text-[#0D7377] transition-colors">Documentation API</a>
                            <a href="#" className="hover:text-[#0D7377] transition-colors">Centre d'aide</a>
                            <a href="#" className="hover:text-[#0D7377] transition-colors">Status</a>
                            <a href="#" className="hover:text-[#0D7377] transition-colors">Mentions légales</a>
                        </div>
                    </div>
                    )}
                </div>
            </ScrollArea>
            </div>

            <Dialog open={deleteSourceDialog.open} onOpenChange={(open) => {
                if (!open) closeDeleteSourceDialog();
            }}>
                <DialogContent className="border-[#E8E6E1] bg-[#FCFBF8] sm:max-w-[520px]">
                    <DialogHeader>
                        <DialogTitle className="settings-display text-2xl text-[#2B2B2B]">
                            Supprimer la source
                        </DialogTitle>
                        <DialogDescription className="pt-2 text-sm leading-relaxed text-[#6B6966]">
                            Cette action retire la source de la configuration active. Vous pouvez aussi supprimer les fichiers cache associés dans la même étape.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4">
                        <div className="rounded-[22px] border border-[#E8E6E1] bg-white px-5 py-4">
                            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#A09E99]">Source ciblée</p>
                            <p className="settings-mono mt-2 text-sm font-semibold text-[#2B2B2B]">
                                {deleteSourceDialog.sourceId}
                            </p>
                        </div>

                        <label className="flex items-start gap-3 rounded-[22px] border border-[#E8E6E1] bg-white px-5 py-4 text-sm text-[#4A4845]">
                            <input
                                type="checkbox"
                                className="mt-1 h-4 w-4 rounded border-[#CFCBC3] text-[#0D7377] focus:ring-[#0D7377]/20"
                                checked={deleteSourceDialog.deleteFiles}
                                disabled={deleteSourceDialog.isDeleting}
                                onChange={(event) => setDeleteSourceDialog((prev) => ({
                                    ...prev,
                                    deleteFiles: event.target.checked,
                                }))}
                            />
                            <span className="space-y-1">
                                <span className="block font-semibold text-[#2B2B2B]">
                                    Supprimer aussi les fichiers cache / parquet
                                </span>
                                <span className="block text-xs leading-relaxed text-[#6B6966]">
                                    Activez cette option pour nettoyer les fichiers générés avec la source, au lieu de supprimer uniquement la référence dans la configuration.
                                </span>
                            </span>
                        </label>
                    </div>

                    <DialogFooter className="gap-2 sm:justify-between">
                        <p className="text-xs text-[#A09E99]">
                            La suppression est définitive.
                        </p>
                        <div className="flex gap-2">
                            <Button
                                variant="ghost"
                                onClick={closeDeleteSourceDialog}
                                disabled={deleteSourceDialog.isDeleting}
                            >
                                Annuler
                            </Button>
                            <Button
                                onClick={confirmDeleteSource}
                                disabled={deleteSourceDialog.isDeleting || !deleteSourceDialog.sourceId}
                                className="border border-red-200 bg-red-600 text-white hover:bg-red-700"
                            >
                                {deleteSourceDialog.isDeleting ? 'Suppression...' : 'Supprimer la source'}
                            </Button>
                        </div>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Download Agent Popup */}
            {selectedSource && selectedTable && (
                <DownloadPopup
                    open={showDownloadPopup}
                    onOpenChange={setShowDownloadPopup}
                    sourceId={selectedSource}
                    tableId={selectedTable}
                    onComplete={() => fetchData(selectedSource, selectedTable)}
                />
            )}

            {/* Embedding Agent Popup */}
            {selectedSource && (
                <EmbeddingPipelinePopup
                    open={showEmbeddingPopup}
                    onOpenChange={setShowEmbeddingPopup}
                    sourceId={selectedSource}
                    tableId={selectedTable || undefined}
                    categoricalColumns={
                        selectedTableColumns.filter(c => currentColumnDrafts[c]?.is_categorical)
                    }
                    onComplete={async () => {
                        if (selectedSource) {
                            const [embResult, embHeadResult] = await Promise.allSettled([
                                getColumnEmbeddings(selectedSource, selectedTable || undefined),
                                getParquetHead({
                                    source_id: selectedSource,
                                    table_id: selectedTable || undefined,
                                    cache_type: 'embeddings',
                                    limit: 500,
                                }),
                            ]);
                            setEmbeddingsData(embResult.status === 'fulfilled' ? embResult.value : null);
                            setEmbeddingPreviewHead(embHeadResult.status === 'fulfilled' ? embHeadResult.value : null);
                        }
                    }}
                />
            )}

            {/* QVD Pipeline Popup */}
            <QvdPipelinePopup
                open={showQvdPopup}
                onOpenChange={setShowQvdPopup}
                onComplete={async (sourceId) => {
                    setIsUploadingQvd(false);
                    setQvdPipelineStatus('completed');
                    setQvdPipelineJobId(null);
                    await fetchSchema();
                    setSelectedSource(sourceId);
                    setSelectedTable(null);
                    await fetchData(sourceId, null);
                }}
            />

            {/* XLSX Pipeline Popup */}
            <XlsxPipelinePopup
                open={showXlsxPopup}
                onOpenChange={setShowXlsxPopup}
                onComplete={async (sourceIds) => {
                    setIsUploadingXlsx(false);
                    setXlsxPipelineStatus('completed');
                    await fetchSchema();
                    if (sourceIds.length > 0) {
                        setSelectedSource(sourceIds[0]);
                        setSelectedTable(null);
                        await fetchData(sourceIds[0], null);
                    }
                }}
            />
        </motion.div>
    );
};

export default SettingsView;
