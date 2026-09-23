/**
 * Boots a local `solana-test-validator` with `curvex.so` loaded at genesis,
 * runs the integration suite against it, and tears the validator down.
 *
 *   npm test
 *
 * `--ticks-per-slot 2` makes a slot ~12ms instead of 400ms, so the suite can
 * exercise cooldowns, the transition guard and the flywheel interval — which
 * are all measured in slots — in seconds rather than hours.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const SO = join(root, "target/sbf/sbpf-solana-solana/release/curvex.so");
const PROGRAM_ID = "GRSUR1XnXMaiibEntNUQQyhVWLwDchHBwsY7iYZUuhLC";
// Ports and ledger are overridable so a second suite (or a dev validator)
// can run side by side without fighting over 8899.
const RPC_PORT = Number(process.env.CURVEX_RPC_PORT ?? 8899);
const FAUCET_PORT = Number(process.env.CURVEX_FAUCET_PORT ?? RPC_PORT + 1001);
// `resolve` so CURVEX_LEDGER_DIR may be absolute; `join(root, "C:/x")` would
// silently produce "<root>/C:/x" on Windows and the validator dies with an
// empty log.
const LEDGER = resolve(root, process.env.CURVEX_LEDGER_DIR ?? ".test-ledger");
const RPC = `http://127.0.0.1:${RPC_PORT}`;
/** RPC, pubsub and faucet ports the validator claims. */
const PORTS = [RPC_PORT, RPC_PORT + 1, FAUCET_PORT];

const validatorBin = process.env.SOLANA_TEST_VALIDATOR ?? "solana-test-validator";

if (!existsSync(SO)) {
  console.error(`missing ${SO}\nbuild it first — see README "Build".`);
  process.exit(1);
}

async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

const portFree = (port) =>
  new Promise((resolve) => {
    const probe = createServer()
      .once("error", () => resolve(false))
      .once("listening", () => probe.close(() => resolve(true)))
      .listen(port, "127.0.0.1");
  });

// A validator left over from an earlier run keeps 8899/9900 bound. The new one
// then dies on "failed to start faucet: address already in use" while the old
// one still answers getHealth with a faucet that no longer works — which
// surfaces as an opaque "airdrop: Internal error" in every single test.
// Check the ports up front and say so plainly.
const taken = [];
for (const port of PORTS) {
  if (!(await portFree(port))) taken.push(port);
}
if (taken.length) {
  console.error(
    `port(s) ${taken.join(", ")} are already in use — a validator from an ` +
      "earlier run is probably still alive.\n" +
      (process.platform === "win32"
        ? "stop it with:  taskkill /F /IM solana-test-validator.exe"
        : "stop it with:  pkill -f solana-test-validator"),
  );
  process.exit(1);
}

// Windows holds memory-mapped ledger files open for a moment after the
// validator dies, so a plain rmSync can throw EPERM. `--reset` wipes the
// ledger anyway, so a best-effort clean is enough.
try {
  rmSync(LEDGER, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
} catch (err) {
  console.warn(`could not remove ${LEDGER} (${err.code}); relying on --reset`);
}
// Do NOT pre-create the ledger directory: on Windows the validator exits
// immediately (code 1, empty log) when `--ledger` points at an existing empty
// directory. It creates the directory itself.

const validator = spawn(
  validatorBin,
  [
    "--ledger", LEDGER,
    "--reset",
    "--rpc-port", String(RPC_PORT),
    "--faucet-port", String(FAUCET_PORT),
    "--quiet",
    "--ticks-per-slot", process.env.CURVEX_TICKS_PER_SLOT ?? "2",
    "--slots-per-epoch", "432000",
    "--faucet-sol", "1000000",
    "--limit-ledger-size", "10000",
    // "none" upgrade authority: the test runs against an immutable deploy,
    // exactly like the devnet target.
    "--upgradeable-program", PROGRAM_ID, SO, "none",
  ],
  // stdin must stay open: the validator exits immediately on EOF.
  { stdio: ["pipe", "ignore", "inherit"], windowsHide: true, detached: false },
);

let validatorDied = false;
validator.on("exit", (code) => {
  validatorDied = true;
  if (code !== null && code !== 0) {
    console.error(`solana-test-validator exited with code ${code}`);
  }
});

let exitCode = 1;
let stopped = false;
const stop = () => {
  if (stopped) return;
  stopped = true;
  try {
    // On Windows a plain kill() leaves the detached validator listening on
    // 8899, which poisons the next run; kill the whole process tree.
    if (process.platform === "win32" && validator.pid) {
      // `/T` takes the launcher's child too: solana-test-validator spawns the
      // real validator, and killing only the parent leaves that one holding
      // 9900, which makes the NEXT run die on "failed to start faucet".
      //
      // Never escalate to `taskkill /IM solana-test-validator.exe`. Another
      // checkout on this machine may legitimately be running its own
      // validator, and killing by image name murders it mid-suite. If our own
      // tree somehow survives, say so and let a human decide.
      spawnSync("taskkill", ["/F", "/T", "/PID", String(validator.pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
      if (stillAlive(validator.pid)) {
        console.error(
          `solana-test-validator pid ${validator.pid} survived taskkill.\n` +
            `stop it by pid:  taskkill /F /T /PID ${validator.pid}`,
        );
      }
    } else {
      validator.kill("SIGKILL");
    }
  } catch {
    /* already gone */
  }
};

/** Is THIS pid still running? Synchronous, for the teardown path where we
 *  cannot await. Scoped to one pid on purpose: the teardown must never reason
 *  about "is anything listening on 8899", because the answer may be another
 *  checkout's validator that we have no business killing. */
function stillAlive(pid) {
  if (process.platform !== "win32") {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  const res = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return (res.stdout ?? "").includes(String(pid));
}
process.on("exit", stop);
process.on("SIGINT", () => {
  stop();
  process.exit(130);
});

/** Healthy RPC is not enough. The suite funds every wallet out of the
 *  validator's own faucet account, so the keypair file has to be on disk and
 *  the account has to actually hold the `--faucet-sol` before tests start. */
async function waitForValidator() {
  const faucet = join(LEDGER, "faucet-keypair.json");
  for (let i = 0; i < 180; i++) {
    if (validatorDied) return false;
    try {
      if ((await rpc("getHealth")).result === "ok" && existsSync(faucet)) {
        const key = Keypair.fromSecretKey(
          Uint8Array.from(JSON.parse(readFileSync(faucet, "utf8"))),
        );
        const bal = await rpc("getBalance", [key.publicKey.toBase58()]);
        if ((bal.result?.value ?? 0) > 0) return true;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

console.log("starting local validator with curvex.so at genesis ...");
if (!(await waitForValidator())) {
  console.error("validator did not become healthy");
  stop();
  process.exit(1);
}
console.log(`validator healthy at ${RPC}\n`);

const tests = spawnSync(
  process.execPath,
  ["--test", "--test-concurrency=2", "client/tests/*.test.ts"],
  {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      CURVEX_RPC_URL: RPC,
      // The validator's own faucet account funds the test wallets directly:
      // requestAirdrop is capped per request and far too slow for this suite.
      CURVEX_FAUCET_KEYPAIR: join(LEDGER, "faucet-keypair.json"),
    },
  },
);
exitCode = tests.status ?? 1;

stop();
process.exit(exitCode);
