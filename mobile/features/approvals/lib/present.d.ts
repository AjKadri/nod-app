import type { Review } from './approval'

export type Presented = {
  headline: string
  agentClaim: string | null
  amount: string | null
  unit: string
  direction: 'send' | 'receive' | 'none' | 'unknown'
  action: string
  recipient: { kind: 'address' | 'text'; value: string }
  fee: string
  previewOk: boolean
  previewText: string
  mismatch: { said: string; actual: string; message: string } | null
  warnings: { level: 'danger' | 'warn'; text: string }[]
  programs: { id: string; name: string | null }[]
  transfers: { to: string; lamports: number | null }[]
  logs: string[]
}

export function presentReview(review: Review): Presented
export function findAmountMismatch(
  note: string,
  review: Review,
): { saidLamports: number; actualLamports: number } | null
export function claimedLamports(note: string): number[]
export function formatAmount(lamports: number): string
