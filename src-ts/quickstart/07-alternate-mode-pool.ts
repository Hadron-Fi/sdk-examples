/**
 * Example: Initialize a Hadron pool with an **Alternate-mode** price curve.
 *
 * In Alternate x-mode, the price curve's x-axis is denominated in
 * "fraction of the sell-side vault consumed by the trade" (Q32 fraction),
 * instead of absolute token atoms. That makes the same curve usable on both
 * bid and ask without scaling — "5% of inventory" is always 5%, regardless of
 * how much liquidity the pool holds.
 *
 * Semantics (from hadron-quote):
 *   Native (0):    x = amount_in                              (atoms)
 *   Alternate (1): x = amount_in * Q32_ONE / vault_balance    (Q32 fraction)
 *
 * For the bid side (selling base X) the denominator is vault_x; for the ask
 * side (selling quote Y) it is vault_y. Because both sides normalize by their
 * own vault, identical curve shapes produce symmetric behavior automatically.
 *
 * This example:
 *   1. Initializes a pool
 *   2. Sets a shared Alt-mode price curve (same points for bid + ask)
 *   3. Deposits liquidity
 *   4. Pushes a midprice update
 *
 * No inventory/risk curve is set — empty risk curves evaluate to a factor of
 * 1.0, so the pool quotes solely on the price curve (plus midprice/spread).
 *
 * Run locally (LiteSVM):
 *   npm run init-alt
 *
 * Run on devnet:
 *   NETWORK=devnet WALLET=./wallet.json npm run init-alt
 */
import { Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  Hadron,
  toQ32,
  Interpolation,
  Side,
  CurveXMode,
} from "@hadron-fi/sdk";
import { TestHarness, logTx, logInfo, logHeader, logExplorer } from "../setup";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

