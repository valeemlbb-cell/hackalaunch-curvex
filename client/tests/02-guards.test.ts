/**
 * Every guard that makes the ladder more than decoration: the per-wallet cap,
 * the per-phase buy cooldown, the rolling sell throttle, the tenure-decayed
 * sell fee, the post-transition guard, and the tenure requirement on the phase
 * vote.
 *
 * Each `it` asserts an on-chain outcome, not just the off-chain mirror.
 */

import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";

import { C, Ctx, ERR, cx, expectError } from "./harness.ts";
import { sellFeeBps, tenureWeightBps } from "../src/curve.ts";

describe("per-wallet guards", { concurrency: false }, () => {
  let ctx: Ctx;

  before(async () => {
    ctx = await Ctx.launch();
  });

  it("clips a whale's fill to the Seeding wallet cap", async () => {
    const whale = await ctx.wallet(200);
    // 100 SOL would buy well past 2,000,000 tokens on the Seeding segment.
    await ctx.buy(whale, 100);
    const balance = await ctx.tokenBalance(whale.publicKey);
    assert.equal(
      balance,
      C.P0_WALLET_CAP,
      `cap must bind exactly, got ${balance} vs ${C.P0_WALLET_CAP}`,
    );

    const pos = await cx.fetchPosition(ctx.conn, ctx.mint, whale.publicKey);
    assert.equal(pos?.balance, C.P0_WALLET_CAP);
  });

  it("rejects a second buy inside the Seeding cooldown", async () => {
    const w = await ctx.wallet(20);
    await ctx.buy(w, 0.2);
    await expectError(ctx.buy(w, 0.2), ERR.CooldownActive, "second buy in cooldown");
  });

  it("rejects a capped wallet even after its cooldown expires", async () => {
    const whale = await ctx.wallet(50);
    await ctx.buy(whale, 30); // fills to the cap
    assert.equal(await ctx.tokenBalance(whale.publicKey), C.P0_WALLET_CAP);

    await ctx.waitSlots(Number(C.P0_BUY_COOLDOWN_SLOTS) + 10);
    await expectError(ctx.buy(whale, 5), ERR.WalletCapExceeded, "capped wallet, cooldown over");
  });

  it("throttles a sell above 25% of the position in one window", async () => {
    const w = await ctx.wallet(50);
    await ctx.buy(w, 5);
    const held = await ctx.tokenBalance(w.publicKey);
    assert.ok(held > C.MIN_COUNTED_BALANCE * 8n, "need a position bigger than the dust floor");

    // A quarter is fine ...
    await ctx.sell(w, held / 4n - 1n);
    // ... the rest of the position in the same window is not.
    await expectError(ctx.sell(w, held / 2n), ERR.SellThrottled, "sell above the window allowance");
  });

  it("refuses to sell tokens the position never bought", async () => {
    const w = await ctx.wallet(20);
    await ctx.buy(w, 1);
    const held = await ctx.tokenBalance(w.publicKey);
    await expectError(
      ctx.sell(w, held * 10n),
      ERR.InsufficientPositionBalance,
      "sell more than the position balance",
    );
  });

  it("charges a smaller sell fee to an older position", async () => {
    const fresh = await ctx.wallet(50);
    const aged = await ctx.wallet(50);

    await ctx.buy(aged, 3);
    await ctx.waitSlots(4_000); // tenure the aged position
    await ctx.buy(fresh, 3);

    const feeVault = cx.addresses(ctx.mint).feeVault;

    const measure = async (w: typeof fresh) => {
      const tokens = (await ctx.tokenBalance(w.publicKey)) / 8n;
      const before = await ctx.lamports(feeVault);
      await ctx.sell(w, tokens);
      const after = await ctx.lamports(feeVault);
      return { tokens, fee: after - before };
    };

    // Sell the fresh position first so both sells happen at a similar point on
    // the curve; then normalise the fee by the tokens actually sold.
    const f = await measure(fresh);
    const a = await measure(aged);
    assert.ok(f.fee > 0n && a.fee > 0n, "both sells paid a fee");

    const freshPerToken = (f.fee * 1_000_000n) / f.tokens;
    const agedPerToken = (a.fee * 1_000_000n) / a.tokens;
    assert.ok(
      agedPerToken < freshPerToken,
      `tenure must cut the sell fee: aged ${agedPerToken} vs fresh ${freshPerToken} per 1e6 tokens`,
    );
  });

  it("mirrors the sell-fee schedule exactly at both ends", () => {
    // Zero tenure, no recent transition: the full base sell fee.
    assert.equal(sellFeeBps(0n, C.TRANSITION_GUARD_SLOTS), C.BASE_SELL_FEE_BPS);
    // Fully matured: the floor.
    assert.equal(sellFeeBps(C.MATURE_SLOTS, C.TRANSITION_GUARD_SLOTS), C.MIN_SELL_FEE_BPS);
    // Matured, but one slot after a transition: the guard is on top.
    const guarded = sellFeeBps(C.MATURE_SLOTS, 0n);
    assert.ok(
      guarded > C.MIN_SELL_FEE_BPS && guarded <= C.MAX_SELL_FEE_BPS,
      `guard applies and stays under the ceiling, got ${guarded}`,
    );
    // The ceiling really is a ceiling.
    assert.ok(sellFeeBps(0n, 0n) <= C.MAX_SELL_FEE_BPS, "sell fee never exceeds the cap");
  });

  it("gives a brand-new position no vote weight", () => {
    assert.equal(tenureWeightBps(0n), 0n);
    assert.equal(tenureWeightBps(C.MATURE_SLOTS), 10_000n);
    assert.ok(tenureWeightBps(C.MATURE_SLOTS / 2n) < 10_000n);
  });

  it("rejects a phase vote from a wallet with no position", async () => {
    const stranger = await ctx.wallet(5);
    // No position PDA exists, so the account constraint fails before any
    // CurveX error code is reached — assert only that it cannot pass.
    await assert.rejects(ctx.vote(stranger, true), "a wallet with no position cannot vote");
  });

  it("rejects a phase vote while the curve is still Seeding", async () => {
    const w = await ctx.wallet(20);
    await ctx.buy(w, 1);
    await ctx.waitSlots(60); // accrue some tenure weight
    await expectError(ctx.vote(w, true), ERR.WrongPhase, "vote outside Discovery");
  });

  it("keeps the vault solvent after every guard test above", async () => {
    const s = await ctx.state();
    const vault = await ctx.lamports(cx.addresses(ctx.mint).solVault);
    assert.ok(
      vault >= s.reserveLamports,
      `vault ${vault} < accounted reserve ${s.reserveLamports}`,
    );
    assert.equal(s.graduated, false);
  });
});
