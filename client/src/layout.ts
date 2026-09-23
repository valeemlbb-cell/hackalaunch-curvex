/**
 * Hand-written wire format for the CurveX program.
 *
 * The Anchor CLI is not part of this toolchain (the program is built with
 * `cargo build --target sbpfv1-solana-solana`), so instead of shipping a
 * generated IDL we encode Anchor's wire format directly. It is small, fully
 * specified, and `client/tests/layout.test.ts` pins every offset against the
 * Rust structs.
 *
 * Anchor discriminators:
 *   instruction  = sha256("global:<snake_case_name>")[0..8]
 *   account      = sha256("account:<StructName>")[0..8]
 */

import { createHash } from "node:crypto";

export function ixDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

export function accountDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

/** Little-endian borsh reader. */
export class Reader {
  private offset = 0;
  private readonly buf: Buffer;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  skip(n: number): this {
    this.offset += n;
    return this;
  }
  u8(): number {
    return this.buf.readUInt8(this.offset++);
  }
  bool(): boolean {
    return this.u8() !== 0;
  }
  u64(): bigint {
    const v = this.buf.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }
  u128(): bigint {
    const lo = this.buf.readBigUInt64LE(this.offset);
    const hi = this.buf.readBigUInt64LE(this.offset + 8);
    this.offset += 16;
    return (hi << 64n) | lo;
  }
  pubkey(): Buffer {
    const v = this.buf.subarray(this.offset, this.offset + 32);
    this.offset += 32;
    return v;
  }
  get pos(): number {
    return this.offset;
  }
}

export function u64le(value: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return b;
}

export function boolByte(value: boolean): Buffer {
  return Buffer.from([value ? 1 : 0]);
}

export const PHASE_NAMES = [
  "Seeding",
  "Discovery",
  "Acceleration",
  "Graduating",
  "Perpetual",
] as const;

export const CAUSE_NAMES = [
  "None",
  "SupplyTarget",
  "HolderTarget",
  "TimeBackstop",
  "VolumeTarget",
  "HolderVote",
  "GraduationThreshold",
  "Migrated",
] as const;

/** Mirrors `state::Curve`. */
export interface CurveState {
  creator: Buffer;
  mint: Buffer;
  bump: number;
  solVaultBump: number;
  feeVaultBump: number;
  poolSolBump: number;
  loyaltyBump: number;
  phase: number;
  lastTransitionCause: number;
  launchSlot: bigint;
  lastTransitionSlot: bigint;
  tokensSold: bigint;
  reserveLamports: bigint;
  volumeLamports: bigint;
  holderCount: bigint;
  totalPositionBalance: bigint;
  phaseVoteYes: bigint;
  phaseVoteNo: bigint;
  phaseVotePassed: boolean;
  splitWeightSum: bigint;
  splitWeightedSum: bigint;
  graduated: boolean;
  graduatedSlot: bigint;
  poolSolReserve: bigint;
  poolTokenReserve: bigint;
  lastFlywheelSlot: bigint;
  flywheelCranks: bigint;
  totalBurned: bigint;
  totalBuybackLamports: bigint;
  totalLoyaltyLamports: bigint;
  rewardIndex: bigint;
}

export function decodeCurve(data: Buffer): CurveState {
  const expected = accountDiscriminator("Curve");
  if (!data.subarray(0, 8).equals(expected)) {
    throw new Error("not a CurveX Curve account");
  }
  const r = new Reader(data).skip(8) as Reader;
  return {
    creator: r.pubkey(),
    mint: r.pubkey(),
    bump: r.u8(),
    solVaultBump: r.u8(),
    feeVaultBump: r.u8(),
    poolSolBump: r.u8(),
    loyaltyBump: r.u8(),
    phase: r.u8(),
    lastTransitionCause: r.u8(),
    launchSlot: r.u64(),
    lastTransitionSlot: r.u64(),
    tokensSold: r.u64(),
    reserveLamports: r.u64(),
    volumeLamports: r.u64(),
    holderCount: r.u64(),
    totalPositionBalance: r.u64(),
    phaseVoteYes: r.u128(),
    phaseVoteNo: r.u128(),
    phaseVotePassed: r.bool(),
    splitWeightSum: r.u128(),
    splitWeightedSum: r.u128(),
    graduated: r.bool(),
    graduatedSlot: r.u64(),
    poolSolReserve: r.u64(),
    poolTokenReserve: r.u64(),
    lastFlywheelSlot: r.u64(),
    flywheelCranks: r.u64(),
    totalBurned: r.u64(),
    totalBuybackLamports: r.u64(),
    totalLoyaltyLamports: r.u64(),
    rewardIndex: r.u128(),
  };
}

/** Mirrors `state::Position`. */
export interface PositionState {
  owner: Buffer;
  curve: Buffer;
  bump: number;
  balance: bigint;
  weightedAcqSlot: bigint;
  lastBuySlot: bigint;
  sellWindowStart: bigint;
  sellWindowBase: bigint;
  soldInWindow: bigint;
  votedPhase: boolean;
  preferredBuybackBps: bigint;
  splitVoteWeight: bigint;
  rewardIndexSnapshot: bigint;
  rewardsClaimed: bigint;
}

export function decodePosition(data: Buffer): PositionState {
  const expected = accountDiscriminator("Position");
  if (!data.subarray(0, 8).equals(expected)) {
    throw new Error("not a CurveX Position account");
  }
  const r = new Reader(data).skip(8) as Reader;
  return {
    owner: r.pubkey(),
    curve: r.pubkey(),
    bump: r.u8(),
    balance: r.u64(),
    weightedAcqSlot: r.u64(),
    lastBuySlot: r.u64(),
    sellWindowStart: r.u64(),
    sellWindowBase: r.u64(),
    soldInWindow: r.u64(),
    votedPhase: r.bool(),
    preferredBuybackBps: r.u64(),
    splitVoteWeight: r.u128(),
    rewardIndexSnapshot: r.u128(),
    rewardsClaimed: r.u64(),
  };
}
