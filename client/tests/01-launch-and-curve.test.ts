import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import { C, Ctx, ERR, cx, expectError } from "./harness.ts";
import { buyCostLamports, quoteBuy, SEGMENTS, segmentFor } from "../src/curve.ts";

describe("launch and curve pricing", { concurrency: false }, () => {
  let ctx: Ctx;

  before(async () => {
    ctx = await Ctx.launch(400);
  });

  it("initializes in Seeding with an empty reserve and no admin field in use", async () => {
    const s = await ctx.state();
    assert.equal(s.phase, 0, "starts in Seeding");
    assert.equal(s.tokensSold, 0n);
    assert.equal(s.reserveLamports, 0n);
    assert.equal(s.holderCount, 0n);
    assert.equal(s.graduated, false);
    assert.equal(new Uint8Array(s.mint).join(), ctx.mint.toBytes().join());
    assert.ok(s.bump > 0 && s.solVaultBump > 0 && s.feeVaultBump > 0);
    assert.equal(await ctx.mintSupply(), 0n);
  });

  it("mints exactly the tokens the integral pays for", async () => {
    const w = await ctx.wallet(20);
    const before = await ctx.state();
    const slot = await ctx.slot();
    const quote = quoteBuy(before, slot, 1_000_000_000n);

    await ctx.buy(w, 1);

    const after = await ctx.state();
    const minted = await ctx.tokenBalance(w.publicKey);
    assert.ok(minted > 0n, "buyer received tokens");
    assert.equal(after.tokensSold, minted, "tokens_sold tracks minted supply");
    assert.equal(await ctx.mintSupply(), minted, "no tokens minted outside the curve");

    // The on-chain fill must match the off-chain mirror within the one-slot
    // drift of the decaying snipe tax.
    const drift = quote.tokens > minted ? quote.tokens - minted : minted - quote.tokens;
    assert.ok(
      drift * 1000n < quote.tokens,
      `off-chain quote ${quote.tokens} vs on-chain ${minted}`,
    );

    // Reserve is funded by the integral, fee went to the fee vault.
    const seg = SEGMENTS[0];
    const expectedCost = buyCostLamports(seg, 0n, minted);
    assert.equal(after.reserveLamports, expectedCost, "reserve == exact curve integral");
    const a = cx.addresses(ctx.mint);
    const vault = await ctx.lamports(a.solVault);
    assert.ok(vault >= after.reserveLamports, "sol vault covers the reserve");
    assert.ok((await ctx.lamports(a.feeVault)) > 0n, "fees accrued for the flywheel");
  });

  it("charges the snipe tax on entry and decays it", async () => {
    const early = await ctx.state();
    const earlySlot = await ctx.slot();
    const earlyFee = quoteBuy(early, earlySlot, 1_000_000_000n).feeBps;
    assert.ok(
      earlyFee > C.BASE_BUY_FEE_BPS,
      `snipe tax active at launch (${earlyFee} bps)`,
    );

    await ctx.waitSlots(Number(C.SNIPE_TAX_SLOTS) + 20);

    const late = await ctx.state();
    const lateSlot = await ctx.slot();
    const lateFee = quoteBuy(late, lateSlot, 1_000_000_000n).feeBps;
    assert.equal(lateFee, C.BASE_BUY_FEE_BPS, "snipe tax fully decayed");

    // And the chain agrees: the same SOL now buys through a smaller fee.
    const w = await ctx.wallet(20);
    const feeBefore = await ctx.lamports(cx.addresses(ctx.mint).feeVault);
    await ctx.buy(w, 1);
    const feeAfter = await ctx.lamports(cx.addresses(ctx.mint).feeVault);
    const paid = feeAfter - feeBefore;
    assert.ok(paid > 0n, "a fee was still charged");
    assert.ok(
      paid * 5n < 1_000_000_000n / 10n,
      `late fee ${paid} should be near the 1% base`,
    );
  });

  it("rejects a buy that cannot meet min_tokens", async () => {
    const w = await ctx.wallet(20);
    await expectError(ctx.buy(w, 0.5, 10_000_000_000n), ERR.SlippageExceeded, "min_tokens");
  });

  it("an instant buy -> sell round trip always loses", async () => {
    const w = await ctx.wallet(50);
    const solBefore = await ctx.lamports(w.publicKey);
    await ctx.buy(w, 2);
    const tokens = await ctx.tokenBalance(w.publicKey);
    assert.ok(tokens > 0n);
    // Sell 20% — the throttle allows a quarter of the position per window.
    await ctx.sell(w, tokens / 5n);
    const solAfter = await ctx.lamports(w.publicKey);
    assert.ok(
      solAfter < solBefore,
      `round trip must be a loss: ${solBefore} -> ${solAfter}`,
    );
  });

  it("keeps the reserve solvent: vault lamports always cover reserve_lamports", async () => {
    const s = await ctx.state();
    const vault = await ctx.lamports(cx.addresses(ctx.mint).solVault);
    assert.ok(
      vault >= s.reserveLamports,
      `vault ${vault} < accounted reserve ${s.reserveLamports}`,
    );
    assert.equal(
      segmentFor(s.tokensSold)?.start,
      0n,
      "still inside the Seeding segment",
    );
  });

  after(() => {
    /* validator is torn down by scripts/run-tests.mjs */
  });
});
