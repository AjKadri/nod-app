import type { Review } from './approval'

export type AutoSettings = { enabled: boolean; limitLamports: number }
export type LedgerEntry = { id: string; at: number; lamports: number }
export type StoredAuto = { settings: AutoSettings; known: string[]; ledger: LedgerEntry[] }

export type AutoDecision =
  | { auto: true; outflowLamports: number; to: string }
  | {
      auto: false
      code:
        | 'off'
        | 'paused'
        | 'background'
        | 'preview_failed'
        | 'warnings'
        | 'not_plain'
        | 'amounts'
        | 'unknown_recipient'
        | 'over_limit'
      reason: string
    }

export const MAX_LIMIT_LAMPORTS: number
export const MAX_KNOWN_ADDRESSES: number
export function parseSolToLamports(text: string): number | null
export function startOfLocalDay(now: number): number
export function spentToday(ledger: LedgerEntry[], now: number): number
export function remainingLamports(args: {
  limitLamports: number
  ledger: LedgerEntry[]
  reservedLamports?: number
  now: number
}): number
export function pruneLedger(ledger: LedgerEntry[], now: number): LedgerEntry[]
export function outflowLamports(review: Review): number
export function plainSolTransfer(review: Review, walletAddress: string): { to: string; lamports: number } | null
export function isPausedForAuto(args: { pauseState: 'off' | 'on' | 'partial'; unconfirmedPause?: boolean }): boolean
export function isEnabled(settings: AutoSettings): boolean
export function decideAutoApprove(args: {
  review: Review | undefined
  settings: AutoSettings
  walletAddress: string
  knownAddresses?: string[]
  ledger?: LedgerEntry[]
  reservedLamports?: number
  now: number
  paused: boolean
  appActive: boolean
}): AutoDecision
export function addressToLearn(args: {
  review: Review | undefined
  outcome: { status: string; signature?: string }
  walletAddress: string
}): string | null
export function ledgerEntryFor(args: {
  id: string
  review: Review | undefined
  outcome: { signature?: string; failedOnChain?: boolean } | undefined
  now: number
  maybeSent?: boolean
}): LedgerEntry | null
export function addKnownAddress(known: string[], address: string): string[]
export function removeKnownAddress(known: string[], address: string): string[]
export function parseStored(text: string): StoredAuto
