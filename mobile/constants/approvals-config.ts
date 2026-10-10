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
}
