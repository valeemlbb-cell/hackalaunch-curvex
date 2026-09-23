//! The perpetual mechanism: what CurveX does *after* the DEX.
//!
//! Every fee the protocol has ever charged — curve buys, curve sells, and half
//! of every post-graduation swap fee — lands in `fee_vault`. Any wallet may
//! crank the flywheel once per `FLYWHEEL_INTERVAL_SLOTS`. The crank:
//!
//! * spends `buyback_bps` of the inflow buying tokens out of the pool and
//!   burning them, permanently shrinking supply against a pool that keeps its
//!   SOL; and
//! * routes the remainder into a loyalty index that only tenured positions can
//!   fully claim.
//!
//! Graduation is therefore a milestone: the curve stops, the flywheel starts,
//! and it has no end condition.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount};

use crate::constants::*;
use crate::errors::CurveXError;
use crate::instructions::common::{move_lamports, vault_spendable};
use crate::math::{cp_amount_out, tenure_weight_bps};
use crate::state::{Curve, FlywheelCranked, Position, Vault};

#[derive(Accounts)]
pub struct CrankFlywheel<'info> {
    pub cranker: Signer<'info>,

    #[account(mut, seeds = [SEED_CURVE, mint.key().as_ref()], bump = curve.bump)]
    pub curve: Account<'info, Curve>,

    #[account(mut, address = curve.mint)]
    pub mint: Account<'info, Mint>,

    #[account(mut, seeds = [SEED_FEE_VAULT, curve.key().as_ref()], bump = curve.fee_vault_bump)]
    pub fee_vault: Account<'info, Vault>,

    #[account(mut, seeds = [SEED_POOL_SOL, curve.key().as_ref()], bump = curve.pool_sol_bump)]
    pub pool_sol_vault: Account<'info, Vault>,

    #[account(mut, seeds = [SEED_POOL_TOKEN, curve.key().as_ref()], bump)]
    pub pool_token_vault: Account<'info, TokenAccount>,

    #[account(mut, seeds = [SEED_LOYALTY_VAULT, curve.key().as_ref()], bump = curve.loyalty_bump)]
    pub loyalty_vault: Account<'info, Vault>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn crank_handler(ctx: Context<CrankFlywheel>) -> Result<()> {
    let now = Clock::get()?.slot;
    let curve_key = ctx.accounts.curve.key();
    let mint_key = ctx.accounts.mint.key();

    require!(ctx.accounts.curve.graduated, CurveXError::NotGraduated);
    require!(
        now.saturating_sub(ctx.accounts.curve.last_flywheel_slot) >= FLYWHEEL_INTERVAL_SLOTS,
        CurveXError::FlywheelTooSoon
    );

    let inflow = vault_spendable(&ctx.accounts.fee_vault.to_account_info())?;
    require!(inflow > 0, CurveXError::NothingToDistribute);

    let buyback_bps = ctx.accounts.curve.buyback_bps();
    let mut buyback = (inflow as u128 * buyback_bps as u128 / BPS_DENOM as u128) as u64;
    let mut loyalty = inflow - buyback;

    // With no staked balance there is nobody to reward, so the whole inflow
    // goes to burning instead of sitting idle.
    if ctx.accounts.curve.total_position_balance == 0 {
        buyback = inflow;
        loyalty = 0;
    }

    // --- buyback and burn ---
    let mut burned = 0u64;
    if buyback > 0 {
        let sol_reserve = ctx.accounts.curve.pool_sol_reserve as u128;
        let token_reserve = ctx.accounts.curve.pool_token_reserve as u128;
        burned = cp_amount_out(sol_reserve, token_reserve, buyback as u128, POOL_FEE_BPS) as u64;

        if burned > 0 {
            move_lamports(
                &ctx.accounts.fee_vault.to_account_info(),
                &ctx.accounts.pool_sol_vault.to_account_info(),
                buyback,
            )?;
            let bump = [ctx.accounts.curve.bump];
            let parts = crate::instructions::common::curve_signer(&mint_key, &bump);
            let seeds: &[&[&[u8]]] = &[&parts];
            token::burn(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Burn {
                        mint: ctx.accounts.mint.to_account_info(),
                        from: ctx.accounts.pool_token_vault.to_account_info(),
                        authority: ctx.accounts.curve.to_account_info(),
                    },
                    seeds,
                ),
                burned
                    .checked_mul(TOKEN_UNIT)
                    .ok_or(CurveXError::MathOverflow)?,
            )?;
            let curve = &mut ctx.accounts.curve;
            curve.pool_sol_reserve += buyback;
            curve.pool_token_reserve -= burned;
            curve.total_burned += burned;
            curve.total_buyback_lamports += buyback;
        } else {
            // Rounding produced no tokens; roll the whole inflow into loyalty.
            loyalty += buyback;
            buyback = 0;
        }
    }

    // --- loyalty index ---
    if loyalty > 0 {
        move_lamports(
            &ctx.accounts.fee_vault.to_account_info(),
            &ctx.accounts.loyalty_vault.to_account_info(),
            loyalty,
        )?;
        let curve = &mut ctx.accounts.curve;
        let stake = curve.total_position_balance as u128;
        if stake > 0 {
            curve.reward_index += (loyalty as u128 * REWARD_INDEX_SCALE) / stake;
        }
        curve.total_loyalty_lamports += loyalty;
    }

    let curve = &mut ctx.accounts.curve;
    curve.last_flywheel_slot = now;
    curve.flywheel_cranks += 1;

    emit!(FlywheelCranked {
        curve: curve_key,
        slot: now,
        inflow_lamports: inflow,
        buyback_lamports: buyback,
        burned_tokens: burned,
        loyalty_lamports: loyalty,
        buyback_bps,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut, seeds = [SEED_CURVE, curve.mint.as_ref()], bump = curve.bump)]
    pub curve: Account<'info, Curve>,

    #[account(
        mut,
        seeds = [SEED_POSITION, curve.key().as_ref(), owner.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == owner.key() @ CurveXError::NoVoteWeight,
    )]
    pub position: Account<'info, Position>,

    #[account(mut, seeds = [SEED_LOYALTY_VAULT, curve.key().as_ref()], bump = curve.loyalty_bump)]
    pub loyalty_vault: Account<'info, Vault>,

    pub system_program: Program<'info, System>,
}

