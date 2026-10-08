import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import React, { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Animated, { FadeInUp } from 'react-native-reanimated'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useTheme } from '@/components/theme-provider'
import { Label, NodButton, Wordmark } from '@/components/ui'
import { space } from '@/constants/theme'

/** First screen: connect a wallet. Pairing with a laptop by QR arrives with the pairing work. */
export function WelcomeScreen() {
  const { tokens } = useTheme()
  const { connect } = useMobileWallet()
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
        <NodButton title="Pair with laptop · coming soon" variant="secondary" disabled onPress={() => {}} />
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
