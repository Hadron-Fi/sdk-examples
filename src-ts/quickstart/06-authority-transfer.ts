/**
 * Example: Authority transfer and quoting authority delegation.
 *
 * Demonstrates the full authority management lifecycle:
 *
 *   1. nominateAuthority — current authority nominates a successor
 *   2. acceptAuthority   — nominee accepts (updates Config.authority)
 *   3. setQuotingAuthority — new authority delegates quoting to a bot
 *   4. Verify the bot can update the midprice
 *
 * Prerequisites:
 *   Run script 01 first to create the pool:
 *     npm run init
 *
 * Run:
 *   npm run authority
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { Hadron, toQ32, fromQ32 } from "@hadron-fi/sdk";
import { TestHarness, logTx, logInfo, logHeader } from "../setup";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

(async () => {
  // ------------------------------------------------------------------
  // Load pool config from script 01 output
  // ------------------------------------------------------------------
  const configPath = path.resolve(__dirname, "../../output/pool-config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(
      "output/pool-config.json not found. Run script 01 first:\n  npm run init"
    );
  }
  const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  const poolJson = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  const poolAddress = new PublicKey(poolJson.poolAddress);

  // Load authority keypair
  const outputDir = path.resolve(__dirname, "../../output");
  let authority: Keypair;
  if (poolJson.authorityKeyFile) {
    const keyBytes = JSON.parse(
      fs.readFileSync(path.join(outputDir, poolJson.authorityKeyFile), "utf-8")
    );
    authority = Keypair.fromSecretKey(Uint8Array.from(keyBytes));
  } else {
    authority = Keypair.fromSecretKey(Uint8Array.from(poolJson.authority));
  }

  const h = await TestHarness.create();

  logHeader("Load existing pool");
  logInfo("Pool:", poolAddress.toBase58());
  logInfo("Authority:", authority.publicKey.toBase58());

  const pool = await h.loadPool(poolAddress);

  // ------------------------------------------------------------------
  // 1. Nominate a new authority
  // ------------------------------------------------------------------
  const newAuthority = Keypair.generate();
  await h.airdrop(newAuthority.publicKey, 10_000_000n);

  logHeader("Step 1 — Nominate new authority");
  logInfo("New authority:", newAuthority.publicKey.toBase58());

  let sig = await h.sendIx(
    pool.nominateAuthority(authority.publicKey, {
      newAuthority: newAuthority.publicKey,
      expirySlot: 999_999_999n,
    }),
    [authority]
  );
  logTx("Nominate", sig);

  // ------------------------------------------------------------------
  // 2. Accept authority transfer
  //    Only updates Config.authority. Quoting authority on oracle,
  //    curveMeta, curveUpdates is managed via SetQuotingAuthority.
  // ------------------------------------------------------------------
  logHeader("Step 2 — Accept authority transfer");

  sig = await h.sendIx(
    pool.acceptAuthority(newAuthority.publicKey),
    [newAuthority]
  );
  logTx("Accept", sig);

  // Reload pool to pick up the new authority
  const poolAfterTransfer = await h.loadPool(pool.poolAddress);
  logInfo("Config authority:", poolAfterTransfer.config.authority.toBase58());
  logInfo("Expected:", newAuthority.publicKey.toBase58());
  if (poolAfterTransfer.config.authority.toBase58() !== newAuthority.publicKey.toBase58()) {
    throw new Error("Authority transfer failed!");
  }

  // ------------------------------------------------------------------
  // 3. Set quoting authority — delegate to a bot
  //    The pool authority can delegate quoting (midprice/curve updates)
  //    to a separate key. This allows a bot to quote without holding
  //    the pool authority key.
  // ------------------------------------------------------------------
  const quotingBot = Keypair.generate();
  await h.airdrop(quotingBot.publicKey, 10_000_000n);

  logHeader("Step 3 — Delegate quoting authority to a bot");
  logInfo("Quoting bot:", quotingBot.publicKey.toBase58());

  sig = await h.sendIx(
    poolAfterTransfer.setQuotingAuthority(newAuthority.publicKey, {
      newQuotingAuthority: quotingBot.publicKey,
    }),
    [newAuthority]
  );
  logTx("Set quoting authority", sig);

  // ------------------------------------------------------------------
  // 4. Verify the bot can update the midprice
  // ------------------------------------------------------------------
  logHeader("Step 4 — Bot updates midprice");

  const newMid = 160.0;
  sig = await h.sendIx(
    poolAfterTransfer.updateMidprice(quotingBot.publicKey, {
      midpriceQ32: toQ32(newMid),
    }),
    [quotingBot]
  );
  logTx(`Midprice → ${newMid}`, sig);

  // Read back and verify
  const poolFinal = await h.loadPool(pool.poolAddress);
  const readBack = fromQ32(poolFinal.oracle.midpriceQ32);
  logInfo("Midprice readback:", readBack.toFixed(4));

  logHeader("Done! Authority transferred and quoting delegated.");
  logInfo("Pool authority:", newAuthority.publicKey.toBase58());
  logInfo("Quoting bot:", quotingBot.publicKey.toBase58());
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
