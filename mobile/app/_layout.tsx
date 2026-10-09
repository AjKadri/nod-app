import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import 'react-native-reanimated'
import { AppProviders } from '@/components/app-providers'
import { useTheme } from '@/components/theme-provider'
import { NotificationTapHandler } from '@/features/push/push-provider'

function RootStack() {
  const { tokens, scheme } = useTheme()
  return (
    <>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: tokens.bg } }} />
      <NotificationTapHandler />
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
    </>
  )
}

export default function RootLayout() {
  return (
    <AppProviders>
      <RootStack />
    </AppProviders>
  )
}
