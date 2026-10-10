import AsyncStorage from '@react-native-async-storage/async-storage'
import { PropsWithChildren, useMemo } from 'react'
import { MobileWalletProvider, type WalletAuthorizationCache } from '@wallet-ui/react-native-web3js'
import { ThemeProvider } from '@/components/theme-provider'
import { WALLET_IDENTITY } from '@/constants/app-config'
import { ApprovalsProvider } from '@/features/approvals/approvals-provider'
import { PushProvider } from '@/features/push/push-provider'
import { PairingProvider } from '@/features/pairing/pairing-provider'
import { NetworkProvider } from '@/features/network/network-provider'
import { useNetwork } from '@/features/network/use-network'
import type { NetworkId } from '@/features/approvals/lib/network'

export function AppProviders({ children }: PropsWithChildren) {
  return (
    <ThemeProvider>
      <NetworkProvider>
        <SolanaNetworkProvider>
          <PairingProvider>
            <PushProvider>
              <ApprovalsProvider>{children}</ApprovalsProvider>
            </PushProvider>
          </PairingProvider>
        </SolanaNetworkProvider>
      </NetworkProvider>
    </ThemeProvider>
  )
}

/**
 * The wallet's login (its authorization) is kept per network, so a login made on Devnet is never
 * reused on Mainnet. Devnet keeps the key the app has always used, so nobody has to log in again.
 */
function authorizationCache(network: NetworkId): WalletAuthorizationCache {
  const key = network === 'devnet' ? 'authorization-cache' : `authorization-cache-${network}`
  return {
    async clear() {
      await AsyncStorage.removeItem(key)
    },
    async get() {
      const text = await AsyncStorage.getItem(key)
      return text ? JSON.parse(text) : undefined
    },
    async set(value) {
      await AsyncStorage.setItem(key, JSON.stringify(value))
    },
  }
}

// The wallet provider starts over when the network changes (the key), so nothing from one network
// is carried into the other: not the wallet login, not the waiting requests, not the daily record.
function SolanaNetworkProvider({ children }: PropsWithChildren) {
  const { network, selectedNetwork } = useNetwork()
  const cache = useMemo(() => authorizationCache(network), [network])
  return (
    <MobileWalletProvider
      key={network}
      cache={cache}
      chain={selectedNetwork.id}
      endpoint={selectedNetwork.url}
      identity={WALLET_IDENTITY}
    >
      {children}
    </MobileWalletProvider>
  )
}
