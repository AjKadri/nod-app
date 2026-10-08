import type { HistoryEntry, Item } from './approvals-provider'
import { demoHistory, demoRequests } from './lib/demo'

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
        payload: { type: 'transfer', note: sample.note, agent: sample.agent },
      },
      presented: sample.presented,
      phase: 'ready',
    }
  })
  const history: HistoryEntry[] = demoHistory().map((sample) => ({
    id: sample.id,
    agent: sample.agent,
    note: sample.note,
    amount: sample.amount,
    unit: 'SOL',
    recipient: sample.recipient,
    status: sample.status,
    reason: sample.reason,
    reported: true,
    at: now - sample.ageSeconds * 1000,
    demo: true,
  }))
  return { items, history }
}
