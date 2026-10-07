export type RelayStatus = 'connecting' | 'online' | 'offline' | 'replaced'

export type RelayRequest = {
  id: string
  status: string
  createdAt: number
  expiresAt: number
  payload: unknown
}

export type RelayResult = {
  status: 'approved' | 'denied' | 'failed'
  signature?: string
  reason?: string
  refreshed?: boolean
}

export type RelayClient = {
  setWallet(address: string): void
  sendResult(id: string, result: RelayResult): Promise<unknown>
  fetchPending(): Promise<RelayRequest[]>
  close(): void
}

export function createRelayClient(options: {
  baseUrl: string
  token?: string
  WebSocketImpl: unknown
  fetchImpl: unknown
  onRequest?: (request: RelayRequest) => void
  onResolved?: (id: string, status: string) => void
  onStatus?: (status: RelayStatus) => void
  reconnectMs?: number
}): RelayClient
