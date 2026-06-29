import apiClient from './client'

export interface DriveConnector {
  id: string
  name: string
  folder_id: string
  auth_type: 'public_link' | 'service_account' | 'access_token'
  last_test_at: string | null
  last_test_status: 'success' | 'failed' | null
  last_test_message: string | null
  created_at: string
  updated_at: string
}

export interface DriveFileItem {
  id: string
  name: string
  mimeType: string
  size?: number
  modifiedTime?: string
  md5Checksum?: string
  isFolder: boolean
  downloaded?: boolean
  downloadedAt?: string
}

export interface DriveFilesResponse {
  files: DriveFileItem[]
  nextPageToken?: string
}

export interface DriveTestResult {
  ok: boolean
  fileCount: number
  message: string
}

/** Extract folder ID from a Google Drive shared folder URL or raw ID. */
export function parseGoogleDriveFolderId(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  if (/^[a-zA-Z0-9_-]{10,}$/.test(trimmed) && !trimmed.includes('/')) {
    return trimmed
  }
  const folderMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/)
  if (folderMatch) return folderMatch[1]
  const idParam = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/)
  if (idParam) return idParam[1]
  return null
}

export async function listDriveConnectors(): Promise<DriveConnector[]> {
  const { data } = await apiClient.get<DriveConnector[]>('/admin/drive-connectors')
  return data
}

export async function createDriveConnector(body: {
  name: string
  folder_id: string
  auth_type: 'public_link' | 'service_account' | 'access_token'
  service_account_json?: string
  access_token?: string
}): Promise<DriveConnector> {
  const { data } = await apiClient.post<DriveConnector>('/admin/drive-connectors', body)
  return data
}

export async function deleteDriveConnector(id: string): Promise<void> {
  await apiClient.delete(`/admin/drive-connectors/${id}`)
}

export async function testDriveConnector(id: string): Promise<DriveTestResult> {
  const { data } = await apiClient.post<DriveTestResult>(`/admin/drive-connectors/${id}/test`)
  return data
}

export async function listDriveConnectorFiles(
  id: string,
  params: { folderId?: string; pageToken?: string; mimeType?: string } = {},
): Promise<DriveFilesResponse> {
  const { data } = await apiClient.get<DriveFilesResponse>(`/admin/drive-connectors/${id}/files`, {
    params,
  })
  return data
}

export function driveConnectorDownloadUrl(
  connectorId: string,
  fileId: string,
  fileName?: string,
): string {
  const base = import.meta.env.VITE_API_URL || '/api'
  const qs = fileName ? `?fileName=${encodeURIComponent(fileName)}` : ''
  return `${base.replace(/\/$/, '')}/admin/drive-connectors/${connectorId}/files/${fileId}/download${qs}`
}

export interface DriveFetchResult {
  skipped: boolean
  downloadedAt: string
  fileName: string
  fileSizeBytes: number
}

export interface DriveDownloadAllResult {
  total: number
  downloaded: number
  skipped: number
  failed: number
  errors: { fileId: string; fileName: string; message: string }[]
}

export async function fetchDriveConnectorFile(
  connectorId: string,
  fileId: string,
  fileName?: string,
): Promise<DriveFetchResult> {
  const { data } = await apiClient.post<DriveFetchResult>(
    `/admin/drive-connectors/${connectorId}/files/${fileId}/fetch`,
    { fileName },
  )
  return data
}

export async function downloadAllDriveConnectorFiles(
  connectorId: string,
  folderId?: string,
  skipExisting = true,
): Promise<DriveDownloadAllResult> {
  const { data } = await apiClient.post<DriveDownloadAllResult>(
    `/admin/drive-connectors/${connectorId}/download-all`,
    { folderId, skipExisting },
  )
  return data
}
