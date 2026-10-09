import type { Presented } from './present'

export type DemoRequest = {
  id: string
  agent: string
  agentIcon: string
  note: string
  ageSeconds: number
  presented: Presented
}

export type DemoHistoryItem = {
  id: string
  agent: string
  agentIcon: string
  note: string
  amount: string | null
  recipient: string
  status: 'approved' | 'rejected' | 'failed'
  reason?: string
  /** Approved without the card, within the daily limit. */
  auto?: boolean
  /** Today's items: how long ago. Older items: which calendar day and time instead. */
  ageSeconds?: number
  daysAgo?: number
  hour?: number
  minute?: number
}

export const SAMPLE_RECIPIENT: string
export function demoRequests(): DemoRequest[]
export function demoHistory(): DemoHistoryItem[]
