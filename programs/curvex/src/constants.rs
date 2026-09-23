//! Immutable protocol constants.
//!
//! Every number that governs CurveX lives here and is compiled into the
//! program. There is no admin instruction that can change any of them, which
//! is what makes the phase ladder credibly neutral.

/// SPL mint decimals. All curve math is done in WHOLE tokens; base units are
/// only used when talking to the token program.
pub const TOKEN_DECIMALS: u8 = 6;
/// 10^TOKEN_DECIMALS.
pub const TOKEN_UNIT: u64 = 1_000_000;

/// Whole tokens that can ever be minted by the bonding curve.
pub const CURVE_SUPPLY: u64 = 800_000_000;
/// Whole tokens minted once, at graduation, into the permanently locked pool.
pub const LP_SUPPLY: u64 = 200_000_000;

/// Fixed-point scale for prices. A price of `1 * PRICE_SCALE` == 1 lamport per
/// whole token, so we keep 9 decimal digits of sub-lamport precision.
pub const PRICE_SCALE: u128 = 1_000_000_000;

// ---------------------------------------------------------------------------
// Phase ladder: piecewise-linear curve segments.
//
//   price(s) = B_p + M_p * (s - START_p)      for s in [START_p, END_p)
//
// Slopes strictly increase, and B_{p+1} is pinned to the exit price of phase p
// so the curve is continuous (no price gap to arbitrage at a transition).
// `test_curve_is_continuous` proves this at build time.
// ---------------------------------------------------------------------------

/// End of Phase 0 (Seeding), in whole tokens sold.
pub const P0_END: u64 = 80_000_000;
/// End of Phase 1 (Discovery).
pub const P1_END: u64 = 300_000_000;
/// End of Phase 2 (Acceleration) == graduation threshold.
pub const P2_END: u64 = 640_000_000;

/// Phase 0 base price, in price units per whole token (10 lamports).
pub const B0: u128 = 10_000_000_000;
/// Phase 0 slope, price units per whole token sold.
pub const M0: u128 = 250;
/// Phase 1 base price (== exit price of phase 0).
pub const B1: u128 = 30_000_000_000;
pub const M1: u128 = 409;
/// Phase 2 base price (== exit price of phase 1).
pub const B2: u128 = 119_980_000_000;
pub const M2: u128 = 823;

// ---------------------------------------------------------------------------
// Fees. All values in basis points (1 bp = 0.01%).
// ---------------------------------------------------------------------------

/// Flat fee on every curve buy.
pub const BASE_BUY_FEE_BPS: u64 = 100;
/// Extra tax applied to the very first buyers, decaying linearly to zero.
/// This is the primary sniper/bot disincentive: it is charged on ENTRY, so a
/// wallet farm pays it N times and cannot recover it by exiting fast.
pub const SNIPE_TAX_MAX_BPS: u64 = 2_000;
/// Slots over which the snipe tax decays to zero (~17 min at 400ms slots).
pub const SNIPE_TAX_SLOTS: u64 = 2_500;

/// Sell fee charged to a position with zero tenure.
pub const BASE_SELL_FEE_BPS: u64 = 800;
/// Sell fee floor, reached once a position is fully matured.
pub const MIN_SELL_FEE_BPS: u64 = 100;
/// Slots of holding time required to reach `MIN_SELL_FEE_BPS` (~24h).
pub const MATURE_SLOTS: u64 = 216_000;

/// Extra sell fee applied immediately after a phase transition, decaying to
/// zero over `TRANSITION_GUARD_SLOTS`. Stops "sell the news" dumps.
pub const TRANSITION_GUARD_MAX_BPS: u64 = 1_500;
pub const TRANSITION_GUARD_SLOTS: u64 = 1_800;

/// Hard ceiling on any sell fee, so the guard can never become a soft freeze.
pub const MAX_SELL_FEE_BPS: u64 = 2_500;

pub const BPS_DENOM: u64 = 10_000;

// ---------------------------------------------------------------------------
// Per-wallet limits (whole tokens). Enforced per Position PDA, so evading them
// costs one rent-exempt account plus one cooldown window per extra wallet.
// ---------------------------------------------------------------------------

pub const P0_WALLET_CAP: u64 = 2_000_000;
pub const P1_WALLET_CAP: u64 = 8_000_000;
pub const P0_BUY_COOLDOWN_SLOTS: u64 = 150;
pub const P1_BUY_COOLDOWN_SLOTS: u64 = 40;

/// Rolling window in which a wallet may sell at most `SELL_WINDOW_BPS` of the
/// balance it held when the window opened.
pub const SELL_WINDOW_SLOTS: u64 = 3_600;
pub const SELL_WINDOW_BPS: u64 = 2_500;

// ---------------------------------------------------------------------------
// Autonomous transition triggers.
// ---------------------------------------------------------------------------

/// Distinct holders that force Phase 0 -> Phase 1 even if supply is untouched.
pub const P0_HOLDER_TRIGGER: u64 = 150;
/// Time backstop for Phase 0, so a quiet launch still progresses (~24h).
pub const P0_TIME_TRIGGER_SLOTS: u64 = 216_000;
/// Cumulative traded volume that forces Phase 1 -> Phase 2 (25 SOL).
pub const P1_VOLUME_TRIGGER_LAMPORTS: u64 = 25_000_000_000;
/// Quorum for the holder vote that can accelerate Phase 1 -> Phase 2, in bps
/// of the tenure-weighted circulating supply.
pub const PHASE_VOTE_QUORUM_BPS: u64 = 2_000;

// ---------------------------------------------------------------------------
// Post-graduation pool + fee flywheel.
// ---------------------------------------------------------------------------

/// Total swap fee on the graduated constant-product pool.
pub const POOL_FEE_BPS: u64 = 100;
/// Portion of `POOL_FEE_BPS` that leaves the pool for the flywheel. The rest
/// stays in the pool and permanently deepens liquidity.
pub const POOL_FEE_TO_FLYWHEEL_BPS: u64 = 50;
/// Swap fee paid by a fully matured holder, rewarding tenure after the DEX.
pub const POOL_FEE_MATURED_BPS: u64 = 50;

/// Minimum slots between flywheel cranks (~1h).
pub const FLYWHEEL_INTERVAL_SLOTS: u64 = 9_000;
/// Default share of flywheel inflow spent on buyback-and-burn.
pub const DEFAULT_BUYBACK_BPS: u64 = 5_000;
/// Hard bounds the holder vote can never move the buyback share outside of.
pub const MIN_BUYBACK_BPS: u64 = 2_000;
pub const MAX_BUYBACK_BPS: u64 = 8_000;

/// Fixed-point scale for the loyalty reward accumulator.
pub const REWARD_INDEX_SCALE: u128 = 1_000_000_000_000;

// ---------------------------------------------------------------------------
// PDA seeds.
// ---------------------------------------------------------------------------

pub const SEED_CURVE: &[u8] = b"curve";
pub const SEED_POSITION: &[u8] = b"position";
pub const SEED_SOL_VAULT: &[u8] = b"sol_vault";
pub const SEED_FEE_VAULT: &[u8] = b"fee_vault";
pub const SEED_POOL_SOL: &[u8] = b"pool_sol";
pub const SEED_POOL_TOKEN: &[u8] = b"pool_token";
pub const SEED_LOYALTY_VAULT: &[u8] = b"loyalty";
pub const SEED_MINT: &[u8] = b"mint";

/// Minimum balance (whole tokens) for a position to count toward
/// `holder_count`. Keeps the holder trigger from being satisfied by dust.
pub const MIN_COUNTED_BALANCE: u64 = 1_000;
