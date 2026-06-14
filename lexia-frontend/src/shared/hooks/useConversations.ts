import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import apiClient from '../api/client'

export interface Conversation {
  id: string
  user_id: string
  title_ar: string
  message_count: number
  is_archived: boolean
  created_at: string
  updated_at: string
}

export interface ConversationMessage {
  id: string
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  tokens_used: number
  created_at: string
}

/**
 * Conversation history is a PRO+ feature on the backend (RequireAccessLevel('PRO')),
 * so callers should only enable this when the user is at least PRO.
 */
export function useConversations(enabled = true) {
  return useQuery<Conversation[]>({
    queryKey: ['conversations'],
    enabled,
    queryFn: async () => (await apiClient.get('/chat/conversations')).data,
  })
}

export function useCreateConversation() {
  const qc = useQueryClient()
  return useMutation<Conversation, unknown, void>({
    mutationFn: async () => (await apiClient.post('/chat/conversations')).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['conversations'] }),
  })
}

/** Backend exposes archive as the soft-delete: it drops the row out of the list. */
export function useDeleteConversation() {
  const qc = useQueryClient()
  return useMutation<void, unknown, string>({
    mutationFn: async (id: string) => {
      await apiClient.patch(`/chat/conversations/${id}/archive`)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['conversations'] }),
  })
}

export async function fetchConversationMessages(
  id: string,
): Promise<ConversationMessage[]> {
  return (await apiClient.get(`/chat/conversations/${id}/messages`)).data
}
