/**
 * Where the phone finds a relay: it does not. Each pairing carries its own relay
 * address and key (see features/pairing). What stays here is how an approved
 * transaction is sent.
 */
export class ApprovalsConfig {
  /**
   * Who broadcasts an approved transaction. Default: Nod (the wallet only signs),
   * because some wallets (the Mock MWA Wallet among them) fail to send on devnet.
   * Set EXPO_PUBLIC_WALLET_SENDS=1 to let the wallet sign and send instead.
   * There is no switch for this on screen.
   */
  static walletSends = process.env.EXPO_PUBLIC_WALLET_SENDS === '1'

  /**
   * Devnet has no real SKR. Set EXPO_PUBLIC_TEST_SKR_MINT to the address of a test token (made with
   * `npm run devnet:skr-test` in the repo root) and Nod shows it as "SKR (test)" on Devnet. It is
   * ignored on Mainnet, where only the official SKR mint is SKR.
   */
  static testSkrMint: string | null = (() => {
    const value = (process.env.EXPO_PUBLIC_TEST_SKR_MINT ?? '').trim()
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) ? value : null
  })()
}
