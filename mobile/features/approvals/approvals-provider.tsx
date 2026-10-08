import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Haptics from 'expo-haptics'
import { useMobileWallet } from '@wallet-ui/react-native-web3js'
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
import { ApprovalsConfig } from '@/constants/approvals-config'
import { tokenOf } from '@/features/pairing/pairing-store'
import { usePairings } from '@/features/pairing/pairing-provider'
import { buildDemo } from './demo-data'
import { reviewRequest, type Review, type SignAndSend } from './lib/approval'
import { rpcChain } from './lib/chain'
import { submitApproval, submitDenial, submitInvalid, type Outcome } from './lib/flow'
import { presentReview, type Presented } from './lib/present'
import { createRelayClient, type RelayClient, type RelayRequest, type RelayStatus } from './lib/relayClient'

export type Phase = 'reviewing' | 'ready' | 'working'

export type Item = {
  request: RelayRequest
  /** Which paired laptop sent it, and what that laptop is called. */
  pairingId: string
  pairingLabel: string
  review?: Review
  presented?: Presented
  phase: Phase
}

export type HistoryEntry = {
  id: string
  agent: string
  note: string | null
  amount: string | null
  unit: string
  recipient: string | null
  status: 'approved' | 'rejected' | 'failed'
  signature?: string
  reason?: string
  /** False when the relay could not be told, so the agent may still be waiting. */
  reported: boolean
  at: number
  /** Sample data from demo mode: nothing was signed, sent or reported. */
  demo?: boolean
}

type ApprovalsValue = {
  address?: string
  /** One word for all pairings: replaced if any was taken over, else online if any is. */
  relayStatus: RelayStatus
  /** Connection status of each paired laptop, by pairing id. */
  pairingStatuses: Record<string, RelayStatus>
  /** Waiting requests, newest first. */
  items: Item[]
  /** Finished requests, newest first. */
  history: HistoryEntry[]
  approve: (id: string) => Promise<void>
  reject: (id: string) => Promise<void>
  /** Take the relay back after another phone replaced this one. */
  reconnectRelay: () => void
  /** Demo mode: sample requests that never touch the wallet or the relay. */
  demo: boolean
  setDemo: (on: boolean) => void
}

const HISTORY_KEY = 'nod.history.v1'
const HISTORY_LIMIT = 50

const ApprovalsContext = createContext<ApprovalsValue>({
  relayStatus: 'offline',
  pairingStatuses: {},
  items: [],
  history: [],
  approve: async () => {},
  reject: async () => {},
  reconnectRelay: () => {},
  demo: false,
  setDemo: () => {},
})

function overallStatus(statuses: Record<string, RelayStatus>, ids: string[]): RelayStatus {
  const list = ids.map((id) => statuses[id] ?? 'connecting')
  if (list.length === 0) return 'offline'
  if (list.includes('replaced')) return 'replaced'
  if (list.includes('online')) return 'online'
  if (list.includes('connecting')) return 'connecting'
  return 'offline'
}

function haptic(run: () => Promise<void>) {
  run().catch(() => {})
}

function payloadOf(request: RelayRequest): { agent?: string; note?: string } {
  return request.payload && typeof request.payload === 'object'
    ? (request.payload as { agent?: string; note?: string })
    : {}
}

function entryFor(item: Item, outcome: Outcome): HistoryEntry {
  const payload = payloadOf(item.request)
  const presented = item.presented
  return {
    id: item.request.id,
    agent: payload.agent || 'Unnamed agent',
    note: presented?.agentClaim ?? (payload.note || null),
    amount: presented?.amount ?? null,
    unit: presented?.unit ?? 'SOL',
    recipient: presented?.recipient.kind === 'address' ? presented.recipient.value : null,
    status: outcome.status === 'approved' ? 'approved' : outcome.status === 'denied' ? 'rejected' : 'failed',
    signature: outcome.signature,
    reason: outcome.status === 'approved' ? undefined : outcome.reason,
    reported: outcome.reported,
    at: Date.now(),
  }
}

/**
 * Owns the relay connection, the waiting requests and the history, and runs
 * the approve / reject flows. What a transaction is and whether it can be
 * signed lives in ./lib (the same code the laptop tests run).
 */
