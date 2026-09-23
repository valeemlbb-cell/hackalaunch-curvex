use anchor_lang::prelude::*;

use crate::constants::*;
use crate::instructions::common::sync_phase;
use crate::phases::{progress_bps, LadderState};
use crate::state::Curve;

/// Permissionless. Any wallet can advance the ladder, which is what makes the
/// time-, holder- and volume-based triggers real: they do not depend on a
/// trade happening, and they do not depend on the creator showing up.
#[derive(Accounts)]
pub struct CrankPhase<'info> {
    pub cranker: Signer<'info>,

    #[account(mut, seeds = [SEED_CURVE, curve.mint.as_ref()], bump = curve.bump)]
    pub curve: Account<'info, Curve>,
}

pub fn handler(ctx: Context<CrankPhase>) -> Result<()> {
    let now = Clock::get()?.slot;
    let curve_key = ctx.accounts.curve.key();
    sync_phase(&mut ctx.accounts.curve, curve_key, now)?;

    let curve = &ctx.accounts.curve;
    let ladder = LadderState {
        phase: curve.phase,
        tokens_sold: curve.tokens_sold,
        holder_count: curve.holder_count,
        volume_lamports: curve.volume_lamports,
        slots_since_launch: curve.slots_since_launch(now),
        phase_vote_passed: curve.phase_vote_passed,
    };
    msg!(
        "curvex: phase={} progress_bps={} sold={} holders={} volume={}",
        curve.phase.ordinal(),
        progress_bps(&ladder),
        curve.tokens_sold,
        curve.holder_count,
        curve.volume_lamports
    );
    Ok(())
}
