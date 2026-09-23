//! Tenure-weighted holder governance.
//!
//! Vote weight is `balance * tenure_weight_bps / 10_000`, so tokens bought one
//! slot ago carry ~zero weight. That is the anti-flash-farm design: you cannot
//! buy governance power, you can only age into it, and ageing into it means
//! carrying price risk for ~24h of slots.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::CurveXError;
use crate::instructions::common::sync_phase;
use crate::state::{Curve, Phase, Position};

#[derive(Accounts)]
pub struct CastPhaseVote<'info> {
    pub voter: Signer<'info>,

    #[account(mut, seeds = [SEED_CURVE, curve.mint.as_ref()], bump = curve.bump)]
    pub curve: Account<'info, Curve>,

    #[account(
        mut,
        seeds = [SEED_POSITION, curve.key().as_ref(), voter.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == voter.key() @ CurveXError::NoVoteWeight,
    )]
    pub position: Account<'info, Position>,
}

pub fn phase_vote_handler(ctx: Context<CastPhaseVote>, approve: bool) -> Result<()> {
    let now = Clock::get()?.slot;
    let curve_key = ctx.accounts.curve.key();
    sync_phase(&mut ctx.accounts.curve, curve_key, now)?;

    let curve = &mut ctx.accounts.curve;
    let position = &mut ctx.accounts.position;

    require!(curve.phase == Phase::Discovery, CurveXError::WrongPhase);
    require!(!position.voted_phase, CurveXError::AlreadyVoted);

    let weight = position.weight(now);
    require!(weight > 0, CurveXError::NoVoteWeight);

    if approve {
        curve.phase_vote_yes += weight;
    } else {
        curve.phase_vote_no += weight;
    }
    position.voted_phase = true;

    // Quorum is measured against raw circulating balance, which is always >=
    // the tenure-weighted total. A quorum is therefore strictly harder to
    // reach than it looks, never easier.
    let quorum = (curve.total_position_balance as u128 * PHASE_VOTE_QUORUM_BPS as u128)
        / BPS_DENOM as u128;
    if curve.phase_vote_yes >= quorum && curve.phase_vote_yes > curve.phase_vote_no {
        curve.phase_vote_passed = true;
    }

    msg!(
        "curvex: phase vote yes={} no={} quorum={} passed={}",
        curve.phase_vote_yes,
        curve.phase_vote_no,
        quorum,
        curve.phase_vote_passed
    );

    sync_phase(&mut ctx.accounts.curve, curve_key, now)?;
    Ok(())
}

#[derive(Accounts)]
pub struct SetSplitPreference<'info> {
    pub voter: Signer<'info>,

    #[account(mut, seeds = [SEED_CURVE, curve.mint.as_ref()], bump = curve.bump)]
    pub curve: Account<'info, Curve>,

    #[account(
        mut,
        seeds = [SEED_POSITION, curve.key().as_ref(), voter.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == voter.key() @ CurveXError::NoVoteWeight,
    )]
    pub position: Account<'info, Position>,
}

/// A standing preference rather than a timed proposal: the effective buyback
/// share is a live weighted average that any holder can nudge at any time, and
/// it is clamped to `[MIN_BUYBACK_BPS, MAX_BUYBACK_BPS]` in code. There is no
/// window to snipe and no proposal for anyone to schedule.
pub fn split_preference_handler(ctx: Context<SetSplitPreference>, buyback_bps: u64) -> Result<()> {
    let now = Clock::get()?.slot;
    require!(
        (MIN_BUYBACK_BPS..=MAX_BUYBACK_BPS).contains(&buyback_bps),
        CurveXError::SplitOutOfBounds
    );

    let curve = &mut ctx.accounts.curve;
    let position = &mut ctx.accounts.position;

    let weight = position.weight(now);
    require!(weight > 0, CurveXError::NoVoteWeight);

    // Retract the previous contribution before adding the new one.
    if position.split_vote_weight > 0 {
        curve.split_weight_sum = curve
            .split_weight_sum
            .saturating_sub(position.split_vote_weight);
        curve.split_weighted_sum = curve
            .split_weighted_sum
            .saturating_sub(position.split_vote_weight * position.preferred_buyback_bps as u128);
    }

    curve.split_weight_sum += weight;
    curve.split_weighted_sum += weight * buyback_bps as u128;
    position.split_vote_weight = weight;
    position.preferred_buyback_bps = buyback_bps;

    msg!("curvex: effective buyback_bps={}", curve.buyback_bps());
    Ok(())
}
