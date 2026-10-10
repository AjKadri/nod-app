import { Ionicons } from '@expo/vector-icons'
import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import Constants from 'expo-constants'
import { useRouter, type Href } from 'expo-router'
import React, { useEffect, useState } from 'react'
import {
  Alert,
  Keyboard,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useTheme } from '@/components/theme-provider'
import { TokenLogo } from '@/components/token-logo'
import { DetailRow, Eyebrow, Label, NodButton } from '@/components/ui'
import { AppConfig } from '@/constants/app-config'
import { radius, space, type ThemePreference } from '@/constants/theme'
import { useApprovals, type AutoTokenView } from '@/features/approvals/approvals-provider'
import { formatSol } from '@/features/approvals/lib/approval'
import { parseSolToLamports } from '@/features/approvals/lib/autoapprove'
import { usePairings } from '@/features/pairing/pairing-provider'
import { usePush } from '@/features/push/push-provider'
import { useNetwork } from '@/features/network/use-network'
import { NETWORKS, type NetworkId } from '@/features/approvals/lib/network'
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
  revoked: 'Unpaired',
} as const

const PUSH_LABEL = {
  unknown: 'Checking…',
  ready: 'On',
  'needs-permission': 'Off',
  denied: 'Blocked in system settings',
  unavailable: 'Not set up',
} as const

export default function SettingsScreen() {
  const { tokens, preference, setPreference } = useTheme()
  const router = useRouter()
  const { account, disconnect } = useMobileWallet()
  const { pairingStatuses, demo, setDemo } = useApprovals()
  const { pairings, revoke } = usePairings()
  const { status: pushStatus, enable: enablePush } = usePush()
  const [revokeNote, setRevokeNote] = useState<string | null>(null)

  function confirmRevoke(id: string, label: string) {
    Alert.alert(
      `Unpair ${label}?`,
      'This laptop will no longer be able to send requests to this phone. You can pair it again later.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unpair',
          style: 'destructive',
          onPress: async () => {
            const { relayNotified } = await revoke(id)
            setRevokeNote(
              relayNotified
                ? null
                : `${label} could not be reached, so it may still think it is paired. It cannot send anything this phone will accept.`,
            )
          },
        },
      ],
    )
  }

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
              onValueChange={(on) => {
                setDemo(on)
                // Without a wallet, leaving demo goes back to Welcome.
                if (!on && !account) router.replace('/' as Href)
              }}
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
          {pairings.length === 0 ? <Label style={styles.help}>No laptop paired.</Label> : null}
          {pairings.map((pairing) => (
            <View key={pairing.id} style={styles.pairRow}>
              <DetailRow label={pairing.label} value={RELAY_LABEL[pairingStatuses[pairing.id] ?? 'connecting']} last />
              <Label>{pairing.relay.replace(/^https?:\/\//, '')}</Label>
              <NodButton
                title="Unpair"
                variant="danger"
                onPress={() => confirmRevoke(pairing.id, pairing.label)}
                accessibilityHint="Stops this laptop from sending requests to this phone"
              />
            </View>
          ))}
          {revokeNote ? <Label style={styles.help}>{revokeNote}</Label> : null}
          <NodButton
            title={pairings.length ? 'Pair another laptop' : 'Pair with laptop'}
            variant="secondary"
            onPress={() => router.push('/pair' as Href)}
            style={styles.pairButton}
          />
        </Section>

        <Section title="Notifications">
          <DetailRow label="Alerts when closed" value={PUSH_LABEL[pushStatus]} last />
          {pushStatus === 'needs-permission' ? (
            <NodButton title="Turn on" variant="secondary" onPress={() => enablePush()} style={styles.pairButton} />
          ) : null}
          {pushStatus === 'denied' ? (
            <NodButton
              title="Open system settings"
              variant="secondary"
              onPress={() => Linking.openSettings()}
              style={styles.pairButton}
            />
          ) : null}
          {pushStatus === 'unavailable' ? (
            <Label style={styles.help}>
              This build cannot receive notifications yet (it needs the Expo project and Firebase setup in
              docs/hosting.md). Requests still arrive while Nod is open.
            </Label>
          ) : null}
        </Section>

        <Section title="Daily limit">
          <AutoApproveSettings />
        </Section>

        <Section title="Theme">
          <Segmented options={THEMES} value={preference} onChange={setPreference} label="Theme" />
        </Section>

        <Section title="Network">
          <NetworkSettings />
        </Section>

        <Section title="About">
          <About />
        </Section>
      </ScrollView>
    </SafeAreaView>
  )
}

