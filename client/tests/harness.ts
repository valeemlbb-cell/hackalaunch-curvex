/**
 * Shared fixtures for the integration suite. Every test file launches its own
 * curve, so files are independent and can run concurrently.
 */

import { readFileSync } from "node:fs";
import { Agent } from "node:http";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

import * as C from "../src/constants.ts";
import * as cx from "../src/curvex.ts";
import { decodeCurve, type CurveState } from "../src/layout.ts";

export const RPC = process.env.CURVEX_RPC_URL ?? "http://127.0.0.1:8899";

/**
 * web3.js opens a fresh TCP connection per RPC call. This suite polls the
 * validator hard enough (slot waits, confirmations, account reads) to exhaust
 * the ephemeral port range within about 30 seconds on Windows — every socket
 * then sits in TIME_WAIT and the next call dies with ECONNRESET, which looks
 * exactly like the validator crashing. One pooled keep-alive agent fixes it.
 */
const AGENT = new Agent({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 5_000 });

/** CurveX error codes; Anchor offsets custom errors by 6000. */
export const ERR = {
  CurveExhausted: 6000,
  WrongPhase: 6001,
  ZeroFill: 6002,
  SlippageExceeded: 6003,
  WalletCapExceeded: 6004,
  CooldownActive: 6005,
  SellThrottled: 6006,
  InsufficientPositionBalance: 6007,
  NotGraduatable: 6008,
  AlreadyGraduated: 6009,
  NotGraduated: 6010,
  FlywheelTooSoon: 6011,
  NothingToDistribute: 6012,
  AlreadyVoted: 6013,
  SplitOutOfBounds: 6014,
  NoVoteWeight: 6015,
} as const;

export class Ctx {
  conn: Connection;
  bank!: Keypair;
  mint!: PublicKey;
  creator!: Keypair;

  constructor() {
    this.conn = new Connection(RPC, { commitment: "confirmed", httpAgent: AGENT });
  }

  static async launch(_bankSol = 4000): Promise<Ctx> {
    const ctx = new Ctx();
    ctx.bank = ctx.loadBank();
    ctx.creator = await ctx.wallet(5);
    const mintKp = Keypair.generate();
    await cx.send(
      ctx.conn,
      [cx.initializeCurveIx(ctx.creator.publicKey, mintKp.publicKey)],
      ctx.creator,
      [mintKp],
    );
    ctx.mint = mintKp.publicKey;
    return ctx;
  }

  /** `requestAirdrop` is capped per request and far too slow for a suite that
   *  needs ~110 SOL of fills, so tests spend the local validator's own faucet
   *  account directly and hand out lamports with plain system transfers. */
  private loadBank(): Keypair {
    const path = process.env.CURVEX_FAUCET_KEYPAIR;
    if (!path) throw new Error("CURVEX_FAUCET_KEYPAIR is not set; run `npm test`");
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
  }

  /** A funded wallet, paid for out of the bank. */
  async wallet(sol: number): Promise<Keypair> {
    const kp = Keypair.generate();
    await this.transferMany([[kp.publicKey, Math.round(sol * LAMPORTS_PER_SOL)]]);
    return kp;
  }

  /** Fund up to 12 wallets in one transaction. */
  async wallets(count: number, sol: number): Promise<Keypair[]> {
    const out: Keypair[] = [];
    for (let i = 0; i < count; i += 12) {
      const batch = Array.from({ length: Math.min(12, count - i) }, () => Keypair.generate());
      await this.transferMany(
        batch.map((kp) => [kp.publicKey, Math.round(sol * LAMPORTS_PER_SOL)] as [PublicKey, number]),
      );
      out.push(...batch);
    }
    return out;
  }

  private async transferMany(pairs: [PublicKey, number][]) {
    const tx = new Transaction();
    for (const [to, lamports] of pairs) {
      tx.add(SystemProgram.transfer({ fromPubkey: this.bank.publicKey, toPubkey: to, lamports }));
    }
    await cx.send(this.conn, tx.instructions, this.bank);
  }

