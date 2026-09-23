/**
 * Point the program and the client at a program ID you control.
 *
 *   node scripts/set-program-id.mjs <PUBKEY>
 *
 * The program keypair itself must live OUTSIDE this repository — `.gitignore`
 * blocks every `*keypair*.json`, and a published private key is a hackathon
 * disqualifier. Only the public key ever enters the tree.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const id = process.argv[2];
if (!id || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(id)) {
  console.error("usage: node scripts/set-program-id.mjs <BASE58_PUBKEY>");
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const targets = [
  ["programs/curvex/src/lib.rs", /declare_id!\("([^"]+)"\)/],
  ["client/src/curvex.ts", /new PublicKey\("([^"]+)"\)/],
  ["scripts/run-tests.mjs", /const PROGRAM_ID = "([^"]+)"/],
];

for (const [file, pattern] of targets) {
  const path = join(root, file);
  const text = readFileSync(path, "utf8");
  const match = text.match(pattern);
  if (!match) {
    console.error(`could not find a program id in ${file}`);
    process.exit(1);
  }
  writeFileSync(path, text.replaceAll(match[1], id));
  console.log(`${file}: ${match[1]} -> ${id}`);
}
console.log("\nrebuild the program so the embedded id matches.");
