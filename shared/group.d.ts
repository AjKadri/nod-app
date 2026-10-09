export type DayGroup<T> = { label: 'Today' | 'Yesterday' | 'Earlier'; entries: T[] }
export function groupByDay<T>(entries: T[], now: number, timeOf: (entry: T) => number): DayGroup<T>[]
