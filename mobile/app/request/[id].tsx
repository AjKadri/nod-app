import { Redirect, useLocalSearchParams, useRouter, type Href } from 'expo-router'
import React from 'react'
import { StyleSheet, Text } from 'react-native'
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
  const { items, history, approve, reject } = useApprovals()
  const item = items.find((other) => other.request.id === id)

  if (item)
    return (
      <ApprovalCard item={item} onApprove={() => approve(item.request.id)} onReject={() => reject(item.request.id)} />
    )

  // Finished while this screen was open (approved, rejected or failed): show how it went.
  if (history.some((entry) => entry.id === id)) return <Redirect href={`/result/${id}` as Href} />

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
