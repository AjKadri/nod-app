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
   * Feasibility Test 2 fallback: if the wallet signs but fails to send, set
   * EXPO_PUBLIC_SIGN_ONLY=1 to have the wallet only sign and the app broadcast.
   */
  static signOnly = process.env.EXPO_PUBLIC_SIGN_ONLY === '1'
}
