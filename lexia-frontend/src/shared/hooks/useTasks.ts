import { useQuery } from '@tanstack/react-query'
import apiClient from '../api/client'

export type UploadTaskState = 'queued' | 'running' | 'completed' | 'failed'

export interface UploadTask {
  id: string
  kind: 'upload'
  documentId: string
  title: string
  documentType: string | null
  origin: 'chat' | 'case' | 'search'
  caseId: string | null
  caseTitle: string | null
  state: UploadTaskState
  stage: string
  progress: number
  pageCount: number | null
  error: string | null
  redis: {
    processingJobId: string | null
    processingState: string | null
    analysisJobId: string | null
    analysisState: string | null
  }
  createdAt: string
  updatedAt: string
}

function hasActiveTasks(tasks: UploadTask[] | undefined): boolean {
  return (tasks || []).some(
    (task) => task.state === 'queued' || task.state === 'running',
  )
}

export function useUploadTasks(enabled = true) {
  return useQuery<UploadTask[]>({
    queryKey: ['upload-tasks'],
    enabled,
    queryFn: async () => (await apiClient.get('/tasks')).data,
    refetchInterval: (query) =>
      hasActiveTasks(query.state.data as UploadTask[] | undefined)
        ? 3000
        : 15000,
  })
}
