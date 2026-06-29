import { lexiaFetch } from './lexia-api';

export interface DriveConnector {
  id: string;
  name: string;
  folder_id: string;
  auth_type: 'service_account' | 'access_token';
  last_test_at: string | null;
  last_test_status: 'success' | 'failed' | null;
  last_test_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface DriveFileItem {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  modifiedTime?: string;
  md5Checksum?: string;
  isFolder: boolean;
}

export interface DriveFilesResponse {
  files: DriveFileItem[];
  nextPageToken?: string;
}

export interface DriveTestResult {
  ok: boolean;
  fileCount: number;
  message: string;
}

export async function listDriveConnectors(): Promise<DriveConnector[]> {
  return lexiaFetch<DriveConnector[]>('/admin/drive-connectors');
}

export async function createDriveConnector(body: {
  name: string;
  folder_id: string;
  auth_type: 'service_account' | 'access_token';
  service_account_json?: string;
  access_token?: string;
}): Promise<DriveConnector> {
  return lexiaFetch<DriveConnector>('/admin/drive-connectors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function updateDriveConnector(
  id: string,
  body: Partial<{
    name: string;
    folder_id: string;
    auth_type: 'service_account' | 'access_token';
    service_account_json: string;
    access_token: string;
  }>,
): Promise<DriveConnector> {
  return lexiaFetch<DriveConnector>(`/admin/drive-connectors/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function deleteDriveConnector(id: string): Promise<void> {
  await lexiaFetch(`/admin/drive-connectors/${id}`, { method: 'DELETE' });
}

export async function testDriveConnector(id: string): Promise<DriveTestResult> {
  return lexiaFetch<DriveTestResult>(`/admin/drive-connectors/${id}/test`, {
    method: 'POST',
  });
}

export async function listDriveConnectorFiles(
  id: string,
  params: { folderId?: string; pageToken?: string; mimeType?: string } = {},
): Promise<DriveFilesResponse> {
  const qs = new URLSearchParams();
  if (params.folderId) qs.set('folderId', params.folderId);
  if (params.pageToken) qs.set('pageToken', params.pageToken);
  if (params.mimeType) qs.set('mimeType', params.mimeType);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return lexiaFetch<DriveFilesResponse>(`/admin/drive-connectors/${id}/files${suffix}`);
}

export function driveConnectorDownloadUrl(connectorId: string, fileId: string): string {
  const base = import.meta.env.VITE_API_URL || '/api';
  return `${base.replace(/\/$/, '')}/admin/drive-connectors/${connectorId}/files/${fileId}/download`;
}
