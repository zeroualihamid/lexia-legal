// 'cassation' = محكمة النقض. It is captured for completeness but is NOT
// searchable on the mahakim.ma public portal (which only covers first-instance
// and appeal courts).
export type CourtType = 'appeal' | 'first_instance' | 'cassation';
export type CaseCategory = 'file' | 'hearings';

export interface MahakimQuery {
  courtType: CourtType;
  courtName: string;
  fileNumber: string; // رقم الملف (numero)
  fileCode: string; // رمز الملف (mark)
  fileYear: string; // السنة (annee)
  category: CaseCategory;
  courtSection?: string | null; // القسم / الغرفة (e.g. القسم التجاري عدد 3)
  courtPanel?: string | null; // الهيئة (e.g. الهيئة عدد 3)
}

export interface MahakimTable {
  caption: string | null;
  headers: string[];
  rows: string[][];
}

export interface MahakimResult {
  found: boolean;
  message: string | null;
  fields: Record<string, string>;
  tables: MahakimTable[];
  text: string;
  query: MahakimQuery;
  capturedAt: string;
}

export interface MahakimSyncJob {
  caseId: string;
  ownerId: string;
  query: MahakimQuery;
}
