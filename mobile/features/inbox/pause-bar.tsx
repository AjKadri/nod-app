import { Ionicons } from '@expo/vector-icons'
import React from 'react'
import { StyleSheet, Switch, Text, View } from 'react-native'
import { useTheme } from '@/components/theme-provider'
import { Label, NodButton } from '@/components/ui'
import { radius, space } from '@/constants/theme'
import { useApprovals } from '@/features/approvals/approvals-provider'

/**
 * "Pause everything": the emergency stop. While it is on, the relay refuses every new request from
 * your laptops and each agent is told why. It stays in view above the list, not inside a menu, and
 * only ever shows what the relay has confirmed.
 */
export function PauseBar() {
  const { tokens } = useTheme()
  const { pauseState, pauseBusy, pauseProblem, setPaused, demo } = useApprovals()
  const on = pauseState !== 'off'
  const partial = pauseState === 'partial'
  const title = partial ? 'Only partly paused' : on ? 'Paused' : 'Pause everything'
  const detail = partial
    ? 'Some laptops can still send requests.'
    : on
      ? demo
        ? 'Sample only: nothing is blocked in demo mode.'
        : 'Agents cannot send new requests.'
      : 'Stop every agent from sending new requests.'

  return (
    <View style={[styles.bar, { backgroundColor: tokens.surface, borderColor: on ? tokens.warn : tokens.line }]}>
      <View style={styles.row}>
        <Ionicons
          name={on ? 'pause-circle' : 'pause-circle-outline'}
          size={26}
          color={on ? tokens.warn : tokens.muted}
        />
        <View style={styles.text}>
          <Text style={{ color: tokens.text, fontSize: 16, fontWeight: '600' }}>{title}</Text>
          <Label>{detail}</Label>
        </View>
        <Switch
          accessibilityLabel="Pause everything"
          accessibilityHint="Stops every agent from sending new requests until you turn it off"
          value={on}
          disabled={pauseBusy}
          onValueChange={(next) => {
            setPaused(next).catch(() => {})
          }}
          trackColor={{ false: tokens.line, true: tokens.warn }}
          thumbColor={tokens.onAccent}
        />
      </View>
      {pauseProblem ? (
        <View style={styles.problem}>
          <Text accessibilityRole="alert" style={{ color: tokens.danger, fontSize: 14, lineHeight: 20 }}>
            {pauseProblem.message}
          </Text>
          <NodButton
            title="Try again"
            variant="secondary"
            disabled={pauseBusy}
            onPress={() => {
              setPaused(pauseProblem.target).catch(() => {})
            }}
          />
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    borderRadius: radius.panel,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 12,
    marginHorizontal: space.screen,
    padding: 14,
  },
  row: { alignItems: 'center', flexDirection: 'row', gap: 12 },
  text: { flex: 1, gap: 2 },
  problem: { gap: 10 },
})
