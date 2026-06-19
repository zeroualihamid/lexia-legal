import { lexiaFetch } from '@/lib/lexia-api';

export interface AdminDocument {
  id: string;
  title_ar: string;
  title_fr: string | null;
  collection: string;
  status: string;
  visibility: string;
  owner_type: string;
  owner_id: string | null;
  page_count: number | null;
  pages_status: string | null;
  minio_bucket: string;
  minio_key: string;
  created_at: string;
  uploaded_by: string | null;
  uploaded_by_email: string | null;
}

export function listAdminDocuments(params?: {
  limit?: number;
  offset?: number;
  status?: string;
}): Promise<AdminDocument[]> {
  const q = new URLSearchParams();
  if (params?.limit) q.set('limit', String(params.limit));
  if (params?.offset) q.set('offset', String(params.offset));
  if (params?.status) q.set('status', params.status);
  const qs = q.toString();
  return lexiaFetch<AdminDocument[]>(`/admin/documents${qs ? `?${qs}` : ''}`);
}
