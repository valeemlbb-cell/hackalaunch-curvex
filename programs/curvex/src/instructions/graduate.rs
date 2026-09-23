//! Permissionless migration into the locked pool.
//!
//! Three properties make this un-ruggable by construction:
//!
//! 1. Anyone can call it. The creator cannot front-run the migration, and
//!    cannot stall it either.
//! 2. The LP is never tokenised. There are no LP tokens to hold, sell or
//!    withdraw — the reserves live in PDAs whose only debit paths are `swap`
//!    and the flywheel's buyback.
//! 3. The mint authority is set to `None` in the same instruction, so total
//!    supply is frozen forever at `tokens_sold + LP_SUPPLY`.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, SetAuthority, Token, TokenAccount};
use anchor_spl::token::spl_token::instruction::AuthorityType;

use crate::constants::*;
use crate::errors::CurveXError;
use crate::instructions::common::{move_lamports, sync_phase};
use crate::state::{Curve, Graduated, Phase, TransitionCause, Vault};

#[derive(Accounts)]
pub struct Graduate<'info> {
    pub cranker: Signer<'info>,

    #[account(mut, seeds = [SEED_CURVE, mint.key().as_ref()], bump = curve.bump)]
    pub curve: Account<'info, Curve>,

    #[account(mut, address = curve.mint)]
    pub mint: Account<'info, Mint>,

    #[account(mut, seeds = [SEED_SOL_VAULT, curve.key().as_ref()], bump = curve.sol_vault_bump)]
    pub sol_vault: Account<'info, Vault>,

    #[account(mut, seeds = [SEED_POOL_SOL, curve.key().as_ref()], bump = curve.pool_sol_bump)]
    pub pool_sol_vault: Account<'info, Vault>,

    #[account(mut, seeds = [SEED_POOL_TOKEN, curve.key().as_ref()], bump)]
    pub pool_token_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Graduate>) -> Result<()> {
    let now = Clock::get()?.slot;
    let curve_key = ctx.accounts.curve.key();
    let mint_key = ctx.accounts.mint.key();
    sync_phase(&mut ctx.accounts.curve, curve_key, now)?;

    {
        let curve = &ctx.accounts.curve;
        require!(!curve.graduated, CurveXError::AlreadyGraduated);
        require!(curve.phase == Phase::Graduating, CurveXError::NotGraduatable);
        require!(curve.tokens_sold >= P2_END, CurveXError::NotGraduatable);
    }

    let reserve = ctx.accounts.curve.reserve_lamports;
    move_lamports(
        &ctx.accounts.sol_vault.to_account_info(),
        &ctx.accounts.pool_sol_vault.to_account_info(),
        reserve,
    )?;

    let bump = [ctx.accounts.curve.bump];
            let parts = crate::instructions::common::curve_signer(&mint_key, &bump);
            let seeds: &[&[&[u8]]] = &[&parts];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.pool_token_vault.to_account_info(),
                authority: ctx.accounts.curve.to_account_info(),
            },
            seeds,
        ),
        LP_SUPPLY
            .checked_mul(TOKEN_UNIT)
            .ok_or(CurveXError::MathOverflow)?,
    )?;

    // Supply is now capped forever. Nothing in this program can mint again.
    token::set_authority(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            SetAuthority {
                current_authority: ctx.accounts.curve.to_account_info(),
                account_or_mint: ctx.accounts.mint.to_account_info(),
            },
            seeds,
        ),
        AuthorityType::MintTokens,
        None,
    )?;

    let curve = &mut ctx.accounts.curve;
    curve.reserve_lamports = 0;
    curve.pool_sol_reserve = reserve;
    curve.pool_token_reserve = LP_SUPPLY;
    curve.graduated = true;
    curve.graduated_slot = now;
    curve.phase = Phase::Perpetual;
    curve.last_transition_cause = TransitionCause::Migrated;
    curve.last_transition_slot = now;
    // The first flywheel crank is allowed one interval after graduation.
    curve.last_flywheel_slot = now;

    emit!(Graduated {
        curve: curve_key,
        slot: now,
        pool_sol: reserve,
        pool_tokens: LP_SUPPLY,
    });
    msg!(
        "curvex: graduated pool_sol={} pool_tokens={} mint_authority=revoked",
        reserve,
        LP_SUPPLY
    );
    Ok(())
}
