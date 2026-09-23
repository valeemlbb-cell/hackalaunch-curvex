# Submission fields — curvex

Paste-ready text for the HackaLaunch form. Replace `<VIDEO_URL>` once the demo
is posted (X or YouTube — the form needs a public **link**, not a file).

---

## 1. Title (80 char max)

```
CurveX — a bonding curve where graduation is a milestone, not the finish line
```

(77 characters.)

## 2. Public GitHub repository

```
https://github.com/valeemlbb-cell/hackalaunch-curvex
```

## 3. Video demo (public link)

```
<VIDEO_URL>
```

Local files: `demo.mp4` (1080p, 121s) and `demo_x.mp4` (3.4 MB, fits X's
140-second / upload limits). Both are gitignored — upload, do not commit.

## 4. Solana payout address

```
7W31iaCmjerN1jkpEnmZevn74SZxv83yEQvLsnc4PS7Q
```

## 5. Description

**CurveX is a multi-phase bonding curve for Solana where the curve advances
itself, and graduation is a milestone rather than the finish line.**

### What it does

Most launchpad curves are one price segment and one event: fill the curve, dump
into a DEX, and whatever held holders together evaporates exactly when the token
needs it. CurveX replaces that with a four-phase ladder plus a terminal phase
that keeps running forever.

Each phase is its own price segment with its own wallet cap, buy cooldown and
fee schedule, and the phases advance on **on-chain state alone**:

| Transition | Fires on |
|---|---|
| Seeding to Discovery | 80M sold, **or** 150 holders, **or** 216,000 slots |
| Discovery to Acceleration | 300M sold, **or** 25 SOL volume, **or** a tenure-weighted holder vote at 20% quorum |
| Acceleration to Graduating | 640M sold (the graduation threshold) |
| Graduating to Perpetual | anyone calls `graduate` — permissionless |

There is **no admin instruction**. Nothing can set the phase, nothing can
withdraw the reserve, and every constant is compiled in. `creator` is recorded
once and never checked again. At graduation the reserve moves into a permanently
locked constant-product pool, 200M tokens are minted into it, and the mint
authority is revoked — after that the supply is fixed and no privileged key
exists anywhere in the system.

### How it works

- **Price.** Three piecewise-linear segments, `p(s) = B + M*(s - start)`, slopes
  strictly increasing, each segment's base pinned to the previous segment's exit
  price so there is no gap to arbitrage at a transition. A test proves continuity.
- **The phase pointer never jumps the price.** The segment is a pure function of
  `tokens_sold`, not of `phase`. Holder, time and volume triggers relax the
  *rules* ahead of the curve but never move the pointer — jumping it without
  moving lamports would let the next seller withdraw against a reserve that was
  never funded at that price.
- **Anti-sniper.** A 20% entry tax decaying to zero over 2,500 slots, charged on
  entry, so a wallet farm pays it once per wallet and cannot escape it by exiting
  fast. Phase 0 caps a wallet at 2M behind a 150-slot cooldown; Phase 1 widens to
  8M at 40 slots; Phase 2 lifts both.
- **Anti-dump.** Sell fees run 800 to 100 bps over 216,000 slots of tenure, plus
  a transition guard adding up to 1,500 bps right after a phase change. A rolling
  window allows at most 25% of the balance held when the window opened. Every
  sell fee is hard-capped at 2,500 bps so the guard can never become a freeze.
- **After graduation.** The locked pool charges 100 bps, half of which feeds a
  flywheel anyone may crank once per ~9,000 slots: buyback-and-burn plus a
  loyalty payout indexed by tenure. Holders vote the buyback share within hard
  bounds of 20-80%. Matured holders swap at 50 bps instead of 100.

### What is real vs mocked

**Nothing is mocked.** The program, the curve integral, the phase machine, the
locked pool, the flywheel and the loyalty accounting are all real and on chain.

- **61 tests, all green** — 28 Rust unit tests (curve math, fee schedules, the
  phase ladder) and 33 integration tests against a local validator running the
  built `curvex.so` with **upgrade authority `none`**, an immutable deploy. The
  suite walks ~70 wallets through the real caps and cooldowns, which is the only
  way to actually reach 640M tokens.
- **Every frame of the demo is captured stdout**, not a slide. That run launched
  a token, walked all four phases, graduated, swapped against the locked pool and
  cranked the flywheel once — burning 15,714,691 tokens and paying 9.35 SOL to
  tenured holders, ending with 69 holders and a 116.8 SOL pool.
- **Devnet only.** Default RPC is `https://api.devnet.solana.com`; there is no
  mainnet code path and no paid RPC key in the repo.
- **No keys committed.** `.gitignore` blocks `*keypair*.json`, every local ledger
  directory and `.env`. The program keypair lives outside the repo.
- **Not audited**, and the economics are opinionated by design — `docs/DESIGN.md`
  argues for each constant instead of pretending the numbers are neutral.

MIT licensed. Built entirely during the hackathon window; the only pre-existing
dependencies are `@solana/web3.js` and `@solana/spl-token`.
