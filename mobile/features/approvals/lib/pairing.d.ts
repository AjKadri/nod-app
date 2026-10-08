export class PairingError extends Error {
  code: string
  constructor(code: string, message: string)
}

export type PairingLink = { relay: string; id: string; secret: string }
export type ClaimedPairing = { id: string; relay: string; label: string; key: string; token: string }

export function encodeBase64Url(bytes: Uint8Array): string
export function randomKey(cryptoImpl?: { getRandomValues<T extends ArrayBufferView>(array: T): T }): string
export function makeToken(id: string, key: string): string
export function buildPairingUrl(link: PairingLink): string
export function parsePairingUrl(text: string): PairingLink
export function claimPairing(args: {
  link: string | PairingLink
  fetchImpl: unknown
  cryptoImpl?: { getRandomValues<T extends ArrayBufferView>(array: T): T }
}): Promise<ClaimedPairing>
