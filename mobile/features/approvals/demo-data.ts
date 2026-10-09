import type { HistoryEntry, Item } from './approvals-provider'
import { cleanAgentIcon } from './lib/agent'
import { demoHistory, demoRequests } from './lib/demo'

/** A time on the calendar day `daysAgo` before `now`, in the phone's time zone. */
function onDay(now: number, daysAgo: number, hour: number, minute: number) {
  const date = new Date(now)
  date.setDate(date.getDate() - daysAgo)
  date.setHours(hour, minute, 0, 0)
  return date.getTime()
}

/** Sample requests and history for demo mode. Built from shared/demo.js, which the tests cover. */
export function buildDemo(now: number): { items: Item[]; history: HistoryEntry[] } {
  const items: Item[] = demoRequests().map((sample) => {
    const createdAt = now - sample.ageSeconds * 1000
    return {
      request: {
        id: sample.id,
        status: 'pending',
        createdAt,
        expiresAt: createdAt + 10 * 60 * 1000,
        payload: { type: 'transfer', note: sample.note, agent: sample.agent, agentIcon: sample.agentIcon },
      },
      pairingId: 'demo',
      pairingLabel: 'Demo laptop',
      presented: sample.presented,
      phase: 'ready',
    }
  })
  const history: HistoryEntry[] = demoHistory().map((sample) => ({
    id: sample.id,
    agent: sample.agent,
    agentIcon: cleanAgentIcon(sample.agentIcon),
    note: sample.note,
    amount: sample.amount,
    unit: 'SOL',
    recipient: sample.recipient,
    status: sample.status,
    reason: sample.reason,
    ...(sample.auto ? { auto: true } : {}),
    reported: true,
    at: sample.daysAgo
      ? onDay(now, sample.daysAgo, sample.hour ?? 12, sample.minute ?? 0)
      : now - (sample.ageSeconds ?? 0) * 1000,
    demo: true,
  }))
  return { items, history }
}
