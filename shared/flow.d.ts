import type { PublicKey } from '@solana/web3.js'
import type { SignAndSend } from './approval'
import type { Chain } from './chain'
import type { RelayClient, RelayRequest, RelayResult } from './relayClient'

export type Outcome = RelayResult & { reported: boolean; reportError?: string }

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
