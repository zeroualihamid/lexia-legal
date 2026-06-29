import { DriveFileItem, DriveListResult } from './google-drive.client';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const USER_AGENT =
  'Mozilla/5.0 (compatible; LexiaLegal/1.0; +https://lexia.legal)';

/** Public folders shared as "anyone with the link" — no OAuth required. */
export async function listPublicDriveFolder(
  folderId: string,
  options: { pageToken?: string; pageSize?: number; mimeType?: string } = {},
): Promise<DriveListResult> {
  if (options.pageToken) {
    return { files: [] };
  }

  const url = `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(folderId)}#list`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(
      `Impossible d'accéder au dossier public (${res.status}). Vérifiez que le lien est partagé en lecture pour « toute personne disposant du lien ».`,
    );
  }

  const html = await res.text();
  const files = parseEmbeddedFolderHtml(html);

  let filtered = files;
  if (options.mimeType) {
    filtered = files.filter((f) => f.mimeType === options.mimeType);
  }

  return { files: filtered };
}

export function parseEmbeddedFolderHtml(html: string): DriveFileItem[] {
  const files: DriveFileItem[] = [];
  const chunks = html.split(/<div class="flip-entry"/).slice(1);

  for (const chunk of chunks) {
    const idMatch = chunk.match(/^\s*id="entry-([^"]+)"/);
    if (!idMatch) continue;

    const id = idMatch[1];
    const titleMatch = chunk.match(/<div class="flip-entry-title">([^<]+)<\/div>/);
    const name = titleMatch?.[1]?.trim() || id;

    const isFolder =
      chunk.includes('type/application/vnd.google-apps.folder') ||
      chunk.includes('/drive/folders/');
    const mimeType = isFolder ? FOLDER_MIME : guessMimeType(chunk, name);

    files.push({
      id,
      name,
      mimeType,
      isFolder,
    });
  }

  return files;
}

function guessMimeType(block: string, name: string): string {
  const iconMatch = block.match(/type\/([^"']+)/);
  if (iconMatch) {
    return decodeURIComponent(iconMatch[1].replace(/\+/g, ' '));
  }
  if (name.toLowerCase().endsWith('.pdf')) {
    return 'application/pdf';
  }
  return 'application/octet-stream';
}

export async function downloadPublicDriveFile(
  fileId: string,
  fileNameHint?: string,
): Promise<{ buffer: Buffer; mimeType: string; fileName: string }> {
  const downloadUrl = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
  const res = await fetch(downloadUrl, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'follow',
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Téléchargement public échoué (${res.status}): ${body.slice(0, 200)}`,
    );
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const contentType = res.headers.get('content-type') || '';
  let mimeType = 'application/octet-stream';
  let fileName = fileNameHint || 'download';

  if (contentType.includes('pdf')) {
    mimeType = 'application/pdf';
  } else if (contentType && !contentType.includes('text/html')) {
    mimeType = contentType.split(';')[0].trim();
  } else if (fileNameHint?.toLowerCase().endsWith('.pdf')) {
    mimeType = 'application/pdf';
  }

  const disposition = res.headers.get('content-disposition') || '';
  const nameMatch = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
  if (nameMatch) {
    fileName = decodeURIComponent(nameMatch[1].replace(/"/g, ''));
  }

  return { buffer, mimeType, fileName };
}

export async function testPublicDriveConnection(
  folderId: string,
): Promise<{ ok: boolean; fileCount: number; message: string }> {
  const result = await listPublicDriveFolder(folderId, { pageSize: 100 });
  const pdfs = result.files.filter(
    (f) => !f.isFolder && f.mimeType === 'application/pdf',
  );
  return {
    ok: true,
    fileCount: result.files.length,
    message: `${result.files.length} élément(s) accessible(s) via lien public (${pdfs.length} PDF).`,
  };
}
