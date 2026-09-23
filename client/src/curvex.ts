/**
 * CurveX client SDK: PDAs, instruction builders, and an off-chain mirror of
 * the on-chain curve math so the CLI can quote a trade before sending it.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
  type Signer,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import * as C from "./constants.ts";
import {
  boolByte,
  decodeCurve,
  decodePosition,
  ixDiscriminator,
  u64le,
  type CurveState,
  type PositionState,
} from "./layout.ts";

export const PROGRAM_ID = new PublicKey("GRSUR1XnXMaiibEntNUQQyhVWLwDchHBwsY7iYZUuhLC");

const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

export function curvePda(mint: PublicKey): PublicKey {
  return pda([C.SEED_CURVE, mint.toBuffer()]);
}

export interface CurveAddresses {
  curve: PublicKey;
  solVault: PublicKey;
  feeVault: PublicKey;
  poolSolVault: PublicKey;
  poolTokenVault: PublicKey;
  loyaltyVault: PublicKey;
}

export function addresses(mint: PublicKey): CurveAddresses {
  const curve = curvePda(mint);
  const b = curve.toBuffer();
  return {
    curve,
    solVault: pda([C.SEED_SOL_VAULT, b]),
    feeVault: pda([C.SEED_FEE_VAULT, b]),
    poolSolVault: pda([C.SEED_POOL_SOL, b]),
    poolTokenVault: pda([C.SEED_POOL_TOKEN, b]),
    loyaltyVault: pda([C.SEED_LOYALTY_VAULT, b]),
  };
}

export function positionPda(curve: PublicKey, owner: PublicKey): PublicKey {
  return pda([C.SEED_POSITION, curve.toBuffer(), owner.toBuffer()]);
}

const meta = (pubkey: PublicKey, isSigner = false, isWritable = false) => ({
  pubkey,
  isSigner,
  isWritable,
});

function ix(keys: ReturnType<typeof meta>[], data: Buffer): TransactionInstruction {
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
}

// --- instruction builders ---------------------------------------------------

export function initializeCurveIx(creator: PublicKey, mint: PublicKey): TransactionInstruction {
  const a = addresses(mint);
  return ix(
    [
      meta(creator, true, true),
      meta(mint, true, true),
      meta(a.curve, false, true),
      meta(a.solVault, false, true),
      meta(a.feeVault, false, true),
      meta(a.poolSolVault, false, true),
      meta(a.loyaltyVault, false, true),
      meta(a.poolTokenVault, false, true),
      meta(TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
      meta(SYSVAR_RENT_PUBKEY),
    ],
    ixDiscriminator("initialize_curve"),
  );
}

export function buyIx(
  buyer: PublicKey,
  mint: PublicKey,
  maxLamports: bigint,
  minTokens: bigint,
): TransactionInstruction {
  const a = addresses(mint);
  return ix(
    [
      meta(buyer, true, true),
      meta(a.curve, false, true),
      meta(mint, false, true),
      meta(getAssociatedTokenAddressSync(mint, buyer), false, true),
      meta(positionPda(a.curve, buyer), false, true),
      meta(a.solVault, false, true),
      meta(a.feeVault, false, true),
      meta(TOKEN_PROGRAM_ID),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
    ],
    Buffer.concat([ixDiscriminator("buy"), u64le(maxLamports), u64le(minTokens)]),
  );
}

export function sellIx(
  seller: PublicKey,
  mint: PublicKey,
  tokens: bigint,
  minLamports: bigint,
): TransactionInstruction {
  const a = addresses(mint);
  return ix(
    [
      meta(seller, true, true),
      meta(a.curve, false, true),
      meta(mint, false, true),
      meta(getAssociatedTokenAddressSync(mint, seller), false, true),
      meta(positionPda(a.curve, seller), false, true),
      meta(seller),
      meta(a.solVault, false, true),
      meta(a.feeVault, false, true),
      meta(TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
    ],
    Buffer.concat([ixDiscriminator("sell"), u64le(tokens), u64le(minLamports)]),
  );
}

export function crankPhaseIx(cranker: PublicKey, mint: PublicKey): TransactionInstruction {
  const a = addresses(mint);
  return ix([meta(cranker, true, false), meta(a.curve, false, true)], ixDiscriminator("crank_phase"));
}

export function castPhaseVoteIx(
  voter: PublicKey,
  mint: PublicKey,
  approve: boolean,
): TransactionInstruction {
  const a = addresses(mint);
  return ix(
    [meta(voter, true, false), meta(a.curve, false, true), meta(positionPda(a.curve, voter), false, true)],
    Buffer.concat([ixDiscriminator("cast_phase_vote"), boolByte(approve)]),
  );
}

export function setSplitPreferenceIx(
  voter: PublicKey,
  mint: PublicKey,
  buybackBps: bigint,
): TransactionInstruction {
  const a = addresses(mint);
  return ix(
    [meta(voter, true, false), meta(a.curve, false, true), meta(positionPda(a.curve, voter), false, true)],
    Buffer.concat([ixDiscriminator("set_split_preference"), u64le(buybackBps)]),
  );
}

export function graduateIx(cranker: PublicKey, mint: PublicKey): TransactionInstruction {
  const a = addresses(mint);
  return ix(
    [
      meta(cranker, true, false),
      meta(a.curve, false, true),
      meta(mint, false, true),
      meta(a.solVault, false, true),
      meta(a.poolSolVault, false, true),
      meta(a.poolTokenVault, false, true),
      meta(TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
    ],
    ixDiscriminator("graduate"),
  );
}

export function swapIx(
  trader: PublicKey,
  mint: PublicKey,
  amountIn: bigint,
  minOut: bigint,
  solToToken: boolean,
): TransactionInstruction {
  const a = addresses(mint);
  return ix(
    [
      meta(trader, true, true),
      meta(a.curve, false, true),
      meta(mint, false, true),
      meta(getAssociatedTokenAddressSync(mint, trader), false, true),
      meta(positionPda(a.curve, trader), false, true),
      meta(a.poolSolVault, false, true),
      meta(a.poolTokenVault, false, true),
      meta(a.feeVault, false, true),
      meta(TOKEN_PROGRAM_ID),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
    ],
    Buffer.concat([
      ixDiscriminator("swap"),
      u64le(amountIn),
      u64le(minOut),
      boolByte(solToToken),
    ]),
  );
}

export function crankFlywheelIx(cranker: PublicKey, mint: PublicKey): TransactionInstruction {
  const a = addresses(mint);
  return ix(
    [
      meta(cranker, true, false),
      meta(a.curve, false, true),
      meta(mint, false, true),
      meta(a.feeVault, false, true),
      meta(a.poolSolVault, false, true),
      meta(a.poolTokenVault, false, true),
      meta(a.loyaltyVault, false, true),
      meta(TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
    ],
    ixDiscriminator("crank_flywheel"),
  );
}

export function claimRewardsIx(owner: PublicKey, mint: PublicKey): TransactionInstruction {
  const a = addresses(mint);
  return ix(
    [
      meta(owner, true, true),
      meta(a.curve, false, true),
      meta(positionPda(a.curve, owner), false, true),
      meta(a.loyaltyVault, false, true),
      meta(SystemProgram.programId),
    ],
    ixDiscriminator("claim_rewards"),
  );
}

// --- reads ------------------------------------------------------------------

export async function fetchCurve(conn: Connection, mint: PublicKey): Promise<CurveState> {
  const info = await conn.getAccountInfo(curvePda(mint), "confirmed");
  if (!info) throw new Error(`no curve for mint ${mint.toBase58()}`);
  return decodeCurve(info.data);
}

export async function fetchPosition(
  conn: Connection,
  mint: PublicKey,
  owner: PublicKey,
): Promise<PositionState | null> {
  const info = await conn.getAccountInfo(positionPda(curvePda(mint), owner), "confirmed");
  return info ? decodePosition(info.data) : null;
}

export async function send(
  conn: Connection,
  ixs: TransactionInstruction[],
  payer: Keypair,
  extra: Signer[] = [],
): Promise<string> {
  const tx = new Transaction().add(...ixs);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = payer.publicKey;
  tx.sign(payer, ...extra);
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  const res = await conn.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  if (res.value.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(res.value.err)}`);
  return sig;
}
