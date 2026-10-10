import { Ionicons } from '@expo/vector-icons'
import React, { PropsWithChildren, useEffect, useState } from 'react'
import { Pressable, StyleProp, StyleSheet, Text, TextProps, TextStyle, View, ViewProps, ViewStyle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/components/theme-provider'
import { radius, size } from '@/constants/theme'
import type { AgentIcon, IconPreset } from '@/features/approvals/lib/agent'

/**
 * A full screen that keeps clear of the status bar and the navigation bar, whatever padding it has
 * of its own. The system bars are transparent here, so anything that reaches under them is seen.
 * The insets are added to the style's padding by hand, which does not depend on how a native
 * SafeAreaView treats a style that already has padding.
 */
export function Screen({ style, children, ...rest }: ViewProps) {
  const { tokens } = useTheme()
  const insets = useSafeAreaInsets()
  const flat = StyleSheet.flatten(style) ?? {}
  const extra = (value: unknown, fallback: number) => (typeof value === 'number' ? value : fallback)
  const base = extra(flat.padding, 0)
  return (
    <View
      {...rest}
      style={[
        { backgroundColor: tokens.bg },
        style,
        {
          paddingTop: extra(flat.paddingTop, base) + insets.top,
          paddingBottom: extra(flat.paddingBottom, base) + insets.bottom,
          paddingLeft: extra(flat.paddingLeft, base) + insets.left,
          paddingRight: extra(flat.paddingRight, base) + insets.right,
        },
      ]}
    >
      {children}
    </View>
  )
}

/** The `nod.` wordmark. The dot uses the accent green. */
export function Wordmark({ fontSize = 30 }: { fontSize?: number }) {
  const { tokens } = useTheme()
  return (
    <Text
      accessibilityRole="header"
      accessibilityLabel="nod"
      style={{ color: tokens.text, fontSize, fontWeight: '700', letterSpacing: -1 }}
    >
      nod<Text style={{ color: tokens.accent }}>.</Text>
    </Text>
  )
}

export function Label({ children, style, ...rest }: TextProps) {
  const { tokens } = useTheme()
  return (
    <Text {...rest} style={[{ color: tokens.muted, fontSize: size.label }, style]}>
      {children}
    </Text>
  )
}

export function Body({ children, style, ...rest }: TextProps) {
  const { tokens } = useTheme()
  return (
    <Text {...rest} style={[{ color: tokens.text, fontSize: size.body }, style]}>
      {children}
    </Text>
  )
}

export function Eyebrow({ children }: PropsWithChildren) {
  const { tokens } = useTheme()
  return (
    <Text
      style={{
        color: tokens.muted,
        fontSize: size.small,
        fontWeight: '600',
        letterSpacing: 1.6,
        textTransform: 'uppercase',
      }}
    >
      {children}
    </Text>
  )
}

export function NetworkPill({ label }: { label: string }) {
  const { tokens } = useTheme()
  return (
    <View style={[styles.pill, { borderColor: tokens.line }]}>
      <Text style={{ color: tokens.muted, fontSize: size.small }}>Solana · {label}</Text>
    </View>
  )
}

/** Shown while demo mode is on, so nobody mistakes sample data for real requests. */
export function DemoPill() {
  const { tokens } = useTheme()
  return (
    <View accessibilityLabel="Demo mode is on" style={[styles.pill, { borderColor: tokens.warn }]}>
      <Text style={{ color: tokens.warn, fontSize: size.small, fontWeight: '600' }}>Demo</Text>
    </View>
  )
}

type ButtonProps = {
  title: string
  onPress: () => void
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'dangerFilled'
  disabled?: boolean
  style?: StyleProp<ViewStyle>
  accessibilityHint?: string
}

/** 56 dp tall, 16 dp radius. One primary per screen. */
export function NodButton({ title, onPress, variant = 'primary', disabled, style, accessibilityHint }: ButtonProps) {
  const { tokens } = useTheme()
  const fills = {
    primary: tokens.accent,
    secondary: tokens.raised,
    ghost: 'transparent',
    danger: 'transparent',
    dangerFilled: tokens.danger,
  }
  const colors = {
    primary: tokens.onAccent,
    secondary: tokens.text,
    ghost: tokens.accentText,
    danger: tokens.danger,
    dangerFilled: tokens.bg,
  }
  const fill = fills[variant]
  const color = colors[variant]
  const textStyle: TextStyle = { color, fontSize: size.body, fontWeight: '600' }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: fill, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 },
        variant === 'danger' || variant === 'dangerFilled' ? { borderColor: tokens.danger, borderWidth: 1 } : null,
        style,
      ]}
    >
      <Text style={textStyle}>{title}</Text>
    </Pressable>
  )
}

/** Label on the left, value on the right, hairline below unless last. */
export function DetailRow({
  label,
  value,
  valueColor,
  last,
  monospace,
}: {
  label: string
  value: string
  valueColor?: string
  last?: boolean
  monospace?: boolean
}) {
  const { tokens } = useTheme()
  return (
    <View
      style={[styles.row, !last && { borderBottomColor: tokens.line, borderBottomWidth: StyleSheet.hairlineWidth }]}
    >
      <Text style={{ color: tokens.muted, fontSize: size.body }}>{label}</Text>
      <Text
        style={{
          color: valueColor ?? tokens.text,
          fontSize: size.body,
          flexShrink: 1,
          textAlign: 'right',
          fontFamily: monospace ? 'monospace' : undefined,
        }}
      >
        {value}
      </Text>
    </View>
  )
}

export function IconCircle({
  name,
  color,
  background,
}: {
  name: keyof typeof Ionicons.glyphMap
  color: string
  background: string
}) {
  return (
    <View style={[styles.circle, { backgroundColor: background }]}>
      <Ionicons name={name} size={40} color={color} />
    </View>
  )
}

/** Re-renders every `intervalMs` so relative times stay fresh. */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

const styles = StyleSheet.create({
  pill: {
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  button: {
    alignItems: 'center',
    borderRadius: radius.button,
    height: size.button,
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 16,
    justifyContent: 'space-between',
    minHeight: 52,
    paddingVertical: 12,
  },
  circle: {
    alignItems: 'center',
    borderRadius: 48,
    height: 96,
    justifyContent: 'center',
    width: 96,
  },
})

const PRESET_GLYPHS: Record<IconPreset, keyof typeof Ionicons.glyphMap> = {
  code: 'code-slash-outline',
  terminal: 'terminal-outline',
  sparkles: 'sparkles-outline',
  chat: 'chatbubbles-outline',
  search: 'search-outline',
  globe: 'globe-outline',
  flash: 'flash-outline',
  cube: 'cube-outline',
}

/**
 * An agent's icon: one of our own drawings, a single emoji, or a laptop when it gave none.
 * The agent only ever picks from that list, so it cannot make the phone load anything.
 * Decorative: the agent's name beside it is what is read aloud.
 */
export function AgentMark({ icon, size: box = 28, color }: { icon?: AgentIcon; size?: number; color?: string }) {
  const { tokens } = useTheme()
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ alignItems: 'center', height: box, justifyContent: 'center', width: box }}
    >
      {icon?.kind === 'emoji' ? (
        <Text style={{ fontSize: box * 0.8 }}>{icon.value}</Text>
      ) : (
        <Ionicons
          name={icon?.kind === 'preset' ? PRESET_GLYPHS[icon.name] : 'laptop-outline'}
          size={box}
          color={color ?? tokens.text}
        />
      )}
    </View>
  )
}
