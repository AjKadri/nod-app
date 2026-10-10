import { clusterApiUrl } from '@solana/web3.js'
import { SolanaCluster } from '@wallet-ui/react-native-web3js'

/**
 * Who Nod says it is when it talks to a wallet (Mobile Wallet Adapter). The wallet shows the name
 * and icon when it asks you to trust Nod, and checks that this site vouches for the app:
 * https://nod.ajkadri.dev/.well-known/assetlinks.json lists the release signing key of
 * com.ajkadri.nod. `icon` is relative to `uri`. One constant object, so the wallet library sees
 * the same identity on every render. Changing any of it makes wallets ask to trust Nod once more.
 */
export const WALLET_IDENTITY = {
  name: 'Nod',
  uri: 'https://nod.ajkadri.dev',
  icon: 'icon.png',
} as const

export class AppConfig {
  static name = WALLET_IDENTITY.name
  static uri = WALLET_IDENTITY.uri
  static networks: SolanaCluster[] = [
    {
      id: 'solana:devnet',
      label: 'Devnet',
      url: clusterApiUrl('devnet'),
    },
    {
      id: 'solana:testnet',
      label: 'Testnet',
      url: clusterApiUrl('testnet'),
    },
  ]
  /** Where Settings → About sends people. */
  static links = {
    website: { label: 'Website', url: WALLET_IDENTITY.uri },
    github: { label: 'GitHub', url: 'https://github.com/AjKadri/nod-app' },
    x: { label: 'X (@nod_app)', url: 'https://x.com/nod_app' },
  } as const
}