/** The version, and where to find Nod on the web. Links open in the browser. */
function About() {
  const version = Constants.expoConfig?.version
  const build = Constants.expoConfig?.android?.versionCode
  const links = [AppConfig.links.website, AppConfig.links.github, AppConfig.links.x]
  return (
    <View>
      <DetailRow
        label="Nod"
        value={version ? `${version}${build ? ` (build ${build})` : ''}` : 'Unknown version'}
        last
      />
      <View style={styles.aboutLinks}>
        {links.map((link) => (
          <NodButton
            key={link.url}
            title={link.label}
            variant="secondary"
            onPress={() => Linking.openURL(link.url).catch(() => {})}
            accessibilityHint={`Opens ${link.url.replace(/^https:\/\//, '')} in your browser`}
          />
        ))}
      </View>
      <Label style={styles.help}>Open source, MIT licensed. Not audited: use amounts you can afford to lose.</Label>
    </View>
  )
}

const NETWORK_OPTIONS: { value: NetworkId; label: string }[] = [
  { value: 'devnet', label: NETWORKS.devnet.label },
  { value: 'mainnet', label: NETWORKS.mainnet.label },
]

/**
 * Devnet (practice money) or Mainnet (real money). Switching to Mainnet asks first. The wallet
 * login, the waiting requests, the daily limit and the trusted addresses are kept apart for each
 * network, and a request for the other network is refused.
 */
function NetworkSettings() {
  const { tokens } = useTheme()
  const { network, info, setNetwork, rpcUrl, customRpc, setCustomRpc } = useNetwork()
  const [rpcText, setRpcText] = useState(customRpc ?? '')
  const [problem, setProblem] = useState<string | null>(null)

  // Each network has its own RPC address.
  useEffect(() => {
    setRpcText(customRpc ?? '')
    setProblem(null)
  }, [customRpc, network])

  function choose(next: NetworkId) {
    if (next === network) return
    if (next === 'devnet') {
      setNetwork('devnet')
      return
    }
    Alert.alert(
      'Switch to Mainnet?',
      'Real money. Transactions here are final.\n\nNod will ask your wallet to connect again, and it will only accept requests that are for Mainnet. Your limits and trusted addresses for Devnet do not carry over.',
      [
        { text: 'Stay on Devnet', style: 'cancel' },
        { text: 'Use Mainnet', style: 'destructive', onPress: () => setNetwork('mainnet') },
      ],
    )
  }

  function saveRpc() {
    if (!setCustomRpc(rpcText)) {
      setProblem('Enter an https:// address, like https://my-rpc.example.com/key.')
      return
    }
    setProblem(null)
    Keyboard.dismiss()
  }

  return (
    <View>
      <Segmented options={NETWORK_OPTIONS} value={network} onChange={choose} label="Network" />
      {info.realMoney ? (
        <View accessibilityRole="alert" style={[styles.warning, { borderColor: tokens.warn }]}>
          <Ionicons name="warning-outline" size={20} color={tokens.warn} />
          <Text style={{ color: tokens.warn, flex: 1, fontSize: 15, fontWeight: '600' }}>
            Real money. Transactions here are final.
          </Text>
        </View>
      ) : (
        <Label style={styles.help}>Devnet is practice money. Nothing here is worth anything.</Label>
      )}
      <View style={[styles.limitBlock, { borderTopColor: tokens.line }]}>
        <Label>RPC address for {info.label}</Label>
        <View style={styles.limitRow}>
          <TextInput
            accessibilityLabel={`RPC address for ${info.label}`}
            value={rpcText}
            onChangeText={(value) => {
              setRpcText(value)
              setProblem(null)
            }}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder={info.rpc}
            placeholderTextColor={tokens.muted}
            returnKeyType="done"
            onSubmitEditing={saveRpc}
            style={[
              styles.limitInput,
              { color: tokens.text, borderColor: tokens.line, backgroundColor: tokens.raised, fontSize: 14 },
            ]}
          />
          <NodButton
            title="Save"
            variant="secondary"
            disabled={rpcText.trim() === (customRpc ?? '')}
            onPress={saveRpc}
          />
        </View>
        {problem ? (
          <Text accessibilityRole="alert" style={{ color: tokens.danger, fontSize: 14 }}>
            {problem}
          </Text>
        ) : null}
        <Label>
          {customRpc
            ? 'Using your own address. Leave it empty to go back to the public one.'
            : `Using the public address (${rpcUrl.replace(/^https:\/\//, '')}). Public servers can be slow or limited.`}{' '}
          Before anything is signed, Nod checks that the server really is {info.label}.
        </Label>
      </View>
    </View>
  )
}

