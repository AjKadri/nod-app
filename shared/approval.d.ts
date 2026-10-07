import type { PublicKey, VersionedMessage, VersionedTransaction } from '@solana/web3.js'
import type { Chain } from './chain'

export class ApprovalError extends Error {
  code: string
  constructor(code: string, message: string)
}

export type TransferPayload = { type: 'transfer'; to: string; lamports: number; note: string; agent: string }
export type RawPayload = { type: 'raw'; transactionBase64: string; note: string; agent: string }
export type RequestPayload = TransferPayload | RawPayload

export type Summary = {
  programs: { id: string; name: string | null }[]
  transfers: { from: string; to: string; lamports: number | null }[]
  instructionCount: number
  signerCount: number
  usesLookupTables: boolean
  unknownPrograms: string[]
}

export type Preview = {
  ok: boolean
  preLamports: number | null
  postLamports: number | null
  deltaLamports: number | null
  feeLamports: number | null
  error: string | null
  logs: string[]
}

export type Review = {
  request: RequestPayload
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
export function prepareTransaction(
  payload: unknown,
  walletAddress: PublicKey | string,
  blockhash: string,
): { transaction: VersionedTransaction; refreshed: boolean; signerCount: number }
export function summarizeTransaction(transaction: VersionedTransaction): Summary
export function previewTransaction(
  chain: Chain,
  transaction: VersionedTransaction,
  walletAddress: PublicKey | string,
): Promise<Preview>
export function describePreview(preview: Preview): string
export function formatSol(lamports: number | null | undefined): string
export function reviewRequest(args: { payload: unknown; walletAddress: PublicKey | string; chain: Chain }): Promise<Review>
export function approveRequest(args: {
  payload: unknown
  walletAddress: PublicKey | string
  chain: Chain
  signAndSend: SignAndSend
}): Promise<{ signature: string; refreshed: boolean }>
export type { VersionedMessage }
