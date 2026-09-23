# Simulation notes — what was actually run, and what was not

This file exists so a reviewer does not have to take the README's word for it.
Every number below comes from a run on this machine, not from an estimate.

## Environment

| | |
|---|---|
| OS | Windows 11 Pro (26200) |
| Node | v24.19.0 |
| Solana CLI | 2.1.5 (`solana-test-validator`) |
| Program build | rustup toolchain `1.89.0-sbpf-solana-v1.54`, target `sbpf-solana-solana` |
| Artifact | `target/sbf/sbpf-solana-solana/release/curvex.so`, 523,360 bytes |
| Program ID | `GRSUR1XnXMaiibEntNUQQyhVWLwDchHBwsY7iYZUuhLC` |
| Deploy mode | `--upgradeable-program <ID> <so> none` — **no upgrade authority** |
| Slot length | `--ticks-per-slot 2`, ~12 ms/slot (~30 slots/s measured) |

The build is reproducible: building a second time into a separate
`CARGO_TARGET_DIR` produced a byte-identical `.so`.

## Unit tests — `cargo test -p curvex --lib`

```
test result: ok. 28 passed; 0 failed; 0 ignored; finished in 0.00s
```

## Integration tests — `npm test`

```
ℹ tests 33
ℹ suites 3
ℹ pass 33
ℹ fail 0
ℹ duration_ms 382962.4131
```

| Suite | Wall clock |
|---|---|
| `01-launch-and-curve` | 81.1 s |
| `02-guards` | 136.0 s |
| `03-graduation-and-flywheel` | 299.3 s |
| total (concurrency 2) | 383.0 s |

Most of that time is the suite genuinely waiting out slot-measured behaviour —
the 2,500-slot snipe-tax decay and the 9,000-slot flywheel interval are real
waits against a real clock, not mocked.

## One full lifecycle, end to end

`node scripts/record-demo.mjs` drives a single token through every phase and
captures the real CLI output at each step (those captures are what the demo
video renders). The run behind the current `demo.mp4`:

| | |
|---|---|
| mint | `ACyohJ6uJwDBWUMqYpxTbvftzvVKnuJc2DaDHABvJop3` |
| final phase | 4 — Perpetual |
| tokens sold | 640,000,000 / 640,000,000 (fill clipped exactly at the threshold) |
| holders | 69 |
| lifetime volume | 126.1537 SOL |
| curve reserve at graduation | 106.4604 SOL, moved to the pool in full |
| pool after first swap | 116.8046 SOL / 182,442,599 tokens |
| mint authority | revoked (`SetAuthority(MintTokens -> None)`) |
| flywheel cranks | 1 — burned 15,714,691 tokens, 9.3492 SOL buyback, 9.3492 SOL loyalty |

Every automatic transition in that run fired on chain state with no privileged
call: Seeding → Discovery and Discovery → Acceleration on the supply target,
Acceleration → Graduating on the graduation threshold, and Graduating →
Perpetual via `graduate` called by a wallet that had never traded.

## What is proven by unit test rather than on chain

Two windows are too long to sit through on a local validator, even at 12 ms
slots, so they are covered by Rust unit tests over the same pure functions the
program calls:

| Behaviour | Window | Wall clock at 12 ms/slot | Covered by |
|---|---|---|---|
| Sell fee reaching its 100 bps floor | `MATURE_SLOTS` = 216,000 | ~2 h | `math::tests::sell_fee_rewards_tenure_and_guards_transitions` |
| Phase 0 time backstop | `P0_TIME_TRIGGER_SLOTS` = 216,000 | ~2 h | `phases::tests::time_backstop_rescues_a_dead_launch` |

The integration suite still exercises both schedules at shorter tenures — it
asserts that an older position pays a strictly smaller sell fee than a fresh
one, and that the off-chain mirror in `client/src/curve.ts` matches the
on-chain fee at both ends of the schedule. What is *not* observed on chain is
the exact value at full maturity.

Everything else in the README is asserted against the running program.

## Known limitations

- **Devnet / local only.** The program has not been deployed to mainnet and has
  not been audited.
- **The pool is a minimal constant-product AMM**, not a Raydium or Orca
  integration. It is deliberately self-contained so graduation cannot depend on
  an external program's upgrade authority.
- **No front end.** The phase, the progress bar and every trade run through the
  CLI (`client/src/cli.ts`).
