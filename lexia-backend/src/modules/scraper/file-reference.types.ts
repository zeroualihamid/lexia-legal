import { MahakimResult } from '../mahakim/mahakim.types';

export type FileReferenceFormat = 'appeal' | 'cassation' | 'unknown';

export interface ParsedFileReference {
  raw: string;
  format: FileReferenceFormat;
  year?: string;
  /** Appeal: رمز الملف (mark). Cassation: chamber id segment. */
  segment2?: string;
  /** Cassation: panel segment. */
  segment3?: string;
  /** Appeal: رقم الملف. Cassation: file segment. */
  fileNumber?: string;
  /** Full string for CSPJ NumeroDos field. */
  cspjQuery?: string;
  /** Mahakim fields when format is appeal. */
  mahakim?: {
    fileYear: string;
    fileCode: string;
    fileNumber: string;
  };
}

export interface ScrapeByFileReferenceOptions {
  fileReference: string;
  courtName?: string;
  courtType?: 'appeal' | 'first_instance' | 'cassation';
  locale?: 'ar' | 'en' | 'fr';
  /** CSPJ subject fallback when the portal requires Sujet (min 3 chars). */
  searchSubject?: string;
}

export interface ScrapeByFileReferenceResult {
  fileReference: string;
  format: FileReferenceFormat;
  source: 'mahakim' | 'juriscassation' | 'none';
  found: boolean;
  title?: string;
  pdf?: Buffer;
  pdfUrl?: string;
  mahakim?: MahakimResult;
  metadata?: Record<string, unknown>;
  message?: string;
}
