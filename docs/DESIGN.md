# CurveX design write-up

## The thesis

Most bonding curves treat graduation as an ending: the curve fills, liquidity lands on a
DEX, and the program that enforced every rule stops having an opinion. Caps, cooldowns and
fee schedules evaporate at exactly the moment the token becomes liquid enough to be worth
attacking. CurveX treats graduation as the point where the mechanism changes job.

## Why piecewise-linear, and why the price pointer never jumps

Each phase owns one linear segment, `p(s) = B + M·(s − start)`, with strictly increasing
slopes. Linear segments integrate exactly in `u128`, which matters more than elegance: a
curve whose rounding is unspecified can be farmed by round-trips that net out in the
trader's favour. CurveX rounds buys **up** and sells **down**, and
`instant_round_trip_is_never_profitable` asserts it. Each segment's base is pinned to the
previous segment's exit price, so the curve is continuous and a transition is not itself
an arbitrage.

The subtle decision is that **phase and price are decoupled**. Price is a pure function of
`tokens_sold`; the phase is a monotonic label that gates the *rules*. When a non-supply
trigger fires — 150 distinct holders, or 216,000 elapsed slots — the ladder advances the
rule regime without moving the price pointer. Moving the pointer without moving lamports
would let the next seller withdraw against a reserve that was never funded at that price:
an instantly insolvent vault. The invariant `phase ≥ segment_for(tokens_sold)` keeps the
ladder monotonic and the reserve exactly solvent at the same time. So a launch that proves
organic distribution escapes the anti-bot regime early and gets 4× wider caps and a
shorter cooldown — it does not get a free repricing.

## Bots and wallet farms

Three costs stack, and all of them are paid on entry.

The **snipe tax** starts at 2,000 bps and decays to zero over 2,500 slots. It is charged
on the buy, so a farm cannot recover it by exiting fast; it is pure transfer from the
earliest buyers to the fee vault, which later funds buybacks and rewards. The **per-wallet
cap** (2,000,000 tokens in Seeding) forces a farm across wallets, and each extra wallet
costs a rent-exempt `Position` PDA plus a token account — ~0.004 SOL, never recovered. The
**cooldown** (150 slots) stops one wallet re-entering repeatedly.

Take the worst case: farming the holder trigger. Reaching 150 counted holders (each needs
≥1,000 tokens, so dust does not count) costs ~0.6 SOL in rent, and the prize is a flip that
does not move the price. Unprofitable by construction, not by parameter tuning.

One more lever: a buy is **clipped to the segment boundary**, so no single whale
transaction can vault through a phase and neutralise the guards on the other side.

## Sell-offs and the transition guard

The classic failure of milestone curves is the "sell the news" dump the moment a phase
flips. CurveX adds **+1,500 bps** to the sell fee after every transition, decaying to zero
over 1,800 slots, and caps any sell fee at 2,500 bps so the guard can never become a soft
freeze. A **rolling throttle** also limits a wallet to 25% of the balance it held when its
3,600-slot window opened. The point is not to trap sellers but to make the first twelve
minutes after a flip expensive enough that a dump spreads out instead of being one
candle.

## Rewarding tenure instead of speed

Each `Position` PDA carries a balance-weighted average acquisition slot. Tenure decays the
sell fee from 800 bps to 100 bps over 216,000 slots (~24 h), scales the loyalty reward, and
*is* the governance weight. Freshly bought tokens carry almost no voting power: you cannot
buy governance, only age into it, and ageing means carrying price risk. Tenure is also not
transferable — only curve-acquired tokens count toward a position, and tokens received
peer-to-peer cannot be sold through `sell` at all.

## After the DEX

`graduate` is permissionless — the creator can neither front-run nor stall it. It moves
the entire reserve into a pool vault, mints the 200,000,000-token LP allocation once, and
**revokes the mint authority**, freezing supply at 840,000,000. The LP is never tokenised:
there are no LP tokens to hold or withdraw, and no instruction moves value out of the pool
vaults to an arbitrary destination. Un-ruggable is structural here, not a promise.

Then the **fee flywheel** runs indefinitely. Every fee the protocol ever charged, plus half
of each post-graduation swap fee, accumulates in the fee vault; the other half stays in the
pool and permanently deepens liquidity. Any wallet may crank once per 9,000 slots: half the
inflow (holder-adjustable between 20% and 80%, clamped in code) buys tokens out of the pool
and burns them — depth rises while supply falls — and the remainder funds a loyalty index
that only tenured positions can fully claim. The unclaimed remainder rolls into the next
crank, so impatient holders subsidise patient ones rather than the protocol. Matured
holders also keep a permanent 50 bps swap discount. That is what "graduation is a
milestone" means concretely: the curve stops, the flywheel starts, and it has no end
condition.

## Failure modes and known limitations

If nobody cranks, time triggers stall — mitigated by running the ladder at the top of every
buy and sell. If the pool is thin a buyback rounds to zero tokens; the crank detects that
and routes the inflow to loyalty instead.

Two honest limitations. The graduated pool is an **internal** constant-product pool rather
than a Raydium or Orca CPI — a deliberate trade that keeps graduation, swaps and buybacks
testable end to end on devnet and keeps the "no withdraw path" claim verifiable by reading
one program. In production the same instruction would CPI into a real AMM and burn the LP
position. And the loyalty index is scaled by tenure at claim time rather than continuously,
an approximation that slightly favours holders who claim late — the direction we want it to
err.
