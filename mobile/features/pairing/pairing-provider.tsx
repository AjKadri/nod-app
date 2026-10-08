import 'react-native-get-random-values'
import React, {
  createContext,
  PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { claimPairing } from '@/features/approvals/lib/pairing'
import { deletePairing, loadPairings, savePairing, tokenOf, type StoredPairing } from './pairing-store'

type PairingsValue = {
  pairings: StoredPairing[]
  /** False until the secure store has been read, so the app does not flash the wrong screen. */
  loaded: boolean
  /** Why a pairing disappeared on its own, e.g. the laptop revoked it. */
  notice: string | null
  dismissNotice: () => void
  /** Claim the pairing a laptop is showing. Throws a PairingError with a message fit for the screen. */
  pair: (link: string) => Promise<StoredPairing>
  /** Revoke at the relay, then forget it here. `relayNotified` is false if the relay could not be reached. */
  revoke: (id: string) => Promise<{ relayNotified: boolean }>
  /** The pairing no longer exists at the relay: forget it here. */
  forget: (id: string, reason?: string) => void
}

const PairingsContext = createContext<PairingsValue>({
  pairings: [],
  loaded: false,
  notice: null,
  dismissNotice: () => {},
  pair: async () => {
    throw new Error('Pairing is not available')
  },
  revoke: async () => ({ relayNotified: false }),
  forget: () => {},
})

async function fetchWithTimeout(url: string, init: RequestInit, ms = 8000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export function PairingProvider({ children }: PropsWithChildren) {
  const [pairings, setPairings] = useState<StoredPairing[]>([])
  const [loaded, setLoaded] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const pairingsRef = useRef<StoredPairing[]>([])

  const update = useCallback((next: (previous: StoredPairing[]) => StoredPairing[]) => {
    setPairings((previous) => {
      const value = next(previous)
      pairingsRef.current = value
      return value
    })
  }, [])

  useEffect(() => {
    loadPairings()
      .then((found) => update(() => found))
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [update])

  const pair = useCallback(
    async (link: string) => {
      const claimed = await claimPairing({ link, fetchImpl: fetch })
      const stored: StoredPairing = {
        id: claimed.id,
        relay: claimed.relay,
        label: claimed.label,
        key: claimed.key,
        pairedAt: Date.now(),
      }
      try {
        await savePairing(stored)
      } catch {
        // Claimed at the relay but not kept here: undo it so nothing is left half-paired.
        await fetchWithTimeout(`${stored.relay}/pairing`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${tokenOf(stored)}` },
        }).catch(() => {})
        throw new Error('Could not save the pairing securely on this phone. Try again.')
      }
      update((previous) => [...previous.filter((other) => other.id !== stored.id), stored])
      return stored
    },
    [update],
  )

  const forget = useCallback(
    (id: string, reason?: string) => {
      update((previous) => previous.filter((other) => other.id !== id))
      deletePairing(id).catch(() => {})
      if (reason) setNotice(reason)
    },
    [update],
  )

  const revoke = useCallback(
    async (id: string) => {
      const pairing = pairingsRef.current.find((other) => other.id === id)
      if (!pairing) return { relayNotified: true }
      let relayNotified = false
      try {
        const response = await fetchWithTimeout(`${pairing.relay}/pairing`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${tokenOf(pairing)}` },
        })
        // 401 means the relay had already dropped it, which is the outcome we wanted.
        relayNotified = response.ok || response.status === 401
      } catch {
        relayNotified = false
      }
      update((previous) => previous.filter((other) => other.id !== id))
      await deletePairing(id).catch(() => {})
      return { relayNotified }
    },
    [update],
  )

  const value = useMemo<PairingsValue>(
    () => ({ pairings, loaded, notice, dismissNotice: () => setNotice(null), pair, revoke, forget }),
    [pairings, loaded, notice, pair, revoke, forget],
  )

  return <PairingsContext.Provider value={value}>{children}</PairingsContext.Provider>
}

export function usePairings() {
  return useContext(PairingsContext)
}
