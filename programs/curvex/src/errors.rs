use anchor_lang::prelude::*;

#[error_code]
pub enum CurveXError {
    #[msg("The bonding curve is exhausted; the pool has graduated")]
    CurveExhausted,
    #[msg("This instruction is not available in the current phase")]
    WrongPhase,
    #[msg("Buy amount is zero after clipping to the current phase boundary")]
    ZeroFill,
    #[msg("Slippage: output below the caller's minimum")]
    SlippageExceeded,
    #[msg("Per-wallet buy cap for this phase would be exceeded")]
    WalletCapExceeded,
    #[msg("Wallet is still in its per-phase buy cooldown")]
    CooldownActive,
    #[msg("Sell throttle: too much of this wallet's balance sold in the current window")]
    SellThrottled,
    #[msg("Position does not hold enough curve-acquired tokens")]
    InsufficientPositionBalance,
    #[msg("Graduation threshold has not been reached")]
    NotGraduatable,
    #[msg("Pool has already graduated")]
    AlreadyGraduated,
    #[msg("Pool has not graduated yet")]
    NotGraduated,
    #[msg("Flywheel was cranked too recently")]
    FlywheelTooSoon,
    #[msg("Nothing to distribute")]
    NothingToDistribute,
    #[msg("This position has already voted on the phase proposal")]
    AlreadyVoted,
    #[msg("Preference is outside the hard-coded buyback bounds")]
    SplitOutOfBounds,
    #[msg("Vote weight is zero; tenure-weighted balance required")]
    NoVoteWeight,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Vault would drop below rent exemption")]
    VaultUnderflow,
    #[msg("Reserve is insufficient to honour this sell")]
    ReserveInsolvent,
}
