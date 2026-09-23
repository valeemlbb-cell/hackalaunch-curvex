# CurveX — a bonding curve where graduation is a milestone, not the finish line

> **Devnet only.** Nothing in this repository touches mainnet. The default RPC is
> `https://api.devnet.solana.com`, the test suite runs a throwaway local
> `solana-test-validator`, and there are no keys, seed phrases or API tokens
> anywhere in the tree (see [`.env.example`](.env.example)).

CurveX is a Solana program that runs a token through **four rule regimes** and then
**keeps running forever** once the pool has graduated. Every transition is triggered by
on-chain state — tokens sold, distinct holders, elapsed slots, traded volume, or a
tenure-weighted holder vote. There is no admin instruction, no privileged key, and no
path that withdraws the graduated liquidity.

| | |
|---|---|
| Program ID | `GRSUR1XnXMaiibEntNUQQyhVWLwDchHBwsY7iYZUuhLC` |
| Network | Solana **devnet** (and a local validator for the test suite) |
| Framework | Anchor 0.31 (`anchor-lang` / `anchor-spl` as libraries) |
| Token | SPL Token, 6 decimals, mint authority **revoked at graduation** |
| Licence | [MIT](LICENSE) |
| Design write-up | [`docs/DESIGN.md`](docs/DESIGN.md) (≈900 words) |
| Demo video | *(link added on upload — see [SUBMISSION.md](SUBMISSION.md))* |

---

## The phase table

Price is a **piecewise-linear** function of tokens sold, `p(s)`, in lamports per whole
token. Each phase owns one segment. Segment bases are pinned to the previous segment's
exit price, so the curve is **continuous** — there is no price gap to arbitrage at a
transition (`math.rs::test_curve_is_continuous` proves it).

| Phase | Tokens sold | Curve `p(s)` lamports/token | Wallet cap | Buy cooldown | Buy fee | Sell fee | Advances when |
|---|---|---|---|---|---|---|---|
| **0 Seeding** | 0 – 80,000,000 | `10 + 2.5e-7 · s` | 2,000,000 tokens | 150 slots | 100 bps **+ snipe tax up to 2000 bps**, decaying to 0 over 2500 slots | 800 → 100 bps over 216,000 slots of tenure | `sold ≥ 80,000,000` **OR** `holders ≥ 150` **OR** `age ≥ 216,000 slots` |
| **1 Discovery** | 80,000,000 – 300,000,000 | `30 + 4.09e-7 · (s − 80,000,000)` | 8,000,000 tokens | 40 slots | 100 bps | same tenure schedule **+ transition guard** | `sold ≥ 300,000,000` **OR** `volume ≥ 25 SOL` **OR** tenure-weighted holder vote passes |
| **2 Acceleration** | 300,000,000 – 640,000,000 | `119.98 + 8.23e-7 · (s − 300,000,000)` | none | none | 100 bps | same tenure schedule **+ transition guard** | `sold ≥ 640,000,000` (graduation threshold) |
| **3 Graduating** | 640,000,000 | frozen | n/a | n/a | curve closed | curve closed | **anyone** calls `graduate` (permissionless) |
| **4 Perpetual** | supply capped at 840,000,000 | constant product `x·y = k` | none | none | 100 bps (**50 bps** for a matured holder) | 100 bps (**50 bps** matured) | terminal — the fee flywheel runs forever |

Exact constants live in [`programs/curvex/src/constants.rs`](programs/curvex/src/constants.rs)
and are compiled into the program. `scripts/gen-constants.mjs` regenerates the TypeScript
copy from that file, so the CLI can never drift from the deployed code.

At graduation the curve has raised **≈106 SOL** and sold 640,000,000 tokens; 200,000,000
more are minted once into the locked pool. `math.rs::full_curve_raise_is_in_range` pins
that figure.

### Other limits

| Limit | Value | Where |
|---|---|---|
| Sell throttle | 25% of the wallet's balance per rolling 3,600-slot window | `trade.rs` |
| Transition guard | +1,500 bps sell fee immediately after a flip, decaying to 0 over 1,800 slots | `math.rs::sell_fee_bps` |
| Sell-fee ceiling | 2,500 bps — the guard can never become a soft freeze | `constants.rs::MAX_SELL_FEE_BPS` |
| Holder counting floor | 1,000 tokens; dust positions do not count toward the holder trigger | `constants.rs::MIN_COUNTED_BALANCE` |
| Vote quorum | 20% of circulating balance, measured in **tenure-weighted** votes | `vote.rs` |
| Flywheel interval | 9,000 slots (~1 h) between permissionless cranks | `flywheel.rs` |
| Buyback share | 50% by default, holder-adjustable **only within 20–80%** | `state.rs::Curve::buyback_bps` |

