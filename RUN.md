# Operator runbook — curvex

Everything below was run on this machine (Windows 11, Node v24.19.0, Solana CLI
2.1.5, `solana-test-validator`). Timings are from that run.

## 0. Prerequisites

- Node >= 22.18 (`npm install` in the repo root)
- `solana-test-validator` on `PATH` (ships with the Solana CLI)
- `ffmpeg` + `ffprobe` on `PATH` — only needed to re-record the demo
- `edge-tts` — optional; without it the demo renders silent

No secrets are needed for anything in this runbook. `cp .env.example .env` if
you want to override ports or the RPC URL.

## 1. Build the program

`cargo-build-sbf` on this machine is from Solana 2.1.5 and fails trying to
download platform-tools v1.43 (`Failed to install platform-tools`). The working
path drives the toolchain directly — this is what produced the committed
artifact, and it reproduces it **byte for byte**:

```bash
SDK="$HOME/.local/share/solana/install/active_release/bin/sdk/sbf/dependencies/platform-tools"
RUSTC="$SDK/rust/bin/rustc" CARGO_TARGET_DIR=target/sbf \
  "$SDK/rust/bin/cargo" build --release \
  --target sbpf-solana-solana \
  --manifest-path programs/curvex/Cargo.toml
# -> target/sbf/sbpf-solana-solana/release/curvex.so   (523,360 bytes, ~40s)
```

Equivalent, if the rustup toolchain is linked:

```bash
rustup run 1.89.0-sbpf-solana-v1.54 cargo build --release \
  --target sbpf-solana-solana --target-dir target/sbf -p curvex
```

**A rebuild is mandatory after changing `declare_id!`** — the program ID is
baked into the binary, and a stale `.so` silently rejects every instruction.
Verify which ID is in the artifact before trusting it:

```bash
node -e 'const{PublicKey}=require("@solana/web3.js");const fs=require("fs");
const id=fs.readFileSync("programs/curvex/src/lib.rs","utf8").match(/declare_id!\("(.+?)"\)/)[1];
const so=fs.readFileSync("target/sbf/sbpf-solana-solana/release/curvex.so");
console.log(id, so.includes(Buffer.from(new PublicKey(id).toBytes()))?"OK":"STALE .so");'
```

## 2. Tests

```bash
cargo test -p curvex --lib     # 28 unit tests, <1s
npm test                       # 33 integration tests, ~6.5 min
```

`npm test` boots its own `solana-test-validator` with `curvex.so` at genesis and
upgrade authority `none`, then tears it down. It refuses to start if 8899 / 8900
/ 9900 are already bound, and it only ever kills the validator process tree it
started — a validator from another checkout is left alone.

To run two suites at once, give each its own ports and ledger:

```bash
CURVEX_RPC_PORT=9899 CURVEX_FAUCET_PORT=10900 CURVEX_LEDGER_DIR=.test-ledger-b npm test
```

If a run is interrupted, a validator can survive and hold the faucet port. The
next run says so by name; clear it by pid:

```bash
netstat -ano | grep ':9900 .*LISTENING'
taskkill /F /T /PID <pid>        # Windows
pkill -f solana-test-validator   # Linux / macOS
```

## 3. Demo video

```bash
node scripts/record-demo.mjs                 # ~8 min (the flywheel wait is 9000 slots)
node scripts/record-demo.mjs --render-only   # re-render from the previous run's captures
```

Writes `demo.mp4` (1080p, ~121s) and `demo_x.mp4` (~3.4 MB, inside X's 140s
limit). Both are gitignored — upload them, do not commit them. It runs on its
own ports (9799 / 10799), so it will not disturb a concurrent `npm test`.

Every frame is the verbatim stdout of a command that just ran against the chain;
`scripts/demo-run.ts` drives the lifecycle and `scripts/record-demo.mjs` renders
the captures. If the run fails, no video is produced.

## 4. Deploy to devnet

```bash
solana-keygen new -o ~/.config/solana/curvex-program.json   # keep OUTSIDE the repo
node scripts/set-program-id.mjs "$(solana-keygen pubkey ~/.config/solana/curvex-program.json)"
# rebuild (step 1) — the ID is compiled in
solana program deploy --url devnet \
  --program-id ~/.config/solana/curvex-program.json \
  --final \
  target/sbf/sbpf-solana-solana/release/curvex.so
```

`--final` means no upgrade authority, which is the claim the README and the demo
both make. Do not deploy without it.

## 5. Pre-push checklist

```bash
git status --porcelain | grep -i keypair   # MUST be empty
git status --porcelain | grep -E 'ledger|node_modules|target/|\.env$'   # MUST be empty
python D:\warung-ops\tools\hacka_qa.py --only curvex     # must print PASS
```

Then push to the existing public repo:

```bash
python D:\warung-ops\tools\hacka_push.py --only curvex
```

First-time repo creation, if it does not exist yet:

```bash
gh repo create valeemlbb-cell/hackalaunch-curvex --public --source=. --remote=origin --push
```

## 6. Submitting

`SUBMISSION.md` holds all five form fields. The video field needs a **public
link**, not a file — post `demo_x.mp4` to X or YouTube first, then paste that
URL into `SUBMISSION.md` and the form. An agent never submits on the platform
and never posts to social on its own; that is the owner's click.
