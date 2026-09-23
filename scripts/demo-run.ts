/**
 * Drive one full CurveX lifecycle against a running validator and capture the
 * REAL CLI output at every milestone.
 *
 *   CURVEX_RPC_URL=... CURVEX_FAUCET_KEYPAIR=... node scripts/demo-run.ts <outDir>
 *
 * Nothing here is staged: the phase walk buys through the real per-wallet caps
 * and cooldowns, and every screen written to <outDir> is the verbatim stdout of
 * `node client/src/cli.ts ...` run against the chain as it stands at that
 * moment. `scripts/record-demo.mjs` renders those files into the video, so the
 * video cannot drift from what the program actually does.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";

import * as C from "../client/src/constants.ts";
import { Ctx } from "../client/tests/harness.ts";

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const OUT = resolve(process.argv[2] ?? join(ROOT, "demo"));
mkdirSync(OUT, { recursive: true });

let step = 0;

/** Run the real CLI and save exactly what a user would see. */
function cli(label: string, args: string[]): string {
  const res = spawnSync(process.execPath, ["client/src/cli.ts", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    maxBuffer: 16 * 1024 * 1024,
  });
  const text = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const name = `${String(step++).padStart(2, "0")}-${label}.txt`;
  writeFileSync(join(OUT, name), text, "utf8");
  console.log(`  captured ${name}  (${text.split("\n").length} lines)`);
  return text;
}

async function main() {
  console.log("phase table (no chain needed) ...");
  cli("table", ["table"]);

  console.log("launching a curve on the local validator ...");
  const ctx = await Ctx.launch();
  const mint = ctx.mint.toBase58();
  writeFileSync(join(OUT, "mint.txt"), mint, "utf8");
  console.log(`  mint ${mint}`);
  cli("seeding", ["status", "--mint", mint]);

  console.log("first buy — the snipe tax is at its peak ...");
  cli("quote-early", ["quote", "--mint", mint, "--sol", "1"]);
  const first = await ctx.wallet(10);
  await ctx.buy(first, 1);
  cli("after-first-buy", ["status", "--mint", mint]);

  console.log("walking Seeding -> Discovery, one capped wallet at a time ...");
  for (const w of await ctx.wallets(40, 2)) {
    if ((await ctx.state()).tokensSold >= C.P0_END) break;
    await ctx.buy(w, 1);
  }
  cli("discovery", ["status", "--mint", mint]);

  console.log("walking Discovery -> Acceleration under the wider cap ...");
  for (const w of await ctx.wallets(30, 4)) {
    if ((await ctx.state()).tokensSold >= C.P1_END) break;
    await ctx.buy(w, 3);
  }
  cli("acceleration", ["status", "--mint", mint]);

  console.log("finishing the curve — no cap, no cooldown in Acceleration ...");
  const whale = await ctx.wallet(160);
  await ctx.buy(whale, 140);
  cli("graduating", ["status", "--mint", mint]);

  console.log("graduating (permissionless — any wallet may call it) ...");
  const stranger = await ctx.wallet(5);
  await ctx.graduate(stranger);
  const revoked = await ctx.mintAuthorityRevoked();
  writeFileSync(join(OUT, "mint-authority.txt"), String(revoked), "utf8");
  console.log(`  mint authority revoked: ${revoked}`);
  cli("graduated", ["status", "--mint", mint]);

  console.log("swapping against the locked pool ...");
  await ctx.swap(stranger, BigInt(LAMPORTS_PER_SOL), true);
  cli("after-swap", ["status", "--mint", mint]);

  console.log(
    `waiting ${C.FLYWHEEL_INTERVAL_SLOTS} slots for the flywheel to become crankable ` +
      "(this is the slow part of the recording) ...",
  );
  await ctx.waitSlots(Number(C.FLYWHEEL_INTERVAL_SLOTS) + 40);
  await ctx.flywheel(stranger);
  cli("flywheel", ["status", "--mint", mint]);

  console.log("a tenured holder claims their share ...");
  await ctx.claim(whale);
  cli("claim", ["position", "--mint", mint, "--owner", whale.publicKey.toBase58()]);

  const final = await ctx.state();
  writeFileSync(
    join(OUT, "summary.json"),
    JSON.stringify(
      {
        mint,
        phase: final.phase,
        graduated: final.graduated,
        mintAuthorityRevoked: revoked,
        tokensSold: final.tokensSold.toString(),
        poolSolReserve: final.poolSolReserve.toString(),
        poolTokenReserve: final.poolTokenReserve.toString(),
        totalBurned: final.totalBurned.toString(),
        flywheelCranks: final.flywheelCranks.toString(),
        holderCount: final.holderCount.toString(),
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log("\ndemo run complete — every screen above is real captured output.");
}

main().catch((err) => {
  console.error(`demo run failed: ${err?.stack ?? err}`);
  process.exit(1);
});
