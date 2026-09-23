//! On-chain account layouts.

use anchor_lang::prelude::*;

use crate::constants::*;

/// The phase ladder. `Graduating` is a one-slot staging state: the curve has
/// hit its threshold and any wallet may now crank `graduate`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Phase {
    Seeding,
    Discovery,
    Acceleration,
    Graduating,
    Perpetual,
}

impl Phase {
    pub fn ordinal(&self) -> u8 {
        match self {
            Phase::Seeding => 0,
            Phase::Discovery => 1,
            Phase::Acceleration => 2,
            Phase::Graduating => 3,
            Phase::Perpetual => 4,
        }
    }

    /// Index into `math::SEGMENTS`, if the curve is still live.
    pub fn segment_index(&self) -> Option<usize> {
        match self {
            Phase::Seeding => Some(0),
            Phase::Discovery => Some(1),
            Phase::Acceleration => Some(2),
            _ => None,
        }
    }

    /// Per-wallet buy cap in whole tokens for this phase.
    pub fn wallet_cap(&self) -> u64 {
        match self {
            Phase::Seeding => P0_WALLET_CAP,
            Phase::Discovery => P1_WALLET_CAP,
            _ => u64::MAX,
        }
    }

    /// Minimum slots a wallet must wait between buys in this phase.
    pub fn buy_cooldown_slots(&self) -> u64 {
        match self {
            Phase::Seeding => P0_BUY_COOLDOWN_SLOTS,
            Phase::Discovery => P1_BUY_COOLDOWN_SLOTS,
            _ => 0,
        }
    }
}

/// Why the most recent phase transition fired. Surfaced to the CLI so the
/// ladder is auditable from the outside.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum TransitionCause {
    None,
    SupplyTarget,
    HolderTarget,
    TimeBackstop,
    VolumeTarget,
    HolderVote,
    GraduationThreshold,
    Migrated,
}

#[account]
#[derive(InitSpace)]
pub struct Curve {
    /// Recorded for attribution only. The creator has NO privileged
    /// instruction anywhere in this program.
    pub creator: Pubkey,
    pub mint: Pubkey,
    pub bump: u8,
    pub sol_vault_bump: u8,
    pub fee_vault_bump: u8,
    pub pool_sol_bump: u8,
    pub loyalty_bump: u8,

    pub phase: Phase,
    pub last_transition_cause: TransitionCause,
    pub launch_slot: u64,
    pub last_transition_slot: u64,

    /// Whole tokens sold by the curve (net of curve sells).
    pub tokens_sold: u64,
    /// Lamports currently backing the curve (excludes fees).
    pub reserve_lamports: u64,
    /// Cumulative lamports traded in either direction.
    pub volume_lamports: u64,
    /// Positions with a non-zero balance.
    pub holder_count: u64,
    /// Sum of all position balances, in whole tokens.
    pub total_position_balance: u64,

    // --- holder vote that can accelerate Discovery -> Acceleration ---
    pub phase_vote_yes: u128,
    pub phase_vote_no: u128,
    pub phase_vote_passed: bool,

    // --- standing governance over the flywheel split ---
    /// Sum of vote weights that have expressed a preference.
    pub split_weight_sum: u128,
    /// Sum of `weight * preferred_bps`.
    pub split_weighted_sum: u128,

    // --- graduated pool ---
    pub graduated: bool,
    pub graduated_slot: u64,
    pub pool_sol_reserve: u64,
    pub pool_token_reserve: u64,

    // --- flywheel ---
    pub last_flywheel_slot: u64,
    pub flywheel_cranks: u64,
    pub total_burned: u64,
    pub total_buyback_lamports: u64,
    pub total_loyalty_lamports: u64,
    /// Accumulated lamports per whole token of stake, scaled by
    /// `REWARD_INDEX_SCALE`.
    pub reward_index: u128,
}

impl Curve {
    /// Effective buyback share, derived live from holder preferences and
    /// clamped to the hard-coded bounds. No admin can move it outside.
    pub fn buyback_bps(&self) -> u64 {
        if self.split_weight_sum == 0 {
            return DEFAULT_BUYBACK_BPS;
        }
        let avg = (self.split_weighted_sum / self.split_weight_sum) as u64;
        avg.clamp(MIN_BUYBACK_BPS, MAX_BUYBACK_BPS)
    }

    pub fn slots_since_transition(&self, now: u64) -> u64 {
        now.saturating_sub(self.last_transition_slot)
    }

    pub fn slots_since_launch(&self, now: u64) -> u64 {
        now.saturating_sub(self.launch_slot)
    }
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub owner: Pubkey,
    pub curve: Pubkey,
    pub bump: u8,

    /// Whole tokens acquired through the curve and still held. Tokens received
    /// by P2P transfer are deliberately NOT counted: tenure cannot be bought
    /// second-hand.
    pub balance: u64,
    /// Balance-weighted average acquisition slot.
    pub weighted_acq_slot: u64,
    pub last_buy_slot: u64,

    /// Rolling sell-throttle window.
    pub sell_window_start: u64,
    pub sell_window_base: u64,
    pub sold_in_window: u64,

    pub voted_phase: bool,
    /// 0 means "no preference expressed".
    pub preferred_buyback_bps: u64,
    pub split_vote_weight: u128,

    pub reward_index_snapshot: u128,
    pub rewards_claimed: u64,
}

impl Position {
    pub fn tenure_slots(&self, now: u64) -> u64 {
        if self.balance == 0 {
            return 0;
        }
        now.saturating_sub(self.weighted_acq_slot)
    }

    /// Tenure-weighted stake in whole tokens; the unit used for governance
    /// weight and loyalty rewards.
    pub fn weight(&self, now: u64) -> u128 {
        let w = crate::math::tenure_weight_bps(self.tenure_slots(now));
        (self.balance as u128 * w as u128) / BPS_DENOM as u128
    }

    /// Fold a new purchase into the balance-weighted acquisition slot.
    pub fn record_buy(&mut self, amount: u64, now: u64) {
        let old = self.balance as u128;
        let new = amount as u128;
        let total = old + new;
        if total == 0 {
            return;
        }
        self.weighted_acq_slot =
            ((self.weighted_acq_slot as u128 * old + now as u128 * new) / total) as u64;
        self.balance = total as u64;
        self.last_buy_slot = now;
    }
}

/// A lamport-holding PDA. It carries a byte of data purely so the account is
/// program-owned and the program can debit it; there is intentionally no
/// instruction anywhere that transfers out of the pool vaults.
#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub bump: u8,
    pub kind: u8,
}

#[event]
pub struct PhaseChanged {
    pub curve: Pubkey,
    pub from: u8,
    pub to: u8,
    pub cause: u8,
    pub slot: u64,
    pub tokens_sold: u64,
    pub reserve_lamports: u64,
}

#[event]
pub struct Traded {
    pub curve: Pubkey,
    pub trader: Pubkey,
    pub is_buy: bool,
    pub tokens: u64,
    pub lamports: u64,
    pub fee_lamports: u64,
    pub fee_bps: u64,
    pub phase: u8,
}

#[event]
pub struct Graduated {
    pub curve: Pubkey,
    pub slot: u64,
    pub pool_sol: u64,
    pub pool_tokens: u64,
}

#[event]
pub struct FlywheelCranked {
    pub curve: Pubkey,
    pub slot: u64,
    pub inflow_lamports: u64,
    pub buyback_lamports: u64,
    pub burned_tokens: u64,
    pub loyalty_lamports: u64,
    pub buyback_bps: u64,
}
