//! # CurveX — a multi-phase bonding curve where graduation is a milestone
//!
//! CurveX runs a token through four rule regimes and then keeps running after
//! the pool graduates. Every transition is triggered by on-chain state
//! (supply, holders, elapsed slots, volume, or a tenure-weighted holder vote).
//! There is no admin instruction, no upgrade-only escape hatch in the program
//! logic, no withdraw path out of the graduated pool, and no privileged key:
//! the `creator` field is recorded for attribution and is never checked.
//!
//! See `README.md` for the phase table and `docs/DESIGN.md` for the write-up.

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod math;
pub mod phases;
pub mod state;

pub use instructions::*;

declare_id!("GRSUR1XnXMaiibEntNUQQyhVWLwDchHBwsY7iYZUuhLC");

#[program]
pub mod curvex {
    use super::*;

    /// Create the mint, the curve and the four program-owned vaults.
    pub fn initialize_curve(ctx: Context<InitializeCurve>) -> Result<()> {
        instructions::initialize::handler(ctx)
    }

    /// Buy along the curve. `max_lamports` is the total the buyer is willing
    /// to spend (fee included); the fill is clipped to the current phase's
    /// segment boundary and to the per-wallet cap, and the unspent remainder
    /// is simply never transferred.
    pub fn buy(ctx: Context<Buy>, max_lamports: u64, min_tokens: u64) -> Result<()> {
        instructions::trade::buy_handler(ctx, max_lamports, min_tokens)
    }

    /// Sell back along the curve. `tokens` is in whole tokens.
    pub fn sell(ctx: Context<Sell>, tokens: u64, min_lamports: u64) -> Result<()> {
        instructions::trade::sell_handler(ctx, tokens, min_lamports)
    }

    /// Permissionless: let time-, holder- and volume-based triggers take
    /// effect when nobody happens to be trading.
    pub fn crank_phase(ctx: Context<CrankPhase>) -> Result<()> {
        instructions::crank::handler(ctx)
    }

    /// Tenure-weighted vote that can accelerate Discovery -> Acceleration.
    pub fn cast_phase_vote(ctx: Context<CastPhaseVote>, approve: bool) -> Result<()> {
        instructions::vote::phase_vote_handler(ctx, approve)
    }

    /// Standing preference for the post-graduation buyback share. The
    /// effective value is a live weight-average, always clamped to
    /// `[MIN_BUYBACK_BPS, MAX_BUYBACK_BPS]`.
    pub fn set_split_preference(ctx: Context<SetSplitPreference>, buyback_bps: u64) -> Result<()> {
        instructions::vote::split_preference_handler(ctx, buyback_bps)
    }

    /// Permissionless migration into the locked constant-product pool. Moves
    /// the entire curve reserve, mints the LP allocation, and revokes the mint
    /// authority so supply is capped forever.
    pub fn graduate(ctx: Context<Graduate>) -> Result<()> {
        instructions::graduate::handler(ctx)
    }

    /// Post-graduation swap against the locked pool.
    pub fn swap(ctx: Context<Swap>, amount_in: u64, min_out: u64, sol_to_token: bool) -> Result<()> {
        instructions::pool::swap_handler(ctx, amount_in, min_out, sol_to_token)
    }

    /// Permissionless: split accumulated fees into buyback-and-burn and the
    /// loyalty reward index. This is the mechanism that keeps working forever.
    pub fn crank_flywheel(ctx: Context<CrankFlywheel>) -> Result<()> {
        instructions::flywheel::crank_handler(ctx)
    }

    /// Claim loyalty rewards, scaled by the position's tenure weight.
    pub fn claim_rewards(ctx: Context<ClaimRewards>) -> Result<()> {
        instructions::flywheel::claim_handler(ctx)
    }
}
