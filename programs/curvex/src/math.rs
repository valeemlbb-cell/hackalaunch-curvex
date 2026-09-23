//! Exact integer bonding-curve math.
//!
//! Everything here is `u128` fixed point. There is no floating point anywhere
//! in CurveX: a curve whose rounding is not fully specified can be farmed by
//! buy/sell round-trips that net out in the trader's favour, so every rounding
//! decision below is deliberate and always favours the reserve.

use crate::constants::*;

/// Integer square root (Newton), exact floor(sqrt(n)).
pub fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    // Seed with a power of two above sqrt(n) so Newton converges downward.
    let mut x = 1u128 << ((128 - n.leading_zeros()).div_ceil(2));
    loop {
        let next = (x + n / x) / 2;
        if next >= x {
            break;
        }
        x = next;
    }
    x
}

/// Segment of the piecewise-linear curve: `price(x) = base + slope * x`,
/// where `x` is tokens sold *within* this segment.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Segment {
    /// Global token-sold offset at which this segment starts.
    pub start: u64,
    /// Global token-sold offset at which this segment ends (exclusive).
    pub end: u64,
    pub base: u128,
    pub slope: u128,
}

/// The three curve segments, indexed by phase ordinal 0..=2.
pub const SEGMENTS: [Segment; 3] = [
    Segment { start: 0, end: P0_END, base: B0, slope: M0 },
    Segment { start: P0_END, end: P1_END, base: B1, slope: M1 },
    Segment { start: P1_END, end: P2_END, base: B2, slope: M2 },
];

impl Segment {
    /// Spot price at a global sold offset, in price units per whole token.
    pub fn price_at(&self, sold: u64) -> u128 {
        let x = (sold.saturating_sub(self.start)) as u128;
        self.base + self.slope * x
    }

    /// Exact integral of the price curve from `from` to `to`, in price units.
    /// Both bounds must lie inside `[start, end]` and `from <= to`.
    pub fn integral(&self, from: u64, to: u64) -> u128 {
        debug_assert!(from <= to);
        let x0 = (from.saturating_sub(self.start)) as u128;
        let x1 = (to.saturating_sub(self.start)) as u128;
        let linear = self.base * (x1 - x0);
        // slope * (x1^2 - x0^2) / 2, factored to keep the intermediate small.
        let quad = self.slope * (x1 + x0) * (x1 - x0) / 2;
        linear + quad
    }

    /// Largest whole-token amount buyable inside this segment for `budget`
    /// price units, never exceeding the segment's remaining supply.
    ///
    /// Solves `slope/2 * d^2 + (base + slope*x0) * d = budget` for `d`, then
    /// corrects downward so the exact integral never exceeds the budget.
    pub fn tokens_for_budget(&self, from: u64, budget: u128) -> u64 {
        let remaining = self.end.saturating_sub(from);
        if remaining == 0 || budget == 0 {
            return 0;
        }
        let x0 = (from.saturating_sub(self.start)) as u128;
        let a = self.base + self.slope * x0;

        let mut d = if self.slope == 0 {
            budget / a
        } else {
            // d = (-a + sqrt(a^2 + 2*slope*budget)) / slope
            let disc = a * a + 2 * self.slope * budget;
            (isqrt(disc).saturating_sub(a)) / self.slope
        };
        d = d.min(remaining as u128);

        // Integer correction: shave until the exact cost fits the budget, then
        // try to add one back in case the sqrt floored too aggressively.
        while d > 0 && self.integral(from, from + d as u64) > budget {
            d -= 1;
        }
        while d < remaining as u128 && self.integral(from, from + d as u64 + 1) <= budget {
            d += 1;
        }
        d as u64
    }
}

/// Which segment a given sold offset belongs to. Returns `None` once the curve
/// is exhausted at `P2_END`.
pub fn segment_for(sold: u64) -> Option<usize> {
    if sold < P0_END {
        Some(0)
    } else if sold < P1_END {
        Some(1)
    } else if sold < P2_END {
        Some(2)
    } else {
        None
    }
}

/// Cost in lamports to move the curve from `from` to `to`, rounded UP.
/// Both bounds must lie in the same segment.
pub fn buy_cost_lamports(seg: &Segment, from: u64, to: u64) -> u64 {
    let units = seg.integral(from, to);
    units.div_ceil(PRICE_SCALE) as u64
}

/// Proceeds in lamports for moving the curve down from `from` to `to`
/// (`to <= from`), rounded DOWN. Buy rounds up, sell rounds down: an
/// instantaneous round trip is always a strict loss, so there is no
/// zero-risk extraction loop.
pub fn sell_proceeds_lamports(seg: &Segment, from: u64, to: u64) -> u64 {
    let units = seg.integral(to, from);
    (units / PRICE_SCALE) as u64
}