(async () => {
  const h = await TestHarness.create();

  // ---------------------------------------------------------------
  // 1. Create token mints and pool authority
  // ---------------------------------------------------------------
  const mintX = Keypair.generate();
  const mintY = Keypair.generate();
  await h.createMint(mintX, 6);
  await h.createMint(mintY, 6);

  const authority = Keypair.generate();
  await h.airdrop(authority.publicKey, 10_000_000n);

  // ---------------------------------------------------------------
  // 2. Initialize the pool
  // ---------------------------------------------------------------
  const initialMidprice = 150.0;

  const { instructions, poolAddress } = Hadron.initialize(
    h.payer.publicKey,
    {
      mintX: mintX.publicKey,
      mintY: mintY.publicKey,
      authority: authority.publicKey,
      initialMidpriceQ32: toQ32(initialMidprice),
      maxPrefabSlots: 3,
      tokenProgramX: TOKEN_PROGRAM_ID,
      tokenProgramY: TOKEN_PROGRAM_ID,
    }
  );

  logHeader("Step 1 — Initialize pool (alt-mode demo)");
  logInfo("Creating X (base) and Y (quote) mints with 6 decimals...", "");
  let sig = await h.sendIxs(instructions);
  logTx("Initialize", sig);
  logInfo("Pool address:", poolAddress.toBase58());
  logExplorer("View on Solscan:", poolAddress.toBase58());

  const pool = await h.loadPool(poolAddress);

  // ---------------------------------------------------------------
  // 3. Set Alt-mode price curves (bid + ask share identical points)
  //
  //    amountIn is a Q32 fraction of the sell-side vault:
  //      toQ32(0.01) = 1% of vault consumed
  //      toQ32(0.05) = 5% of vault consumed, etc.
  //
  //    The curve is interpreted relative to vault_x on the bid and
  //    vault_y on the ask, so the same shape produces symmetric
  //    spread regardless of per-side depth.
  // ---------------------------------------------------------------
  logHeader("Step 2 — Set Alt-mode price curves (bid + ask, identical shape)");

  // Curve extends all the way to ~99% of vault so the pool can quote any
  // trade size up to near-full depletion (slippage explodes at the tail).
  // Past the last point the program returns InsufficientLiquidity, so leaving
  // a small buffer (<100%) is intentional — it prevents fully draining a side.
  const altPricePoints = [
    { amountIn: toQ32(0.0), priceFactor: 1.0 }, // midprice — no size
    { amountIn: toQ32(0.01), priceFactor: 0.99950 }, // 1%  of vault  → ~5 bps
    { amountIn: toQ32(0.025), priceFactor: 0.99875 }, // 2.5%          → ~12.5 bps
    { amountIn: toQ32(0.05), priceFactor: 0.99700 }, // 5%            → ~30 bps
    { amountIn: toQ32(0.10), priceFactor: 0.99400 }, // 10%           → ~60 bps
    { amountIn: toQ32(0.20), priceFactor: 0.98800 }, // 20%           → ~120 bps
    { amountIn: toQ32(0.40), priceFactor: 0.97500 }, // 40%           → ~250 bps
    { amountIn: toQ32(0.60), priceFactor: 0.95000 }, // 60%           → ~500 bps
    { amountIn: toQ32(0.80), priceFactor: 0.90000 }, // 80%           → ~1000 bps
    { amountIn: toQ32(0.95), priceFactor: 0.80000 }, // 95%           → ~2000 bps
    { amountIn: toQ32(0.99), priceFactor: 0.50000 }, // 99%           → ~5000 bps (steep tail)
  ];

  sig = await h.sendIx(
    pool.setCurve(authority.publicKey, {
      side: Side.Bid,
      defaultInterpolation: Interpolation.Linear,
      slot: 0,
      xMode: CurveXMode.Alternate,
      points: altPricePoints,
    }),
    [authority]
  );
  logTx("Price curve (bid, alt-mode — 7 points)", sig);

  sig = await h.sendIx(
    pool.setCurve(authority.publicKey, {
      side: Side.Ask,
      defaultInterpolation: Interpolation.Linear,
      slot: 0,
      xMode: CurveXMode.Alternate,
      points: altPricePoints,
    }),
    [authority]
  );
  logTx("Price curve (ask, alt-mode — 7 points)", sig);

  // ---------------------------------------------------------------
  // 4. Deposit liquidity
  //    Because the price curve is x-mode=Alternate, the absolute
  //    depth here only affects how many tokens "1% of vault" maps
  //    to — the bps impact schedule itself is unchanged.
  // ---------------------------------------------------------------
  logHeader("Step 3 — Deposit liquidity");
  await h.createAta(pool.addresses.config, mintX.publicKey);
  await h.createAta(pool.addresses.config, mintY.publicKey);

  const userAtaX = await h.createAta(authority.publicKey, mintX.publicKey);
  const userAtaY = await h.createAta(authority.publicKey, mintY.publicKey);
  await h.mintTo(mintX.publicKey, userAtaX, 10_000_000_000n);           // 10k X
  await h.mintTo(mintY.publicKey, userAtaY, 1_500_000_000_000n);        // 1.5M Y

  // 50/50 value deposit: 5,000 X ($750k) + 750,000 Y ($750k)
  sig = await h.sendIx(
    pool.deposit(authority.publicKey, {
      amountX: 5_000_00000n,
      amountY: 750_000_000_000n,
      expiration: Math.floor(Date.now() / 1000) + 3600,
    }),
    [authority]
  );
  logTx("Deposit 5,000 X + 750,000 Y", sig);

  // ---------------------------------------------------------------
  // 5. Update the midprice oracle
  // ---------------------------------------------------------------
  logHeader("Step 4 — Update midprice oracle");
  sig = await h.sendIx(
    pool.updateMidprice(authority.publicKey, {
      midpriceQ32: toQ32(152.5),
    }),
    [authority]
  );
  logTx("Midprice -> 152.5", sig);

  // ---------------------------------------------------------------
  // 6. Save pool config to JSON
  // ---------------------------------------------------------------
  logHeader("Step 5 — Save pool config to output/");
  const outputDir = path.resolve(__dirname, "../../output");
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const authorityKeyFile = `authority-${poolAddress.toBase58().slice(0, 8)}.json`;
  fs.writeFileSync(
    path.join(outputDir, authorityKeyFile),
    JSON.stringify(Array.from(authority.secretKey))
  );

  const entry = {
    poolAddress: poolAddress.toBase58(),
    authority: authority.publicKey.toBase58(),
    authorityKeyFile,
    xMode: "Alternate",
    createdAt: new Date().toISOString(),
  };

  const configPath = path.join(outputDir, "pool-config.json");
  const existing = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf-8"))
    : [];
  const pools = Array.isArray(existing) ? existing : [existing];
  pools.push(entry);
  fs.writeFileSync(configPath, JSON.stringify(pools, null, 2));
  logInfo("Config appended:", "output/pool-config.json");
  logInfo("Authority key:", `output/${authorityKeyFile}`);

  logHeader("Alt-mode pool is live!");
  logInfo("Pool address:", pool.poolAddress.toBase58());
  logExplorer("View on Solscan:", pool.poolAddress.toBase58());
  logInfo("Price x-mode:", "Alternate (fraction of vault)");
  logInfo("Risk curve:", "none (defaults to factor 1.0)");
  logInfo("Next steps:", "npm run read  — inspect pool state and curve xMode");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
