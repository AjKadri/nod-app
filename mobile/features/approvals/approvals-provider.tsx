import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Haptics from 'expo-haptics'
import { AppState } from 'react-native'
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
import { useNetwork } from '@/features/network/use-network'
import { tokenOf } from '@/features/pairing/pairing-store'
import { usePairings } from '@/features/pairing/pairing-provider'
import { useAutoStore } from './auto-store'
import { buildDemo } from './demo-data'
import { cleanAgentName, describeAgent, type AgentIcon } from './lib/agent'
import { reviewRequest, type Review, type SignAndSend } from './lib/approval'
import type { NetworkId } from './lib/network'
import {
  addressToLearn,
  decideAutoApprove,
  isEnabled,
  isPausedForAuto,
  ledgerEntryFor,
  normalizeTokenLimit,
  outflowLamports,
  tokenLimitRaw,
  tokenOutflows,
} from './lib/autoapprove'
import * as tokenLib from './lib/tokens'
import { rpcChain } from './lib/chain'
import {
  explainError,
  NeedsCardError,
  submitApproval,
  submitAutoApproval,
  submitDenial,
  submitInvalid,
  type Outcome,
} from './lib/flow'
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
  /** Being approved without the card: the wallet is signing within the daily limit. */
  autoRunning?: boolean
  /** Why this one asks, when auto-approve is on but did not apply (shown on the card). */
  autoNote?: string
}

export type HistoryEntry = {
  id: string
  agent: string
  /** Absent in history saved before icons existed. */
  agentIcon?: AgentIcon
  note: string | null
  amount: string | null
  unit: string
  /** The logo of a token Nod recognises by its mint. */
  logo?: string
  recipient: string | null
  status: 'approved' | 'rejected' | 'failed'
  signature?: string
  reason?: string
  /** Approved without the card, within the daily limit. */
  auto?: boolean
  /** The network it was for. Absent in history saved before Mainnet existed: that was Devnet. */
  network?: NetworkId
  /** False when the relay could not be told, so the agent may still be waiting. */
  reported: boolean
  at: number
  /** Sample data from demo mode: nothing was signed, sent or reported. */
  demo?: boolean
}

/** Whether new requests are blocked: off, on for every paired laptop, or on for only some of them. */
export type PauseState = 'off' | 'on' | 'partial'

/** The daily limit of one token. Amounts are text in whole tokens, e.g. "100". */
export type AutoTokenView = {
  mint: string
  /** "SKR", or "SKR (test)" on Devnet. */
  label: string
  logo: string | null
  /** The limit, or null when none is set. */
  limit: string | null
  spent: string
  remaining: string | null
  /** Set the limit ("" clears it). Returns false when the text is not an amount. */
  setLimit: (text: string) => boolean
}

