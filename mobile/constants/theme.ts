/**
 * Every colour in the app comes from here. Components read tokens through
 * useTheme(); no hex values anywhere else.
 *
 * Contrast (checked): body text >= 4.5:1 on bg, surface and raised in both
 * schemes; the large amount needs 3:1. `accent` is the button fill and the dot
 * in the wordmark; `accentText` is the same green made readable as text on the
 * dark surfaces (accent itself is only 2.2-2.9:1 there).
 */
export type ThemeTokens = {
  bg: string
  surface: string
  raised: string
  line: string
  text: string
  muted: string
  accent: string
  accentText: string
  onAccent: string
  danger: string
  warn: string
}

export const darkTokens: ThemeTokens = {
  bg: '#151816',
  surface: '#1C201D',
  raised: '#27302A',
  line: '#343D37',
  text: '#EEF1EC',
  muted: '#98A29A',
  accent: '#3E6B4D',
  accentText: '#7FB591',
  onAccent: '#F3F6F1',
  danger: '#E8776E',
  warn: '#E3B25C',
}

export const lightTokens: ThemeTokens = {
  bg: '#F3F5F1',
  surface: '#FFFFFF',
  raised: '#E6ECE5',
  line: '#D3DBD2',
  text: '#161A17',
  muted: '#5B655D',
  accent: '#2F5A3E',
  accentText: '#2F5A3E',
  onAccent: '#FFFFFF',
  danger: '#B3261E',
  warn: '#8A5A00',
}

export type ThemePreference = 'system' | 'light' | 'dark'
export type Scheme = 'light' | 'dark'

export const space = { screen: 24, gap: 16, small: 8 } as const
export const radius = { card: 28, panel: 16, button: 16, pill: 999 } as const
export const size = {
  amount: 68,
  headline: 32,
  body: 16,
  label: 14,
  small: 13,
  button: 56,
} as const
