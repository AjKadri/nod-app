import AsyncStorage from '@react-native-async-storage/async-storage'
import React, { createContext, PropsWithChildren, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useColorScheme } from 'react-native'
import { darkTokens, lightTokens, type Scheme, type ThemePreference, type ThemeTokens } from '@/constants/theme'

const STORAGE_KEY = 'nod.theme'

type ThemeValue = {
  tokens: ThemeTokens
  scheme: Scheme
  preference: ThemePreference
  setPreference: (preference: ThemePreference) => void
}

const ThemeContext = createContext<ThemeValue>({
  tokens: darkTokens,
  scheme: 'dark',
  preference: 'system',
  setPreference: () => {},
})

export function ThemeProvider({ children }: PropsWithChildren) {
  const system = useColorScheme()
  const [preference, setPreferenceState] = useState<ThemePreference>('system')

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (stored === 'light' || stored === 'dark' || stored === 'system') setPreferenceState(stored)
      })
      .catch(() => {})
  }, [])

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next)
    AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {})
  }, [])

  const value = useMemo<ThemeValue>(() => {
    const scheme: Scheme = preference === 'system' ? (system === 'light' ? 'light' : 'dark') : preference
    return { tokens: scheme === 'light' ? lightTokens : darkTokens, scheme, preference, setPreference }
  }, [preference, system, setPreference])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  return useContext(ThemeContext)
}
