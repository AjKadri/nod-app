# Phone app (feasibility spike)

This is the official Solana Mobile `web3js-expo-minimal` template (MIT, from
github.com/solana-foundation/templates) plus one feature: `features/approvals/`.

See the README one folder up for how to run it.

- `features/approvals/approvals-feature-index.tsx`: the approval screen.
- `features/approvals/lib/`: approval logic, copied from `../shared` by `npm run sync`
  in the parent folder. Edit it in `../shared`, not here.
- `constants/approvals-config.ts`: where the phone finds the relay.
