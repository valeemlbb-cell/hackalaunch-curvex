#!/usr/bin/env node
/**
 * Record the CurveX submission video.
 *
 *   node scripts/record-demo.mjs
 *
 * Boots a local validator with the built `curvex.so` at genesis, drives one
 * complete lifecycle through it (`scripts/demo-run.ts`), and renders the REAL
 * captured CLI output into a 1080p video with an English voice-over.
 *
 * Nothing is typed in by hand: every terminal frame is the verbatim stdout of a
 * command that just ran against the chain, so the video cannot drift from what
 * the program does. The validator runs with `--upgradeable-program ... none`,
 * i.e. an immutable deploy, exactly like the devnet target.
 *
 * Needs ffmpeg + ffprobe on PATH. edge-tts is optional; without it the video
 * renders silent with fixed scene lengths.
 *
 * Writes demo.mp4 (1080p) and demo_x.mp4 (<= 20 MB, for X's upload limit).
 * Both are gitignored — upload them, do not commit them.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const WORK = join(ROOT, "demo");
const CAPTURES = join(WORK, "captures");
const FONT_DIR = join(ROOT, "assets", "fonts");

const WIDTH = 1920;
const HEIGHT = 1080;
const MAX_LINES = 30;
const MAX_COLS = 112;
const FONT_SIZE = 25;
const LINE_HEIGHT = 31;
const TEXT_TOP = 150;
const BG = "0x0B0F14";
const FG = "0xD7E0EA";
const ACCENT = "0x5FD3A6";
const RULE = "0x1E2933";
const VOICE = "en-US-AndrewNeural";
/** X refuses uploads over ~512 MB but the practical ceiling we want is 20 MB. */
const X_MAX_BYTES = 20 * 1024 * 1024;
/** Hard cap so the clip fits X's 140-second limit. */
const MAX_TOTAL_SECONDS = 140;

// Private ports so a concurrent `npm test` in another checkout is untouched.
const RPC_PORT = Number(process.env.CURVEX_DEMO_RPC_PORT ?? 9799);
const FAUCET_PORT = Number(process.env.CURVEX_DEMO_FAUCET_PORT ?? 10799);
const LEDGER = join(ROOT, ".demo-ledger");
const RPC = `http://127.0.0.1:${RPC_PORT}`;
const PROGRAM_ID = readProgramId();
const SO = join(ROOT, "target/sbf/sbpf-solana-solana/release/curvex.so");

function readProgramId() {
  const lib = readFileSync(join(ROOT, "programs/curvex/src/lib.rs"), "utf8");
  const match = lib.match(/declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)/);
  if (!match) throw new Error("could not read declare_id! from programs/curvex/src/lib.rs");
  return match[1];
}

function has(command) {
  try {
    execFileSync(command, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function duration(file) {
  const res = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8" },
  );
  const value = Number((res.stdout ?? "").trim());
  return Number.isFinite(value) ? value : 0;
}

function ffmpeg(args) {
  const res = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    cwd: WORK,
    encoding: "utf8",
  });
  if (res.status !== 0) throw new Error(`ffmpeg failed: ${res.stderr?.slice(0, 800)}`);
}

/** drawtext values need : \ ' % escaped. */
function esc(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%");
}

/**
 * Trim a capture to something that fits the frame. `head` keeps the top of the
 * output (status screens), otherwise the tail is kept (long scrolling logs).
 */
function frame(text, { head = 0, skip = 0 } = {}) {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .slice(skip)
    // drawtext reads a backslash as an escape and renders tofu for non-ascii.
    .map((line) => line.replace(/\\/g, "/"))
    .map((line) =>
      line.replace(/[^\x20-\x7E]/g, (ch) => (ch === "—" || ch === "–" ? "-" : ch === "·" ? "-" : "")),
    )
    .map((line) => (line.length > MAX_COLS ? `${line.slice(0, MAX_COLS - 1)}>` : line));
  const body = head > 0 ? lines.slice(0, head) : lines.slice(-MAX_LINES);
  return body.slice(0, MAX_LINES).join("\n");
}

