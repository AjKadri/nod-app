import { Ionicons } from '@expo/vector-icons'
import React, { PropsWithChildren, useEffect, useState } from 'react'
import { Pressable, StyleProp, StyleSheet, Text, TextProps, TextStyle, View, ViewStyle } from 'react-native'
import { useTheme } from '@/components/theme-provider'
import { radius, size } from '@/constants/theme'

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

type ButtonProps = {
  title: string
  onPress: () => void
  variant?: 'primary' | 'secondary' | 'ghost'
  disabled?: boolean
  style?: StyleProp<ViewStyle>
  accessibilityHint?: string
}

/** 56 dp tall, 16 dp radius. One primary per screen. */
export function NodButton({ title, onPress, variant = 'primary', disabled, style, accessibilityHint }: ButtonProps) {
  const { tokens } = useTheme()
  const fill = variant === 'primary' ? tokens.accent : variant === 'secondary' ? tokens.raised : 'transparent'
  const color = variant === 'primary' ? tokens.onAccent : variant === 'ghost' ? tokens.accentText : tokens.text
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
