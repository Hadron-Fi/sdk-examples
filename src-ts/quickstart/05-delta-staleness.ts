/**
 * Example: Configure delta staleness with a 10-slot buffer.
 *
 * Loads the pool created by script 01 and demonstrates:
 *
 *   1. Read current delta staleness from pool config
 *   2. Set delta staleness to 10 (a 10-slot buffer)
 *   3. Verify the update on-chain
 *
 * Delta staleness controls how many slots old the oracle midprice update
 * can be before the pool considers it stale and rejects swaps. Setting it
 * to a small buffer above the current slot's trailing delta ensures the
 * pool stays live under normal conditions but halts if the oracle goes
 * silent for too long.
 *
 * Prerequisites:
 *   Run script 01 first to create the pool:
 *     npm run init
 *
 * Run:
 *   npm run delta-staleness
 */
import { Hadron } from "@hadron-fi/sdk";
import { TestHarness, logTx, logInfo, logHeader } from "../setup";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Keypair, PublicKey } from "@solana/web3.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const h = await TestHarness.create();

  // ── Load pool config from output/ ──
  const configPath = path.resolve(__dirname, "../../output/pool-config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error("No pool-config.json found. Run `npm run init` first.");
  }
  const entries = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  const latest = entries[entries.length - 1];
  const poolAddress = new PublicKey(latest.poolAddress);

  // Load authority keypair
  const authorityPath = path.resolve(
    __dirname,
    "../../output",
    latest.authorityKeyFile
  );
  const authoritySecret = JSON.parse(fs.readFileSync(authorityPath, "utf-8"));
  const authority = Keypair.fromSecretKey(Uint8Array.from(authoritySecret));

  logHeader("Load existing pool");
  logInfo("Pool:", poolAddress.toBase58());
  logInfo("Authority:", authority.publicKey.toBase58());

  let pool = await h.loadPool(poolAddress);

  // ── 1. Read current delta staleness ──
  logHeader("1. Current delta staleness");
  logInfo("deltaStaleness:", pool.config.deltaStaleness.toString());

  // ── 2. Set delta staleness to 10 (a 10-slot buffer) ──
  logHeader("2. Update delta staleness (10-slot buffer)");

  const newStaleness = 10;
  logInfo("New value:", newStaleness.toString());

  const ix = pool.updateDeltaStaleness(authority.publicKey, {
    deltaStaleness: newStaleness,
  });
  const sig = await h.sendIx(ix, [authority]);
  logTx("updateDeltaStaleness()", sig);

  // ── 3. Verify on-chain ──
  logHeader("3. Verify on-chain");
  pool = await h.loadPool(poolAddress);
  logInfo("deltaStaleness:", pool.config.deltaStaleness.toString());

  if (pool.config.deltaStaleness !== newStaleness) {
    throw new Error(
      `Delta staleness mismatch: expected ${newStaleness}, got ${pool.config.deltaStaleness}`
    );
  }
  logInfo("Verified:", "on-chain value matches expected");

  // ── 4. Reset delta staleness back to 0 ──
  logHeader("4. Reset delta staleness to 0");

  const resetIx = pool.updateDeltaStaleness(authority.publicKey, {
    deltaStaleness: 0,
  });
  const resetSig = await h.sendIx(resetIx, [authority]);
  logTx("updateDeltaStaleness(0)", resetSig);

  pool = await h.loadPool(poolAddress);
  logInfo("deltaStaleness:", pool.config.deltaStaleness.toString());

  if (pool.config.deltaStaleness !== 0) {
    throw new Error(
      `Delta staleness mismatch: expected 0, got ${pool.config.deltaStaleness}`
    );
  }
  logInfo("Verified:", "reset to 0");

  logHeader("Done! Delta staleness lifecycle complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
