import * as SecureStore from 'expo-secure-store'
import { makeToken } from '@/features/approvals/lib/pairing'

/** One paired laptop. `key` is this phone's secret for the pairing, so it lives in the secure store only. */
export type StoredPairing = {
  id: string
  relay: string
  label: string
  key: string
  pairedAt: number
}

const INDEX_KEY = 'nod.pairing-ids'
const itemKey = (id: string) => `nod.pairing.${id}`
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK }

export const tokenOf = (pairing: StoredPairing) => makeToken(pairing.id, pairing.key)

async function readIds(): Promise<string[]> {
  try {
    const raw = await SecureStore.getItemAsync(INDEX_KEY, OPTIONS)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

export async function loadPairings(): Promise<StoredPairing[]> {
  const found: StoredPairing[] = []
  for (const id of await readIds()) {
    try {
      const raw = await SecureStore.getItemAsync(itemKey(id), OPTIONS)
      const value = raw ? (JSON.parse(raw) as Partial<StoredPairing>) : null
      if (value && value.id === id && value.relay && value.key) {
        found.push({
          id,
          relay: value.relay,
          key: value.key,
          label: value.label || 'Laptop',
          pairedAt: value.pairedAt || 0,
        })
      }
    } catch {
      // A damaged entry is skipped rather than blocking the app.
    }
  }
  return found.sort((a, b) => a.pairedAt - b.pairedAt)
}

/** Throws if the secure store refuses, so the caller can undo the pairing. */
export async function savePairing(pairing: StoredPairing): Promise<void> {
  await SecureStore.setItemAsync(itemKey(pairing.id), JSON.stringify(pairing), OPTIONS)
  const ids = await readIds()
  if (!ids.includes(pairing.id))
    await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify([...ids, pairing.id]), OPTIONS)
}

export async function deletePairing(id: string): Promise<void> {
  const ids = await readIds()
  await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify(ids.filter((other) => other !== id)), OPTIONS)
  await SecureStore.deleteItemAsync(itemKey(id), OPTIONS)
}
