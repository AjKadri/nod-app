import { Ionicons } from '@expo/vector-icons'
import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { useRouter, type Href } from 'expo-router'
import React from 'react'
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useTheme } from '@/components/theme-provider'
import { DetailRow, Eyebrow, Label, NodButton } from '@/components/ui'
import { ApprovalsConfig } from '@/constants/approvals-config'
import { radius, space, type ThemePreference } from '@/constants/theme'
import { useApprovals } from '@/features/approvals/approvals-provider'
import { useNetwork } from '@/features/network/use-network'
import { shorten } from '@/utils/format'

const THEMES: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

const RELAY_LABEL = {
  online: 'Connected',
  connecting: 'Connecting…',
  offline: 'Offline',
  replaced: 'Taken over by another phone',
} as const

export default function SettingsScreen() {
  const { tokens, preference, setPreference } = useTheme()
  const router = useRouter()
  const { account, disconnect } = useMobileWallet()
  const { networks, selectedNetwork, setSelectedNetwork } = useNetwork()
  const { relayStatus, demo, setDemo } = useApprovals()

  const relayHost = ApprovalsConfig.relayUrl.replace(/^https?:\/\//, '')

  async function onDisconnect() {
    await disconnect()
    router.replace('/' as Href)
  }

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: tokens.bg }]}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back" hitSlop={12} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={28} color={tokens.text} />
        </Pressable>
        <Text accessibilityRole="header" style={{ color: tokens.text, fontSize: 24, fontWeight: '600' }}>
          Settings
        </Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Section title="Demo">
          <View style={styles.switchRow}>
            <View style={styles.switchText}>
              <Text style={{ color: tokens.text, fontSize: 16 }}>Demo mode</Text>
              <Label>Sample requests that never touch your wallet or the relay.</Label>
            </View>
            <Switch
              accessibilityLabel="Demo mode"
              value={demo}
              onValueChange={setDemo}
              trackColor={{ false: tokens.line, true: tokens.accent }}
              thumbColor={tokens.onAccent}
            />
          </View>
        </Section>

        <Section title="Wallet">
          <DetailRow
            label="Connected"
            value={account ? shorten(account.address.toString(), 6) : 'Not connected'}
            monospace
            last
          />
          {account ? (
            <NodButton title="Disconnect wallet" variant="ghost" onPress={onDisconnect} style={styles.inline} />
          ) : null}
        </Section>

        <Section title="Paired laptops">
          <DetailRow label={relayHost} value={RELAY_LABEL[relayStatus]} last />
          <Label style={styles.help}>Pairing by QR code, and revoking a laptop, are coming.</Label>
        </Section>

        <Section title="Daily limit">
          <DetailRow label="Auto-approve small payments" value="Coming soon" last />
        </Section>

        <Section title="Theme">
          <Segmented options={THEMES} value={preference} onChange={setPreference} label="Theme" />
        </Section>

        <Section title="Network">
          <Segmented
            options={networks.map((network) => ({ value: network.id, label: network.label }))}
            value={selectedNetwork.id}
            onChange={(id) => {
              const next = networks.find((network) => network.id === id)
              if (next) setSelectedNetwork(next)
            }}
            label="Network"
          />
        </Section>
      </ScrollView>
    </SafeAreaView>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const { tokens } = useTheme()
  return (
    <View style={styles.section}>
      <Eyebrow>{title}</Eyebrow>
      <View style={[styles.panel, { backgroundColor: tokens.surface, borderColor: tokens.line }]}>{children}</View>
    </View>
  )
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
  label: string
}) {
  const { tokens } = useTheme()
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={[styles.segmented, { backgroundColor: tokens.raised }]}
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            onPress={() => onChange(option.value)}
            style={[styles.segment, selected && { backgroundColor: tokens.accent }]}
          >
            <Text
              style={{
                color: selected ? tokens.onAccent : tokens.text,
                fontSize: 15,
                fontWeight: selected ? '600' : '400',
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { alignItems: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
  content: { gap: 24, padding: space.screen, paddingTop: 8 },
  section: { gap: 8 },
  panel: {
    borderRadius: radius.panel,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  switchRow: { alignItems: 'center', flexDirection: 'row', gap: 16, paddingVertical: 12 },
  switchText: { flex: 1, gap: 2 },
  inline: { alignSelf: 'flex-start', paddingHorizontal: 0 },
  help: { paddingBottom: 12 },
  segmented: { borderRadius: radius.panel, flexDirection: 'row', margin: 8, padding: 4 },
  segment: { alignItems: 'center', borderRadius: 12, flex: 1, justifyContent: 'center', minHeight: 44 },
})
