import { useQuery } from '@tanstack/react-query'
import apiClient from '../api/client'

export interface DocumentPagesResponse {
  pages: Array<{ page_number: number; width: number | null; height: number | null }>
  pagesStatus: 'pending' | 'running' | 'completed' | 'failed' | null
  pageCount: number | null
}

// `basePath` selects the API surface: '/admin/documents' (admin) or
// '/documents' (owner-scoped user endpoints). Both expose identical
// /:id/pages and /:id/pages/:n/url shapes.
export function useDocumentPages(
  documentId: string | null,
  basePath = '/admin/documents',
) {
  return useQuery<DocumentPagesResponse>({
    queryKey: ['document-pages', basePath, documentId],
    enabled: !!documentId,
    queryFn: async () => {
      const res = await apiClient.get(`${basePath}/${documentId}/pages`)
      return res.data
    },
    refetchInterval: (q) => {
      const data = q.state.data
      if (!data) return 2000
      return data.pagesStatus === 'pending' || data.pagesStatus === 'running'
        ? 2000
        : false
    },
  })
}

export function useDocumentPageUrl(
  documentId: string | null,
  pageNumber: number | null,
  basePath = '/admin/documents',
) {
  return useQuery<{ url: string; expiresIn: number }>({
    queryKey: ['document-page-url', basePath, documentId, pageNumber],
    enabled: !!documentId && !!pageNumber,
    queryFn: async () => {
      const res = await apiClient.get(
        `${basePath}/${documentId}/pages/${pageNumber}/url`,
      )
      return res.data
    },
    // Presigned URL is valid for 1h; refetch a bit before to avoid drift.
    staleTime: 1000 * 60 * 50,
  })
}
