import AsyncStorage from '@react-native-async-storage/async-storage'
import { createContext, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SolanaCluster } from '@wallet-ui/react-native-web3js'
import {
  DEFAULT_NETWORK,
  NETWORKS,
  parseNetworkSettings,
  rpcFor,
  validateRpcUrl,
  type NetworkId,
  type NetworkInfo,
  type NetworkSettings,
} from '@/features/approvals/lib/network'

const KEY = 'nod.network.v1'

export interface NetworkProviderContextValue {
  /** The network Nod works on. Requests for the other one are refused. */
  network: NetworkId
  info: NetworkInfo
  /** The RPC address in use: the person's own for this network, else the public one. */
  rpcUrl: string
  /** The person's own RPC address for this network, if they set one. */
  customRpc: string | null
  setNetwork: (network: NetworkId) => void
  /** Returns false (and changes nothing) if the address is not acceptable. Null goes back to the public RPC. */
  setCustomRpc: (url: string | null) => boolean
  /** A block explorer link. `forNetwork` is the network the thing happened on (default: the current one). */
  getExplorerUrl(path: string, forNetwork?: NetworkId): string
  /** The same thing in the shape the wallet library wants. */
  selectedNetwork: SolanaCluster
}

export const NetworkProviderContext = createContext<NetworkProviderContextValue>({} as NetworkProviderContextValue)

/**
 * Which Solana network Nod is on, saved on this phone. Devnet unless the person chose Mainnet in
 * Settings. Nothing below this renders until the saved choice is read, so the wallet never starts
 * on the wrong network and then switches.
 */
export function NetworkProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<NetworkSettings | null>(null)
  const settingsRef = useRef<NetworkSettings>({ network: DEFAULT_NETWORK, rpc: {} })

  useEffect(() => {
    AsyncStorage.getItem(KEY)
      .then((text) => parseNetworkSettings(text ?? ''))
      .catch(() => parseNetworkSettings(''))
      .then((loaded) => {
        settingsRef.current = loaded
        setSettings(loaded)
      })
  }, [])

  const update = useCallback((next: NetworkSettings) => {
    settingsRef.current = next
    setSettings(next)
    AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => {})
  }, [])

  const value = useMemo<NetworkProviderContextValue | null>(() => {
    if (!settings) return null
    const network = settings.network
    const info = NETWORKS[network]
    const rpcUrl = rpcFor(network, settings)
    return {
      network,
      info,
      rpcUrl,
      customRpc: settings.rpc[network] ?? null,
      setNetwork: (next) => update({ ...settingsRef.current, network: next }),
      setCustomRpc: (url) => {
        const rpc = { ...settingsRef.current.rpc }
        if (url === null || url.trim() === '') delete rpc[settingsRef.current.network]
        else {
          const valid = validateRpcUrl(url)
          if (!valid) return false
          rpc[settingsRef.current.network] = valid
        }
        update({ ...settingsRef.current, rpc })
        return true
      },
      getExplorerUrl: (path: string, forNetwork: NetworkId = network) =>
        `https://explorer.solana.com/${path}${forNetwork === 'devnet' ? '?cluster=devnet' : ''}`,
      selectedNetwork: { id: info.cluster, label: info.label, url: rpcUrl } as SolanaCluster,
    }
  }, [settings, update])

  if (!value) return null
  return <NetworkProviderContext.Provider value={value}>{children}</NetworkProviderContext.Provider>
}
