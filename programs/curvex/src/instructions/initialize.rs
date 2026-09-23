use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::*;
use crate::state::{Curve, Phase, TransitionCause, Vault};

#[derive(Accounts)]
pub struct InitializeCurve<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    /// A fresh mint. Authority is handed to the curve PDA immediately and is
    /// revoked entirely at graduation, so supply is capped by code.
    #[account(
        init,
        payer = creator,
        mint::decimals = TOKEN_DECIMALS,
        mint::authority = curve,
    )]
    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = creator,
        space = 8 + Curve::INIT_SPACE,
        seeds = [SEED_CURVE, mint.key().as_ref()],
        bump
    )]
    pub curve: Account<'info, Curve>,

    #[account(
        init, payer = creator, space = 8 + Vault::INIT_SPACE,
        seeds = [SEED_SOL_VAULT, curve.key().as_ref()], bump
    )]
    pub sol_vault: Account<'info, Vault>,

    #[account(
        init, payer = creator, space = 8 + Vault::INIT_SPACE,
        seeds = [SEED_FEE_VAULT, curve.key().as_ref()], bump
    )]
    pub fee_vault: Account<'info, Vault>,

    #[account(
        init, payer = creator, space = 8 + Vault::INIT_SPACE,
        seeds = [SEED_POOL_SOL, curve.key().as_ref()], bump
    )]
    pub pool_sol_vault: Account<'info, Vault>,

    #[account(
        init, payer = creator, space = 8 + Vault::INIT_SPACE,
        seeds = [SEED_LOYALTY_VAULT, curve.key().as_ref()], bump
    )]
    pub loyalty_vault: Account<'info, Vault>,

    /// Holds the LP token side after graduation. Its authority is the curve
    /// PDA and no instruction ever transfers out of it.
    #[account(
        init, payer = creator,
        token::mint = mint,
        token::authority = curve,
        seeds = [SEED_POOL_TOKEN, curve.key().as_ref()], bump
    )]
    pub pool_token_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<InitializeCurve>) -> Result<()> {
    let now = Clock::get()?.slot;
    let curve = &mut ctx.accounts.curve;

    curve.creator = ctx.accounts.creator.key();
    curve.mint = ctx.accounts.mint.key();
    curve.bump = ctx.bumps.curve;
    curve.sol_vault_bump = ctx.bumps.sol_vault;
    curve.fee_vault_bump = ctx.bumps.fee_vault;
    curve.pool_sol_bump = ctx.bumps.pool_sol_vault;
    curve.loyalty_bump = ctx.bumps.loyalty_vault;

    curve.phase = Phase::Seeding;
    curve.last_transition_cause = TransitionCause::None;
    curve.launch_slot = now;
    curve.last_transition_slot = now;

    ctx.accounts.sol_vault.bump = ctx.bumps.sol_vault;
    ctx.accounts.sol_vault.kind = 0;
    ctx.accounts.fee_vault.bump = ctx.bumps.fee_vault;
    ctx.accounts.fee_vault.kind = 1;
    ctx.accounts.pool_sol_vault.bump = ctx.bumps.pool_sol_vault;
    ctx.accounts.pool_sol_vault.kind = 2;
    ctx.accounts.loyalty_vault.bump = ctx.bumps.loyalty_vault;
    ctx.accounts.loyalty_vault.kind = 3;

    msg!(
        "curvex: launched mint={} curve_supply={} graduation_at={}",
        curve.mint,
        CURVE_SUPPLY,
        P2_END
    );
    Ok(())
}
