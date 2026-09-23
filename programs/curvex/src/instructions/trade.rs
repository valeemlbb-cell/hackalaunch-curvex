//! Curve trading: `buy` and `sell`.
//!
//! Both instructions clip their fill to the current curve segment. A single
//! transaction can therefore never vault through a phase boundary and skip the
//! guards that live on the other side — the fill stops at the boundary, the
//! ladder transitions, and the caller must send another transaction under the
//! new rules.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount};

use crate::constants::*;
use crate::errors::CurveXError;
use crate::instructions::common::{move_lamports, sync_phase};
use crate::math::{
    buy_cost_lamports, buy_fee_bps, fee_of, segment_for, sell_fee_bps, sell_proceeds_lamports,
    SEGMENTS,
};
use crate::state::{Curve, Position, Traded, Vault};

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(mut, seeds = [SEED_CURVE, mint.key().as_ref()], bump = curve.bump)]
    pub curve: Account<'info, Curve>,

    #[account(mut, address = curve.mint)]
    pub mint: Account<'info, Mint>,

    #[account(
        init_if_needed, payer = buyer,
        associated_token::mint = mint,
        associated_token::authority = buyer,
    )]
    pub buyer_token_account: Account<'info, TokenAccount>,

    #[account(
        init_if_needed, payer = buyer, space = 8 + Position::INIT_SPACE,
        seeds = [SEED_POSITION, curve.key().as_ref(), buyer.key().as_ref()], bump
    )]
    pub position: Account<'info, Position>,

    #[account(mut, seeds = [SEED_SOL_VAULT, curve.key().as_ref()], bump = curve.sol_vault_bump)]
    pub sol_vault: Account<'info, Vault>,

    #[account(mut, seeds = [SEED_FEE_VAULT, curve.key().as_ref()], bump = curve.fee_vault_bump)]
    pub fee_vault: Account<'info, Vault>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn buy_handler(ctx: Context<Buy>, max_lamports: u64, min_tokens: u64) -> Result<()> {
    let now = Clock::get()?.slot;
    let curve_key = ctx.accounts.curve.key();
    let mint_key = ctx.accounts.mint.key();
    sync_phase(&mut ctx.accounts.curve, curve_key, now)?;

    let curve_bump = [ctx.accounts.curve.bump];
    let curve = &mut ctx.accounts.curve;
    let position = &mut ctx.accounts.position;

    // Phase first: once the ladder has reached Graduating or Perpetual the
    // curve is closed, and the caller should hear that rather than a
    // supply-exhaustion error that implies they were merely too late.
    require!(curve.phase.segment_index().is_some(), CurveXError::WrongPhase);
    let seg_idx = segment_for(curve.tokens_sold).ok_or(CurveXError::CurveExhausted)?;
    let seg = SEGMENTS[seg_idx];

    // Bootstrap a fresh position PDA.
    if position.owner == Pubkey::default() {
        position.owner = ctx.accounts.buyer.key();
        position.curve = curve_key;
        position.bump = ctx.bumps.position;
        position.reward_index_snapshot = curve.reward_index;
    }

    // Per-phase cooldown: a wallet farm pays this delay once per wallet.
    let cooldown = curve.phase.buy_cooldown_slots();
    if position.last_buy_slot != 0 {
        require!(
            now.saturating_sub(position.last_buy_slot) >= cooldown,
            CurveXError::CooldownActive
        );
    }

    let fee_bps = buy_fee_bps(curve.slots_since_launch(now));
    // max_lamports is inclusive of the fee, so the curve only gets
    // max_lamports / (1 + fee).
    let net_budget = (max_lamports as u128 * BPS_DENOM as u128)
        / (BPS_DENOM as u128 + fee_bps as u128);

    let mut tokens = seg.tokens_for_budget(curve.tokens_sold, net_budget * PRICE_SCALE);

    // Per-wallet cap for this phase.
    let cap = curve.phase.wallet_cap();
    let headroom = cap.saturating_sub(position.balance);
    require!(headroom > 0, CurveXError::WalletCapExceeded);
    tokens = tokens.min(headroom);
    require!(tokens > 0, CurveXError::ZeroFill);

    // Ceil-rounding on cost can push the total one lamport past the budget;
    // shave at most a few tokens to fit. Each token is worth >= 10 lamports,
    // so this converges immediately.
    let mut cost = buy_cost_lamports(&seg, curve.tokens_sold, curve.tokens_sold + tokens);
    let mut fee = fee_of(cost, fee_bps);
    for _ in 0..4 {
        if cost + fee <= max_lamports || tokens <= 1 {
            break;
        }
        tokens -= 1;
        cost = buy_cost_lamports(&seg, curve.tokens_sold, curve.tokens_sold + tokens);
        fee = fee_of(cost, fee_bps);
    }
    let total = cost
        .checked_add(fee)
        .ok_or(CurveXError::MathOverflow)?;
    require!(total <= max_lamports, CurveXError::SlippageExceeded);
    require!(tokens >= min_tokens, CurveXError::SlippageExceeded);

    // Lamports in.
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to: ctx.accounts.sol_vault.to_account_info(),
            },
        ),
        cost,
    )?;
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to: ctx.accounts.fee_vault.to_account_info(),
            },
        ),
        fee,
    )?;

    // Tokens out.
    let parts = crate::instructions::common::curve_signer(&mint_key, &curve_bump);
    let seeds: &[&[&[u8]]] = &[&parts];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.buyer_token_account.to_account_info(),
                authority: curve.to_account_info(),
            },
            seeds,
        ),
        tokens
            .checked_mul(TOKEN_UNIT)
            .ok_or(CurveXError::MathOverflow)?,
    )?;

    let counted_before = position.balance >= MIN_COUNTED_BALANCE;
    position.record_buy(tokens, now);
    if !counted_before && position.balance >= MIN_COUNTED_BALANCE {
        curve.holder_count += 1;
    }

    curve.tokens_sold += tokens;
    curve.reserve_lamports += cost;
    curve.volume_lamports = curve.volume_lamports.saturating_add(total);
    curve.total_position_balance += tokens;

    emit!(Traded {
        curve: curve_key,
        trader: ctx.accounts.buyer.key(),
        is_buy: true,
        tokens,
        lamports: total,
        fee_lamports: fee,
        fee_bps,
        phase: curve.phase.ordinal(),
    });

    // Re-run the ladder so a buy that reaches a boundary transitions in the
    // same transaction.
    sync_phase(&mut ctx.accounts.curve, curve_key, now)?;
    Ok(())
}