/// Linear decay helper: returns `max_bps` at `elapsed == 0`, 0 at
/// `elapsed >= window`.
pub fn linear_decay_bps(elapsed: u64, window: u64, max_bps: u64) -> u64 {
    if window == 0 || elapsed >= window {
        return 0;
    }
    let remaining = window - elapsed;
    ((max_bps as u128 * remaining as u128) / window as u128) as u64
}

/// Buy-side fee in bps: flat base plus the decaying anti-snipe tax.
pub fn buy_fee_bps(slots_since_launch: u64) -> u64 {
    BASE_BUY_FEE_BPS + linear_decay_bps(slots_since_launch, SNIPE_TAX_SLOTS, SNIPE_TAX_MAX_BPS)
}

/// Sell-side fee in bps: a tenure-decayed base plus the post-transition guard,
/// clamped to `MAX_SELL_FEE_BPS`.
pub fn sell_fee_bps(tenure_slots: u64, slots_since_transition: u64) -> u64 {
    let spread = BASE_SELL_FEE_BPS - MIN_SELL_FEE_BPS;
    let tenure_component =
        MIN_SELL_FEE_BPS + linear_decay_bps(tenure_slots, MATURE_SLOTS, spread);
    let guard = linear_decay_bps(
        slots_since_transition,
        TRANSITION_GUARD_SLOTS,
        TRANSITION_GUARD_MAX_BPS,
    );
    (tenure_component + guard).min(MAX_SELL_FEE_BPS)
}

/// `amount * bps / 10_000`, rounded up so fees are never rounded away.
pub fn fee_of(amount: u64, bps: u64) -> u64 {
    ((amount as u128 * bps as u128).div_ceil(BPS_DENOM as u128)) as u64
}

/// Tenure weight in bps: 0 for a brand-new position, 10_000 once matured.
/// Used for reward accrual and for vote weight, so freshly bought tokens
/// carry almost no governance power.
pub fn tenure_weight_bps(tenure_slots: u64) -> u64 {
    if tenure_slots >= MATURE_SLOTS {
        BPS_DENOM
    } else {
        ((tenure_slots as u128 * BPS_DENOM as u128) / MATURE_SLOTS as u128) as u64
    }
}

