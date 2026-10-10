export type NetworkId = 'devnet' | 'mainnet'

export type NetworkInfo = {
  id: NetworkId
  label: string
  /** Wallet Standard / Mobile Wallet Adapter chain id. */
  cluster: 'solana:devnet' | 'solana:mainnet'
  rpc: string
  genesisHash: string
  realMoney: boolean
}

export type NetworkSettings = { network: NetworkId; rpc: Partial<Record<NetworkId, string>> }

export const NETWORKS: Record<NetworkId, NetworkInfo>
export const DEFAULT_NETWORK: NetworkId
export function parseNetwork(value: unknown): NetworkId | null
export function networkLabel(id: string): string
export function networkMismatchMessage(requestNetwork: string | undefined, phoneNetwork: string): string
export function validateRpcUrl(text: unknown): string | null
export function parseNetworkSettings(text: string): NetworkSettings
export function rpcFor(network: NetworkId, settings?: NetworkSettings): string
