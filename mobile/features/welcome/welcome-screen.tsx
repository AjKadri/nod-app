import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { useRouter, type Href } from 'expo-router'
import React, { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Animated, { FadeInUp } from 'react-native-reanimated'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useTheme } from '@/components/theme-provider'
import { Label, NodButton, Wordmark } from '@/components/ui'
import { space } from '@/constants/theme'
import { useApprovals } from '@/features/approvals/approvals-provider'
import { usePairings } from '@/features/pairing/pairing-provider'

/** First screen: connect a wallet. Connect a wallet, pair a laptop, or try the demo. */
export function WelcomeScreen() {
  const { tokens } = useTheme()
  const { connect } = useMobileWallet()
  const { setDemo } = useApprovals()
  const { pairings } = usePairings()
  const router = useRouter()
  const paired = pairings[0]
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onConnect() {
    setBusy(true)
    setError(null)
    try {
      await connect()
    } catch {
      setError('Could not reach a wallet. Install a Solana wallet such as Solflare or Phantom, then try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: tokens.bg }]}>
      <Animated.View entering={FadeInUp.duration(400)} style={styles.hero}>
        <Wordmark fontSize={72} />
        <Text style={[styles.line, { color: tokens.text }]}>Your agent asks.{'\n'}You nod.</Text>
        <Label style={styles.sub}>
          See what a transaction really does before your wallet signs it. Your agent never holds the key.
        </Label>
      </Animated.View>

      <View style={styles.actions}>
        {error ? <Text style={{ color: tokens.danger, fontSize: 14 }}>{error}</Text> : null}
        <NodButton
          title={busy ? 'Opening wallet…' : 'Connect wallet'}
          disabled={busy}
          onPress={onConnect}
          accessibilityHint="Opens your Solana wallet to link it with Nod"
        />
        <NodButton
          title={paired ? `Paired with ${paired.label}` : 'Pair with laptop'}
          variant="secondary"
          onPress={() => router.push('/pair' as Href)}
          accessibilityHint="Scan the code your laptop shows to link it with this phone"
        />
        <NodButton
          title="Try demo"
          variant="ghost"
          onPress={() => setDemo(true)}
          accessibilityHint="Shows sample requests. No wallet needed and nothing is sent"
        />
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'space-between', padding: space.screen },
  hero: { flex: 1, gap: 20, justifyContent: 'center' },
  line: { fontSize: 32, fontWeight: '500', letterSpacing: -0.5, lineHeight: 38 },
  sub: { fontSize: 16, lineHeight: 24 },
  actions: { gap: 12, paddingBottom: 8 },
})
