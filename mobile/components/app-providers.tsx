import { PropsWithChildren } from 'react'
import { MobileWalletProvider } from '@wallet-ui/react-native-web3js'
import { ThemeProvider } from '@/components/theme-provider'
import { AppConfig } from '@/constants/app-config'
import { ApprovalsProvider } from '@/features/approvals/approvals-provider'
import { PairingProvider } from '@/features/pairing/pairing-provider'
import { NetworkProvider } from '@/features/network/network-provider'
import { useNetwork } from '@/features/network/use-network'

export function AppProviders({ children }: PropsWithChildren) {
  return (
    <ThemeProvider>
      <NetworkProvider>
        <SolanaNetworkProvider>
          <PairingProvider>
            <ApprovalsProvider>{children}</ApprovalsProvider>
          </PairingProvider>
        </SolanaNetworkProvider>
      </NetworkProvider>
    </ThemeProvider>
  )
}

// We have this SolanaNetworkProvider because of the network switching logic.
// If you only connect to a single network, use MobileWalletProvider directly.
function SolanaNetworkProvider({ children }: PropsWithChildren) {
  const { selectedNetwork } = useNetwork()
  return (
    <MobileWalletProvider chain={selectedNetwork.id} endpoint={selectedNetwork.url} identity={{ name: AppConfig.name }}>
      {children}
    </MobileWalletProvider>
  )
}
