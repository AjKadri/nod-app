import { Ionicons } from '@expo/vector-icons'
import React, { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import Animated, { SlideInDown } from 'react-native-reanimated'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useTheme } from '@/components/theme-provider'
import { DemoPill, DetailRow, Eyebrow, Label, NodButton, useNow, Wordmark } from '@/components/ui'
import { radius, size, space } from '@/constants/theme'
import { useNetwork } from '@/features/network/use-network'
import { formatSol } from './lib/approval'
import type { Presented } from './lib/present'
import { useApprovals, type Item } from './approvals-provider'
import { shorten, timeAgo } from '@/utils/format'

/**
 * The approval card, top to bottom as in docs/design/approval-card-reference.png.
 * Everything under the headline comes from the simulated review. The headline is
 * the agent's own note, shown as a quote.
 */
export function ApprovalCard({
  item,
  onApprove,
  onReject,
}: {
  item: Item
  onApprove: () => void
  onReject: () => void
}) {
  const { tokens } = useTheme()
  const { selectedNetwork } = useNetwork()
  const now = useNow()
  const { demo } = useApprovals()
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const { presented, phase } = item
  const payload = (item.request.payload ?? {}) as { agent?: string }
  const agent = payload.agent || 'Unnamed agent'
  const working = phase === 'working'
  const ready = phase === 'ready'
  const risky = !!presented?.risky

  // The confirm step lapses on its own, so a stray second tap later does nothing.
  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), 5000)
    return () => clearTimeout(timer)
  }, [confirming])

  function onSendAnyway() {
    if (!confirming) {
      setConfirming(true)
      return
    }
    onApprove()
  }

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: tokens.bg }]}>
      <Animated.View
        entering={SlideInDown.duration(320)}
        style={[styles.card, { backgroundColor: tokens.surface, borderColor: tokens.line }]}
      >
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          <View style={styles.headerRow}>
            <Wordmark />
            <View style={styles.headerRight}>
              {demo ? <DemoPill /> : null}
              <Label>Solana · {selectedNetwork.label}</Label>
            </View>
          </View>

          <View style={styles.agentRow}>
            <Ionicons name="laptop-outline" size={24} color={tokens.text} />
            <View style={styles.agentText}>
              <Text style={{ color: tokens.text, fontSize: size.body + 2 }} numberOfLines={1}>
                {agent}
              </Text>
              <Label>From your paired laptop</Label>
            </View>
            <Label>{timeAgo(item.request.createdAt, now)}</Label>
          </View>

          <Eyebrow>Request to review</Eyebrow>

          {presented ? (
            <Reviewed presented={presented} open={open} onToggle={() => setOpen((value) => !value)} />
          ) : (
            <View style={styles.checking}>
              <ActivityIndicator color={tokens.muted} />
              <Label>Checking what this request does…</Label>
            </View>
          )}
        </ScrollView>

        <View style={styles.footer}>
          <Label>
            {working
              ? 'Approve it in your wallet.'
              : risky
                ? 'Something here does not look right. Rejecting is the safe choice.'
                : 'Your wallet will ask you to sign.'}
          </Label>
          {risky ? (
            <View style={styles.buttons}>
              <NodButton
                title={working ? 'Waiting for wallet…' : confirming ? 'Tap again to send' : 'Send anyway'}
                variant={confirming ? 'dangerFilled' : 'danger'}
                disabled={!ready}
                onPress={onSendAnyway}
                style={styles.compact}
                accessibilityHint="Asks you to confirm, then opens your wallet so you can sign"
              />
              <NodButton title="Reject" disabled={working} onPress={onReject} style={styles.primary} />
            </View>
          ) : (
            <View style={styles.buttons}>
              <NodButton title="Reject" variant="secondary" disabled={working} onPress={onReject} />
              <NodButton
                title={working ? 'Waiting for wallet…' : 'Continue to wallet'}
                disabled={!ready}
                onPress={onApprove}
                style={styles.primary}
                accessibilityHint="Opens your wallet so you can sign"
              />
            </View>
          )}
        </View>
      </Animated.View>
    </SafeAreaView>
  )
}