/** "0.05" for 50,000,000 lamports. */
function solText(lamports: number) {
  return formatSol(lamports).replace(/ SOL$/, '')
}

function AutoApproveSettings() {
  const { tokens } = useTheme()
  const { auto } = useApprovals()
  const saved = auto.limitLamports > 0 ? solText(auto.limitLamports) : ''
  const [text, setText] = useState(saved)
  const [problem, setProblem] = useState<string | null>(null)

  // Follow the saved limit unless the person is typing a different one.
  useEffect(() => setText(saved), [saved])

  const changed = text.trim() !== saved
  const parsed = parseSolToLamports(text)

  function save() {
    if (parsed === null) {
      setProblem('Enter an amount in SOL, like 0.05. The most you can set is 100 SOL.')
      return
    }
    auto.setLimit(parsed)
    setProblem(null)
    Keyboard.dismiss()
  }

  function toggle(on: boolean) {
    if (on && auto.limitLamports <= 0 && !auto.skr?.limit) {
      setProblem('Set a daily limit first, then turn this on.')
      return
    }
    setProblem(null)
    auto.setEnabled(on)
  }

  return (
    <View>
      <View style={styles.switchRow}>
        <View style={styles.switchText}>
          <Text style={{ color: tokens.text, fontSize: 16 }}>Auto-approve small payments</Text>
          <Label>
            Skips the card for a plain SOL or SKR transfer to an address you approved yourself before, up to that
            token’s limit.
          </Label>
        </View>
        <Switch
          accessibilityLabel="Auto-approve small payments"
          value={auto.enabled}
          disabled={!auto.loaded}
          onValueChange={toggle}
          trackColor={{ false: tokens.line, true: tokens.accent }}
          thumbColor={tokens.onAccent}
        />
      </View>

      <View style={[styles.limitBlock, { borderTopColor: tokens.line }]}>
        <Label>Limit per day, in SOL</Label>
        <View style={styles.limitRow}>
          <TextInput
            accessibilityLabel="Daily limit in SOL"
            value={text}
            onChangeText={(value) => {
              setText(value)
              setProblem(null)
            }}
            keyboardType="decimal-pad"
            placeholder="0.05"
            placeholderTextColor={tokens.muted}
            returnKeyType="done"
            onSubmitEditing={save}
            style={[
              styles.limitInput,
              { color: tokens.text, borderColor: tokens.line, backgroundColor: tokens.raised },
            ]}
          />
          <NodButton title="Save" variant="secondary" disabled={!changed || !text.trim()} onPress={save} />
        </View>
        {problem ? (
          <Text accessibilityRole="alert" style={{ color: tokens.danger, fontSize: 14 }}>
            {problem}
          </Text>
        ) : null}
      </View>

      {auto.limitLamports > 0 ? (
        <>
          <DetailRow label="Spent today" value={formatSol(auto.spentLamports)} />
          <DetailRow label="Left today" value={formatSol(auto.remainingLamports)} last />
        </>
      ) : null}

      {auto.skr ? <TokenLimit token={auto.skr} /> : null}

      <Label style={styles.help}>
        Every payment through Nod counts, approved by hand or not, with its network fee. The day ends at midnight, your
        local time. Anything else always asks: other kinds of transactions, a new address, any warning, a preview that
        fails, or Pause everything. Nod must be open on screen.
      </Label>

      <View style={[styles.limitBlock, { borderTopColor: tokens.line }]}>
        <Label>Addresses you approved</Label>
        {auto.knownAddresses.length === 0 ? (
          <Label>None yet. An address shows up here after you approve a payment to it yourself.</Label>
        ) : (
          auto.knownAddresses.map((address) => (
            <View key={address} style={styles.knownRow}>
              <Text style={{ color: tokens.text, flex: 1, fontFamily: 'monospace', fontSize: 14 }}>
                {shorten(address, 6)}
              </Text>
              <NodButton
                title="Forget"
                variant="ghost"
                onPress={() => auto.forgetAddress(address)}
                accessibilityHint="This address asks you again next time"
              />
            </View>
          ))
        )}
      </View>
    </View>
  )
}