---

## What happens after graduation

Graduation is one permissionless instruction that anybody can crank:

1. the **entire** curve reserve moves into a program-owned pool vault;
2. 200,000,000 tokens are minted once into the pool's token vault;
3. the **mint authority is set to `None`** — supply is frozen forever;
4. the phase becomes `Perpetual`.

The LP is **never tokenised**. There are no LP tokens to hold, sell or withdraw, and no
instruction in the program moves value out of the pool vaults to an arbitrary
destination. The ten instructions are `initialize_curve`, `buy`, `sell`, `crank_phase`,
`cast_phase_vote`, `set_split_preference`, `graduate`, `swap`, `crank_flywheel`,
`claim_rewards` — that is the whole surface.

Then the **fee flywheel** starts, and it has no end condition. Every fee the protocol has
ever charged, plus half of every post-graduation swap fee, accumulates in `fee_vault`.
Once per interval any wallet may crank it:

- `buyback_bps` of the inflow buys tokens out of the pool and **burns** them — the pool
  keeps the SOL, so depth rises while supply falls;
- the rest funds a **loyalty index** that only tenured positions can fully claim; the
  un-claimed remainder rolls into the next crank, so impatient holders subsidise patient
  ones rather than the protocol.

---

## Quickstart

### Build the program

The Anchor CLI is **not** required. The program is built with the Solana platform
toolchain directly:

```bash
# 1. Program keypair (kept OUT of this repo — see .gitignore)
solana-keygen new -o ~/.config/solana/curvex-program.json
# 2. Point declare_id!/PROGRAM_ID at it
node scripts/set-program-id.mjs "$(solana-keygen pubkey ~/.config/solana/curvex-program.json)"
# 3. Build
cargo-build-sbf --manifest-path programs/curvex/Cargo.toml --sbf-out-dir target/deploy
```

If `cargo-build-sbf` cannot install its platform tools (common on Windows, where it needs
symlink privileges), drive the toolchain directly — this is what produced the artifact in
this repo:

```bash
SDK="$HOME/.local/share/solana/install/active_release/bin/sdk/sbf/dependencies/platform-tools"
RUSTC="$SDK/rust/bin/rustc" CARGO_TARGET_DIR=target/sbf \
  "$SDK/rust/bin/cargo" build --release \
  --target sbpf-solana-solana \
  --manifest-path programs/curvex/Cargo.toml
# -> target/sbf/sbpf-solana-solana/release/curvex.so  (~511 KB)
```

### Test

```bash
cargo test -p curvex --lib     # 28 unit tests: curve math + the phase ladder
npm install
npm test                       # integration suite on a local validator
```

`npm test` boots `solana-test-validator` with `curvex.so` loaded at genesis and an
upgrade authority of `none` — the suite runs against an **immutable** deploy, exactly like
the devnet target. `--ticks-per-slot 2` shortens a slot to ~12 ms so slot-measured
behaviour (cooldowns, the transition guard, the flywheel interval) runs in seconds.
Override ports with `CURVEX_RPC_PORT` if 8899 is busy.

### Deploy to devnet

```bash
export CURVEX_RPC_URL=https://api.devnet.solana.com
solana airdrop 5                                      # needs ~4 SOL of rent
solana program deploy target/deploy/curvex.so \
  --program-id ~/.config/solana/curvex-program.json \
  --url devnet --final                                 # --final = non-upgradeable
```

### Use the CLI

```bash
node client/src/cli.ts table                    # the phase table, from the constants
node client/src/cli.ts launch                   # create a mint + curve, prints the mint
node client/src/cli.ts status   --mint <MINT>   # phase, progress bar, what changes next
node client/src/cli.ts watch    --mint <MINT>   # same, refreshing
node client/src/cli.ts quote    --mint <MINT> --sol 1
node client/src/cli.ts buy      --mint <MINT> --sol 1
node client/src/cli.ts sell     --mint <MINT> --tokens 100000
node client/src/cli.ts crank    --mint <MINT>   # permissionless phase advance
node client/src/cli.ts graduate --mint <MINT>   # permissionless migration
node client/src/cli.ts swap     --mint <MINT> --sol 0.5
node client/src/cli.ts flywheel --mint <MINT>   # permissionless buyback + burn
node client/src/cli.ts claim    --mint <MINT>
node client/src/cli.ts status   --mint <MINT> --json
```

