//! Autonomous phase transitions.
//!
//! No instruction in CurveX lets anyone *choose* a phase. Every state-changing
//! instruction calls [`apply_transitions`] first, and any wallet can call the
//! permissionless `crank_phase` instruction to make a time- or holder-based
//! trigger take effect when nobody is trading.
//!
//! ## Why a phase never moves the price pointer
//!
//! The price segment is a pure function of `tokens_sold`, not of `phase`.
//! Holder-count, time and volume triggers therefore relax the *rule regime*
//! (wallet caps, cooldowns, fee schedule) ahead of the curve, but they never
//! jump the price. Jumping the pointer without moving lamports would let the
//! next seller withdraw against a reserve that was never funded at that price
//! — an instantly insolvent vault. `phase >= segment_for(tokens_sold)` is the
//! invariant that keeps the ladder monotonic and the vault solvent at once.

use crate::constants::*;
use crate::state::{Phase, TransitionCause};

/// Everything a transition decision depends on. Kept as a plain struct so the
/// whole ladder is unit-testable without any Solana runtime.
#[derive(Clone, Copy, Debug)]
pub struct LadderState {
    pub phase: Phase,
    pub tokens_sold: u64,
    pub holder_count: u64,
    pub volume_lamports: u64,
    pub slots_since_launch: u64,
    pub phase_vote_passed: bool,
}

/// The single step the ladder would take right now, if any.
pub fn next_transition(s: &LadderState) -> Option<(Phase, TransitionCause)> {
    match s.phase {
        Phase::Seeding => {
            if s.tokens_sold >= P0_END {
                Some((Phase::Discovery, TransitionCause::SupplyTarget))
            } else if s.holder_count >= P0_HOLDER_TRIGGER {
                Some((Phase::Discovery, TransitionCause::HolderTarget))
            } else if s.slots_since_launch >= P0_TIME_TRIGGER_SLOTS {
                Some((Phase::Discovery, TransitionCause::TimeBackstop))
            } else {
                None
            }
        }
        Phase::Discovery => {
            if s.tokens_sold >= P1_END {
                Some((Phase::Acceleration, TransitionCause::SupplyTarget))
            } else if s.volume_lamports >= P1_VOLUME_TRIGGER_LAMPORTS {
                Some((Phase::Acceleration, TransitionCause::VolumeTarget))
            } else if s.phase_vote_passed {
                Some((Phase::Acceleration, TransitionCause::HolderVote))
            } else {
                None
            }
        }
        Phase::Acceleration => {
            if s.tokens_sold >= P2_END {
                Some((Phase::Graduating, TransitionCause::GraduationThreshold))
            } else {
                None
            }
        }
        // `Graduating -> Perpetual` needs token accounts, so it happens in the
        // permissionless `graduate` instruction rather than here.
        Phase::Graduating | Phase::Perpetual => None,
    }
}

/// Apply every transition that is currently justified. Returns the list of
/// steps taken so the caller can emit one event per step.
pub fn apply_transitions(s: &mut LadderState) -> Vec<(Phase, Phase, TransitionCause)> {
    let mut steps = Vec::new();
    // At most four rungs exist, so this cannot spin.
    for _ in 0..4 {
        match next_transition(s) {
            Some((to, cause)) => {
                steps.push((s.phase, to, cause));
                s.phase = to;
            }
            None => break,
        }
    }
    steps
}