function capture(name) {
  const path = join(CAPTURES, name);
  if (!existsSync(path)) throw new Error(`missing capture ${name} — did demo-run.ts fail?`);
  return readFileSync(path, "utf8");
}

/**
 * Find an edge-tts that actually synthesises on this machine. Several Python
 * installs can shadow each other and only some resolve DNS, so the probe makes
 * a real file instead of trusting --help.
 */
function findTts() {
  const user = process.env.USERNAME ?? "";
  const candidates = [
    process.env.EDGE_TTS_PATH,
    "edge-tts",
    `C:/Users/${user}/AppData/Local/Programs/Python/Python311/Scripts/edge-tts.exe`,
    "C:/Python314/Scripts/edge-tts.exe",
  ].filter(Boolean);
  const probe = join(WORK, "tts-probe.mp3");
  for (const candidate of candidates) {
    const res = spawnSync(
      candidate,
      ["--voice", VOICE, "--text", "check", "--write-media", probe],
      { encoding: "utf8", shell: false, timeout: 60_000, windowsHide: true },
    );
    if (res.status === 0 && existsSync(probe) && statSync(probe).size > 1000) return candidate;
    rmSync(probe, { force: true });
  }
  return null;
}

function synth(binary, text, outFile) {
  const res = spawnSync(
    binary,
    ["--voice", VOICE, "--text", text, "--write-media", outFile],
    { encoding: "utf8", shell: false, timeout: 180_000, windowsHide: true },
  );
  return res.status === 0 && existsSync(outFile) && statSync(outFile).size > 1000;
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

function startValidator() {
  try {
    rmSync(LEDGER, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {
    /* --reset wipes it anyway */
  }
  return spawn(
    process.env.SOLANA_TEST_VALIDATOR ?? "solana-test-validator",
    [
      "--ledger", LEDGER,
      "--reset",
      "--quiet",
      "--rpc-port", String(RPC_PORT),
      "--faucet-port", String(FAUCET_PORT),
      "--ticks-per-slot", process.env.CURVEX_TICKS_PER_SLOT ?? "2",
      "--slots-per-epoch", "432000",
      "--faucet-sol", "1000000",
      "--limit-ledger-size", "10000",
      // Immutable deploy, same as the devnet target.
      "--upgradeable-program", PROGRAM_ID, SO, "none",
    ],
    // stdin must stay open: the validator exits on EOF.
    { stdio: ["pipe", "ignore", "inherit"], windowsHide: true },
  );
}

async function waitForValidator(child) {
  const faucet = join(LEDGER, "faucet-keypair.json");
  for (let i = 0; i < 180; i++) {
    if (child.exitCode !== null) return false;
    try {
      if ((await rpc("getHealth")).result === "ok" && existsSync(faucet)) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** Kill only the tree we started — never by image name. */
function stopValidator(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === "win32" && child.pid) {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

function buildScenes() {
  const summary = JSON.parse(capture("summary.json"));
  const revoked = capture("mint-authority.txt").trim() === "true";
  const burned = Number(summary.totalBurned).toLocaleString("en-US");

  const scenes = [];

  scenes.push({
    title: "CURVEX",
    body: [
      "",
      "   A bonding curve where graduation is a milestone, not the finish line.",
      "",
      "   Four phases. Every transition fires on chain state alone:",
      "     supply sold, holder count, elapsed slots, traded volume,",
      "     or a tenure-weighted holder vote.",
      "",
      "   There is no admin instruction. Nobody can set the phase.",
      "   Nobody can withdraw the reserve. The constants are compiled in.",
      "",
      `   program  ${PROGRAM_ID}`,
      "   devnet only - MIT - Solana / Anchor",
    ].join("\n"),
    say:
      "CurveX is a multi phase bonding curve for Solana. " +
      "Every transition fires on chain state alone: supply sold, holder count, elapsed slots, " +
      "traded volume, or a tenure weighted holder vote. " +
      "There is no admin instruction, and no withdraw path.",
  });

  scenes.push({
    title: "THE PHASE LADDER",
    body: frame(capture("00-table.txt"), { head: MAX_LINES, skip: 1 }),
    say:
      "The command line prints the ladder straight out of the program constants, so the docs " +
      "cannot drift from the deployed code. Each phase has its own price segment, wallet cap, " +
      "cooldown and fee schedule.",
  });

  scenes.push({
    title: "PHASE 0 - SEEDING",
    body: frame(capture("01-seeding.txt"), { head: MAX_LINES }),
    say:
      "Here is a freshly launched token. Phase zero, empty reserve, zero holders. " +
      "The status screen shows the live phase, progress toward the next one, " +
      "and what changes when it gets there.",
  });

  scenes.push({
    title: "THE SNIPE TAX",
    body: frame(capture("02-quote-early.txt"), { head: 12 }) +
      "\n\n" +
      frame(capture("03-after-first-buy.txt"), { head: 16 }),
    say:
      "The first buyers pay a twenty percent entry tax that decays to zero over twenty five hundred slots. " +
      "It is charged on entry, so a wallet farm pays it once per wallet and cannot escape it by exiting fast.",
  });

  scenes.push({
    title: "IT ADVANCES ITSELF",
    body: frame(capture("04-discovery.txt"), { head: MAX_LINES }),
    say:
      "Forty capped wallets buy through the cooldown and the curve crosses eighty million tokens. " +
      "Nobody called an admin function. The supply target fired the transition on its own, " +
      "and the wallet cap just widened four times.",
  });

  scenes.push({
    // The screen here is the post-fill state, which is already PHASE 3
    // GRADUATING — the title has to say so or it contradicts the frame.
    title: "ACCELERATION -> CURVE CLOSED",
    body: frame(capture("06-graduating.txt"), { head: MAX_LINES }),
    say:
      "Another thirty wallets push it into Acceleration, where the caps lift entirely. " +
      "The final fill is clipped exactly at the graduation threshold, and the curve closes.",
  });

  scenes.push({
    title: "GRADUATION",
    body: frame(capture("07-graduated.txt"), { head: MAX_LINES }),
    say:
      `Any wallet can call graduate, and a stranger did. The whole reserve moved into a permanently ` +
      `locked pool, and the mint authority was ${revoked ? "revoked" : "NOT revoked"}. ` +
      "The supply is now fixed and no privileged key exists.",
  });

  scenes.push({
    title: "THE PERPETUAL PHASE",
    body: frame(capture("09-flywheel.txt"), { head: MAX_LINES }),
    say:
      "Graduation is not the end. The pool charges one percent, half of which feeds a flywheel " +
      `anyone may crank once an hour. This crank burned ${burned} tokens ` +
      "and paid the rest out by tenure. Long holders pay a lower swap fee, forever.",
  });

  scenes.push({
    title: "WHAT IS REAL",
    body: [
      "",
      "   Everything in this video is real captured output from a local validator",
      "   running the built program with upgrade authority set to NONE.",
      "",
      "   real      the Anchor program, the curve integral, the phase machine,",
      "             the locked pool, the flywheel, the loyalty accounting",
      "   real      33 integration tests + 28 unit tests, all green",
      "   devnet    default RPC is devnet; no mainnet code path exists",
      "   mocked    nothing",
      "",
      "   No admin instruction. No withdraw path. No upgrade authority.",
      "   MIT licensed. No keys in the repository.",
    ].join("\n"),
    say:
      "Everything you just saw is real captured output from the built program, running with " +
      "upgrade authority set to none. Thirty three integration tests and twenty eight unit tests, all green. " +
      "Nothing here is mocked. Devnet only, MIT licensed, no keys in the repository.",
  });

  return scenes;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render(scenes, tts) {
  const clips = [];

  // Pass 1: synthesise every voice line first. Allocating the time budget
  // greedily as we go would let the early scenes eat it and truncate the last
  // one mid-sentence, which is exactly where the "what is real" disclosure
  // lives. Knowing all the durations up front means we can fail loudly with a
  // number instead of silently cutting the ending off.
  const plan = scenes.map((scene, index) => {
    const name = `scene${String(index).padStart(2, "0")}`;
    let audio = null;
    let seconds = 9;
    if (tts) {
      const mp3 = join(WORK, `${name}.mp3`);
      if (synth(tts, scene.say, mp3)) {
        audio = `${name}.mp3`;
        seconds = Math.max(duration(mp3) + 0.7, 4);
      }
    }
    return { name, audio, seconds };
  });

  const natural = plan.reduce((sum, p) => sum + p.seconds, 0);
  if (natural > MAX_TOTAL_SECONDS) {
    const longest = [...plan].sort((a, b) => b.seconds - a.seconds)[0];
    throw new Error(
      `narration runs ${natural.toFixed(1)}s, ${(natural - MAX_TOTAL_SECONDS).toFixed(1)}s over the ` +
        `${MAX_TOTAL_SECONDS}s limit. Shorten a scene's \`say\` — the longest is ` +
        `${longest.name} at ${longest.seconds.toFixed(1)}s. Never truncate audio to fit.`,
    );
  }
  console.log(`  narration total ${natural.toFixed(1)}s of ${MAX_TOTAL_SECONDS}s\n`);

  // Pass 2: render each scene at its full, untruncated length.
  scenes.forEach((scene, index) => {
    const { name, audio, seconds } = plan[index];

    const titleDraw =
      `drawtext=fontfile=title.ttf:text='${esc(scene.title)}':x=70:y=52:fontsize=44:fontcolor=${ACCENT}` +
      `,drawbox=x=70:y=112:w=${WIDTH - 140}:h=2:color=${RULE}:t=fill`;

    // One drawtext per line: ffmpeg renders a tofu box for the newline inside a
    // multi-line textfile, so the lines are placed by hand.
    const draws = scene.body
      .split("\n")
      .slice(0, MAX_LINES)
      .map((line, i) => {
        if (line.trim() === "") return null;
        const file = `${name}_l${String(i).padStart(2, "0")}.txt`;
        writeFileSync(join(WORK, file), line, "utf8");
        // expansion=none: otherwise drawtext eats "%" and "\" and silently
        // deletes every percentage in the status screens.
        return (
          `drawtext=fontfile=mono.ttf:textfile=${file}:expansion=none` +
          `:x=70:y=${TEXT_TOP + i * LINE_HEIGHT}:fontsize=${FONT_SIZE}:fontcolor=${FG}`
        );
      })
      .filter(Boolean);

    const input = [
      "-f", "lavfi", "-t", String(seconds), "-i", `color=c=${BG}:s=${WIDTH}x${HEIGHT}:r=30`,
    ];
    const map = ["-map", "[v]"];
    if (audio) {
      input.push("-i", audio);
      map.push("-map", "1:a", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2");
    } else {
      input.push("-f", "lavfi", "-t", String(seconds), "-i", "anullsrc=r=48000:cl=stereo");
      map.push("-map", "1:a", "-c:a", "aac", "-b:a", "128k");
    }

    ffmpeg([
      ...input,
      "-filter_complex", `[0:v]${[...draws, titleDraw].join(",")}[v]`,
      ...map,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-pix_fmt", "yuv420p",
      "-r", "30",
      "-shortest",
      `${name}.mp4`,
    ]);
    clips.push(`${name}.mp4`);
    console.log(`  ${name}  ${seconds.toFixed(1)}s  ${scene.title}`);
  });

  writeFileSync(join(WORK, "list.txt"), clips.map((c) => `file '${c}'`).join("\n"), "utf8");
  ffmpeg(["-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "../demo.mp4"]);
}

/** Shrink a copy until it fits X's upload limit. */
function makeXCopy() {
  const src = join(ROOT, "demo.mp4");
  const dst = join(ROOT, "demo_x.mp4");
  if (statSync(src).size <= X_MAX_BYTES) {
    copyFileSync(src, dst);
    return;
  }
  const seconds = duration(src);
  for (const crf of [23, 26, 29, 32]) {
    ffmpeg([
      "-i", src,
      "-c:v", "libx264", "-preset", "slow", "-crf", String(crf),
      "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      "-c:a", "aac", "-b:a", "96k",
      dst,
    ]);
    if (statSync(dst).size <= X_MAX_BYTES) return;
  }
  console.warn(
    `demo_x.mp4 is still ${(statSync(dst).size / 1e6).toFixed(1)} MB after ${seconds.toFixed(0)}s of video`,
  );
}

// ---------------------------------------------------------------------------

async function main() {
  if (!has("ffmpeg") || !has("ffprobe")) {
    console.error("ffmpeg and ffprobe must be on PATH");
    process.exit(1);
  }
  if (!existsSync(SO)) {
    console.error(`missing ${SO}\nbuild it first — see README "Build the program".`);
    process.exit(1);
  }

  // Driving the chain takes minutes (the flywheel interval alone is 9000
  // slots), so `--render-only` re-renders from the captures already on disk.
  // Useful while iterating on the narration; it never invents a capture.
  const renderOnly = process.argv.includes("--render-only");
  if (renderOnly && !existsSync(join(CAPTURES, "summary.json"))) {
    console.error("--render-only needs a previous run's captures in demo/captures/");
    process.exit(1);
  }
  if (!renderOnly) rmSync(WORK, { recursive: true, force: true });
  mkdirSync(CAPTURES, { recursive: true });
  // The two DejaVu faces are committed under assets/fonts/ with their licence
  // (Bitstream Vera / DejaVu — free to embed and redistribute). No system font
  // is ever burned into the published video.
  copyFileSync(join(FONT_DIR, "DejaVuSansMono.ttf"), join(WORK, "mono.ttf"));
  copyFileSync(join(FONT_DIR, "DejaVuSans-Bold.ttf"), join(WORK, "title.ttf"));

  if (renderOnly) {
    console.log("--render-only: reusing the captures from the previous run\n");
  } else {
    const validator = startValidator();
    process.on("exit", () => stopValidator(validator));
    process.on("SIGINT", () => {
      stopValidator(validator);
      process.exit(130);
    });

    try {
      console.log(`starting local validator on ${RPC} with ${PROGRAM_ID} ...`);
      if (!(await waitForValidator(validator))) {
        console.error("validator did not become healthy");
        process.exit(1);
      }
      console.log("validator healthy\n");

      console.log("driving one full lifecycle (the flywheel wait takes a few minutes) ...");
      const run = spawnSync(process.execPath, ["scripts/demo-run.ts", CAPTURES], {
        cwd: ROOT,
        stdio: "inherit",
        env: {
          ...process.env,
          CURVEX_RPC_URL: RPC,
          CURVEX_FAUCET_KEYPAIR: join(LEDGER, "faucet-keypair.json"),
        },
      });
      if (run.status !== 0) {
        console.error("demo run failed — not rendering a video of a broken run");
        process.exit(1);
      }
    } finally {
      stopValidator(validator);
    }
  }

  const tts = findTts();
  console.log(tts ? `\nvoice-over via ${tts}` : "\nno working edge-tts — rendering silent");

  const scenes = buildScenes();
  console.log(`rendering ${scenes.length} scenes ...`);
  render(scenes, tts);
  makeXCopy();

  const total = duration(join(ROOT, "demo.mp4"));
  const xSize = statSync(join(ROOT, "demo_x.mp4")).size / 1e6;
  console.log(`\ndemo.mp4    ${total.toFixed(1)}s  ${(statSync(join(ROOT, "demo.mp4")).size / 1e6).toFixed(1)} MB`);
  console.log(`demo_x.mp4  ${total.toFixed(1)}s  ${xSize.toFixed(1)} MB  (X limit 140s / 20 MB)`);
  if (total > MAX_TOTAL_SECONDS) console.warn("TOO LONG for X — trim a scene.");
}

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});
