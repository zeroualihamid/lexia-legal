import { useCallback, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import apiClient from '../api/client'
import { useUploadTasks } from './useTasks'

export interface SearchUploadResult {
  documentId: string
  taskId: string
  jobId: string | number
}

export function useSearchUpload() {
  const queryClient = useQueryClient()
  const [lastDocumentId, setLastDocumentId] = useState<string | null>(null)
  const tasksQ = useUploadTasks(true)

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData()
      fd.append('file', file)
      const res = await apiClient.post<SearchUploadResult>('/search/upload', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      return res.data
    },
    onSuccess: (data) => {
      setLastDocumentId(data.documentId)
      queryClient.invalidateQueries({ queryKey: ['upload-tasks'] })
      queryClient.invalidateQueries({ queryKey: ['search-files'] })
    },
  })

  const uploadFile = useCallback(
    async (file: File) => uploadMutation.mutateAsync(file),
    [uploadMutation],
  )

  const searchTasks = (tasksQ.data || []).filter((task) => task.origin === 'search')
  const activeSearchTasks = searchTasks.filter(
    (task) => task.state === 'queued' || task.state === 'running',
  )

  return {
    uploadFile,
    uploading: uploadMutation.isPending,
    uploadError: uploadMutation.error as Error | null,
    lastDocumentId,
    tasks: searchTasks,
    activeTasks: activeSearchTasks,
    tasksLoading: tasksQ.isLoading,
    refetchTasks: tasksQ.refetch,
  }
}
