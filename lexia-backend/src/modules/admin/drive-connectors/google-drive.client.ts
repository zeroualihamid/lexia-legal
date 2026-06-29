import { GoogleAuth } from 'google-auth-library';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

export interface DriveFileItem {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  modifiedTime?: string;
  md5Checksum?: string;
  isFolder: boolean;
  downloaded?: boolean;
  downloadedAt?: string;
}

export interface DriveListResult {
  files: DriveFileItem[];
  nextPageToken?: string;
}

export type DriveAuthConfig =
  | { authType: 'public_link' }
  | { authType: 'service_account'; credentials: Record<string, unknown> }
  | { authType: 'access_token'; accessToken: string };

async function getAccessToken(auth: DriveAuthConfig): Promise<string> {
  if (auth.authType === 'public_link') {
    throw new Error('Lien public : pas de jeton OAuth requis.');
  }
  if (auth.authType === 'access_token') {
    return auth.accessToken;
  }
  const client = new GoogleAuth({
    credentials: auth.credentials,
    scopes: [DRIVE_SCOPE],
  });
  const authClient = await client.getClient();
  const tokenResponse = await authClient.getAccessToken();
  if (!tokenResponse.token) {
    throw new Error('Impossible d\'obtenir un jeton Google Drive.');
  }
  return tokenResponse.token;
}

async function driveFetch(accessToken: string, url: string): Promise<Response> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google Drive API ${res.status}: ${body.slice(0, 400)}`);
  }
  return res;
}

export async function testDriveConnection(
  auth: DriveAuthConfig,
  folderId: string,
): Promise<{ ok: boolean; fileCount: number; message: string }> {
  const result = await listDriveFiles(auth, folderId, { pageSize: 5 });
  const pdfs = result.files.filter((f) => !f.isFolder && f.mimeType === 'application/pdf');
  return {
    ok: true,
    fileCount: result.files.length,
    message: `${result.files.length} élément(s) visible(s) dans le dossier (${pdfs.length} PDF).`,
  };
}

export async function listDriveFiles(
  auth: DriveAuthConfig,
  folderId: string,
  options: { pageToken?: string; pageSize?: number; mimeType?: string } = {},
): Promise<DriveListResult> {
  const accessToken = await getAccessToken(auth);
  const pageSize = options.pageSize || 50;
  let q = `'${folderId}' in parents and trashed=false`;
  if (options.mimeType) {
    q += ` and mimeType='${options.mimeType}'`;
  }

  const url = new URL('https://www.googleapis.com/drive/v3/files');
  url.searchParams.set('q', q);
  url.searchParams.set(
    'fields',
    'nextPageToken,files(id,name,mimeType,size,md5Checksum,modifiedTime)',
  );
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('orderBy', 'folder,name');
  if (options.pageToken) {
    url.searchParams.set('pageToken', options.pageToken);
  }

  const res = await driveFetch(accessToken, url.toString());
  const data = await res.json();
  const files: DriveFileItem[] = (data.files || []).map((file: any) => ({
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size ? Number(file.size) : undefined,
    modifiedTime: file.modifiedTime,
    md5Checksum: file.md5Checksum,
    isFolder: file.mimeType === 'application/vnd.google-apps.folder',
  }));

  return {
    files,
    nextPageToken: data.nextPageToken,
  };
}

export async function downloadDriveFile(
  auth: DriveAuthConfig,
  fileId: string,
): Promise<{ buffer: Buffer; mimeType: string; fileName: string }> {
  const accessToken = await getAccessToken(auth);

  const metaUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType`;
  const metaRes = await driveFetch(accessToken, metaUrl);
  const meta = await metaRes.json();

  if (meta.mimeType === 'application/vnd.google-apps.folder') {
    throw new Error('Impossible de télécharger un dossier.');
  }

  const downloadUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  const fileRes = await driveFetch(accessToken, downloadUrl);
  const arrayBuffer = await fileRes.arrayBuffer();

  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: meta.mimeType || 'application/octet-stream',
    fileName: meta.name || 'download',
  };
}
