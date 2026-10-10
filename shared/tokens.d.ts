import type { PublicKey, TransactionInstruction } from '@solana/web3.js'

export type TokenInfo = { symbol: string; label: string; logo: string | null; test?: boolean }
export type TokenRegistry = { network: string; tokens: Record<string, TokenInfo> }

export type RawAccount = { lamports: number; owner: string; data: Uint8Array } | null

export type TokenChange = {
  mint: string
  /** Raw amounts as decimal strings (no rounding). */
  preRaw: string
  postRaw: string
  deltaRaw: string
  decimals: number
  program: string
  claimedSymbol: string | null
}
export type TokenOther = TokenChange & { owner?: string }
export type TokenView = {
  /** False when some account could not be read, so the list may be missing changes. */
  complete: boolean
  /** Changes to the wallet's own token accounts. */
  changes: TokenChange[]
  /** Changes to other people's token accounts (the recipient). */
  others: TokenOther[]
  /** Token accounts this transaction creates. */
  created: { address: string; mint: string; owner: string; own: boolean; rentLamports: number }[]
  error: string | null
}

export const TOKEN_PROGRAM_ID: string
export const TOKEN_2022_PROGRAM_ID: string
export const ASSOCIATED_TOKEN_PROGRAM_ID: string
export const METAPLEX_METADATA_PROGRAM_ID: string
export const SKR_MINT: string
export const USDC_MINT: { mainnet: string; devnet: string }
export const MAX_WATCHED_ACCOUNTS: number

export function isTokenProgram(programId: string): boolean
export function tokenRegistry(network: string, options?: { testSkrMint?: string | null }): TokenRegistry
export function officialMintFor(registry: TokenRegistry, symbol: string): string | null
export function shortMint(mint: string): string
export function tokenLabel(registry: TokenRegistry | null | undefined, mint: string): string
export function protectedSymbols(registry: TokenRegistry | null | undefined): string[]
export function parseTokenAmount(text: string, decimals: number): bigint | null
export function formatTokenAmount(raw: bigint | string | number, decimals: number): string
export function formatSolShort(lamports: number): string
export function classifyTokenInstruction(
  programId: string,
  data: Uint8Array,
): { kind: 'transfer' | 'createAta' | 'dangerous' | 'other'; danger?: string } | null
export function associatedTokenAddress(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey
export function createAtaIdempotentInstruction(args: {
  payer: PublicKey
  ata: PublicKey
  owner: PublicKey
  mint: PublicKey
  tokenProgram: PublicKey
}): TransactionInstruction
export function transferCheckedInstruction(args: {
  source: PublicKey
  mint: PublicKey
  destination: PublicKey
  authority: PublicKey
  amount: bigint
  decimals: number
  tokenProgram: PublicKey
}): TransactionInstruction
