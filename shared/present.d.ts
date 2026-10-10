import type { Review } from './approval'
import type { NetworkId } from './network'

export type Presented = {
  headline: string
  agentClaim: string | null
  amount: string | null
  /** "SOL", a token symbol ("SKR", "SKR (test)") or a shortened mint. */
  unit: string
  /** The token on the card when it is not SOL. */
  token: { mint: string; label: string; symbol: string | null; logo: string | null; known: boolean; test: boolean } | null
  network: NetworkId | null
  direction: 'send' | 'receive' | 'none' | 'unknown'
  action: string
  recipient: { kind: 'address' | 'text'; value: string }
  fee: string
  /** Lines under the amount, e.g. rent for a new token account. */
  notes: string[]
  /** Other amounts that move in the same transaction. */
  also: string[]
  /** The wallet's token balances before and after. */
  tokenLines: string[]
  previewOk: boolean
  previewText: string
  mismatch: { said: string; actual: string; message: string } | null
  /** True when any red (danger) warning shows. */
  risky: boolean
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
export function findTokenMismatches(note: string, review: Review): { said: string; actual: string; message: string }[]
export function findImpostors(note: string, review: Review): string[]
export function claimedTokenAmounts(note: string): { amount: string; symbol: string }[]
export function claimedLamports(note: string): number[]
export function formatAmount(lamports: number): string
