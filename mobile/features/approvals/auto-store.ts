import AsyncStorage from '@react-native-async-storage/async-storage'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState } from 'react-native'
import {
  addKnownAddress,
  parseStored,
  pruneLedger,
  remainingLamports,
  removeKnownAddress,
  spentToday,
  spentTodayToken,
  type AutoSettings,
  type LedgerEntry,
  type StoredAuto,
  type TokenAmountRaw,
} from './lib/autoapprove'

import type { NetworkId } from './lib/network'

// Devnet keeps the key it has always had. Mainnet is stored apart: its limit, its trusted addresses and
// its record of spending are separate, so nothing learned on Devnet can approve real money.
const keyFor = (network: NetworkId) => (network === 'devnet' ? 'nod.autoapprove.v1' : `nod.autoapprove.v1.${network}`)
const EMPTY: StoredAuto = { settings: { enabled: false, limitLamports: 0, tokenLimits: {} }, known: [], ledger: [] }

/** Next local midnight, in ms. */
function nextMidnight(now: number) {
  const date = new Date(now)
  date.setHours(24, 0, 0, 0)
  return date.getTime()
}

/**
 * The saved auto-approve state: settings, the addresses approved by hand, and what has left the
 * wallet recently. Lives only on this phone. Reads and writes go through a ref, so two requests
 * arriving together see each other's reservations at once (no waiting for a re-render).
 */
export function useAutoStore(network: NetworkId) {
  const KEY = keyFor(network)
  const ref = useRef<StoredAuto>(EMPTY)
  const loadedRef = useRef(false)
  // False when saved data could not be read: then nothing is written, so a bad read cannot erase the ledger.
  const canSaveRef = useRef(true)
  const reserved = useRef(new Map<string, { lamports: number; tokens: TokenAmountRaw[] }>())
  const [state, setState] = useState<StoredAuto>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const save = useCallback(() => {
    if (!loadedRef.current || !canSaveRef.current) return
    AsyncStorage.setItem(KEY, JSON.stringify(ref.current)).catch(() => {})
  }, [KEY])

  const change = useCallback(
    (update: (previous: StoredAuto) => StoredAuto) => {
      ref.current = update(ref.current)
      setState(ref.current)
      save()
    },
    [save],
  )

  useEffect(() => {
    AsyncStorage.getItem(KEY)
      .then((text) => {
        const stored = parseStored(text ?? '')
        const early = ref.current
        // Anything recorded before the read finished is kept.
        const ids = new Set(early.ledger.map((entry) => entry.id))
        ref.current = {
          settings: stored.settings,
          known: early.known.reduce((known, address) => addKnownAddress(known, address), stored.known),
          ledger: [...stored.ledger.filter((entry) => !ids.has(entry.id)), ...early.ledger],
        }
      })
      .catch(() => {
        canSaveRef.current = false
      })
      .finally(() => {
        loadedRef.current = true
        setState(ref.current)
        setLoaded(true)
        save()
      })
  }, [KEY, save])

  // The day rolls over at local midnight, and the clock may have moved while Nod was closed.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const arm = () => {
      clearTimeout(timer)
      const current = Date.now()
      timer = setTimeout(
        () => {
          setNow(Date.now())
          arm()
        },
        Math.max(1000, nextMidnight(current) - current + 500),
      )
    }
    arm()
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        setNow(Date.now())
        arm()
      }
    })
    return () => {
      clearTimeout(timer)
      sub.remove()
    }
  }, [])

  // Old days can no longer count: forget them.
  useEffect(() => {
    if (!loaded) return
    const pruned = pruneLedger(ref.current.ledger, Date.now())
    if (pruned.length !== ref.current.ledger.length) change((previous) => ({ ...previous, ledger: pruned }))
  }, [loaded, now, change])

  const reservedTotal = useCallback(() => {
    let total = 0
    reserved.current.forEach((held) => (total += held.lamports))
    return total
  }, [])

  const reservedTokens = useCallback(() => {
    const all: TokenAmountRaw[] = []
    reserved.current.forEach((held) => all.push(...held.tokens))
    return all
  }, [])

  const api = useMemo(
    () => ({
      /** Everything a decision needs, read at this instant. */
      snapshot: () => ({
        loaded: loadedRef.current,
        settings: ref.current.settings,
        known: ref.current.known,
        ledger: ref.current.ledger,
        reservedLamports: reservedTotal(),
        reservedTokens: reservedTokens(),
      }),
      /** Hold back money for a payment that has started and is not finished. */
      reserve: (id: string, lamports: number, tokens: TokenAmountRaw[] = []) =>
        void reserved.current.set(id, { lamports, tokens }),
      release: (id: string) => void reserved.current.delete(id),
      record: (entry: LedgerEntry) =>
        change((previous) => ({
          ...previous,
          ledger: [...previous.ledger.filter((other) => other.id !== entry.id), entry],
        })),
      learn: (address: string) =>
        change((previous) => ({ ...previous, known: addKnownAddress(previous.known, address) })),
      forget: (address: string) =>
        change((previous) => ({ ...previous, known: removeKnownAddress(previous.known, address) })),
      setSettings: (settings: AutoSettings) => change((previous) => ({ ...previous, settings })),
    }),
    [change, reservedTokens, reservedTotal],
  )

  const view = useMemo(
    () => ({
      loaded,
      settings: state.settings,
      known: state.known,
      spentLamports: spentToday(state.ledger, now),
      remainingLamports: remainingLamports({ limitLamports: state.settings.limitLamports, ledger: state.ledger, now }),
      /** Whole units of a token that left today, and the decimals last recorded for it (null until one has). */
      tokenUsage: (mint: string) => {
        let decimals: number | null = null
        for (const entry of state.ledger) {
          for (const item of entry.tokens ?? [])
            if (item.mint === mint && typeof item.decimals === 'number') decimals = item.decimals
        }
        return { spentRaw: spentTodayToken(state.ledger, mint, now), decimals }
      },
    }),
    [loaded, state, now],
  )

  return { api, view }
}
