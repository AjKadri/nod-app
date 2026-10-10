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
  type AutoSettings,
  type LedgerEntry,
  type StoredAuto,
} from './lib/autoapprove'

const KEY = 'nod.autoapprove.v1'
const EMPTY: StoredAuto = { settings: { enabled: false, limitLamports: 0 }, known: [], ledger: [] }

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
export function useAutoStore() {
  const ref = useRef<StoredAuto>(EMPTY)
  const loadedRef = useRef(false)
  // False when saved data could not be read: then nothing is written, so a bad read cannot erase the ledger.
  const canSaveRef = useRef(true)
  const reserved = useRef(new Map<string, number>())
  const [state, setState] = useState<StoredAuto>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const save = useCallback(() => {
    if (!loadedRef.current || !canSaveRef.current) return
    AsyncStorage.setItem(KEY, JSON.stringify(ref.current)).catch(() => {})
  }, [])

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
  }, [save])

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
    reserved.current.forEach((lamports) => (total += lamports))
    return total
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
      }),
      /** Hold back money for a payment that has started and is not finished. */
      reserve: (id: string, lamports: number) => void reserved.current.set(id, lamports),
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
    [change, reservedTotal],
  )

  const view = useMemo(
    () => ({
      loaded,
      settings: state.settings,
      known: state.known,
      spentLamports: spentToday(state.ledger, now),
      remainingLamports: remainingLamports({ limitLamports: state.settings.limitLamports, ledger: state.ledger, now }),
    }),
    [loaded, state, now],
  )

  return { api, view }
}
