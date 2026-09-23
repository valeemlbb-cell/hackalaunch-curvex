//! Helpers shared by every instruction: the phase sync that makes transitions
//! autonomous, and safe lamport movement in and out of program-owned vaults.

use anchor_lang::prelude::*;

use crate::errors::CurveXError;
use crate::phases::{apply_transitions, LadderState};
use crate::state::{Curve, PhaseChanged};

/// Run the ladder against the live curve state and emit one event per rung
/// climbed. Every state-changing instruction calls this first, which is what
/// makes transitions autonomous rather than admin-triggered.
pub fn sync_phase(curve: &mut Curve, curve_key: Pubkey, now: u64) -> Result<()> {
    let mut ladder = LadderState {
        phase: curve.phase,
        tokens_sold: curve.tokens_sold,
        holder_count: curve.holder_count,
        volume_lamports: curve.volume_lamports,
        slots_since_launch: curve.slots_since_launch(now),
        phase_vote_passed: curve.phase_vote_passed,
    };
    let steps = apply_transitions(&mut ladder);
    for (from, to, cause) in steps {
        curve.phase = to;
        curve.last_transition_cause = cause;
        curve.last_transition_slot = now;
        emit!(PhaseChanged {
            curve: curve_key,
            from: from.ordinal(),
            to: to.ordinal(),
            cause: cause as u8,
            slot: now,
            tokens_sold: curve.tokens_sold,
            reserve_lamports: curve.reserve_lamports,
        });
    }
    Ok(())
}

/// Lamports a program-owned vault may pay out without losing rent exemption.
pub fn vault_spendable(vault: &AccountInfo) -> Result<u64> {
    let rent = Rent::get()?;
    let floor = rent.minimum_balance(vault.data_len());
    Ok(vault.lamports().saturating_sub(floor))
}

/// Move lamports between two accounts this program owns. Never use this on a
/// system-owned account: use a `system_program::transfer` CPI instead.
pub fn move_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    require!(vault_spendable(from)? >= amount, CurveXError::VaultUnderflow);
    **from.try_borrow_mut_lamports()? = from
        .lamports()
        .checked_sub(amount)
        .ok_or(CurveXError::MathOverflow)?;
    **to.try_borrow_mut_lamports()? = to
        .lamports()
        .checked_add(amount)
        .ok_or(CurveXError::MathOverflow)?;
    Ok(())
}

/// Signer seeds for the curve PDA, which is the mint and vault authority.
///
/// The bump has to outlive the CPI, so callers bind it first:
/// `let b = [curve.bump]; let seeds = curve_signer(&mint_key, &b);`
pub fn curve_signer<'a>(mint: &'a Pubkey, bump: &'a [u8; 1]) -> [&'a [u8]; 3] {
    [crate::constants::SEED_CURVE, mint.as_ref(), bump]
}