  curveKey(): PublicKey {
    return cx.curvePda(this.mint);
  }

  async state(): Promise<CurveState> {
    return cx.fetchCurve(this.conn, this.mint);
  }

  async slot(): Promise<bigint> {
    return BigInt(await this.conn.getSlot("confirmed"));
  }

  /** Wait for `n` slots to pass. Polls at 150ms: the validator runs ~30
   *  slots/s under `--ticks-per-slot 2`, so anything tighter just burns
   *  sockets without seeing the target sooner. */
  async waitSlots(n: number) {
    const target = (await this.conn.getSlot("confirmed")) + n;
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      if ((await this.conn.getSlot("confirmed")) >= target) return;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`timed out waiting for ${n} slots`);
  }

  async tokenBalance(owner: PublicKey): Promise<bigint> {
    const ata = getAssociatedTokenAddressSync(this.mint, owner);
    const info = await this.conn.getAccountInfo(ata, "confirmed");
    if (!info) return 0n;
    return info.data.readBigUInt64LE(64) / C.TOKEN_UNIT;
  }

  async mintSupply(): Promise<bigint> {
    const info = await this.conn.getAccountInfo(this.mint, "confirmed");
    return info!.data.readBigUInt64LE(36) / C.TOKEN_UNIT;
  }

  /** `true` once graduation has revoked the mint authority. */
  async mintAuthorityRevoked(): Promise<boolean> {
    const info = await this.conn.getAccountInfo(this.mint, "confirmed");
    return info!.data.readUInt32LE(0) === 0;
  }

  async lamports(key: PublicKey): Promise<bigint> {
    const info = await this.conn.getAccountInfo(key, "confirmed");
    return BigInt(info?.lamports ?? 0);
  }

  async buy(w: Keypair, sol: number, minTokens = 0n) {
    return cx.send(
      this.conn,
      [cx.buyIx(w.publicKey, this.mint, BigInt(Math.round(sol * LAMPORTS_PER_SOL)), minTokens)],
      w,
    );
  }

  async sell(w: Keypair, tokens: bigint, minLamports = 0n) {
    return cx.send(this.conn, [cx.sellIx(w.publicKey, this.mint, tokens, minLamports)], w);
  }

  async crank(w: Keypair) {
    return cx.send(this.conn, [cx.crankPhaseIx(w.publicKey, this.mint)], w);
  }

  async graduate(w: Keypair) {
    return cx.send(this.conn, [cx.graduateIx(w.publicKey, this.mint)], w);
  }

  async swap(w: Keypair, amountIn: bigint, solToToken: boolean, minOut = 0n) {
    return cx.send(
      this.conn,
      [cx.swapIx(w.publicKey, this.mint, amountIn, minOut, solToToken)],
      w,
    );
  }

  async flywheel(w: Keypair) {
    return cx.send(this.conn, [cx.crankFlywheelIx(w.publicKey, this.mint)], w);
  }

  async claim(w: Keypair) {
    return cx.send(this.conn, [cx.claimRewardsIx(w.publicKey, this.mint)], w);
  }

  async vote(w: Keypair, approve: boolean) {
    return cx.send(this.conn, [cx.castPhaseVoteIx(w.publicKey, this.mint, approve)], w);
  }

  async setSplit(w: Keypair, bps: bigint) {
    return cx.send(this.conn, [cx.setSplitPreferenceIx(w.publicKey, this.mint, bps)], w);
  }
}

/** Assert that a transaction failed with a specific CurveX error code. */
export async function expectError(
  promise: Promise<unknown>,
  code: number,
  what: string,
): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const text = JSON.stringify((err as { logs?: string[] }).logs ?? "") + String(err);
    if (!text.includes(String(code))) {
      throw new Error(`${what}: expected error ${code}, got:\n${text.slice(0, 1200)}`);
    }
    return;
  }
  throw new Error(`${what}: expected the transaction to fail with ${code}, it succeeded`);
}

export { cx, C, decodeCurve };
