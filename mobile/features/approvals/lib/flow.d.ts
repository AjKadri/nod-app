import type { PublicKey } from '@solana/web3.js'
import type { SignAndSend } from './approval'
import type { Chain } from './chain'
import type { RelayClient, RelayRequest, RelayResult } from './relayClient'

export type Outcome = RelayResult & {
  reported: boolean
  reportError?: string
  /** Sent, then failed on chain: only the fee left the wallet. Phone-only, never sent to the relay. */
  failedOnChain?: boolean
  /** Approved without the card. Phone-only. */
  auto?: boolean
}
export type NeedsCard = { status: 'needs_card'; reason: string; reported: false }

/** Throw from signAndSend when the wallet needs the person and nothing has been broadcast. */
export class NeedsCardError extends Error {
  needsCard: true
}

export function explainError(error: unknown): string
export function submitApproval(args: {
  request: RelayRequest
  walletAddress: PublicKey | string
  chain: Chain
  signAndSend: SignAndSend
  relay: RelayClient
  confirmTimeoutMs?: number
}): Promise<Outcome>
export function submitDenial(args: { request: RelayRequest; relay: RelayClient; reason?: string }): Promise<Outcome>
export function submitInvalid(args: { request: RelayRequest; relay: RelayClient; error: unknown }): Promise<Outcome>
export function submitAutoApproval(args: {
  request: RelayRequest
  walletAddress: PublicKey | string
  chain: Chain
  signAndSend: SignAndSend
  relay: RelayClient
  confirmTimeoutMs?: number
}): Promise<Outcome | NeedsCard>
