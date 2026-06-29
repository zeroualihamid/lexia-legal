import {
  FileReferenceFormat,
  ParsedFileReference,
} from './file-reference.types';

/** Normalize user input: trim, unify slashes, strip Arabic commas. */
export function normalizeFileReference(raw: string): string {
  return (raw || '')
    .replace(/[،,]/g, '/')
    .replace(/\s+/g, '')
    .replace(/\/+/g, '/')
    .replace(/^\/|\/$/g, '')
    .trim();
}

/**
 * Classify Moroccan court file references:
 * - Appeal / mahakim:  YEAR/CODE/NUMBER  e.g. 2018/8221/4933
 * - Cassation / CSPJ:  YEAR/CHAMBER/PANEL/NUMBER e.g. 2023/1/1/1823
 */
export function parseFileReference(raw: string): ParsedFileReference {
  const normalized = normalizeFileReference(raw);
  const parts = normalized.split('/').filter(Boolean);

  if (
    parts.length === 4 &&
    /^(19|20)\d{2}$/.test(parts[0]) &&
    /^\d+$/.test(parts[1]) &&
    /^\d+$/.test(parts[2]) &&
    /^\d+$/.test(parts[3])
  ) {
    return {
      raw: normalized,
      format: 'cassation',
      year: parts[0],
      segment2: parts[1],
      segment3: parts[2],
      fileNumber: parts[3],
      cspjQuery: normalized,
    };
  }

  if (
    parts.length === 3 &&
    /^(19|20)\d{2}$/.test(parts[0]) &&
    /^\d+$/.test(parts[1]) &&
    /^\d+$/.test(parts[2])
  ) {
    return {
      raw: normalized,
      format: 'appeal',
      year: parts[0],
      segment2: parts[1],
      fileNumber: parts[2],
      cspjQuery: normalized,
      mahakim: {
        fileYear: parts[0],
        fileCode: parts[1],
        fileNumber: parts[2],
      },
    };
  }

  return {
    raw: normalized,
    format: 'unknown',
    cspjQuery: normalized,
  };
}

export function preferredSourceOrder(
  format: FileReferenceFormat,
): Array<'mahakim' | 'juriscassation'> {
  if (format === 'cassation') return ['juriscassation'];
  if (format === 'appeal') return ['mahakim', 'juriscassation'];
  return ['mahakim', 'juriscassation'];
}

/** CSPJ requires Sujet min 3 chars — derive from file reference digits. */
export function defaultCspjSubject(parsed: ParsedFileReference): string {
  const digits = (parsed.fileNumber || parsed.raw || '').replace(/\D/g, '');
  if (digits.length >= 3) return digits.slice(-4);
  return 'قانون';
}

export function buildDocumentTitle(
  parsed: ParsedFileReference,
  extras?: { decisionNumber?: string; decisionDate?: string; courtName?: string },
): string {
  const parts = [`ملف ${parsed.raw}`];
  if (extras?.decisionNumber) parts.push(`قرار ${extras.decisionNumber}`);
  if (extras?.decisionDate) parts.push(extras.decisionDate);
  if (extras?.courtName) parts.unshift(extras.courtName);
  return parts.filter(Boolean).join(' — ');
}
