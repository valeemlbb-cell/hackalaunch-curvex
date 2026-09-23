/**
 * The full ladder, end to end: Seeding -> Discovery -> Acceleration ->
 * Graduating -> Perpetual, then the locked pool and the fee flywheel.
 *
 * This is the expensive test. It drives ~70 wallets through the real
 * per-phase wallet caps (which is the only way to reach 640,000,000 tokens
 * sold), calls the permissionless `graduate`, and then proves the three claims
 * the submission rests on:
 *
 *   1. the mint authority is revoked at graduation, so supply is frozen;
 *   2. the pool has no withdraw path — only `swap` and the flywheel's buyback
 *      can move its reserves, and the constant product never decreases;
 *   3. the flywheel keeps running after the DEX, burning supply and paying
 *      tenured holders.
 */

import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";
import type { Keypair } from "@solana/web3.js";

import { C, Ctx, ERR, cx, expectError } from "./harness.ts";

/** Phase ordinals, mirroring `state::Phase`. */
const SEEDING = 0;
const DISCOVERY = 1;
const ACCELERATION = 2;
const GRADUATING = 3;
const PERPETUAL = 4;

const LAMPORTS = 1_000_000_000n;

describe("graduation and the perpetual flywheel", { concurrency: false }, () => {
  let ctx: Ctx;
  let whale: Keypair;
  let reserveAtGraduation = 0n;

  before(async () => {
    ctx = await Ctx.launch();
  });

  it("walks Seeding to Discovery one capped wallet at a time", async () => {
    assert.equal((await ctx.state()).phase, SEEDING);

    // 80,000,000 tokens at a 2,000,000 cap per wallet: 40 wallets, minimum.
    const buyers = await ctx.wallets(40, 2);
    for (const w of buyers) {
      if ((await ctx.state()).tokensSold >= C.P0_END) break;
      await ctx.buy(w, 1);
    }

    const s = await ctx.state();
    assert.ok(s.tokensSold >= C.P0_END, `sold ${s.tokensSold} < ${C.P0_END}`);
    assert.equal(s.phase, DISCOVERY, "supply target advanced the ladder on its own");
    assert.ok(s.holderCount >= 40n, `every capped buyer counted: ${s.holderCount}`);
    assert.equal(s.lastTransitionSlot > s.launchSlot, true);
  });

  it("accepts a tenured holder's phase vote in Discovery and rejects a double vote", async () => {
    const voter = await ctx.wallet(10);
    await ctx.buy(voter, 2);
    await ctx.waitSlots(120); // accrue non-zero tenure weight

    await ctx.vote(voter, true);
    const s = await ctx.state();
    assert.ok(s.phaseVoteYes > 0n, "a yes vote was recorded with real weight");

    await expectError(ctx.vote(voter, true), ERR.AlreadyVoted, "second vote from one position");
  });

  it("does not let a small vote pass the quorum on its own", async () => {
    const s = await ctx.state();
    const quorum = (s.totalPositionBalance * C.PHASE_VOTE_QUORUM_BPS) / C.BPS_DENOM;
    assert.ok(
      s.phaseVoteYes < quorum,
      `one fresh 2M position must not reach the ${C.PHASE_VOTE_QUORUM_BPS} bps quorum`,
    );
    assert.equal(s.phaseVotePassed, false);
    assert.equal(s.phase, DISCOVERY, "still Discovery — the vote did not carry");
  });

  it("walks Discovery to Acceleration under the wider cap", async () => {
    // 300,000,000 - 80,000,000 = 220,000,000 at an 8,000,000 cap: 28 wallets.
    const buyers = await ctx.wallets(30, 4);
    for (const w of buyers) {
      if ((await ctx.state()).tokensSold >= C.P1_END) break;
      await ctx.buy(w, 3);
    }

    const s = await ctx.state();
    assert.ok(s.tokensSold >= C.P1_END, `sold ${s.tokensSold} < ${C.P1_END}`);
    assert.equal(s.phase, ACCELERATION, "supply target advanced the ladder again");
  });

  it("lifts caps and cooldowns in Acceleration and reaches the graduation threshold", async () => {
    whale = await ctx.wallet(160);
    // No cap and no cooldown here, so one transaction can finish the curve.
    // The fill is still clipped to the segment end, never past it.
    await ctx.buy(whale, 140);

    const s = await ctx.state();
    assert.equal(s.tokensSold, C.P2_END, "the fill stopped exactly at the graduation threshold");
    assert.equal(s.phase, GRADUATING, "curve is closed, migration is pending");
    assert.ok((await ctx.tokenBalance(whale.publicKey)) > C.P1_WALLET_CAP, "no cap applied");

    reserveAtGraduation = s.reserveLamports;
    assert.ok(reserveAtGraduation > 50n * LAMPORTS, `reserve looks real: ${reserveAtGraduation}`);
  });

  it("refuses further curve trades once the curve is closed", async () => {
    const late = await ctx.wallet(10);
    await expectError(ctx.buy(late, 1), ERR.WrongPhase, "buy after the curve closed");
  });

  it("lets ANY wallet graduate, moves the whole reserve, and revokes the mint authority", async () => {
    assert.equal(await ctx.mintAuthorityRevoked(), false, "authority still held before graduation");
    const supplyBefore = await ctx.mintSupply();

    // A stranger with no position and no relationship to the creator.
    const stranger = await ctx.wallet(5);
    await ctx.graduate(stranger);

    const s = await ctx.state();
    assert.equal(s.graduated, true);
    assert.equal(s.phase, PERPETUAL);
    assert.equal(s.reserveLamports, 0n, "the curve reserve is fully drained into the pool");
    assert.equal(s.poolSolReserve, reserveAtGraduation, "every lamport landed in the pool");
    assert.equal(s.poolTokenReserve, C.LP_SUPPLY);

    assert.equal(await ctx.mintAuthorityRevoked(), true, "supply is frozen forever");
    assert.equal(
      await ctx.mintSupply(),
      supplyBefore + C.LP_SUPPLY,
      "exactly the LP allocation was minted, nothing else",
    );

    const a = cx.addresses(ctx.mint);
    assert.ok(
      (await ctx.lamports(a.poolSolVault)) >= s.poolSolReserve,
      "pool vault actually holds the accounted reserve",
    );
  });

  it("cannot be graduated twice", async () => {
    const stranger = await ctx.wallet(2);
    await expectError(ctx.graduate(stranger), ERR.AlreadyGraduated, "second graduation");
  });

  it("swaps against the locked pool without ever decreasing the constant product", async () => {
    const before = await ctx.state();
    const kBefore = before.poolSolReserve * before.poolTokenReserve;

    const trader = await ctx.wallet(20);
    const tokensBefore = await ctx.tokenBalance(trader.publicKey);
    await ctx.swap(trader, 5n * LAMPORTS, true);
    const tokensAfter = await ctx.tokenBalance(trader.publicKey);
    assert.ok(tokensAfter > tokensBefore, "the swap delivered tokens");

    const after = await ctx.state();
    const kAfter = after.poolSolReserve * after.poolTokenReserve;
    assert.ok(kAfter >= kBefore, `constant product must not fall: ${kBefore} -> ${kAfter}`);
    assert.ok(after.poolSolReserve > before.poolSolReserve, "pool gained SOL");
    assert.ok(after.poolTokenReserve < before.poolTokenReserve, "pool released tokens");

    // Half of the swap fee left the pool for the flywheel; the rest stayed in
    // and permanently deepened liquidity.
    const feeVault = await ctx.lamports(cx.addresses(ctx.mint).feeVault);
    assert.ok(feeVault > 0n, "fee vault is funded for the flywheel");
  });

  it("rejects a swap that cannot meet min_out", async () => {
    const trader = await ctx.wallet(10);
    await expectError(
      ctx.swap(trader, LAMPORTS / 100n, true, C.LP_SUPPLY),
      ERR.SlippageExceeded,
      "swap min_out",
    );
  });

  it("refuses to crank the flywheel before its interval has elapsed", async () => {
    const cranker = await ctx.wallet(2);
    await expectError(ctx.flywheel(cranker), ERR.FlywheelTooSoon, "early crank");
  });

  it("burns supply and funds the loyalty index on the first legal crank", async () => {
    const before = await ctx.state();

    // FLYWHEEL_INTERVAL_SLOTS since graduation, waited in chunks so a slow
    // validator cannot trip the per-call polling budget.
    const target = Number(C.FLYWHEEL_INTERVAL_SLOTS) + 60;
    for (let waited = 0; waited < target; waited += 2_000) {
      await ctx.waitSlots(Math.min(2_000, target - waited));
    }

    const cranker = await ctx.wallet(2);
    await ctx.flywheel(cranker);

    const after = await ctx.state();
    assert.equal(after.flywheelCranks, before.flywheelCranks + 1n);
    assert.ok(after.totalBurned > 0n, "buyback-and-burn actually burned supply");
    assert.ok(
      after.poolTokenReserve < before.poolTokenReserve,
      "burned tokens came out of the pool",
    );
    assert.ok(after.poolSolReserve > before.poolSolReserve, "the buyback SOL stayed in the pool");
    assert.ok(after.totalLoyaltyLamports > 0n, "the remainder funded the loyalty index");
    assert.ok(after.rewardIndex > 0n, "reward index advanced");

    // Supply really shrank — this is only possible because nothing can mint.
    const supply = await ctx.mintSupply();
    assert.equal(await ctx.mintAuthorityRevoked(), true);
    assert.ok(supply < C.P2_END + C.LP_SUPPLY, `supply shrank to ${supply}`);
  });

  it("refuses a second crank inside the same interval", async () => {
    const cranker = await ctx.wallet(2);
    await expectError(ctx.flywheel(cranker), ERR.FlywheelTooSoon, "back-to-back crank");
  });

  it("pays a tenured holder out of the loyalty vault", async () => {
    const before = await cx.fetchPosition(ctx.conn, ctx.mint, whale.publicKey);
    assert.ok(before && before.balance > 0n, "the whale still holds its curve position");

    const solBefore = await ctx.lamports(whale.publicKey);
    await ctx.claim(whale);
    const solAfter = await ctx.lamports(whale.publicKey);

    const after = await cx.fetchPosition(ctx.conn, ctx.mint, whale.publicKey);
    assert.ok(after!.rewardsClaimed > 0n, "a non-zero reward was recorded");
    assert.ok(solAfter > solBefore, "lamports actually reached the holder");
  });

  it("pays nothing to a wallet with no accrued index", async () => {
    const latecomer = await ctx.wallet(5);
    await ctx.swap(latecomer, LAMPORTS, true); // opens a position at the current index
    await expectError(
      ctx.claim(latecomer),
      ERR.NothingToDistribute,
      "claim with nothing accrued",
    );
  });

  it("clamps the buyback split vote to its hard bounds", async () => {
    await expectError(
      ctx.setSplit(whale, C.MAX_BUYBACK_BPS + 1n),
      ERR.SplitOutOfBounds,
      "split above the ceiling",
    );
    await expectError(
      ctx.setSplit(whale, C.MIN_BUYBACK_BPS - 1n),
      ERR.SplitOutOfBounds,
      "split below the floor",
    );

    await ctx.setSplit(whale, 7_000n);
    const s = await ctx.state();
    assert.ok(s.splitWeightSum > 0n, "the preference was recorded with tenure weight");
  });
});
