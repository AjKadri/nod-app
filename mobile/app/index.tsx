import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import React from 'react'
import { InboxScreen } from '@/features/inbox/inbox-screen'
import { WelcomeScreen } from '@/features/welcome/welcome-screen'

export default function HomeScreen() {
  const { account } = useMobileWallet()
  return account ? <InboxScreen /> : <WelcomeScreen />
}
