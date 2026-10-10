import type { PublicKey, VersionedMessage, VersionedTransaction } from '@solana/web3.js'
import type { Chain } from './chain'
import type { NetworkId } from './network'
import type { TokenRegistry, TokenView } from './tokens'

export class ApprovalError extends Error {
  code: string
  constructor(code: string, message: string)
}

export type TransferPayload = {
  type: 'transfer'
  to: string
  lamports: number
  note: string
  agent: string
  network?: NetworkId
}
export type RawPayload = {
  type: 'raw'
  transactionBase64: string
  note: string
  agent: string
  network?: NetworkId
}
export type TokenTransferPayload = {
  type: 'token_transfer'
  mint: string
  to: string
  /** Decimal text, e.g. "250" or "0.5". Converted with the decimals read from the mint. */
  amount: string
  note: string
  agent: string
  network?: NetworkId
}
export type RequestPayload = TransferPayload | TokenTransferPayload | RawPayload

export type Summary = {
  programs: { id: string; name: string | null }[]
  transfers: { from: string; to: string; lamports: number | null }[]
  instructionCount: number
  signerCount: number
  usesLookupTables: boolean
  unknownPrograms: string[]
  tokenInstructions: string[]
  /** Red warnings about token instructions (approve, change authority). */
  tokenDangers: string[]
}

export type Preview = {
  ok: boolean
  preLamports: number | null
  postLamports: number | null
  deltaLamports: number | null
  feeLamports: number | null
  error: string | null
  logs: string[]
  /** Token changes from the simulation. Null when the chain cannot look up accounts. */
  tokens: TokenView | null
}

export type Review = {
  request: RequestPayload
  /** The network this phone was on when it reviewed the request. */
  network: NetworkId
  /** The named tokens for this network, used to label amounts. */
  registry: TokenRegistry
  summary: Summary
  preview: Preview
  /** One sentence for the screen, e.g. "You send 0.001005 SOL (network fee included)". */
  headline: string
  /** False when other signers are involved, so the blockhash cannot be refreshed. */
  refreshable: boolean
  signerCount: number
}

export type SignAndSend = (transaction: VersionedTransaction, minContextSlot: number) => Promise<string>

export const KNOWN_PROGRAMS: Record<string, string>
export const LAMPORTS_PER_SOL: number
export function validateRequest(payload: unknown): RequestPayload
export function assertNetwork(request: RequestPayload, chain: Chain): Promise<void>
export function prepareTransaction(
  payload: unknown,
  walletAddress: PublicKey | string,
  blockhash: string,
  context?: unknown,
): { transaction: VersionedTransaction; refreshed: boolean; signerCount: number }
export function summarizeTransaction(transaction: VersionedTransaction): Summary
export function previewTransaction(
  chain: Chain,
  transaction: VersionedTransaction,
  walletAddress: PublicKey | string,
): Promise<Preview>
export function describePreview(preview: Preview, registry?: TokenRegistry): string
export function formatSol(lamports: number | null | undefined): string
export function reviewRequest(args: {
  payload: unknown
  walletAddress: PublicKey | string
  chain: Chain
  registry?: TokenRegistry
}): Promise<Review>
export function approveRequest(args: {
  payload: unknown
  walletAddress: PublicKey | string
  chain: Chain
  registry?: TokenRegistry
  signAndSend: SignAndSend
}): Promise<{ signature: string; refreshed: boolean }>
export type { VersionedMessage }