/** The daily limit of one token (SKR). Kept apart from the SOL limit: each is spent on its own. */
function TokenLimit({ token }: { token: AutoTokenView }) {
  const { tokens } = useTheme()
  const saved = token.limit ?? ''
  const [text, setText] = useState(saved)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => setText(saved), [saved])
  const changed = text.trim() !== saved

  function save() {
    if (!token.setLimit(text)) {
      setProblem(`Enter an amount in ${token.label}, like 100. Leave it empty for no limit.`)
      return
    }
    setProblem(null)
    Keyboard.dismiss()
  }

  return (
    <View style={[styles.limitBlock, { borderTopColor: tokens.line }]}>
      <View style={styles.limitRow}>
        <TokenLogo logo={token.logo} size={22} />
        <Label>Limit per day, in {token.label}</Label>
      </View>
      <View style={styles.limitRow}>
        <TextInput
          accessibilityLabel={`Daily limit in ${token.label}`}
          value={text}
          onChangeText={(value) => {
            setText(value)
            setProblem(null)
          }}
          keyboardType="decimal-pad"
          placeholder="No limit set"
          placeholderTextColor={tokens.muted}
          returnKeyType="done"
          onSubmitEditing={save}
          style={[styles.limitInput, { color: tokens.text, borderColor: tokens.line, backgroundColor: tokens.raised }]}
        />
        <NodButton title="Save" variant="secondary" disabled={!changed} onPress={save} />
      </View>
      {problem ? (
        <Text accessibilityRole="alert" style={{ color: tokens.danger, fontSize: 14 }}>
          {problem}
        </Text>
      ) : null}
      {token.limit ? (
        <>
          <DetailRow label={`${token.label} spent today`} value={`${token.spent} ${token.label}`} />
          <DetailRow
            label={`${token.label} left today`}
            value={`${token.remaining ?? token.limit} ${token.label}`}
            last
          />
        </>
      ) : null}
    </View>
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
  help: { paddingBottom: 12, paddingTop: 12 },
  aboutLinks: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingVertical: 12 },
  limitBlock: { borderTopWidth: StyleSheet.hairlineWidth, gap: 8, paddingVertical: 12 },
  limitRow: { alignItems: 'center', flexDirection: 'row', gap: 12 },
  limitInput: { borderRadius: radius.panel, borderWidth: 1, flex: 1, fontSize: 18, height: 52, paddingHorizontal: 14 },
  warning: {
    alignItems: 'center',
    borderRadius: radius.panel,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    marginVertical: 8,
    padding: 12,
  },
  knownRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  pairRow: { gap: 8, paddingTop: 4, paddingBottom: 12 },
  pairButton: { marginVertical: 12 },
  segmented: { borderRadius: radius.panel, flexDirection: 'row', margin: 8, padding: 4 },
  segment: { alignItems: 'center', borderRadius: 12, flex: 1, justifyContent: 'center', minHeight: 44 },
})
