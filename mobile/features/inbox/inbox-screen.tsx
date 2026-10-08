import { Ionicons } from '@expo/vector-icons'
import { useRouter, type Href } from 'expo-router'
import React from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import Animated, { LinearTransition, SlideInDown } from 'react-native-reanimated'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useTheme } from '@/components/theme-provider'
import { DemoPill, Eyebrow, Label, NetworkPill, NodButton, useNow, Wordmark } from '@/components/ui'
import { radius, space } from '@/constants/theme'
import { useNetwork } from '@/features/network/use-network'
import { useApprovals, type HistoryEntry, type Item } from '@/features/approvals/approvals-provider'
import { timeAgo } from '@/utils/format'

export function InboxScreen() {
  const { tokens } = useTheme()
  const router = useRouter()
  const { selectedNetwork } = useNetwork()
  const { items, history, relayStatus, reconnectRelay, demo } = useApprovals()
  const now = useNow()

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: tokens.bg }]}>
      <View style={styles.header}>
        <Wordmark />
        <View style={styles.headerRight}>
          {demo ? <DemoPill /> : null}
          <NetworkPill label={selectedNetwork.label} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Settings"
            hitSlop={12}
            onPress={() => router.push('/settings' as Href)}
          >
            <Ionicons name="settings-outline" size={24} color={tokens.text} />
          </Pressable>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {demo ? null : relayStatus === 'replaced' ? (
          <View style={[styles.banner, { borderColor: tokens.danger }]}>
            <Text style={{ color: tokens.danger, fontSize: 15 }}>
              Another phone took over this connection to your laptop.
            </Text>
            <NodButton title="Take it back" variant="secondary" onPress={reconnectRelay} />
          </View>
        ) : relayStatus !== 'online' ? (
          <Label>
            {relayStatus === 'connecting' ? 'Connecting to your laptop…' : 'Cannot reach your laptop. Retrying…'}
          </Label>
        ) : null}

        <Eyebrow>Waiting for you</Eyebrow>
        {items.length === 0 ? (
          <View style={[styles.empty, { borderColor: tokens.line, backgroundColor: tokens.surface }]}>
            <Text style={{ color: tokens.text, fontSize: 18, fontWeight: '600' }}>Nothing to approve</Text>
            <Label style={{ lineHeight: 20 }}>When your agent needs to spend, the request shows up here.</Label>
          </View>
        ) : (
          items.map((item) => (
            <Animated.View key={item.request.id} entering={SlideInDown.duration(320)} layout={LinearTransition}>
              <PendingRow item={item} now={now} onPress={() => router.push(`/request/${item.request.id}` as Href)} />
            </Animated.View>
          ))
        )}

        {history.length > 0 ? <Eyebrow>Recent</Eyebrow> : null}
        {history.map((entry) => (
          <HistoryRow
            key={entry.id}
            entry={entry}
            now={now}
            onPress={() => router.push(`/result/${entry.id}` as Href)}
          />
        ))}
      </ScrollView>
    </SafeAreaView>
  )
}

function PendingRow({ item, now, onPress }: { item: Item; now: number; onPress: () => void }) {
  const { tokens } = useTheme()
  const presented = item.presented
  const payload = (item.request.payload ?? {}) as { agent?: string }
  const agent = payload.agent || 'Unnamed agent'
  const summary = presented ? presented.headline : 'Checking this request…'
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Request from ${agent}. ${summary}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: tokens.surface, borderColor: tokens.line, opacity: pressed ? 0.85 : 1 },
      ]}
    >
      <Ionicons name="laptop-outline" size={24} color={tokens.text} />
      <View style={styles.rowText}>
        <Text style={{ color: tokens.text, fontSize: 16, fontWeight: '600' }} numberOfLines={1}>
          {agent}
        </Text>
        <Label numberOfLines={1}>{summary}</Label>
        {presented?.mismatch ? (
          <Text style={{ color: tokens.danger, fontSize: 13 }}>Amount differs from the agent’s note</Text>
        ) : null}
      </View>
      <View style={styles.rowEnd}>
        <Text style={{ color: tokens.text, fontSize: 16, fontWeight: '600' }}>
          {presented?.amount ? `${presented.amount} ${presented.unit}` : '…'}
        </Text>
        <Label style={{ fontSize: 13 }}>{timeAgo(item.request.createdAt, now)}</Label>
      </View>
    </Pressable>
  )
}

const STATUS = {
  approved: { icon: 'checkmark-circle', label: 'Approved' },
  rejected: { icon: 'close-circle', label: 'Rejected' },
  failed: { icon: 'alert-circle', label: 'Failed' },
} as const

function HistoryRow({ entry, now, onPress }: { entry: HistoryEntry; now: number; onPress: () => void }) {
  const { tokens } = useTheme()
  const meta = STATUS[entry.status]
  const color =
    entry.status === 'approved' ? tokens.accentText : entry.status === 'rejected' ? tokens.danger : tokens.warn
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${meta.label}, ${entry.agent}`}
      onPress={onPress}
      style={({ pressed }) => [styles.historyRow, { borderBottomColor: tokens.line, opacity: pressed ? 0.7 : 1 }]}
    >
      <Ionicons name={meta.icon} size={24} color={color} />
      <View style={styles.rowText}>
        <Text style={{ color: tokens.text, fontSize: 16 }} numberOfLines={1}>
          {entry.agent}
        </Text>
        <Text style={{ color, fontSize: 13 }}>{meta.label}</Text>
      </View>
      <View style={styles.rowEnd}>
        {entry.amount ? (
          <Text style={{ color: tokens.text, fontSize: 16 }}>
            {entry.amount} {entry.unit}
          </Text>
        ) : null}
        <Label style={{ fontSize: 13 }}>{timeAgo(entry.at, now)}</Label>
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: space.screen,
    paddingVertical: 12,
  },
  headerRight: { alignItems: 'center', flexDirection: 'row', gap: 14 },
  content: { gap: 12, padding: space.screen, paddingTop: 8 },
  banner: { borderRadius: radius.panel, borderWidth: 1, gap: 12, padding: 16 },
  empty: { borderRadius: radius.panel, borderWidth: StyleSheet.hairlineWidth, gap: 6, padding: 20 },
  row: {
    alignItems: 'center',
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 14,
    padding: 16,
  },
  rowText: { flex: 1, gap: 2 },
  rowEnd: { alignItems: 'flex-end', gap: 2 },
  historyRow: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 14,
    paddingVertical: 14,
  },
})
