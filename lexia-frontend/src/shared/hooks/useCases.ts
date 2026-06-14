import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import apiClient from '../api/client'

export type MahakimStatus =
  | 'idle'
  | 'queued'
  | 'processing'
  | 'ready'
  | 'not_found'
  | 'failed'
  | 'unsupported'

export type CourtType = 'appeal' | 'first_instance' | 'cassation'

export interface MahakimTable {
  caption: string | null
  headers: string[]
  rows: string[][]
}

export interface MahakimData {
  found: boolean
  message: string | null
  fields: Record<string, string>
  tables: MahakimTable[]
  text: string
  query?: Record<string, string>
  capturedAt?: string
}

export interface CaseRecord {
  id: string
  owner_id: string
  title: string
  client_name: string | null
  case_ref: string | null
  description: string | null
  status: 'open' | 'closed' | 'archived'
  // Structured court reference (mahakim.ma lookup).
  court_type: CourtType | null
  court_name: string | null
  file_number: string | null
  file_code: string | null
  file_year: string | null
  court_section: string | null
  court_panel: string | null
  case_category: 'file' | 'hearings' | null
  mahakim_status: MahakimStatus
  mahakim_data: MahakimData | null
  mahakim_fetched_at: string | null
  mahakim_error: string | null
  document_count?: number
  processing_count?: number
  created_at: string
  updated_at: string
}

export interface CaseDocument {
  id: string
  title_ar: string
  title_fr: string | null
  document_type: string | null
  status: string
  pages_status: string | null
  page_count: number | null
  file_size_bytes: number | null
  content_type: string | null
  created_at: string
  error_message: string | null
}

export interface CaseSearchHit {
  documentId: string
  caseId: string | null
  docType: string | null
  documentType?: string | null
  chunkIndex: number
  content: string
  score: number
  titleAr?: string | null
}

export interface CasePayload {
  title?: string
  clientName?: string
  caseRef?: string
  description?: string
  status?: string
  courtType?: CourtType
  courtName?: string
  fileNumber?: string
  fileCode?: string
  fileYear?: string
  courtSection?: string
  courtPanel?: string
  caseCategory?: 'file' | 'hearings'
}

const MAHAKIM_PENDING: MahakimStatus[] = ['queued', 'processing']

export function useCases(enabled = true) {
  return useQuery<CaseRecord[]>({
    queryKey: ['cases'],
    enabled,
    queryFn: async () => (await apiClient.get('/cases')).data,
    refetchInterval: (q) =>
      (q.state.data || []).some((c) => MAHAKIM_PENDING.includes(c.mahakim_status))
        ? 4000
        : false,
  })
}

export function useCase(id: string | null) {
  return useQuery<CaseRecord>({
    queryKey: ['case', id],
    enabled: !!id,
    queryFn: async () => (await apiClient.get(`/cases/${id}`)).data,
    refetchInterval: (q) =>
      q.state.data && MAHAKIM_PENDING.includes(q.state.data.mahakim_status)
        ? 4000
        : false,
  })
}

export function useRefreshMahakim() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (caseId: string) =>
      (await apiClient.post(`/cases/${caseId}/mahakim/refresh`)).data,
    onSuccess: (_d, caseId) => {
      qc.invalidateQueries({ queryKey: ['cases'] })
      qc.invalidateQueries({ queryKey: ['case', caseId] })
    },
  })
}

export function useCaseDocuments(id: string | null) {
  return useQuery<CaseDocument[]>({
    queryKey: ['case-documents', id],
    enabled: !!id,
    queryFn: async () => (await apiClient.get(`/cases/${id}/documents`)).data,
    refetchInterval: (q) => {
      const data = q.state.data
      if (!data) return false
      return data.some((d) => d.status === 'processing') ? 3000 : false
    },
  })
}

export function useCreateCase() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: CasePayload) =>
      (await apiClient.post('/cases', payload)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cases'] }),
  })
}

export function useUpdateCase(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: CasePayload) =>
      (await apiClient.patch(`/cases/${id}`, payload)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cases'] })
      qc.invalidateQueries({ queryKey: ['case', id] })
    },
  })
}

export function useDeleteCase() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => (await apiClient.delete(`/cases/${id}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cases'] }),
  })
}

export function useDeleteCaseDocument(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (documentId: string) =>
      (await apiClient.delete(`/documents/${documentId}`)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['case-documents', caseId] })
      qc.invalidateQueries({ queryKey: ['cases'] })
    },
  })
}

export async function searchCase(
  caseId: string,
  query: string,
  limit = 10,
): Promise<CaseSearchHit[]> {
  const res = await apiClient.post(`/cases/${caseId}/search`, { query, limit })
  return res.data
}

export interface UploadQuota {
  used: number
  limit: number
  month: string
}

export function useUploadQuota() {
  return useQuery<UploadQuota>({
    queryKey: ['upload-quota'],
    queryFn: async () => (await apiClient.get('/documents/quota')).data,
  })
}