function Reviewed({ presented, open, onToggle }: { presented: Presented; open: boolean; onToggle: () => void }) {
  const { tokens } = useTheme()
  const recipient =
    presented.recipient.kind === 'address' ? shorten(presented.recipient.value) : presented.recipient.value
  const worst = presented.warnings.some((w) => w.level === 'danger') ? tokens.danger : tokens.warn
  const count = presented.warnings.length

  return (
    <>
      <View style={styles.claim}>
        <Text style={[styles.headline, { color: tokens.text }]} numberOfLines={2}>
          {presented.agentClaim ? `“${presented.headline}”` : presented.headline}
        </Text>
        {presented.agentClaim ? <Label>In the agent’s words</Label> : null}
      </View>

      <View>
        {presented.direction === 'receive' ? <Label>You receive</Label> : null}
        {presented.direction === 'none' ? <Label>No change to your SOL balance</Label> : null}
        <View style={styles.amountRow}>
          <Text
            accessibilityLabel={presented.amount ? `${presented.amount} ${presented.unit}` : 'Amount unknown'}
            style={[styles.amount, { color: tokens.text }]}
            numberOfLines={1}
            adjustsFontSizeToFit
          >
            {presented.amount ?? '—'}
          </Text>
          <Text style={{ color: tokens.muted, fontSize: 24 }}>{presented.unit}</Text>
        </View>
        {presented.mismatch ? (
          <View accessibilityRole="alert" style={[styles.mismatch, { borderColor: tokens.danger }]}>
            <Ionicons name="warning-outline" size={20} color={tokens.danger} />
            <Text style={{ color: tokens.danger, flex: 1, fontSize: size.body, fontWeight: '600' }}>
              {presented.mismatch.message}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={[styles.panel, { backgroundColor: tokens.raised }]}>
        <DetailRow label="Recipient" value={recipient} monospace={presented.recipient.kind === 'address'} />
        <DetailRow label="Action" value={presented.action} />
        <DetailRow label="Network fee" value={presented.fee} />
        <DetailRow
          label="Preview"
          value={presented.previewText}
          valueColor={presented.previewOk ? undefined : tokens.danger}
          last
        />
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        style={styles.disclosure}
      >
        <Ionicons name={open ? 'caret-down' : 'caret-forward'} size={14} color={tokens.text} />
        <Text style={{ color: tokens.text, fontSize: size.body }}>See transaction details</Text>
        {count > 0 ? (
          <Text style={{ color: worst, fontSize: size.label, fontWeight: '600' }}>
            · {count} warning{count === 1 ? '' : 's'}
          </Text>
        ) : null}
      </Pressable>

      {open ? <Details presented={presented} /> : null}
    </>
  )
}

function Details({ presented }: { presented: Presented }) {
  const { tokens } = useTheme()
  const unknown = new Set(presented.programs.filter((p) => !p.name).map((p) => p.id))
  return (
    <View style={styles.details}>
      <Section title="Programs">
        {presented.programs.map((program) => (
          <Text
            key={program.id}
            style={{ color: unknown.has(program.id) ? tokens.danger : tokens.text, fontSize: size.label }}
          >
            {program.name ?? `${shorten(program.id, 6)} (not recognised)`}
          </Text>
        ))}
      </Section>

      {presented.transfers.length > 0 ? (
        <Section title="Accounts">
          {presented.transfers.map((transfer, index) => (
            <Text key={`${index}-${transfer.to}`} style={{ color: tokens.text, fontSize: size.label }}>
              {transfer.lamports === null ? 'Sends SOL' : `Sends ${formatSol(transfer.lamports)}`} to{' '}
              {shorten(transfer.to, 6)}
            </Text>
          ))}
        </Section>
      ) : null}

      <Section title="Warnings">
        {presented.warnings.length === 0 ? (
          <Text style={{ color: tokens.text, fontSize: size.label }}>None</Text>
        ) : (
          presented.warnings.map((warning) => (
            <Text
              key={warning.text}
              style={{ color: warning.level === 'danger' ? tokens.danger : tokens.warn, fontSize: size.label }}
            >
              {warning.text}
            </Text>
          ))
        )}
      </Section>

      {presented.logs.length > 0 ? (
        <Section title="Simulation log">
          {presented.logs.slice(-8).map((line, index) => (
            <Text key={`${index}-${line}`} style={{ color: tokens.muted, fontFamily: 'monospace', fontSize: 12 }}>
              {line}
            </Text>
          ))}
        </Section>
      ) : null}
    </View>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Eyebrow>{title}</Eyebrow>
      {children}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 12 },
  card: {
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    overflow: 'hidden',
  },
  scroll: { gap: 20, padding: space.screen },
  headerRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  headerRight: { alignItems: 'center', flexDirection: 'row', gap: 10 },
  agentRow: { alignItems: 'center', flexDirection: 'row', gap: 14 },
  agentText: { flex: 1 },
  checking: { alignItems: 'center', flexDirection: 'row', gap: 12, paddingVertical: 24 },
  claim: { gap: 6 },
  headline: { fontSize: size.headline, fontWeight: '500', letterSpacing: -0.5, lineHeight: size.headline + 6 },
  amountRow: { alignItems: 'baseline', flexDirection: 'row', gap: 10 },
  amount: { flexShrink: 1, fontSize: size.amount, fontWeight: '400', letterSpacing: -2 },
  mismatch: {
    alignItems: 'center',
    borderRadius: radius.panel,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    marginTop: 8,
    padding: 12,
  },
  panel: { borderRadius: radius.panel, paddingHorizontal: 20 },
  disclosure: { alignItems: 'center', flexDirection: 'row', gap: 8, minHeight: 44 },
  details: { gap: 16 },
  section: { gap: 6 },
  footer: { gap: 12, paddingBottom: space.screen, paddingHorizontal: space.screen, paddingTop: 8 },
  buttons: { flexDirection: 'row', gap: 12 },
  primary: { flex: 1 },
  compact: { flexShrink: 0 },
})