export function ApprovalsProvider({ children }: PropsWithChildren) {
  const { account, connection, connect, signAndSendTransaction, signTransaction } = useMobileWallet()
  const address = account?.address.toString()
  const chain = useMemo(() => rpcChain(connection), [connection])
  const { pairings, forget } = usePairings()
  const relaysRef = useRef<Map<string, RelayClient>>(new Map())
  const itemsRef = useRef<Item[]>([])
  const [statuses, setStatuses] = useState<Record<string, RelayStatus>>({})
  const [items, setItemsState] = useState<Item[]>([])
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [reconnectKey, setReconnectKey] = useState(0)
  // Demo mode keeps its own items and history. Nothing in it reaches the wallet or the relay.
  const [demo, setDemoState] = useState(false)
  const demoRef = useRef(false)
  const [demoItems, setDemoItems] = useState<Item[]>([])
  const [demoHistory, setDemoHistory] = useState<HistoryEntry[]>([])
  const demoItemsRef = useRef<Item[]>([])
  useEffect(() => {
    demoItemsRef.current = demoItems
  }, [demoItems])

  // Keep a ref in step with state so callbacks always see the latest items.
  const setItems = useCallback((update: (previous: Item[]) => Item[]) => {
    setItemsState((previous) => {
      const next = update(previous)
      itemsRef.current = next
      return next
    })
  }, [])

  useEffect(() => {
    AsyncStorage.getItem(HISTORY_KEY)
      .then((stored) => {
        if (stored) {
          const parsed: unknown = JSON.parse(stored)
          if (Array.isArray(parsed)) setHistory(parsed as HistoryEntry[])
        }
      })
      .catch(() => {})
      .finally(() => setHistoryLoaded(true))
  }, [])

  useEffect(() => {
    if (!historyLoaded) return
    AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(history)).catch(() => {})
  }, [history, historyLoaded])

  const remember = useCallback((entry: HistoryEntry) => {
    setHistory((previous) => [entry, ...previous.filter((other) => other.id !== entry.id)].slice(0, HISTORY_LIMIT))
  }, [])

  useEffect(() => {
    if (!address || pairings.length === 0) return

    const clients = new Map<string, RelayClient>()
    for (const pairing of pairings) {
      const client = createRelayClient({
        baseUrl: pairing.relay,
        token: tokenOf(pairing),
        WebSocketImpl: WebSocket,
        fetchImpl: fetch,
        onStatus: (status) => {
          setStatuses((previous) => ({ ...previous, [pairing.id]: status }))
          // The laptop revoked the pairing: forget it here too.
          if (status === 'revoked') forget(pairing.id, `${pairing.label} ended the pairing.`)
        },
        onRequest: (request) => {
          setItems((previous) => [
            ...previous,
            { request, phase: 'reviewing', pairingId: pairing.id, pairingLabel: pairing.label },
          ])
          haptic(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light))
          reviewRequest({ payload: request.payload, walletAddress: address, chain })
            .then((review) => {
              const presented = presentReview(review)
              setItems((previous) =>
                previous.map((item) =>
                  item.request.id === request.id ? { ...item, review, presented, phase: 'ready' } : item,
                ),
              )
            })
            .catch(async (error: unknown) => {
              // Could not even be shown (bad address, wrong fee payer, undecodable). Tell the agent.
              const outcome = await submitInvalid({ request, relay: client, error })
              const gone = itemsRef.current.find((item) => item.request.id === request.id)
              setItems((previous) => previous.filter((item) => item.request.id !== request.id))
              remember(
                entryFor(
                  gone ?? { request, phase: 'reviewing', pairingId: pairing.id, pairingLabel: pairing.label },
                  outcome,
                ),
              )
            })
        },
        // Answered elsewhere, expired, or withdrawn by the agent: take it off the screen
        // unless we are already in the middle of signing it.
        onResolved: (id) =>
          setItems((previous) => previous.filter((item) => item.request.id !== id || item.phase === 'working')),
      })
      client.setWallet(address)
      clients.set(pairing.id, client)
    }
    relaysRef.current = clients

    return () => {
      clients.forEach((client) => client.close())
      relaysRef.current = new Map()
      setItems(() => [])
      setStatuses({})
    }
  }, [address, chain, forget, pairings, reconnectKey, remember, setItems])

  const finish = useCallback(
    (item: Item, outcome: Outcome) => {
      setItems((previous) => previous.filter((other) => other.request.id !== item.request.id))
      remember(entryFor(item, outcome))
      haptic(() =>
        outcome.status === 'approved'
          ? Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
          : outcome.status === 'denied'
            ? Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
            : Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
      )
    },
    [remember, setItems],
  )

  const markWorking = useCallback(
    (id: string) =>
      setItems((previous) => previous.map((item) => (item.request.id === id ? { ...item, phase: 'working' } : item))),
    [setItems],
  )

  const setDemo = useCallback((on: boolean) => {
    demoRef.current = on
    setDemoState(on)
    const seed = on ? buildDemo(Date.now()) : { items: [], history: [] }
    setDemoItems(seed.items)
    setDemoHistory(seed.history)
  }, [])

  const finishDemo = useCallback((item: Item, outcome: Outcome) => {
    setDemoItems((previous) => previous.filter((other) => other.request.id !== item.request.id))
    setDemoHistory((previous) => [{ ...entryFor(item, outcome), demo: true }, ...previous])
    haptic(() =>
      outcome.status === 'approved'
        ? Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
        : Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium),
    )
  }, [])

  // Pretend to open the wallet for a moment, then finish. No wallet call, no relay call.
  const approveDemo = useCallback(
    (id: string) => {
      const item = demoItemsRef.current.find((other) => other.request.id === id)
      if (!item || item.phase !== 'ready') return
      setDemoItems((previous) => previous.map((o) => (o.request.id === id ? { ...o, phase: 'working' } : o)))
      setTimeout(() => {
        const still = demoItemsRef.current.find((other) => other.request.id === id)
        if (!demoRef.current || still?.phase !== 'working') return
        finishDemo(item, { status: 'approved', reported: true })
      }, 1200)
    },
    [finishDemo],
  )

  const rejectDemo = useCallback(
    (id: string) => {
      const item = demoItemsRef.current.find((other) => other.request.id === id)
      if (!item || item.phase === 'working') return
      finishDemo(item, { status: 'denied', reason: 'Rejected in demo mode', reported: true })
    },
    [finishDemo],
  )

  const approve = useCallback(
    async (id: string) => {
      if (demoRef.current) return approveDemo(id)
      const item = itemsRef.current.find((other) => other.request.id === id)
      const relay = item ? relaysRef.current.get(item.pairingId) : undefined
      if (!relay || !address || !item || item.phase !== 'ready') return
      markWorking(id)

      // Nod broadcasts by default (the wallet only signs): some wallets fail to send on devnet.
      const sendOnce: SignAndSend = async (transaction, minContextSlot) => {
        if (!ApprovalsConfig.walletSends) {
          const signed = await signTransaction(transaction)
          return chain.sendRaw(signed.serialize())
        }
        return signAndSendTransaction(transaction, minContextSlot)
      }
      // A wallet login that has gone stale fails with "authorization request failed".
      // Log in to the wallet again once, then retry.
      const signAndSend: SignAndSend = async (transaction, minContextSlot) => {
        try {
          return await sendOnce(transaction, minContextSlot)
        } catch (error) {
          if (!/authoriz/i.test(String((error as Error)?.message ?? error))) throw error
          await connect()
          return sendOnce(transaction, minContextSlot)
        }
      }

      const outcome = await submitApproval({ request: item.request, walletAddress: address, chain, signAndSend, relay })
      finish(item, outcome)
    },
    [address, approveDemo, chain, connect, finish, markWorking, signAndSendTransaction, signTransaction],
  )

  const reject = useCallback(
    async (id: string) => {
      if (demoRef.current) return rejectDemo(id)
      const item = itemsRef.current.find((other) => other.request.id === id)
      const relay = item ? relaysRef.current.get(item.pairingId) : undefined
      if (!relay || !item || item.phase === 'working') return
      markWorking(id)
      const outcome = await submitDenial({ request: item.request, relay })
      finish(item, outcome)
    },
    [finish, markWorking, rejectDemo],
  )

  const value = useMemo<ApprovalsValue>(
    () => ({
      address,
      relayStatus: overallStatus(
        statuses,
        pairings.map((pairing) => pairing.id),
      ),
      pairingStatuses: statuses,
      items: [...(demo ? demoItems : items)].sort((a, b) => b.request.createdAt - a.request.createdAt),
      history: demo ? demoHistory : history,
      approve,
      reject,
      reconnectRelay: () => setReconnectKey((key) => key + 1),
      demo,
      setDemo,
    }),
    [address, statuses, pairings, items, history, approve, reject, demo, demoItems, demoHistory, setDemo],
  )

  return <ApprovalsContext.Provider value={value}>{children}</ApprovalsContext.Provider>
}

export function useApprovals() {
  return useContext(ApprovalsContext)
}
