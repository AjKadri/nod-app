import type { Review } from './approval'

export type AutoSettings = {
  enabled: boolean
  /** Daily limit for SOL, in lamports. 0 = none. */
  limitLamports: number
  /** Daily limit per token, by mint: the amount as text in whole tokens, e.g. "100". */
  tokenLimits: Record<string, string>
}
export type TokenAmountRaw = { mint: string; raw: string }
export type LedgerEntry = { id: string; at: number; lamports: number; tokens?: TokenAmountRaw[] }
export type StoredAuto = { settings: AutoSettings; known: string[]; ledger: LedgerEntry[] }

export type AutoDecision =
  | { auto: true; outflowLamports: number; to: string; token?: TokenAmountRaw }
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
        | 'unknown_token'
        | 'no_limit'
        | 'over_limit'
      reason: string
    }

export const MAX_LIMIT_LAMPORTS: number
export const MAX_KNOWN_ADDRESSES: number
export function parseSolToLamports(text: string): number | null
export function normalizeTokenLimit(text: string): string | null
export function tokenLimitRaw(settings: AutoSettings, mint: string, decimals: number): bigint | null
export function spentTodayToken(ledger: LedgerEntry[], mint: string, now: number): bigint
export function remainingToken(args: {
  limitRaw: bigint
  ledger: LedgerEntry[]
  reserved?: TokenAmountRaw[]
  mint: string
  now: number
}): bigint
export function tokenOutflows(review: Review): { mint: string; raw: string; decimals: number }[]
export function tokenTransfer(
  review: Review,
  walletAddress: string,
  options?: { allowCreate?: boolean },
): { mint: string; raw: string; decimals: number; to: string; createsAccount: boolean } | null
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
  reservedTokens?: TokenAmountRaw[]
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