/** Auto-approve as the screens see it. SOL amounts are lamports. */
export type AutoView = {
  loaded: boolean
  enabled: boolean
  limitLamports: number
  spentLamports: number
  remainingLamports: number
  /** Addresses approved by hand before, newest first. */
  knownAddresses: string[]
  /** SKR on this network (the official mint, or the test mint on Devnet), or null when there is none. */
  skr: AutoTokenView | null
  setEnabled: (on: boolean) => void
  setLimit: (lamports: number) => void
  forgetAddress: (address: string) => void
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
  /** "Pause everything", as each paired relay last confirmed it. */
  pauseState: PauseState
  pauseBusy: boolean
  /** Set when the last attempt did not reach every laptop; cleared by the next success. `target` is what was asked for. */
  pauseProblem: { message: string; target: boolean } | null
  /** Pause or resume every paired laptop. The state shown is only what the relays confirm. */
  setPaused: (on: boolean) => Promise<void>
  auto: AutoView
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
  pauseState: 'off',
  pauseBusy: false,
  pauseProblem: null,
  setPaused: async () => {},
  auto: {
    loaded: false,
    enabled: false,
    limitLamports: 0,
    spentLamports: 0,
    remainingLamports: 0,
    knownAddresses: [],
    skr: null,
    setEnabled: () => {},
    setLimit: () => {},
    forgetAddress: () => {},
  },
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

function payloadOf(request: RelayRequest): { note?: string } {
  return request.payload && typeof request.payload === 'object' ? (request.payload as { note?: string }) : {}
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function entryFor(item: Item, outcome: Outcome): HistoryEntry {
  const payload = payloadOf(item.request)
  const presented = item.presented
  const agent = describeAgent(item.request.payload)
  return {
    id: item.request.id,
    agent: agent.name,
    agentIcon: agent.icon,
    note: presented?.agentClaim ?? (payload.note || null),
    amount: presented?.amount ?? null,
    unit: presented?.unit ?? 'SOL',
    ...(presented?.token?.known && presented.token.logo ? { logo: presented.token.logo } : {}),
    recipient: presented?.recipient.kind === 'address' ? presented.recipient.value : null,
    status: outcome.status === 'approved' ? 'approved' : outcome.status === 'denied' ? 'rejected' : 'failed',
    signature: outcome.signature,
    reason: outcome.status === 'approved' ? undefined : outcome.reason,
    ...(outcome.auto ? { auto: true } : {}),
    ...(item.review ? { network: item.review.network } : {}),
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
  const { network } = useNetwork()
  const chain = useMemo(() => rpcChain(connection, network), [connection, network])
  const registry = useMemo(
    () => tokenLib.tokenRegistry(network, { testSkrMint: ApprovalsConfig.testSkrMint }),
    [network],
  )
  const { pairings, forget } = usePairings()
  const relaysRef = useRef<Map<string, RelayClient>>(new Map())
  const itemsRef = useRef<Item[]>([])
  const [statuses, setStatuses] = useState<Record<string, RelayStatus>>({})
  const [items, setItemsState] = useState<Item[]>([])
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [reconnectKey, setReconnectKey] = useState(0)
  // What each relay last said about "Pause everything", by pairing id.
  const [pausedBy, setPausedBy] = useState<Record<string, boolean>>({})
  const [pauseBusy, setPauseBusy] = useState(false)
  // Auto-approve reads these at the moment it decides, so they are kept in refs as well as state.
  const autoStore = useAutoStore(network)
  const autoApi = autoStore.api
  const pausedByRef = useRef<Record<string, boolean>>({})
  const pauseBusyRef = useRef(false)
  const pauseTargetRef = useRef<boolean | null>(null)
  const resolvedRef = useRef(new Set<string>())
  const autoClaimedRef = useRef(new Set<string>())
  const historyRef = useRef<HistoryEntry[]>([])
  const onReviewedRef = useRef<
    (request: RelayRequest, pairingId: string, review: Review, presented: Presented) => void
  >(() => {})
  const [pauseProblem, setPauseProblem] = useState<{ message: string; target: boolean } | null>(null)
  const [demoPaused, setDemoPaused] = useState(false)
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
          // Names saved by older versions were not cleaned; clean them as they are read back.
          if (Array.isArray(parsed)) {
            setHistory((parsed as HistoryEntry[]).map((entry) => ({ ...entry, agent: cleanAgentName(entry.agent) })))
          }
        }
      })
      .catch(() => {})
      .finally(() => setHistoryLoaded(true))
  }, [])

  useEffect(() => {
    historyRef.current = history
  }, [history])

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
        onPaused: (paused) => {
          pausedByRef.current = { ...pausedByRef.current, [pairing.id]: paused }
          setPausedBy((previous) => ({ ...previous, [pairing.id]: paused }))
        },
        onRequest: (request) => {
          setItems((previous) => [
            ...previous,
            { request, phase: 'reviewing', pairingId: pairing.id, pairingLabel: pairing.label },
          ])
          haptic(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light))
          reviewRequest({ payload: request.payload, walletAddress: address, chain, registry })
            .then((review) => {
              // Shows the card, or approves without it when every auto-approve rule holds.
              onReviewedRef.current(request, pairing.id, review, presentReview(review))
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
        onResolved: (id) => {
          resolvedRef.current.add(id)
          setItems((previous) => previous.filter((item) => item.request.id !== id || item.phase === 'working'))
        },
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
      setPausedBy({})
      pausedByRef.current = {}
    }
  }, [address, chain, forget, pairings, reconnectKey, registry, remember, setItems])

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

  // What left the wallet counts against today's limit, and a plain payment the person approved by
  // hand teaches Nod that address. `maybeSent` is true when the wallet signed but the network call broke.
  const settle = useCallback(
    (item: Item, outcome: Outcome, maybeSent: boolean) => {
      const entry = ledgerEntryFor({ id: item.request.id, review: item.review, outcome, now: Date.now(), maybeSent })
      if (entry) autoApi.record(entry)
      if (!outcome.auto && address) {
        const learned = addressToLearn({ review: item.review, outcome, walletAddress: address })
        if (learned) autoApi.learn(learned)
      }
      autoApi.release(item.request.id)
    },
    [address, autoApi],
  )

  // Approve without the card. The wallet still signs. Any wallet problem before it signs gives the card back.
  const runAuto = useCallback(
    async (item: Item, relay: RelayClient) => {
      if (!address) return
      let signed = false
      const signAndSend: SignAndSend = async (transaction) => {
        let result
        try {
          result = await signTransaction(transaction)
        } catch (error) {
          // A login that has expired, a prompt that was declined: nothing was sent. Do not log in again here.
          throw new NeedsCardError(explainError(error))
        }
        signed = true
        return chain.sendRaw(result.serialize())
      }
      let outcome
      try {
        outcome = await submitAutoApproval({ request: item.request, walletAddress: address, chain, signAndSend, relay })
      } catch (error) {
        outcome = signed
          ? ({ status: 'failed', reason: explainError(error), reported: false, auto: true } as const)
          : ({ status: 'needs_card', reason: explainError(error), reported: false } as const)
      }
      if (outcome.status === 'needs_card') {
        autoApi.release(item.request.id)
        setItems((previous) =>
          previous.map((other) =>
            other.request.id === item.request.id
              ? {
                  ...other,
                  phase: 'ready',
                  autoRunning: false,
                  autoNote: `Auto-approve could not finish (${outcome.reason}), so it asks you.`,
                }
              : other,
          ),
        )
        haptic(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning))
        return
      }
      settle(item, outcome, signed)
      finish(item, outcome)
    },
    [address, autoApi, chain, finish, setItems, settle, signTransaction],
  )

  const onReviewed = useCallback(
    (request: RelayRequest, pairingId: string, review: Review, presented: Presented) => {
      const toCard = (autoNote?: string) =>
        setItems((previous) =>
          previous.map((item) =>
            item.request.id === request.id
              ? { ...item, review, presented, phase: 'ready', autoRunning: false, autoNote }
              : item,
          ),
        )
      const relay = relaysRef.current.get(pairingId)
      const snapshot = autoApi.snapshot()
      const seenBefore =
        autoClaimedRef.current.has(request.id) ||
        snapshot.ledger.some((entry) => entry.id === request.id) ||
        historyRef.current.some((entry) => entry.id === request.id)
      const gone = resolvedRef.current.has(request.id) || Date.now() >= request.expiresAt
      if (
        !relay ||
        !address ||
        !snapshot.loaded ||
        seenBefore ||
        gone ||
        demoRef.current ||
        ApprovalsConfig.walletSends
      ) {
        toCard()
        return
      }
      // Paused, or a Pause that is on its way: nothing is approved automatically.
      const anyPaused = Object.values(pausedByRef.current).some(Boolean)
      const paused =
        isPausedForAuto({
          pauseState: anyPaused ? 'on' : 'off',
          unconfirmedPause: pauseBusyRef.current || pauseTargetRef.current === true,
        }) || pausedByRef.current[pairingId] !== false
      const decision = decideAutoApprove({
        review,
        settings: snapshot.settings,
        walletAddress: address,
        knownAddresses: snapshot.known,
        ledger: snapshot.ledger,
        reservedLamports: snapshot.reservedLamports,
        reservedTokens: snapshot.reservedTokens,
        now: Date.now(),
        paused,
        appActive: AppState.currentState === 'active',
      })
      if (!decision.auto) {
        // Said only when it is news: warnings are already on the card, and "off" needs no explaining.
        const quiet = decision.code === 'off' || decision.code === 'warnings' || decision.code === 'preview_failed'
        toCard(quiet ? undefined : decision.reason)
        return
      }
      autoClaimedRef.current.add(request.id)
      autoApi.reserve(request.id, decision.outflowLamports, decision.token ? [decision.token] : [])
      const pairing = pairings.find((other) => other.id === pairingId)
      const item: Item = {
        request,
        pairingId,
        pairingLabel: pairing?.label ?? '',
        review,
        presented,
        phase: 'working',
        autoRunning: true,
      }
      setItems((previous) => previous.map((other) => (other.request.id === request.id ? item : other)))
      haptic(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light))
      void runAuto(item, relay)
    },
    [address, autoApi, pairings, runAuto, setItems],
  )

  useEffect(() => {
    onReviewedRef.current = onReviewed
  }, [onReviewed])

  const setPaused = useCallback(
    async (on: boolean) => {
      if (demoRef.current) {
        setDemoPaused(on) // pretend: there are no agents in demo mode
        return
      }
      setPauseBusy(true)
      pauseBusyRef.current = true
      pauseTargetRef.current = on
      const failed: string[] = []
      await Promise.all(
        pairings.map(async (pairing) => {
          const client = relaysRef.current.get(pairing.id)
          try {
            if (!client) throw new Error('not connected')
            await withTimeout(client.setPaused(on), 8000)
          } catch {
            failed.push(pairing.label)
          }
        }),
      )
      setPauseBusy(false)
      pauseBusyRef.current = false
      // A Pause the person asked for that did not reach every laptop still counts as "paused" here.
      pauseTargetRef.current = failed.length === 0 ? null : on
      setPauseProblem(
        failed.length === 0
          ? null
          : {
              target: on,
              message: `Could not reach ${failed.join(', ')}. ${on ? 'It can still send requests' : 'It is still paused'} until this works. Check the connection and try again.`,
            },
      )
      haptic(() =>
        failed.length === 0
          ? Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
          : Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
      )
    },
    [pairings],
  )

  const pauseState = useMemo<PauseState>(() => {
    if (demo) return demoPaused ? 'on' : 'off'
    const flags = pairings.map((pairing) => pausedBy[pairing.id] === true)
    if (flags.length === 0 || flags.every((flag) => !flag)) return 'off'
    return flags.every(Boolean) ? 'on' : 'partial'
  }, [demo, demoPaused, pairings, pausedBy])

  const setDemo = useCallback((on: boolean) => {
    demoRef.current = on
    setDemoState(on)
    setDemoPaused(false)
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
      // Hold this payment's money back from auto-approve until it is done.
      autoApi.reserve(
        id,
        item.review ? outflowLamports(item.review) : 0,
        item.review ? tokenOutflows(item.review).map(({ mint, raw }) => ({ mint, raw })) : [],
      )
      let maybeSent = false

      // Nod broadcasts by default (the wallet only signs): some wallets fail to send on devnet.
      const sendOnce: SignAndSend = async (transaction, minContextSlot) => {
        if (!ApprovalsConfig.walletSends) {
          const signed = await signTransaction(transaction)
          maybeSent = true
          return chain.sendRaw(signed.serialize())
        }
        try {
          return await signAndSendTransaction(transaction, minContextSlot)
        } catch (error) {
          // The wallet may have sent it before failing; only a login problem is known to be safe.
          if (!/authoriz/i.test(String((error as Error)?.message ?? error))) maybeSent = true
          throw error
        }
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

      let outcome: Outcome
      try {
        outcome = await submitApproval({ request: item.request, walletAddress: address, chain, signAndSend, relay })
      } finally {
        autoApi.release(id)
      }
      settle(item, outcome, maybeSent)
      finish(item, outcome)
    },
    [
      address,
      approveDemo,
      autoApi,
      chain,
      connect,
      finish,
      markWorking,
      settle,
      signAndSendTransaction,
      signTransaction,
    ],
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

  const autoView = autoStore.view
  const skrView = useMemo<AutoTokenView | null>(() => {
    const mint = tokenLib.officialMintFor(registry, 'SKR')
    if (!mint) return null
    const limit = autoView.settings.tokenLimits[mint] ?? null
    const usage = autoView.tokenUsage(mint)
    const spent = usage.decimals === null ? '0' : tokenLib.formatTokenAmount(usage.spentRaw, usage.decimals)
    let remaining: string | null = null
    if (limit !== null) {
      if (usage.decimals === null) remaining = limit
      else {
        const raw = tokenLimitRaw(autoView.settings, mint, usage.decimals)
        const left = raw === null ? 0n : raw > usage.spentRaw ? raw - usage.spentRaw : 0n
        remaining = tokenLib.formatTokenAmount(left, usage.decimals)
      }
    }
    return {
      mint,
      label: tokenLib.tokenLabel(registry, mint),
      logo: registry.tokens[mint]?.logo ?? null,
      limit,
      spent,
      remaining,
      setLimit: (text) => {
        const current = autoApi.snapshot().settings
        const tokenLimits = { ...current.tokenLimits }
        if (text.trim() === '') delete tokenLimits[mint]
        else {
          const normal = normalizeTokenLimit(text)
          if (!normal) return false
          tokenLimits[mint] = normal
        }
        const next = { ...current, tokenLimits }
        // The switch cannot stay on with no limit left to apply it to.
        autoApi.setSettings(isEnabled({ ...next, enabled: true }) ? next : { ...next, enabled: false })
        return true
      },
    }
  }, [autoApi, autoView, registry])
  const auto = useMemo<AutoView>(
    () => ({
      loaded: autoView.loaded,
      enabled: isEnabled(autoView.settings),
      limitLamports: autoView.settings.limitLamports,
      spentLamports: autoView.spentLamports,
      remainingLamports: autoView.remainingLamports,
      knownAddresses: autoView.known,
      skr: skrView,
      setEnabled: (on) => {
        const current = autoApi.snapshot().settings
        if (on && !isEnabled({ ...current, enabled: true })) return
        autoApi.setSettings({ ...current, enabled: on })
      },
      setLimit: (lamports) => autoApi.setSettings({ ...autoApi.snapshot().settings, limitLamports: lamports }),
      forgetAddress: (address) => autoApi.forget(address),
    }),
    [autoApi, autoView, skrView],
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
      pauseState,
      pauseBusy,
      pauseProblem,
      setPaused,
      auto,
    }),
    [
      address,
      statuses,
      pairings,
      items,
      history,
      approve,
      reject,
      demo,
      demoItems,
      demoHistory,
      setDemo,
      pauseState,
      pauseBusy,
      pauseProblem,
      setPaused,
      auto,
    ],
  )

  return <ApprovalsContext.Provider value={value}>{children}</ApprovalsContext.Provider>
}

export function useApprovals() {
  return useContext(ApprovalsContext)
}