/// Progress toward the next rung, in basis points. Used by the CLI and the
/// monitor UI. Returns the dominant trigger's progress.
pub fn progress_bps(s: &LadderState) -> u64 {
    let ratio = |num: u128, den: u128| -> u64 {
        if den == 0 {
            return BPS_DENOM;
        }
        ((num * BPS_DENOM as u128) / den).min(BPS_DENOM as u128) as u64
    };
    match s.phase {
        Phase::Seeding => {
            let supply = ratio(s.tokens_sold as u128, P0_END as u128);
            let holders = ratio(s.holder_count as u128, P0_HOLDER_TRIGGER as u128);
            let time = ratio(s.slots_since_launch as u128, P0_TIME_TRIGGER_SLOTS as u128);
            supply.max(holders).max(time)
        }
        Phase::Discovery => {
            let supply = ratio(
                (s.tokens_sold.saturating_sub(P0_END)) as u128,
                (P1_END - P0_END) as u128,
            );
            let volume = ratio(s.volume_lamports as u128, P1_VOLUME_TRIGGER_LAMPORTS as u128);
            supply.max(volume)
        }
        Phase::Acceleration => ratio(
            (s.tokens_sold.saturating_sub(P1_END)) as u128,
            (P2_END - P1_END) as u128,
        ),
        Phase::Graduating => BPS_DENOM,
        Phase::Perpetual => BPS_DENOM,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> LadderState {
        LadderState {
            phase: Phase::Seeding,
            tokens_sold: 0,
            holder_count: 0,
            volume_lamports: 0,
            slots_since_launch: 0,
            phase_vote_passed: false,
        }
    }

    #[test]
    fn a_quiet_launch_does_not_transition() {
        let mut s = fresh();
        assert!(apply_transitions(&mut s).is_empty());
        assert_eq!(s.phase, Phase::Seeding);
    }

    #[test]
    fn supply_target_advances_seeding() {
        let mut s = fresh();
        s.tokens_sold = P0_END;
        let steps = apply_transitions(&mut s);
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].2, TransitionCause::SupplyTarget);
        assert_eq!(s.phase, Phase::Discovery);
    }

    #[test]
    fn holder_target_advances_seeding_without_supply() {
        let mut s = fresh();
        s.holder_count = P0_HOLDER_TRIGGER;
        let steps = apply_transitions(&mut s);
        assert_eq!(steps[0].2, TransitionCause::HolderTarget);
        assert_eq!(s.phase, Phase::Discovery);
        // the price pointer is untouched: solvency invariant
        assert_eq!(s.tokens_sold, 0);
    }

    #[test]
    fn time_backstop_rescues_a_dead_launch() {
        let mut s = fresh();
        s.slots_since_launch = P0_TIME_TRIGGER_SLOTS;
        assert_eq!(apply_transitions(&mut s)[0].2, TransitionCause::TimeBackstop);
    }

    #[test]
    fn volume_target_advances_discovery() {
        let mut s = fresh();
        s.phase = Phase::Discovery;
        s.volume_lamports = P1_VOLUME_TRIGGER_LAMPORTS;
        assert_eq!(apply_transitions(&mut s)[0].2, TransitionCause::VolumeTarget);
        assert_eq!(s.phase, Phase::Acceleration);
    }

    #[test]
    fn holder_vote_advances_discovery() {
        let mut s = fresh();
        s.phase = Phase::Discovery;
        s.phase_vote_passed = true;
        assert_eq!(apply_transitions(&mut s)[0].2, TransitionCause::HolderVote);
    }

    #[test]
    fn graduation_threshold_stages_migration() {
        let mut s = fresh();
        s.phase = Phase::Acceleration;
        s.tokens_sold = P2_END;
        assert_eq!(s.phase_after(), Phase::Graduating);
    }

    impl LadderState {
        fn phase_after(mut self) -> Phase {
            apply_transitions(&mut self);
            self.phase
        }
    }

    #[test]
    fn a_single_crank_can_walk_multiple_rungs() {
        let mut s = fresh();
        s.tokens_sold = P2_END;
        let steps = apply_transitions(&mut s);
        assert_eq!(steps.len(), 3, "Seeding -> Discovery -> Acceleration -> Graduating");
        assert_eq!(s.phase, Phase::Graduating);
    }

    #[test]
    fn transitions_are_one_way() {
        let mut s = fresh();
        s.phase = Phase::Acceleration;
        s.tokens_sold = 0;
        s.holder_count = 0;
        assert!(apply_transitions(&mut s).is_empty());
        assert_eq!(s.phase, Phase::Acceleration, "phase must never regress");
    }

    #[test]
    fn graduating_and_perpetual_are_terminal_for_the_ladder() {
        for phase in [Phase::Graduating, Phase::Perpetual] {
            let mut s = fresh();
            s.phase = phase;
            s.tokens_sold = P2_END;
            assert!(apply_transitions(&mut s).is_empty());
        }
    }

    #[test]
    fn progress_is_monotonic_and_bounded() {
        let mut s = fresh();
        let mut last = 0;
        for sold in (0..P0_END).step_by(1_000_000) {
            s.tokens_sold = sold;
            let p = progress_bps(&s);
            assert!(p >= last && p <= BPS_DENOM);
            last = p;
        }
        s.tokens_sold = P0_END;
        assert_eq!(progress_bps(&s), BPS_DENOM);
    }

    #[test]
    fn progress_tracks_the_fastest_trigger() {
        let mut s = fresh();
        s.holder_count = P0_HOLDER_TRIGGER / 2;
        assert_eq!(progress_bps(&s), 5_000);
        s.tokens_sold = P0_END * 3 / 4;
        assert_eq!(progress_bps(&s), 7_500);
    }
}
