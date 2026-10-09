import { Redirect, useLocalSearchParams, useRouter, type Href } from 'expo-router'
import React, { useEffect, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useTheme } from '@/components/theme-provider'
import { Label, NodButton } from '@/components/ui'
import { space } from '@/constants/theme'
import { ApprovalCard } from '@/features/approvals/approval-card'
import { useApprovals } from '@/features/approvals/approvals-provider'

export default function RequestScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { tokens } = useTheme()
  const router = useRouter()
  const { items, history, approve, reject, relayStatus } = useApprovals()
  const item = items.find((other) => other.request.id === id)

  // Opened from a notification while the app was closed: the request arrives a moment after the
  // screen does. Give the connection time before saying it is gone (briefly once online, longer while connecting).
  const [gaveUp, setGaveUp] = useState(false)
  useEffect(() => {
    setGaveUp(false)
    const wait = relayStatus === 'online' || relayStatus === 'replaced' || relayStatus === 'revoked' ? 1500 : 8000
    const timer = setTimeout(() => setGaveUp(true), wait)
    return () => clearTimeout(timer)
  }, [relayStatus])

  if (item)
    return (
      <ApprovalCard item={item} onApprove={() => approve(item.request.id)} onReject={() => reject(item.request.id)} />
    )

  // Finished while this screen was open (approved, rejected or failed): show how it went.
  if (history.some((entry) => entry.id === id)) return <Redirect href={`/result/${id}` as Href} />

  if (!gaveUp)
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: tokens.bg, alignItems: 'center' }]}>
        <ActivityIndicator color={tokens.muted} />
        <Label accessibilityRole="alert">Opening your request…</Label>
      </SafeAreaView>
    )

  // Never sign for nobody: withdrawn, expired or answered elsewhere.
  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: tokens.bg }]}>
      <Text style={{ color: tokens.text, fontSize: 28, fontWeight: '600' }}>No longer waiting</Text>
      <Label style={{ fontSize: 16, lineHeight: 24 }}>
        This request was withdrawn, expired or answered somewhere else, so there is nothing to approve.
      </Label>
      <NodButton title="Back to inbox" onPress={() => router.replace('/' as Href)} />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, gap: 16, justifyContent: 'center', padding: space.screen },
})
