/** 8kQp…3vLm style short form for an address or signature. */
export function shorten(value: string, edge = 4): string {
  if (value.length <= edge * 2 + 1) return value
  return `${value.slice(0, edge)}…${value.slice(-edge)}`
}

/** "Now", "5 min ago", "3 h ago", or a short date. */
export function timeAgo(timestamp: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 45) return 'Now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return new Date(timestamp).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
