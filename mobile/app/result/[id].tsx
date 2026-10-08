import Clipboard from '@react-native-clipboard/clipboard'
import { useLocalSearchParams, useRouter, type Href } from 'expo-router'
import * as WebBrowser from 'expo-web-browser'
import React, { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Animated, { FadeIn } from 'react-native-reanimated'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useTheme } from '@/components/theme-provider'
import { DetailRow, IconCircle, Label, NodButton } from '@/components/ui'
import { radius, space } from '@/constants/theme'
import { useApprovals } from '@/features/approvals/approvals-provider'
import { useNetwork } from '@/features/network/use-network'
import { shorten } from '@/utils/format'

const COPY = {
  approved: {
    icon: 'checkmark',
    title: 'Approved',
    note: 'Your wallet signed it and the payment is confirmed. The agent has been told.',
  },
  rejected: {
    icon: 'close',
    title: 'Rejected',
    note: 'Nothing was signed and no money moved. The agent has been told.',
  },
  failed: { icon: 'alert', title: 'Did not go through', note: '' },
} as const

export default function ResultScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { tokens } = useTheme()
  const router = useRouter()
  const { history } = useApprovals()
  const { getExplorerUrl } = useNetwork()
  const [copied, setCopied] = useState(false)
  const entry = history.find((other) => other.id === id)

  const home = () => router.replace('/' as Href)

  if (!entry) {
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: tokens.bg }]}>
        <Text style={{ color: tokens.text, fontSize: 28, fontWeight: '600' }}>Nothing here</Text>
        <Label style={{ fontSize: 16 }}>This request is not in your history.</Label>
        <NodButton title="Back to inbox" onPress={home} />
      </SafeAreaView>
    )
  }

  const meta = COPY[entry.status]
  const color =
    entry.status === 'approved' ? tokens.accentText : entry.status === 'rejected' ? tokens.danger : tokens.warn
  const note = entry.status === 'failed' ? entry.reason || 'Something went wrong.' : meta.note
  const explorerUrl = entry.signature ? getExplorerUrl(`tx/${entry.signature}`) : null

  async function copySignature() {
    if (!entry?.signature) return
    Clipboard.setString(entry.signature)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: tokens.bg }]}>
      <Animated.View entering={FadeIn.duration(300)} style={styles.center}>
        <IconCircle
          name={meta.icon === 'checkmark' ? 'checkmark' : meta.icon === 'close' ? 'close' : 'alert'}
          color={color}
          background={tokens.raised}
        />
        <Text accessibilityRole="header" style={{ color: tokens.text, fontSize: 32, fontWeight: '600' }}>
          {meta.title}
        </Text>
        {entry.amount && entry.status !== 'rejected' ? (
          <Text style={{ color: tokens.text, fontSize: 24 }}>
            {entry.amount} <Text style={{ color: tokens.muted }}>{entry.unit}</Text>
          </Text>
        ) : null}
        <Label style={styles.note}>{note}</Label>
      </Animated.View>

      <View style={[styles.panel, { backgroundColor: tokens.raised }]}>
        <DetailRow label="Agent" value={entry.agent} last={!entry.recipient && !entry.signature} />
        {entry.recipient ? (
          <DetailRow label="Recipient" value={shorten(entry.recipient)} monospace last={!entry.signature} />
        ) : null}
        {entry.signature ? <DetailRow label="Signature" value={shorten(entry.signature, 6)} monospace last /> : null}
      </View>

      {!entry.reported ? (
        <Text style={{ color: tokens.warn, fontSize: 14 }}>
          Nod could not tell the relay, so the agent may still be waiting. Ask it to check again.
        </Text>
      ) : null}

      <View style={styles.actions}>
        {explorerUrl ? (
          <View style={styles.pair}>
            <NodButton
              title={copied ? 'Copied' : 'Copy signature'}
              variant="secondary"
              onPress={copySignature}
              style={styles.half}
            />
            <NodButton
              title="View on explorer"
              variant="secondary"
              onPress={() => WebBrowser.openBrowserAsync(explorerUrl)}
              style={styles.half}
            />
          </View>
        ) : null}
        <NodButton title="Done" onPress={home} />
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, gap: 20, justifyContent: 'center', padding: space.screen },
  center: { alignItems: 'center', flex: 1, gap: 14, justifyContent: 'center' },
  note: { fontSize: 16, lineHeight: 24, textAlign: 'center' },
  panel: { borderRadius: radius.panel, paddingHorizontal: 20 },
  actions: { gap: 12 },
  pair: { flexDirection: 'row', gap: 12 },
  half: { flex: 1 },
})
