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
import { reviewRequest, type Review, type SignAndSend } from './lib/approval'
import { rpcChain } from './lib/chain'
import { submitApproval, submitDenial, submitInvalid, type Outcome } from './lib/flow'
import { presentReview, type Presented } from './lib/present'
import { createRelayClient, type RelayClient, type RelayRequest, type RelayStatus } from './lib/relayClient'

export type Phase = 'reviewing' | 'ready' | 'working'

export type Item = {
  request: RelayRequest
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
}

type ApprovalsValue = {
  address?: string
  relayStatus: RelayStatus
  /** Waiting requests, newest first. */
  items: Item[]
  /** Finished requests, newest first. */
  history: HistoryEntry[]
  approve: (id: string) => Promise<void>
  reject: (id: string) => Promise<void>
  /** Take the relay back after another phone replaced this one. */
  reconnectRelay: () => void
}

const HISTORY_KEY = 'nod.history.v1'
const HISTORY_LIMIT = 50

const ApprovalsContext = createContext<ApprovalsValue>({
  relayStatus: 'offline',
  items: [],
  history: [],
  approve: async () => {},
  reject: async () => {},
  reconnectRelay: () => {},
})

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
  const relayRef = useRef<RelayClient | null>(null)
  const itemsRef = useRef<Item[]>([])
  const [relayStatus, setRelayStatus] = useState<RelayStatus>('offline')
  const [items, setItemsState] = useState<Item[]>([])
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [reconnectKey, setReconnectKey] = useState(0)

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
    if (!address) return

    const client = createRelayClient({
      baseUrl: ApprovalsConfig.relayUrl,
      token: ApprovalsConfig.relayToken,
      WebSocketImpl: WebSocket,
      fetchImpl: fetch,
      onStatus: setRelayStatus,
      onRequest: (request) => {
        setItems((previous) => [...previous, { request, phase: 'reviewing' }])
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
            remember(entryFor(gone ?? { request, phase: 'reviewing' }, outcome))
          })
      },
      // Answered elsewhere, expired, or withdrawn by the agent: take it off the screen
      // unless we are already in the middle of signing it.
      onResolved: (id) =>
        setItems((previous) => previous.filter((item) => item.request.id !== id || item.phase === 'working')),
    })
    client.setWallet(address)
    relayRef.current = client

    return () => {
      client.close()
      relayRef.current = null
      setItems(() => [])
      setRelayStatus('offline')
    }
  }, [address, chain, reconnectKey, remember, setItems])

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

  const approve = useCallback(
    async (id: string) => {
      const relay = relayRef.current
      const item = itemsRef.current.find((other) => other.request.id === id)
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
    [address, chain, connect, finish, markWorking, signAndSendTransaction, signTransaction],
  )

  const reject = useCallback(
    async (id: string) => {
      const relay = relayRef.current
      const item = itemsRef.current.find((other) => other.request.id === id)
      if (!relay || !item || item.phase === 'working') return
      markWorking(id)
      const outcome = await submitDenial({ request: item.request, relay })
      finish(item, outcome)
    },
    [finish, markWorking],
  )

  const value = useMemo<ApprovalsValue>(
    () => ({
      address,
      relayStatus,
      items: [...items].sort((a, b) => b.request.createdAt - a.request.createdAt),
      history,
      approve,
      reject,
      reconnectRelay: () => setReconnectKey((key) => key + 1),
    }),
    [address, relayStatus, items, history, approve, reject],
  )

  return <ApprovalsContext.Provider value={value}>{children}</ApprovalsContext.Provider>
}

export function useApprovals() {
  return useContext(ApprovalsContext)
}
