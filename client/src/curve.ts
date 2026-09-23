/**
 * Off-chain mirror of `programs/curvex/src/math.rs` and `phases.rs`.
 *
 * Every function here uses BigInt so it reproduces the on-chain integer
 * rounding exactly. `client/tests/parity.test.ts` checks the mirror against
 * real on-chain fills.
 */

import * as C from "./constants.ts";
import { CAUSE_NAMES, PHASE_NAMES, type CurveState } from "./layout.ts";

export interface Segment {
  start: bigint;
  end: bigint;
  base: bigint;
  slope: bigint;
}

export const SEGMENTS: Segment[] = [
  { start: 0n, end: C.P0_END, base: C.B0, slope: C.M0 },
  { start: C.P0_END, end: C.P1_END, base: C.B1, slope: C.M1 },
  { start: C.P1_END, end: C.P2_END, base: C.B2, slope: C.M2 },
];

export function segmentFor(sold: bigint): Segment | null {
  return SEGMENTS.find((s) => sold >= s.start && sold < s.end) ?? null;
}

/** Spot price in price units per whole token. */
export function priceAt(sold: bigint): bigint {
  const seg = segmentFor(sold) ?? SEGMENTS[2];
  const clamped = sold > seg.end - 1n ? seg.end - 1n : sold;
  return seg.base + seg.slope * (clamped - seg.start);
}

/** Spot price in lamports per whole token (floating, for display only). */
export function priceLamports(sold: bigint): number {
  return Number(priceAt(sold)) / Number(C.PRICE_SCALE);
}

