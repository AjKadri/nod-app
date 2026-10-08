import type { Presented } from './present'

export type DemoRequest = {
  id: string
  agent: string
  note: string
  ageSeconds: number
  presented: Presented
}

export type DemoHistoryItem = {
  id: string
  agent: string
  note: string
  amount: string | null
  recipient: string
  status: 'approved' | 'rejected' | 'failed'
  reason?: string
  ageSeconds: number
}

export const SAMPLE_RECIPIENT: string
export function demoRequests(): DemoRequest[]
export function demoHistory(): DemoHistoryItem[]
