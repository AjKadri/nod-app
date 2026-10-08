/**
 * Where the phone finds the relay.
 *
 * Spike setup: the relay runs on your laptop on port 8787. Run
 *   adb reverse tcp:8787 tcp:8787
 * so that "localhost" on the phone (or emulator) reaches the laptop.
 *
 * EXPO_PUBLIC_* values are baked into the app at build time and are readable by
 * anyone who has the APK. That is fine for a local spike token, not for a real secret.
 */
export class ApprovalsConfig {
  static relayUrl = process.env.EXPO_PUBLIC_RELAY_URL ?? 'http://localhost:8787'
  static relayToken = process.env.EXPO_PUBLIC_RELAY_TOKEN ?? ''
  /**
   * Who broadcasts an approved transaction. Default: Nod (the wallet only signs),
   * because some wallets (the Mock MWA Wallet among them) fail to send on devnet.
   * Set EXPO_PUBLIC_WALLET_SENDS=1 to let the wallet sign and send instead.
   * There is no switch for this on screen.
   */
  static walletSends = process.env.EXPO_PUBLIC_WALLET_SENDS === '1'
}
