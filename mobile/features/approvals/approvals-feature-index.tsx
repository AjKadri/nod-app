import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Button, Text, View } from 'react-native'
import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { appStyles } from '@/constants/app-styles'
import { ApprovalsConfig } from '@/constants/approvals-config'
import { ellipsify } from '@/utils/ellipsify'
import { formatSol, reviewRequest, type Review, type SignAndSend } from './lib/approval'
import { rpcChain } from './lib/chain'
import { submitApproval, submitDenial, submitInvalid, type Outcome } from './lib/flow'
import { createRelayClient, type RelayClient, type RelayRequest, type RelayStatus } from './lib/relayClient'

type Item = {
  request: RelayRequest
  review?: Review
  phase: 'reviewing' | 'ready' | 'working'
}

/**
 * Feasibility spike screen: shows approval requests that agents send through
 * the relay, and signs the approved ones with the connected mobile wallet.
 *
 * All decisions about what a transaction is and whether it can be signed live
 * in ./lib, which is the same code the laptop tests run.
 */
export function ApprovalsFeatureIndex() {
  const { account, connection, connect, signAndSendTransaction, signTransaction } = useMobileWallet()
  const address = account?.address.toString()
  const chain = useMemo(() => rpcChain(connection), [connection])
  const relayRef = useRef<RelayClient | null>(null)
  const [relayStatus, setRelayStatus] = useState<RelayStatus>('offline')
  const [items, setItems] = useState<Item[]>([])
  const [history, setHistory] = useState<string[]>([])
  // Who broadcasts an approved transaction. Default: Nod (the wallet only signs),
  // because some wallets (the Mock MWA Wallet among them) fail to send on devnet.
  const [walletSends, setWalletSends] = useState(false)

  useEffect(() => {
    if (!address) return

    const remember = (line: string) => setHistory((previous) => [line, ...previous].slice(0, 5))
    const drop = (id: string) => setItems((previous) => previous.filter((item) => item.request.id !== id))

    const client = createRelayClient({
      baseUrl: ApprovalsConfig.relayUrl,
      token: ApprovalsConfig.relayToken,
      WebSocketImpl: WebSocket,
      fetchImpl: fetch,
      onStatus: setRelayStatus,
      onRequest: (request) => {
        setItems((previous) => [...previous, { request, phase: 'reviewing' }])
        reviewRequest({ payload: request.payload, walletAddress: address, chain })
          .then((review) => {
            setItems((previous) =>
              previous.map((item) => (item.request.id === request.id ? { ...item, review, phase: 'ready' } : item)),
            )
          })
          .catch(async (error: unknown) => {
            // Could not even be shown (bad address, wrong fee payer, undecodable). Tell the agent.
            const outcome = await submitInvalid({ request, relay: client, error })
            drop(request.id)
            remember(`Refused a bad request: ${outcome.reason ?? 'unknown reason'}`)
          })
      },
      // Answered elsewhere, expired, or withdrawn by the agent: take it off the screen
      // unless we are already in the middle of signing it.
      onResolved: (id) =>
        setItems((previous) => previous.filter((item) => item.request.id !== id || item.phase === 'working')),
    })
    client.setWallet(address)
    relayRef.current = client

    return () => {
      client.close()
      relayRef.current = null
      setItems([])
      setRelayStatus('offline')
    }
  }, [address, chain])

  function finish(item: Item, outcome: Outcome) {
    setItems((previous) => previous.filter((other) => other.request.id !== item.request.id))
    const line =
      outcome.status === 'approved'
        ? `Approved: ${ellipsify(outcome.signature, 8)}`
        : outcome.status === 'denied'
          ? 'Denied'
          : `Failed: ${outcome.reason ?? 'unknown reason'}`
    const suffix = outcome.reported ? '' : ' (could not tell the relay)'
    setHistory((previous) => [line + suffix, ...previous].slice(0, 5))
  }

  async function approve(item: Item) {
    const relay = relayRef.current
    if (!relay || !address) return
    setItems((previous) =>
      previous.map((other) => (other.request.id === item.request.id ? { ...other, phase: 'working' } : other)),
    )

    const sendOnce: SignAndSend = async (transaction, minContextSlot) => {
      if (!walletSends) {
        const signed = await signTransaction(transaction)
        return chain.sendRaw(signed.serialize())
      }
      return signAndSendTransaction(transaction, minContextSlot)
    }
    // A wallet login that has gone stale fails with "authorization request failed".
    // Log in to the wallet again once, then retry.
    const signAndSend: SignAndSend = async (transaction, minContextSlot) => {
      try {
        return await sendOnce(transaction, minContextSlot)
      } catch (error) {
        if (!/authoriz/i.test(String((error as Error)?.message ?? error))) throw error
        await connect()
        return sendOnce(transaction, minContextSlot)
      }
    }

    const outcome = await submitApproval({ request: item.request, walletAddress: address, chain, signAndSend, relay })
    finish(item, outcome)
  }

  async function deny(item: Item) {
    const relay = relayRef.current
    if (!relay) return
    setItems((previous) =>
      previous.map((other) => (other.request.id === item.request.id ? { ...other, phase: 'working' } : other)),
    )
    const outcome = await submitDenial({ request: item.request, relay })
    finish(item, outcome)
  }

  const current = items[0]

  return (
    <View style={appStyles.stack}>
      <Text style={appStyles.title}>Approvals</Text>
      <View style={appStyles.card}>
        <Text>
          Relay <Text style={{ fontWeight: 'bold' }}>{address ? relayStatus : 'not started'}</Text> (
          {ApprovalsConfig.relayUrl})
        </Text>
        {relayStatus === 'replaced' ? (
          <Text>Another phone took over this relay. Reconnect the wallet to take it back.</Text>
        ) : null}
        <Button
          title={walletSends ? 'Sending: wallet sends (tap to switch)' : 'Sending: Nod sends (tap to switch)'}
          onPress={() => setWalletSends((value) => !value)}
        />
        {!address ? <Text>Connect a wallet above to receive approval requests.</Text> : null}
        {address && !current ? <Text>Waiting for an agent to ask...</Text> : null}
      </View>

      {current ? <ApprovalCard item={current} waiting={items.length - 1} onApprove={approve} onDeny={deny} /> : null}

      {history.length > 0 ? (
        <View style={appStyles.card}>
          {history.map((line, index) => (
            <Text key={`${index}-${line}`}>{line}</Text>
          ))}
        </View>
      ) : null}
    </View>
  )
}

