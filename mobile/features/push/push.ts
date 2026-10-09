import Constants from 'expo-constants'
import * as Notifications from 'expo-notifications'
import { AppState, Platform } from 'react-native'
import { tokenOf, type StoredPairing } from '@/features/pairing/pairing-store'

/** Android notification channel the relay's pushes are sent to (see relay `channelId`). */
export const CHANNEL_ID = 'approvals'

export type PushStatus =
  /** Not checked yet. */
  | 'unknown'
  /** Allowed, and this phone has a token the relay can use. */
  | 'ready'
  /** The person has not been asked yet, or can still be asked. */
  | 'needs-permission'
  /** The person said no and the system will not ask again: only system settings can change it. */
  | 'denied'
  /** This build cannot receive pushes (no Expo project id, no Firebase config, or an emulator without Play services). */
  | 'unavailable'

// While Nod is open the inbox already updates live; only show a banner when it is not.
Notifications.setNotificationHandler({
  handleNotification: async () => {
    const open = AppState.currentState === 'active'
    return {
      shouldShowBanner: !open,
      shouldShowList: !open,
      shouldPlaySound: !open,
      shouldSetBadge: false,
    }
  },
})

export async function ensureChannel() {
  if (Platform.OS !== 'android') return
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Approvals',
    description: 'A request from one of your agents is waiting for you',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 200, 100, 200],
  })
}

function projectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? null
}

/** Whether the system allows notifications, without asking. */
export async function permissionStatus(): Promise<PushStatus> {
  if (!projectId()) return 'unavailable'
  const permission = await Notifications.getPermissionsAsync()
  if (permission.granted) return 'ready'
  return permission.canAskAgain ? 'needs-permission' : 'denied'
}

/** Show the system's permission dialog (Android 13 and later; earlier versions allow by default). */
export async function askPermission(): Promise<PushStatus> {
  await ensureChannel() // the dialog only appears once a channel exists
  await Notifications.requestPermissionsAsync()
  return permissionStatus()
}

/** This phone's Expo push token, or null if the build cannot get one. */
export async function fetchPushToken(): Promise<string | null> {
  const id = projectId()
  if (!id) return null
  try {
    await ensureChannel()
    return (await Notifications.getExpoPushTokenAsync({ projectId: id })).data
  } catch {
    return null
  }
}

/** Tell one relay where to send this phone's pushes. 'refused' means the pairing is no longer valid there. */
export async function registerToken(pairing: StoredPairing, token: string): Promise<'ok' | 'refused' | 'failed'> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(`${pairing.relay}/push-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenOf(pairing)}` },
      body: JSON.stringify({ token }),
      signal: controller.signal,
    })
    if (response.ok) return 'ok'
    return response.status === 401 || response.status === 403 ? 'refused' : 'failed'
  } catch {
    return 'failed'
  } finally {
    clearTimeout(timer)
  }
}

const REQUEST_ID = /^[0-9a-f-]{36}$/i

/** The request a tapped notification is about, or null if it carries nothing we recognise. */
export function requestIdFrom(data: unknown): string | null {
  const id = (data as { requestId?: unknown } | null | undefined)?.requestId
  return typeof id === 'string' && REQUEST_ID.test(id) ? id : null
}