#[derive(Accounts)]
pub struct Sell<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(mut, seeds = [SEED_CURVE, mint.key().as_ref()], bump = curve.bump)]
    pub curve: Account<'info, Curve>,

    #[account(mut, address = curve.mint)]
    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = seller,
    )]
    pub seller_token_account: Account<'info, TokenAccount>,

    #[account(
        mut, has_one = owner,
        seeds = [SEED_POSITION, curve.key().as_ref(), seller.key().as_ref()], bump = position.bump
    )]
    pub position: Account<'info, Position>,

    /// CHECK: equals `seller`; only used to satisfy `has_one` on the position.
    #[account(address = seller.key())]
    pub owner: UncheckedAccount<'info>,

    #[account(mut, seeds = [SEED_SOL_VAULT, curve.key().as_ref()], bump = curve.sol_vault_bump)]
    pub sol_vault: Account<'info, Vault>,

    #[account(mut, seeds = [SEED_FEE_VAULT, curve.key().as_ref()], bump = curve.fee_vault_bump)]
    pub fee_vault: Account<'info, Vault>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn sell_handler(ctx: Context<Sell>, tokens: u64, min_lamports: u64) -> Result<()> {
    let now = Clock::get()?.slot;
    let curve_key = ctx.accounts.curve.key();
    sync_phase(&mut ctx.accounts.curve, curve_key, now)?;

    let curve = &mut ctx.accounts.curve;
    let position = &mut ctx.accounts.position;

    require!(curve.phase.segment_index().is_some(), CurveXError::WrongPhase);
    let seg_idx = segment_for(curve.tokens_sold.saturating_sub(1))
        .ok_or(CurveXError::CurveExhausted)?;
    let seg = SEGMENTS[seg_idx];

    // Only curve-acquired tokens carry tenure. Tokens received by transfer are
    // not sellable through this instruction: tenure cannot be bought second
    // hand, and the reserve is only ever debited for supply it was paid for.
    require!(
        position.balance >= tokens && tokens > 0,
        CurveXError::InsufficientPositionBalance
    );
    // Clip to this segment so the integral stays valid.
    let floor = seg.start;
    let max_here = curve.tokens_sold.saturating_sub(floor);
    let tokens = tokens.min(max_here);
    require!(tokens > 0, CurveXError::ZeroFill);

    // Rolling sell throttle.
    //
    // The window opens on the FIRST sell, not at `buy`. A position created by
    // `buy` has `sell_window_base == 0`, and measuring the window from a
    // never-set `sell_window_start` would leave the allowance pinned at zero
    // until SELL_WINDOW_SLOTS had elapsed — a fresh holder could not exit at
    // all. Opening it here bases the allowance on the balance actually held
    // when the seller first asks to leave.
    let window_open = position.sell_window_base > 0
        && now.saturating_sub(position.sell_window_start) < SELL_WINDOW_SLOTS;
    if !window_open {
        position.sell_window_start = now;
        position.sell_window_base = position.balance;
        position.sold_in_window = 0;
    }
    let window_allowance =
        ((position.sell_window_base as u128 * SELL_WINDOW_BPS as u128) / BPS_DENOM as u128) as u64;
    require!(
        position.sold_in_window + tokens <= window_allowance.max(MIN_COUNTED_BALANCE),
        CurveXError::SellThrottled
    );

    let gross = sell_proceeds_lamports(&seg, curve.tokens_sold, curve.tokens_sold - tokens);
    let fee_bps = sell_fee_bps(
        position.tenure_slots(now),
        curve.slots_since_transition(now),
    );
    let fee = fee_of(gross, fee_bps);
    let net = gross.saturating_sub(fee);
    require!(net >= min_lamports, CurveXError::SlippageExceeded);
    require!(curve.reserve_lamports >= gross, CurveXError::ReserveInsolvent);

    // Tokens in (burned — circulating supply always matches the curve).
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.mint.to_account_info(),
                from: ctx.accounts.seller_token_account.to_account_info(),
                authority: ctx.accounts.seller.to_account_info(),
            },
        ),
        tokens
            .checked_mul(TOKEN_UNIT)
            .ok_or(CurveXError::MathOverflow)?,
    )?;

    // Lamports out.
    move_lamports(
        &ctx.accounts.sol_vault.to_account_info(),
        &ctx.accounts.seller.to_account_info(),
        net,
    )?;
    move_lamports(
        &ctx.accounts.sol_vault.to_account_info(),
        &ctx.accounts.fee_vault.to_account_info(),
        fee,
    )?;

    let counted_before = position.balance >= MIN_COUNTED_BALANCE;
    position.balance -= tokens;
    position.sold_in_window += tokens;
    if counted_before && position.balance < MIN_COUNTED_BALANCE {
        curve.holder_count = curve.holder_count.saturating_sub(1);
    }

    curve.tokens_sold -= tokens;
    curve.reserve_lamports -= gross;
    curve.volume_lamports = curve.volume_lamports.saturating_add(gross);
    curve.total_position_balance = curve.total_position_balance.saturating_sub(tokens);

    emit!(Traded {
        curve: curve_key,
        trader: ctx.accounts.seller.key(),
        is_buy: false,
        tokens,
        lamports: net,
        fee_lamports: fee,
        fee_bps,
        phase: curve.phase.ordinal(),
    });

    sync_phase(&mut ctx.accounts.curve, curve_key, now)?;
    Ok(())
}