`status` prints the current phase, a progress bar toward the next one, the dominant
trigger, and a one-line summary of exactly what changes when it fires.

---

## Tests

**28 Rust unit tests** (`cargo test -p curvex --lib`) cover the parts that must be right
before anything touches a chain:

- `isqrt` is an exact integer floor square root across the full `u128` range;
- the curve is continuous at both phase boundaries and slopes strictly increase;
- price is monotonic and the integral is additive;
- `tokens_for_budget` never overspends and never leaves a whole token on the table;
- **an instant buy → sell round trip is never profitable** (buy rounds up, sell rounds
  down) — the single most important economic invariant;
- the snipe tax decays to the base fee; the tenure schedule and transition guard behave
  at both ends and respect the ceiling;
- the constant-product invariant never decreases and the pool cannot be drained;
- every ladder trigger fires (supply, holders, time, volume, vote), transitions are
  one-way, a single crank can climb several rungs, and `progress_bps` is monotonic.

**Integration tests** (`npm test`) run the *compiled* `curvex.so` on a local validator:

| File | What it proves |
|---|---|
| `01-launch-and-curve` | launch state, minted amount equals the exact integral, reserve funded from the integral, fees routed to the flywheel vault, off-chain quote matches the on-chain fill, round trip loses, vault stays solvent |
| `02-guards` | per-wallet cap binds exactly, cooldown rejects a fast second buy, capped wallet stays capped, sell throttle rejects a dump, position cannot sell tokens it did not buy, an older position pays a smaller sell fee, votes need tenure and the right phase |
| `03-graduation-and-flywheel` | drives ~70 wallets through the real caps to 640,000,000 sold, asserts every automatic transition and its recorded cause, permissionless graduation, mint authority revoked, supply frozen at 840,000,000, pool trades with `k` never decreasing, flywheel burns supply and advances the loyalty index, the interval is enforced |

`SIM_NOTES.md` records the last full run, including what is proven by unit test rather
than on chain (the 216,000-slot maturity and time-backstop windows are ~43 minutes of
wall clock even at 12 ms slots, so they are covered by the Rust tests).

---

## Repository layout

```
programs/curvex/src/
  constants.rs        every tunable, compiled in; no admin can change any of them
  math.rs             exact u128 curve integral, inverse, fee schedules  (+ unit tests)
  phases.rs           the autonomous ladder and progress reporting       (+ unit tests)
  state.rs            Curve / Position / Vault accounts and events
  errors.rs
  instructions/
    initialize.rs  trade.rs  crank.rs  vote.rs  graduate.rs  pool.rs  flywheel.rs
    common.rs         sync_phase() — runs the ladder before every state change
client/src/
  constants.ts        GENERATED from constants.rs
  layout.ts           Anchor wire format (discriminators + borsh decoders)
  curvex.ts           PDAs, instruction builders, account reads
  curve.ts            off-chain mirror of the on-chain math, in BigInt
  phase-table.ts      the phase table, derived from the constants
  cli.ts              phase / progress / trade CLI
client/tests/         integration suite
scripts/              constant generator, program-id setter, test runner
docs/DESIGN.md        the design write-up
```

---

## Disclosures

**Pre-hackathon work.** Every line of the CurveX program, client, CLI and test suite in
this repository was written during the hackathon window. No code was carried over from an
earlier project. The authors have previously built bonding-curve launchpads on other
chains, and that *experience* informed the design — in particular the decision to make
the reserve accounting exact and the rounding asymmetric — but no source was reused, and
the phase ladder, the flywheel and the tenure model are new here.

**AI agent usage.** This entry was built with heavy AI assistance: an agent wrote the
program, the client and the tests, ran the builds and the test suite, and drafted this
documentation. A human set the direction, reviewed the mechanism design, and performed
every action that touches an account or a key (repository creation, deployment,
submission). The hackathon rules permit any language or AI framework; this note is here
so nobody has to guess.

**Third-party code.** Two npm dependencies, both official Solana packages
(`@solana/web3.js`, `@solana/spl-token`). Two Rust dependencies, `anchor-lang` and
`anchor-spl`. No vendored code, no assets, no fonts.

**Honest limitations.** See the "Known limitations" section of
[`docs/DESIGN.md`](docs/DESIGN.md) — the graduated pool is an internal constant-product
pool rather than a Raydium/Orca CPI, and that choice is argued rather than hidden.
