//! Phase 4 (Perpetual): the graduated constant-product pool.
//!
//! Tenure keeps paying after the DEX: a fully matured position swaps at
//! `POOL_FEE_MATURED_BPS` instead of `POOL_FEE_BPS`. Half of the standard fee
//! stays in the pool and permanently deepens liquidity; the other half leaves
//! for the fee flywheel.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::CurveXError;
use crate::instructions::common::move_lamports;
use crate::math::{cp_amount_out, tenure_weight_bps};
use crate::state::{Curve, Position, Traded, Vault};

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(mut, seeds = [SEED_CURVE, mint.key().as_ref()], bump = curve.bump)]
    pub curve: Account<'info, Curve>,

    #[account(mut, address = curve.mint)]
    pub mint: Account<'info, Mint>,

    #[account(
        init_if_needed, payer = trader,
        associated_token::mint = mint,
        associated_token::authority = trader,
    )]
    pub trader_token_account: Account<'info, TokenAccount>,

    #[account(
        init_if_needed, payer = trader, space = 8 + Position::INIT_SPACE,
        seeds = [SEED_POSITION, curve.key().as_ref(), trader.key().as_ref()], bump
    )]
    pub position: Account<'info, Position>,

    #[account(mut, seeds = [SEED_POOL_SOL, curve.key().as_ref()], bump = curve.pool_sol_bump)]
    pub pool_sol_vault: Account<'info, Vault>,

    #[account(mut, seeds = [SEED_POOL_TOKEN, curve.key().as_ref()], bump)]
    pub pool_token_vault: Account<'info, TokenAccount>,

    #[account(mut, seeds = [SEED_FEE_VAULT, curve.key().as_ref()], bump = curve.fee_vault_bump)]
    pub fee_vault: Account<'info, Vault>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn swap_handler(
    ctx: Context<Swap>,
    amount_in: u64,
    min_out: u64,
    sol_to_token: bool,
) -> Result<()> {
    let now = Clock::get()?.slot;
    let curve_key = ctx.accounts.curve.key();
    let mint_key = ctx.accounts.mint.key();
    require!(ctx.accounts.curve.graduated, CurveXError::NotGraduated);
    require!(amount_in > 0, CurveXError::ZeroFill);

    let position = &mut ctx.accounts.position;
    if position.owner == Pubkey::default() {
        position.owner = ctx.accounts.trader.key();
        position.curve = curve_key;
        position.bump = ctx.bumps.position;
        position.reward_index_snapshot = ctx.accounts.curve.reward_index;
    }

    // Tenure discount survives graduation.
    let matured = tenure_weight_bps(position.tenure_slots(now)) == BPS_DENOM;
    let fee_bps = if matured { POOL_FEE_MATURED_BPS } else { POOL_FEE_BPS };

    let sol_reserve = ctx.accounts.curve.pool_sol_reserve as u128;
    let token_reserve = ctx.accounts.curve.pool_token_reserve as u128;

    if sol_to_token {
        let out = cp_amount_out(sol_reserve, token_reserve, amount_in as u128, fee_bps) as u64;
        require!(out >= min_out && out > 0, CurveXError::SlippageExceeded);

        let flywheel_cut = crate::math::fee_of(amount_in, POOL_FEE_TO_FLYWHEEL_BPS).min(amount_in);
        let to_pool = amount_in - flywheel_cut;

        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.trader.to_account_info(),
                    to: ctx.accounts.pool_sol_vault.to_account_info(),
                },
            ),
            to_pool,
        )?;
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.trader.to_account_info(),
                    to: ctx.accounts.fee_vault.to_account_info(),
                },
            ),
            flywheel_cut,
        )?;

        let bump = [ctx.accounts.curve.bump];
            let parts = crate::instructions::common::curve_signer(&mint_key, &bump);
            let seeds: &[&[&[u8]]] = &[&parts];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.pool_token_vault.to_account_info(),
                    to: ctx.accounts.trader_token_account.to_account_info(),
                    authority: ctx.accounts.curve.to_account_info(),
                },
                seeds,
            ),
            out.checked_mul(TOKEN_UNIT).ok_or(CurveXError::MathOverflow)?,
        )?;

        let curve = &mut ctx.accounts.curve;
        curve.pool_sol_reserve += to_pool;
        curve.pool_token_reserve -= out;
        curve.volume_lamports = curve.volume_lamports.saturating_add(amount_in);
        curve.total_position_balance += out;
        position.record_buy(out, now);

        emit!(Traded {
            curve: curve_key,
            trader: ctx.accounts.trader.key(),
            is_buy: true,
            tokens: out,
            lamports: amount_in,
            fee_lamports: flywheel_cut,
            fee_bps,
            phase: curve.phase.ordinal(),
        });
    } else {
        let out = cp_amount_out(token_reserve, sol_reserve, amount_in as u128, fee_bps) as u64;
        require!(out > 0, CurveXError::SlippageExceeded);
        let flywheel_cut = crate::math::fee_of(out, POOL_FEE_TO_FLYWHEEL_BPS).min(out);
        let net = out - flywheel_cut;
        require!(net >= min_out, CurveXError::SlippageExceeded);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.trader_token_account.to_account_info(),
                    to: ctx.accounts.pool_token_vault.to_account_info(),
                    authority: ctx.accounts.trader.to_account_info(),
                },
            ),
            amount_in
                .checked_mul(TOKEN_UNIT)
                .ok_or(CurveXError::MathOverflow)?,
        )?;

        move_lamports(
            &ctx.accounts.pool_sol_vault.to_account_info(),
            &ctx.accounts.trader.to_account_info(),
            net,
        )?;
        move_lamports(
            &ctx.accounts.pool_sol_vault.to_account_info(),
            &ctx.accounts.fee_vault.to_account_info(),
            flywheel_cut,
        )?;

        let curve = &mut ctx.accounts.curve;
        curve.pool_sol_reserve -= out;
        curve.pool_token_reserve += amount_in;
        curve.volume_lamports = curve.volume_lamports.saturating_add(out);

        let reduce = amount_in.min(position.balance);
        position.balance -= reduce;
        curve.total_position_balance = curve.total_position_balance.saturating_sub(reduce);

        emit!(Traded {
            curve: curve_key,
            trader: ctx.accounts.trader.key(),
            is_buy: false,
            tokens: amount_in,
            lamports: net,
            fee_lamports: flywheel_cut,
            fee_bps,
            phase: curve.phase.ordinal(),
        });
    }

    Ok(())
}
