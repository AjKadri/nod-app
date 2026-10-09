import { useRouter, type Href } from 'expo-router'
import * as Notifications from 'expo-notifications'
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
import { AppState } from 'react-native'
import { usePairings } from '@/features/pairing/pairing-provider'
import { askPermission, fetchPushToken, permissionStatus, registerToken, requestIdFrom, type PushStatus } from './push'

type PushValue = {
  status: PushStatus
  /** Ask the system for permission if that is still possible, then register with every paired relay. */
  enable: () => Promise<PushStatus>
}

const PushContext = createContext<PushValue>({ status: 'unknown', enable: async () => 'unknown' })

/** Keeps every paired relay told where to push, and exposes whether pushes can work on this phone. */
export function PushProvider({ children }: PropsWithChildren) {
  const { pairings, loaded } = usePairings()
  const [status, setStatus] = useState<PushStatus>('unknown')
  // pairing id -> the token we last gave it during this run, so we do not repeat ourselves.
  const sent = useRef(new Map<string, string>())
  // Read through a ref so a caller holding an older `refresh` still registers the newest pairings.
  const pairingsRef = useRef(pairings)
  pairingsRef.current = pairings

  const refresh = useCallback(async (ask: boolean) => {
    let next = await permissionStatus()
    if (ask && next === 'needs-permission') next = await askPermission()
    if (next === 'ready') {
      const token = await fetchPushToken()
      if (!token) {
        next = 'unavailable'
      } else {
        await Promise.all(
          pairingsRef.current
            .filter((pairing) => sent.current.get(pairing.id) !== token)
            .map(async (pairing) => {
              if ((await registerToken(pairing, token)) === 'ok') sent.current.set(pairing.id, token)
            }),
        )
      }
    }
    setStatus(next)
    return next
  }, [])

  // Also runs when a laptop is paired or unpaired, so a new pairing gets this phone's token.
  useEffect(() => {
    if (loaded) refresh(false).catch(() => setStatus('unavailable'))
  }, [loaded, pairings, refresh])

  // Coming back from system settings after allowing notifications there.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && loaded) refresh(false).catch(() => {})
    })
    return () => subscription.remove()
  }, [loaded, refresh])

  const enable = useCallback(() => refresh(true).catch(() => 'unavailable' as PushStatus), [refresh])
  const value = useMemo(() => ({ status, enable }), [status, enable])
  return <PushContext.Provider value={value}>{children}</PushContext.Provider>
}

export function usePush() {
  return useContext(PushContext)
}

/**
 * Opens the request a tapped notification is about. Lives inside the navigator.
 * `useLastNotificationResponse` also reports the tap that launched the app from closed.
 */
export function NotificationTapHandler() {
  const router = useRouter()
  const { loaded } = usePairings()
  const response = Notifications.useLastNotificationResponse()
  const handled = useRef<string | null>(null)

  useEffect(() => {
    if (!response || !loaded) return
    const key = response.notification.request.identifier
    if (handled.current === key) return
    handled.current = key
    if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return
    const id = requestIdFrom(response.notification.request.content.data)
    if (id) router.push(`/request/${id}` as Href)
  }, [response, loaded, router])

  return null
}
