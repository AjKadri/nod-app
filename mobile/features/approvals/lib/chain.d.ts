import type { Connection, PublicKey, VersionedMessage, VersionedTransaction } from '@solana/web3.js'

import type { NetworkId } from './network'
import type { RawAccount } from './tokens'

export type Chain = {
  /** The network this chain is meant to be. */
  network: NetworkId
  /** Throws unless the RPC server really is that network (checked by genesis hash). */
  verifyNetwork(): Promise<unknown>
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number; slot: number }>
  getBalance(publicKey: PublicKey): Promise<number>
  simulate(
    transaction: VersionedTransaction,
    publicKey: PublicKey,
    watch?: PublicKey[],
  ): Promise<{ err: unknown; postLamports: number | null; logs: string[]; accounts: RawAccount[] }>
  /** The accounts at these addresses right now (null where there is none). */
  getAccounts(addresses: PublicKey[]): Promise<RawAccount[]>
  getFee(message: VersionedMessage): Promise<number | null>
  sendRaw(serializedTransaction: Uint8Array): Promise<string>
  confirm(
    signature: string,
    options?: { timeoutMs?: number; intervalMs?: number },
  ): Promise<{ confirmed: boolean; err: unknown }>
}

export function rpcChain(connection: Connection, network: NetworkId): Chain
