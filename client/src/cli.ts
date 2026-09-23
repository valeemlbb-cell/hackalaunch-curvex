#!/usr/bin/env node
/**
 * CurveX CLI — the required "show current phase, progress toward the next
 * phase, and what changes at the next phase" surface.
 *
 *   node client/src/cli.ts status  --mint <MINT>
 *   node client/src/cli.ts watch   --mint <MINT>
 *   node client/src/cli.ts table
 *   node client/src/cli.ts launch
 *   node client/src/cli.ts buy     --mint <MINT> --sol 0.5
 *   node client/src/cli.ts sell    --mint <MINT> --tokens 100000
 *   node client/src/cli.ts crank   --mint <MINT>
 *   node client/src/cli.ts vote    --mint <MINT> --approve
 *   node client/src/cli.ts split   --mint <MINT> --bps 6000
 *   node client/src/cli.ts graduate --mint <MINT>
 *   node client/src/cli.ts swap    --mint <MINT> --sol 0.2 | --tokens 5000
 *   node client/src/cli.ts flywheel --mint <MINT>
 *   node client/src/cli.ts claim   --mint <MINT>
 *
 * Network comes from CURVEX_RPC_URL, the keypair from CURVEX_KEYPAIR
 * (see .env.example). No secret is ever read from this repository.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import * as C from "./constants.ts";
import * as cx from "./curvex.ts";
import {
  causeName,
  fmt,
  phaseName,
  priceLamports,
  progress,
  quoteBuy,
  sellFeeBps,
  sol,
  tenureWeightBps,
  walletCap,
} from "./curve.ts";
import { PHASE_TABLE, renderPhaseTable } from "./phase-table.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function rpcUrl(): string {
  return process.env.CURVEX_RPC_URL ?? "https://api.devnet.solana.com";
}

function loadKeypair(): Keypair {
  const path =
    process.env.CURVEX_KEYPAIR ?? `${homedir()}/.config/solana/id.json`;
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

const bar = (bps: bigint, width = 32) => {
  const filled = Number((bps * BigInt(width)) / 10_000n);
  return `[${"#".repeat(filled)}${".".repeat(width - filled)}] ${(Number(bps) / 100).toFixed(2)}%`;
};

async function status(conn: Connection, mint: PublicKey, json: boolean) {
  const state = await cx.fetchCurve(conn, mint);
  const slot = BigInt(await conn.getSlot("confirmed"));
  const p = progress(state, slot);
  const next = PHASE_TABLE[state.phase + 1];

  if (json) {
    console.log(
      JSON.stringify(
        {
          mint: mint.toBase58(),
          curve: cx.curvePda(mint).toBase58(),
          phase: state.phase,
          phaseName: phaseName(state.phase),
          progressBps: Number(p.bps),
          nextPhase: next?.name ?? null,
          tokensSold: state.tokensSold.toString(),
          reserveLamports: state.reserveLamports.toString(),
          holderCount: state.holderCount.toString(),
          volumeLamports: state.volumeLamports.toString(),
          spotPriceLamports: priceLamports(state.tokensSold),
          graduated: state.graduated,
          poolSolReserve: state.poolSolReserve.toString(),
          poolTokenReserve: state.poolTokenReserve.toString(),
          totalBurned: state.totalBurned.toString(),
          flywheelCranks: state.flywheelCranks.toString(),
          lastTransitionCause: causeName(state.lastTransitionCause),
        },
        null,
        2,
      ),
    );
    return;
  }

  const cap = walletCap(state.phase);
  console.log(`
  CurveX  ${mint.toBase58()}
  ${"-".repeat(66)}
  PHASE ${state.phase}  ${phaseName(state.phase).toUpperCase()}   (entered via ${causeName(state.lastTransitionCause)})
  ${p.label}
  ${bar(p.bps)}
  ${p.detail}

  spot price        ${priceLamports(state.tokensSold).toFixed(4)} lamports/token
  tokens sold       ${fmt(state.tokensSold)} / ${fmt(C.P2_END)}
  curve reserve     ${sol(state.reserveLamports)} SOL
  holders           ${state.holderCount}
  lifetime volume   ${sol(state.volumeLamports)} SOL
  wallet cap now    ${cap === null ? "none" : fmt(cap) + " tokens"}
  sell fee (fresh)  ${sellFeeBps(0n, slot - state.lastTransitionSlot)} bps
  sell fee (mature) ${sellFeeBps(C.MATURE_SLOTS, slot - state.lastTransitionSlot)} bps
${
  state.graduated
    ? `
  GRADUATED at slot ${state.graduatedSlot}
  pool              ${sol(state.poolSolReserve)} SOL / ${fmt(state.poolTokenReserve)} tokens
  flywheel cranks   ${state.flywheelCranks}   burned ${fmt(state.totalBurned)} tokens
  buyback spent     ${sol(state.totalBuybackLamports)} SOL
  loyalty paid out  ${sol(state.totalLoyaltyLamports)} SOL`
    : ""
}
  ${"-".repeat(66)}
  NEXT: ${next ? `${next.name} — ${next.changes}` : "nothing; the flywheel runs forever"}
`);
}

async function main() {
  const cmd = process.argv[2] ?? "help";

  if (cmd === "table") {
    console.log(renderPhaseTable());
    return;
  }
  if (cmd === "help" || cmd === "--help") {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]);
    return;
  }

  const conn = new Connection(rpcUrl(), "confirmed");

  if (cmd === "launch") {
    const payer = loadKeypair();
    const mintKp = Keypair.generate();
    const sig = await cx.send(
      conn,
      [cx.initializeCurveIx(payer.publicKey, mintKp.publicKey)],
      payer,
      [mintKp],
    );
    console.log(
      JSON.stringify(
        { mint: mintKp.publicKey.toBase58(), curve: cx.curvePda(mintKp.publicKey).toBase58(), signature: sig },
        null,
        2,
      ),
    );
    return;
  }

  const mintArg = arg("mint");
  if (!mintArg) throw new Error("--mint <PUBKEY> is required");
  const mint = new PublicKey(mintArg);

  switch (cmd) {
    case "status":
      await status(conn, mint, flag("json"));
      return;

    case "watch": {
      for (;;) {
        process.stdout.write("\x1b[2J\x1b[H");
        await status(conn, mint, false);
        await new Promise((r) => setTimeout(r, Number(arg("interval") ?? 4000)));
      }
    }

    case "quote": {
      const state = await cx.fetchCurve(conn, mint);
      const slot = BigInt(await conn.getSlot("confirmed"));
      const lamports = BigInt(Math.round(Number(arg("sol") ?? "1") * 1e9));
      const q = quoteBuy(state, slot, lamports);
      console.log(
        `  ${sol(lamports)} SOL -> ${fmt(q.tokens)} tokens` +
          `\n  curve cost ${sol(q.cost)} SOL, fee ${sol(q.fee)} SOL (${q.feeBps} bps)` +
          `\n  effective ${(Number(q.total) / Number(q.tokens || 1n)).toFixed(4)} lamports/token`,
      );
      return;
    }

    case "position": {
      const owner = arg("owner") ? new PublicKey(arg("owner")!) : loadKeypair().publicKey;
      const pos = await cx.fetchPosition(conn, mint, owner);
      if (!pos) {
        console.log("no position");
        return;
      }
      const slot = BigInt(await conn.getSlot("confirmed"));
      const tenure = pos.balance === 0n ? 0n : slot - pos.weightedAcqSlot;
      console.log(
        JSON.stringify(
          {
            owner: owner.toBase58(),
            balance: pos.balance.toString(),
            tenureSlots: tenure.toString(),
            tenureWeightBps: Number(tenureWeightBps(tenure)),
            sellFeeBpsNow: Number(sellFeeBps(tenure, 10_000n)),
            preferredBuybackBps: Number(pos.preferredBuybackBps),
            rewardsClaimed: pos.rewardsClaimed.toString(),
          },
          null,
          2,
        ),
      );
      return;
    }
  }

  // Everything below signs a transaction.
  const payer = loadKeypair();
  const lamportsArg = () => BigInt(Math.round(Number(arg("sol") ?? "0") * 1e9));
  let sig: string;

  switch (cmd) {
    case "buy":
      sig = await cx.send(conn, [cx.buyIx(payer.publicKey, mint, lamportsArg(), 0n)], payer);
      break;
    case "sell":
      sig = await cx.send(
        conn,
        [cx.sellIx(payer.publicKey, mint, BigInt(arg("tokens") ?? "0"), 0n)],
        payer,
      );
      break;
    case "crank":
      sig = await cx.send(conn, [cx.crankPhaseIx(payer.publicKey, mint)], payer);
      break;
    case "vote":
      sig = await cx.send(
        conn,
        [cx.castPhaseVoteIx(payer.publicKey, mint, !process.argv.includes("--reject"))],
        payer,
      );
      break;
    case "split":
      sig = await cx.send(
        conn,
        [cx.setSplitPreferenceIx(payer.publicKey, mint, BigInt(arg("bps") ?? "5000"))],
        payer,
      );
      break;
    case "graduate":
      sig = await cx.send(conn, [cx.graduateIx(payer.publicKey, mint)], payer);
      break;
    case "swap": {
      const tokens = arg("tokens");
      sig = tokens
        ? await cx.send(conn, [cx.swapIx(payer.publicKey, mint, BigInt(tokens), 0n, false)], payer)
        : await cx.send(conn, [cx.swapIx(payer.publicKey, mint, lamportsArg(), 0n, true)], payer);
      break;
    }
    case "flywheel":
      sig = await cx.send(conn, [cx.crankFlywheelIx(payer.publicKey, mint)], payer);
      break;
    case "claim":
      sig = await cx.send(conn, [cx.claimRewardsIx(payer.publicKey, mint)], payer);
      break;
    default:
      throw new Error(`unknown command: ${cmd}`);
  }

  console.log(`signature ${sig}`);
  await status(conn, mint, false);
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
});