/// Claim accrued loyalty rewards.
///
/// The claim is scaled by the position's tenure weight. The un-scaled
/// remainder is *not* minted to anyone — it simply stays in the loyalty vault
/// and is redistributed by the next crank, so impatient holders subsidise
/// patient ones rather than the protocol.
pub fn claim_handler(ctx: Context<ClaimRewards>) -> Result<()> {
    let now = Clock::get()?.slot;
    let curve = &ctx.accounts.curve;
    let position = &mut ctx.accounts.position;

    let delta = curve
        .reward_index
        .saturating_sub(position.reward_index_snapshot);
    let gross = (delta * position.balance as u128) / REWARD_INDEX_SCALE;
    let weight = tenure_weight_bps(position.tenure_slots(now)) as u128;
    let payout = ((gross * weight) / BPS_DENOM as u128) as u64;

    position.reward_index_snapshot = curve.reward_index;
    require!(payout > 0, CurveXError::NothingToDistribute);

    let available = vault_spendable(&ctx.accounts.loyalty_vault.to_account_info())?;
    let payout = payout.min(available);
    require!(payout > 0, CurveXError::NothingToDistribute);

    move_lamports(
        &ctx.accounts.loyalty_vault.to_account_info(),
        &ctx.accounts.owner.to_account_info(),
        payout,
    )?;
    position.rewards_claimed += payout;
    msg!("curvex: claimed {} lamports", payout);
    Ok(())
}