function ApprovalCard({
  item,
  waiting,
  onApprove,
  onDeny,
}: {
  item: Item
  waiting: number
  onApprove: (item: Item) => void
  onDeny: (item: Item) => void
}) {
  const { review, phase } = item

  if (!review) {
    return (
      <View style={appStyles.card}>
        <Text>Checking a new request...</Text>
        <ActivityIndicator />
      </View>
    )
  }

  const { request, summary, preview } = review
  const busy = phase === 'working'

  return (
    <View style={[appStyles.card, appStyles.stack]}>
      <Text>
        From agent <Text style={{ fontWeight: 'bold' }}>{request.agent || '(unnamed)'}</Text>
      </Text>
      {request.note ? <Text>Agent says: &quot;{request.note}&quot;</Text> : null}

      <Text style={{ fontSize: 18, fontWeight: 'bold' }}>{review.headline}</Text>
      {preview.ok && preview.feeLamports !== null ? <Text>Network fee: {formatSol(preview.feeLamports)}</Text> : null}

      {summary.transfers.map((transfer, index) => (
        <Text key={`${index}-${transfer.to}`}>
          Sends {formatSol(transfer.lamports)} to {ellipsify(transfer.to, 6)}
        </Text>
      ))}
      <Text>Programs: {summary.programs.map((program) => program.name ?? ellipsify(program.id, 4)).join(', ')}</Text>

      {!preview.ok ? (
        <Text style={{ color: '#b00020' }}>This transaction would fail or could not be checked.</Text>
      ) : null}
      {summary.unknownPrograms.length > 0 ? (
        <Text style={{ color: '#b00020' }}>
          Calls {summary.unknownPrograms.length} program(s) this app does not recognise.
        </Text>
      ) : null}
      {!review.refreshable ? (
        <Text style={{ color: '#b00020' }}>Other signers are involved, so approve soon or it will expire.</Text>
      ) : null}

      {busy ? <ActivityIndicator /> : null}
      <Button title="Approve" disabled={busy} onPress={() => onApprove(item)} />
      <Button title="Deny" color="#b00020" disabled={busy} onPress={() => onDeny(item)} />
      {waiting > 0 ? <Text>{waiting} more waiting</Text> : null}
    </View>
  )
}
