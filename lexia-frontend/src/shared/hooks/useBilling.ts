import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import apiClient from '../api/client'

export interface Plan {
  id: string
  name: string
  name_ar: string
  price_monthly: number
  price_yearly: number
  features: string[]
  limits: {
    messages_per_day: number
    searches_per_day: number
    uploads_per_month: number
  }
}

export interface Subscription {
  id: string
  plan_id: string
  plan_name: string
  plan_name_ar: string
  status: 'active' | 'cancelled' | 'expired'
  starts_at: string
  expires_at: string
  auto_renew: boolean
  billing_cycle: 'monthly' | 'yearly'
  price: number
}

export interface Usage {
  messages_today: number
  messages_limit: number
  searches_today: number
  searches_limit: number
  uploads_this_month: number
  uploads_limit: number
  history: Array<{ month: string; messages: number; searches: number }>
}

export interface Invoice {
  id: string
  number: string
  date: string
  amount: number
  currency: string
  status: 'paid' | 'pending' | 'failed'
  pdf_url?: string
}

export function usePlans() {
  return useQuery<Plan[]>({
    queryKey: ['plans'],
    queryFn: async () => {
      const res = await apiClient.get('/billing/plans')
      return res.data
    },
    staleTime: 5 * 60 * 1000,
  })
}

export function useSubscription() {
  return useQuery<Subscription | null>({
    queryKey: ['subscription'],
    queryFn: async () => {
      try {
        const res = await apiClient.get('/billing/subscription')
        return res.data
      } catch (err: any) {
        if (err.response?.status === 404) return null
        throw err
      }
    },
  })
}

export function useUsage() {
  return useQuery<Usage>({
    queryKey: ['usage'],
    queryFn: async () => {
      const res = await apiClient.get('/billing/usage')
      return res.data
    },
    refetchInterval: 60 * 1000,
  })
}

export function useInvoices() {
  return useQuery<Invoice[]>({
    queryKey: ['invoices'],
    queryFn: async () => {
      const res = await apiClient.get('/billing/invoices')
      return res.data
    },
  })
}

export function useSubscribeMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (params: { plan_id: string; billing_cycle: 'monthly' | 'yearly' }) => {
      const res = await apiClient.post('/billing/subscribe', params)
      return res.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['subscription'] })
      qc.invalidateQueries({ queryKey: ['usage'] })
    },
  })
}

export function useCancelSubscriptionMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const res = await apiClient.post('/billing/cancel')
      return res.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['subscription'] })
    },
  })
}

export function useToggleAutoRenewMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (autoRenew: boolean) => {
      const res = await apiClient.patch('/billing/subscription', { auto_renew: autoRenew })
      return res.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['subscription'] })
    },
  })
}