export function integral(seg: Segment, from: bigint, to: bigint): bigint {
  const x0 = from - seg.start;
  const x1 = to - seg.start;
  return seg.base * (x1 - x0) + (seg.slope * (x1 + x0) * (x1 - x0)) / 2n;
}

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** Whole tokens buyable inside one segment for `budget` price units. */
export function tokensForBudget(seg: Segment, from: bigint, budget: bigint): bigint {
  const remaining = seg.end - from;
  if (remaining <= 0n || budget <= 0n) return 0n;
  const x0 = from - seg.start;
  const a = seg.base + seg.slope * x0;
  let d = seg.slope === 0n ? budget / a : (isqrt(a * a + 2n * seg.slope * budget) - a) / seg.slope;
  if (d > remaining) d = remaining;
  while (d > 0n && integral(seg, from, from + d) > budget) d -= 1n;
  while (d < remaining && integral(seg, from, from + d + 1n) <= budget) d += 1n;
  return d;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

export function buyCostLamports(seg: Segment, from: bigint, to: bigint): bigint {
  return ceilDiv(integral(seg, from, to), C.PRICE_SCALE);
}

export function sellProceedsLamports(seg: Segment, from: bigint, to: bigint): bigint {
  return integral(seg, to, from) / C.PRICE_SCALE;
}

export function linearDecayBps(elapsed: bigint, window: bigint, maxBps: bigint): bigint {
  if (window === 0n || elapsed >= window) return 0n;
  return (maxBps * (window - elapsed)) / window;
}

export function buyFeeBps(slotsSinceLaunch: bigint): bigint {
  return (
    C.BASE_BUY_FEE_BPS + linearDecayBps(slotsSinceLaunch, C.SNIPE_TAX_SLOTS, C.SNIPE_TAX_MAX_BPS)
  );
}

export function sellFeeBps(tenureSlots: bigint, slotsSinceTransition: bigint): bigint {
  const spread = C.BASE_SELL_FEE_BPS - C.MIN_SELL_FEE_BPS;
  const tenure = C.MIN_SELL_FEE_BPS + linearDecayBps(tenureSlots, C.MATURE_SLOTS, spread);
  const guard = linearDecayBps(
    slotsSinceTransition,
    C.TRANSITION_GUARD_SLOTS,
    C.TRANSITION_GUARD_MAX_BPS,
  );
  const total = tenure + guard;
  return total > C.MAX_SELL_FEE_BPS ? C.MAX_SELL_FEE_BPS : total;
}

export function tenureWeightBps(tenureSlots: bigint): bigint {
  return tenureSlots >= C.MATURE_SLOTS ? 10_000n : (tenureSlots * 10_000n) / C.MATURE_SLOTS;
}

/** Quote a buy exactly as the program will fill it. */
export function quoteBuy(
  state: CurveState,
  slot: bigint,
  maxLamports: bigint,
  positionBalance = 0n,
): { tokens: bigint; cost: bigint; fee: bigint; feeBps: bigint; total: bigint } {
  const seg = segmentFor(state.tokensSold);
  if (!seg) return { tokens: 0n, cost: 0n, fee: 0n, feeBps: 0n, total: 0n };
  const feeBps = buyFeeBps(slot - state.launchSlot);
  const netBudget = (maxLamports * 10_000n) / (10_000n + feeBps);
  let tokens = tokensForBudget(seg, state.tokensSold, netBudget * C.PRICE_SCALE);
  const cap = walletCap(state.phase);
  if (cap !== null) {
    const headroom = cap > positionBalance ? cap - positionBalance : 0n;
    if (tokens > headroom) tokens = headroom;
  }
  let cost = buyCostLamports(seg, state.tokensSold, state.tokensSold + tokens);
  let fee = ceilDiv(cost * feeBps, 10_000n);
  for (let i = 0; i < 4 && cost + fee > maxLamports && tokens > 1n; i++) {
    tokens -= 1n;
    cost = buyCostLamports(seg, state.tokensSold, state.tokensSold + tokens);
    fee = ceilDiv(cost * feeBps, 10_000n);
  }
  return { tokens, cost, fee, feeBps, total: cost + fee };
}

export function walletCap(phase: number): bigint | null {
  if (phase === 0) return C.P0_WALLET_CAP;
  if (phase === 1) return C.P1_WALLET_CAP;
  return null;
}

export function buyCooldownSlots(phase: number): bigint {
  if (phase === 0) return C.P0_BUY_COOLDOWN_SLOTS;
  if (phase === 1) return C.P1_BUY_COOLDOWN_SLOTS;
  return 0n;
}

export interface Progress {
  bps: bigint;
  label: string;
  detail: string;
}

/** Progress toward the next rung, mirroring `phases::progress_bps`. */
export function progress(state: CurveState, slot: bigint): Progress {
  const ratio = (num: bigint, den: bigint) =>
    den === 0n ? 10_000n : (num * 10_000n) / den > 10_000n ? 10_000n : (num * 10_000n) / den;
  const sold = state.tokensSold;
  switch (state.phase) {
    case 0: {
      const supply = ratio(sold, C.P0_END);
      const holders = ratio(state.holderCount, C.P0_HOLDER_TRIGGER);
      const time = ratio(slot - state.launchSlot, C.P0_TIME_TRIGGER_SLOTS);
      const bps = supply > holders ? (supply > time ? supply : time) : holders > time ? holders : time;
      return {
        bps,
        label: "Seeding -> Discovery",
        detail:
          `supply ${fmt(sold)}/${fmt(C.P0_END)} | holders ${state.holderCount}/${C.P0_HOLDER_TRIGGER}` +
          ` | age ${slot - state.launchSlot}/${C.P0_TIME_TRIGGER_SLOTS} slots`,
      };
    }
    case 1: {
      const supply = ratio(sold > C.P0_END ? sold - C.P0_END : 0n, C.P1_END - C.P0_END);
      const volume = ratio(state.volumeLamports, C.P1_VOLUME_TRIGGER_LAMPORTS);
      return {
        bps: supply > volume ? supply : volume,
        label: "Discovery -> Acceleration",
        detail:
          `supply ${fmt(sold)}/${fmt(C.P1_END)} | volume ${sol(state.volumeLamports)}/${sol(C.P1_VOLUME_TRIGGER_LAMPORTS)} SOL` +
          ` | vote ${state.phaseVotePassed ? "PASSED" : "open"}`,
      };
    }
    case 2:
      return {
        bps: ratio(sold > C.P1_END ? sold - C.P1_END : 0n, C.P2_END - C.P1_END),
        label: "Acceleration -> Graduation",
        detail: `supply ${fmt(sold)}/${fmt(C.P2_END)}`,
      };
    case 3:
      return { bps: 10_000n, label: "Graduating", detail: "anyone may call `graduate` now" };
    default:
      return {
        bps: 10_000n,
        label: "Perpetual",
        detail: `flywheel cranks ${state.flywheelCranks} | burned ${fmt(state.totalBurned)}`,
      };
  }
}

export const phaseName = (p: number) => PHASE_NAMES[p] ?? `#${p}`;
export const causeName = (c: number) => CAUSE_NAMES[c] ?? `#${c}`;

export function fmt(n: bigint): string {
  return n.toLocaleString("en-US");
}

export function sol(lamports: bigint): string {
  return (Number(lamports) / 1e9).toFixed(4);
}
