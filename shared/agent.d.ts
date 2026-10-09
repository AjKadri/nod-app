export const DEFAULT_NAME: string
export const ICON_PRESETS: readonly ['code', 'terminal', 'sparkles', 'chat', 'search', 'globe', 'flash', 'cube']
export type IconPreset = (typeof ICON_PRESETS)[number]
export type AgentIcon = { kind: 'preset'; name: IconPreset } | { kind: 'emoji'; value: string } | null
export function cleanAgentName(value: unknown): string
export function cleanAgentIcon(value: unknown): AgentIcon
export function describeAgent(payload: unknown): { name: string; icon: AgentIcon }