/// Constant-product output for the graduated pool, net of `fee_bps`.
pub fn cp_amount_out(reserve_in: u128, reserve_out: u128, amount_in: u128, fee_bps: u64) -> u128 {
    if reserve_in == 0 || reserve_out == 0 || amount_in == 0 {
        return 0;
    }
    let amount_in_net = amount_in * (BPS_DENOM - fee_bps) as u128 / BPS_DENOM as u128;
    // floor, so the invariant k never decreases
    (reserve_out * amount_in_net) / (reserve_in + amount_in_net)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isqrt_is_exact_floor() {
        for n in 0u128..2_000 {
            let r = isqrt(n);
            assert!(r * r <= n, "isqrt({n}) too big");
            assert!((r + 1) * (r + 1) > n, "isqrt({n}) too small");
        }
        for n in [u128::MAX, u128::MAX / 3, 1u128 << 100, (1u128 << 64) - 1] {
            let r = isqrt(n);
            assert!(r <= n / r.max(1) || r * r <= n);
            assert!(r.checked_mul(r).map(|v| v <= n).unwrap_or(false));
        }
    }

    /// The price must not jump at a phase boundary, or the transition itself
    /// becomes a free arbitrage.
    #[test]
    fn test_curve_is_continuous() {
        assert_eq!(SEGMENTS[0].price_at(P0_END - 1) + M0, SEGMENTS[1].base);
        assert_eq!(SEGMENTS[1].price_at(P1_END - 1) + M1, SEGMENTS[2].base);
    }

    #[test]
    fn slopes_strictly_increase() {
        assert!(M0 < M1 && M1 < M2);
    }

    #[test]
    fn price_is_monotonically_increasing() {
        let mut last = 0u128;
        for sold in (0..P2_END).step_by(1_000_003) {
            let seg = &SEGMENTS[segment_for(sold).unwrap()];
            let p = seg.price_at(sold);
            assert!(p >= last, "price dipped at {sold}");
            last = p;
        }
    }

    #[test]
    fn graduation_price_is_within_expected_band() {
        let exit = SEGMENTS[2].price_at(P2_END - 1);
        // ~400 lamports per token at graduation.
        assert!(exit > 399 * PRICE_SCALE && exit < 401 * PRICE_SCALE, "exit={exit}");
    }

    #[test]
    fn full_curve_raise_is_in_range() {
        let total: u128 = SEGMENTS[0].integral(0, P0_END)
            + SEGMENTS[1].integral(P0_END, P1_END)
            + SEGMENTS[2].integral(P1_END, P2_END);
        let sol = total / PRICE_SCALE / 1_000_000_000;
        assert!((100..=115).contains(&sol), "graduation raise = {sol} SOL");
    }

    #[test]
    fn integral_is_additive() {
        let seg = SEGMENTS[1];
        let whole = seg.integral(P0_END, P0_END + 100_000);
        let a = seg.integral(P0_END, P0_END + 40_000);
        let b = seg.integral(P0_END + 40_000, P0_END + 100_000);
        assert_eq!(whole, a + b);
    }

    #[test]
    fn tokens_for_budget_never_overspends() {
        let cases = [
            (0u64, 1_000_000_000u128),
            (0, 10_000_000_000_000_000),
            (P0_END, 5_000_000_000_000_000),
            (P1_END, 50_000_000_000_000_000),
            (P2_END - 10, 900_000_000_000_000_000),
        ];
        for (from, budget) in cases {
            let idx = segment_for(from).unwrap_or(2);
            let seg = SEGMENTS[idx];
            let from = from.max(seg.start);
            let d = seg.tokens_for_budget(from, budget);
            let cost = seg.integral(from, from + d);
            assert!(cost <= budget, "overspent at from={from}");
            if from + d < seg.end {
                let cost_next = seg.integral(from, from + d + 1);
                assert!(cost_next > budget, "left money on the table at from={from}");
            }
        }
    }

    /// The single most important economic invariant: an instant buy->sell
    /// round trip must never return more lamports than it cost.
    #[test]
    fn instant_round_trip_is_never_profitable() {
        for from in [0u64, 1, 40_000_000, P0_END, 150_000_000, P1_END, 500_000_000] {
            let idx = segment_for(from).unwrap();
            let seg = SEGMENTS[idx];
            for amount in [1u64, 7, 1_000, 5_000_000] {
                let to = (from + amount).min(seg.end);
                if to <= from {
                    continue;
                }
                let cost = buy_cost_lamports(&seg, from, to);
                let back = sell_proceeds_lamports(&seg, to, from);
                assert!(back <= cost, "round trip profit at {from}+{amount}: {back} > {cost}");
            }
        }
    }

    #[test]
    fn snipe_tax_decays_to_base() {
        assert_eq!(buy_fee_bps(0), BASE_BUY_FEE_BPS + SNIPE_TAX_MAX_BPS);
        assert!(buy_fee_bps(SNIPE_TAX_SLOTS / 2) < buy_fee_bps(0));
        assert_eq!(buy_fee_bps(SNIPE_TAX_SLOTS), BASE_BUY_FEE_BPS);
        assert_eq!(buy_fee_bps(u64::MAX), BASE_BUY_FEE_BPS);
    }

    #[test]
    fn sell_fee_rewards_tenure_and_guards_transitions() {
        // fresh buyer, long after a transition
        assert_eq!(sell_fee_bps(0, TRANSITION_GUARD_SLOTS), BASE_SELL_FEE_BPS);
        // matured holder, long after a transition
        assert_eq!(sell_fee_bps(MATURE_SLOTS, TRANSITION_GUARD_SLOTS), MIN_SELL_FEE_BPS);
        // tenure always helps
        assert!(sell_fee_bps(MATURE_SLOTS / 2, 0) < sell_fee_bps(0, 0));
        // the guard bites right after a flip and decays away
        assert!(sell_fee_bps(0, 0) > sell_fee_bps(0, TRANSITION_GUARD_SLOTS - 1));
        // and can never freeze the market
        assert!(sell_fee_bps(0, 0) <= MAX_SELL_FEE_BPS);
    }

    #[test]
    fn tenure_weight_is_bounded() {
        assert_eq!(tenure_weight_bps(0), 0);
        assert_eq!(tenure_weight_bps(MATURE_SLOTS), BPS_DENOM);
        assert_eq!(tenure_weight_bps(MATURE_SLOTS * 9), BPS_DENOM);
        assert!(tenure_weight_bps(MATURE_SLOTS / 4) < tenure_weight_bps(MATURE_SLOTS / 2));
    }

    #[test]
    fn cp_invariant_never_decreases() {
        let (mut ri, mut ro) = (120_000_000_000u128, 200_000_000u128);
        let k0 = ri * ro;
        for _ in 0..50 {
            let out = cp_amount_out(ri, ro, 1_000_000_000, POOL_FEE_BPS);
            ri += 1_000_000_000;
            ro -= out;
            assert!(ri * ro >= k0, "k decreased");
        }
    }

    #[test]
    fn cp_output_is_bounded_by_reserves() {
        let out = cp_amount_out(1_000, 500, u64::MAX as u128, POOL_FEE_BPS);
        assert!(out < 500, "pool can be fully drained");
    }

    #[test]
    fn fee_of_rounds_up() {
        assert_eq!(fee_of(1, 1), 1);
        assert_eq!(fee_of(10_000, 100), 100);
        assert_eq!(fee_of(0, 2_500), 0);
    }
}
