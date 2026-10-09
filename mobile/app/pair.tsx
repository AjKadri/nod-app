import { Ionicons } from '@expo/vector-icons'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { useRouter, type Href } from 'expo-router'
import React, { useRef, useState } from 'react'
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useTheme } from '@/components/theme-provider'
import { Body, IconCircle, Label, NodButton } from '@/components/ui'
import { radius, space } from '@/constants/theme'
import { usePairings } from '@/features/pairing/pairing-provider'
import { usePush } from '@/features/push/push-provider'

type Phase =
  { name: 'scan' } | { name: 'working' } | { name: 'done'; label: string } | { name: 'error'; message: string }

/** Scan the QR code that `npm run pair` shows on the laptop. A pasted link works too. */
export default function PairScreen() {
  const { tokens } = useTheme()
  const router = useRouter()
  const { pair } = usePairings()
  const { enable: enablePush } = usePush()
  const [permission, requestPermission] = useCameraPermissions()
  const [phase, setPhase] = useState<Phase>({ name: 'scan' })
  const [typing, setTyping] = useState(false)
  const [text, setText] = useState('')
  const locked = useRef(false)

  async function submit(link: string) {
    if (locked.current) return
    locked.current = true
    setPhase({ name: 'working' })
    try {
      const stored = await pair(link)
      setPhase({ name: 'done', label: stored.label })
      // Ask for notification permission now that there is a reason to. Never blocks pairing.
      enablePush().catch(() => {})
    } catch (error) {
      setPhase({ name: 'error', message: error instanceof Error ? error.message : 'Pairing failed. Try again.' })
    }
  }

  function retry() {
    locked.current = false
    setText('')
    setPhase({ name: 'scan' })
  }

  function leave() {
    if (router.canGoBack()) router.back()
    else router.replace('/' as Href)
  }

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: tokens.bg }]}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close" hitSlop={12} onPress={leave}>
          <Ionicons name="close" size={28} color={tokens.text} />
        </Pressable>
        <Text accessibilityRole="header" style={{ color: tokens.text, fontSize: 24, fontWeight: '600' }}>
          Pair with laptop
        </Text>
      </View>

      {phase.name === 'done' ? (
        <View style={styles.center}>
          <IconCircle name="checkmark" color={tokens.onAccent} background={tokens.accent} />
          <Text style={{ color: tokens.text, fontSize: 24, fontWeight: '600', textAlign: 'center' }}>
            Paired with {phase.label}
          </Text>
          <Body style={{ textAlign: 'center' }}>
            Requests from this laptop will show up here. Only this phone can approve them.
          </Body>
          <NodButton title="Done" onPress={leave} style={styles.full} />
        </View>
      ) : phase.name === 'error' ? (
        <View style={styles.center}>
          <IconCircle name="alert" color={tokens.danger} background={tokens.raised} />
          <Text style={{ color: tokens.text, fontSize: 22, fontWeight: '600', textAlign: 'center' }}>
            Could not pair
          </Text>
          <Body style={{ textAlign: 'center' }}>{phase.message}</Body>
          <NodButton title="Try again" onPress={retry} style={styles.full} />
        </View>
      ) : phase.name === 'working' ? (
        <View style={styles.center}>
          <Label>Pairing…</Label>
        </View>
      ) : typing ? (
        <View style={styles.body}>
          <Body>On your laptop run `npm run pair`, copy the line that starts with nod://pair and paste it here.</Body>
          <TextInput
            accessibilityLabel="Pairing link"
            value={text}
            onChangeText={setText}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            placeholder="nod://pair?…"
            placeholderTextColor={tokens.muted}
            style={[styles.input, { color: tokens.text, borderColor: tokens.line, backgroundColor: tokens.surface }]}
          />
          <NodButton title="Pair" disabled={!text.trim()} onPress={() => submit(text)} />
          <NodButton title="Scan instead" variant="ghost" onPress={() => setTyping(false)} />
        </View>
      ) : !permission ? (
        <View style={styles.center}>
          <Label>Opening the camera…</Label>
        </View>
      ) : !permission.granted ? (
        <View style={styles.center}>
          <IconCircle name="camera" color={tokens.text} background={tokens.raised} />
          <Text style={{ color: tokens.text, fontSize: 22, fontWeight: '600', textAlign: 'center' }}>
            Nod needs the camera to scan the code
          </Text>
          <Body style={{ textAlign: 'center' }}>
            It is only used to read the pairing code. Nothing is saved or sent.
          </Body>
          {permission.canAskAgain ? (
            <NodButton title="Allow camera" onPress={requestPermission} style={styles.full} />
          ) : (
            <NodButton title="Open settings" onPress={() => Linking.openSettings()} style={styles.full} />
          )}
          <NodButton
            title="Paste the link instead"
            variant="ghost"
            onPress={() => setTyping(true)}
            style={styles.full}
          />
        </View>
      ) : (
        <View style={styles.body}>
          <Body>On your laptop run `npm run pair`, then point the camera at the code.</Body>
          <View style={[styles.camera, { borderColor: tokens.line }]}>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={({ data }) => submit(data)}
              accessibilityLabel="Camera. Point at the pairing code on your laptop"
            />
          </View>
          <NodButton title="Paste the link instead" variant="ghost" onPress={() => setTyping(true)} />
        </View>
      )}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { alignItems: 'center', flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  body: { flex: 1, gap: 16, padding: space.screen },
  center: { alignItems: 'center', flex: 1, gap: 16, justifyContent: 'center', padding: space.screen },
  full: { alignSelf: 'stretch' },
  camera: { aspectRatio: 1, borderRadius: radius.panel, borderWidth: 1, overflow: 'hidden' },
  input: {
    borderRadius: radius.panel,
    borderWidth: 1,
    fontSize: 15,
    minHeight: 96,
    padding: 14,
    textAlignVertical: 'top',
  },
})
