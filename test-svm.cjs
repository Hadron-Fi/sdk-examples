const { LiteSVM, FeatureSet } = require("litesvm");
const { PublicKey, Keypair, Transaction, Connection } = require("@solana/web3.js");
const { TOKEN_PROGRAM_ID, MintLayout, getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, createMintToInstruction } = require("@solana/spl-token");
const { Hadron, toQ32, Interpolation, Side, HADRON_PROGRAM_ID, getFeeConfigAddress, decodeFeeConfig, decodeConfig, decodeMidpriceOracle, decodeCurveMeta, derivePoolAddresses } = require("@hadron-fi/sdk");
const path = require("path");

const PROGRAM_PATH = path.resolve(__dirname, "programs/hadron.so");
const PROGRAM_ID = HADRON_PROGRAM_ID;

function logMem(label) {
  const used = process.memoryUsage();
  console.log(`  [${label}] rss=${Math.round(used.rss / 1024 / 1024)}MB heap=${Math.round(used.heapUsed / 1024 / 1024)}MB`);
}

function sendTx(svm, payer, ixs) {
  const tx = new Transaction();
  for (const ix of ixs) tx.add(ix);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = svm.latestBlockhash();
  tx.sign(payer);
  const result = svm.sendTransaction(tx);
  svm.expireBlockhash();
}

function createMint(svm, payer, mintKp, decimals) {
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode({
    mintAuthorityOption: 1,
    mintAuthority: payer.publicKey,
    supply: 0n,
    decimals,
    isInitialized: true,
    freezeAuthorityOption: 0,
    freezeAuthority: PublicKey.default,
  }, data);
  svm.setAccount(mintKp.publicKey, {
    lamports: 1000000000n,
    data,
    owner: TOKEN_PROGRAM_ID,
    executable: false,
  });
}

function createAta(svm, payer, owner, mint) {
  const ata = getAssociatedTokenAddressSync(mint, owner, true);
  if (svm.getAccount(ata)) return ata;
  const ix = createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, mint);
  sendTx(svm, payer, [ix]);
  return ata;
}

function loadPool(svm, addr) {
  const configData = svm.getAccount(addr);
  const config = decodeConfig(new Uint8Array(configData.data));
  const addrs = derivePoolAddresses(config.seed, config.mintX, config.mintY, config.tokenProgramX, config.tokenProgramY, HADRON_PROGRAM_ID);
  const oracleData = svm.getAccount(addrs.midpriceOracle);
  const curveMetaData = svm.getAccount(addrs.curveMeta);
  const curvePrefabsData = svm.getAccount(addrs.curvePrefabs);
  return new Hadron(null, addr, addrs, config, decodeMidpriceOracle(new Uint8Array(oracleData.data)), decodeCurveMeta(new Uint8Array(curveMetaData.data)), new Uint8Array(curvePrefabsData.data), HADRON_PROGRAM_ID);
}

async function main() {
  console.log("Step 1: Fetch fee config from devnet");
  const rpcUrl = process.env.RPC_URL || "https://api.devnet.solana.com";
  const conn = new Connection(rpcUrl, "confirmed");
  const [feeConfigPda] = getFeeConfigAddress();
  const feeConfigAcct = await conn.getAccountInfo(feeConfigPda);
  if (!feeConfigAcct) throw new Error("Fee config not found");
  const feeRecipient = decodeFeeConfig(feeConfigAcct.data).feeRecipient;
  console.log("  Fee recipient:", feeRecipient.toBase58());
  logMem("fee config fetched");

  console.log("\nStep 2: Create SVM with fee config injected");
  const svm = LiteSVM.default()
    .withFeatureSet(FeatureSet.allEnabled())
    .withSigverify(false)
    .withBuiltins()
    .withSysvars()
    .withDefaultPrograms()
    .withLamports(1000000000000000n);
  svm.addProgramFromFile(PROGRAM_ID, PROGRAM_PATH);

  svm.setAccount(feeConfigPda, {
    lamports: BigInt(feeConfigAcct.lamports),
    data: Buffer.from(feeConfigAcct.data),
    owner: HADRON_PROGRAM_ID,
    executable: false,
  });
  logMem("svm + fee config");

  const payer = Keypair.generate();
  svm.airdrop(payer.publicKey, 100000000000000n);
  svm.airdrop(feeRecipient, 1000000000n);

  const mintX = Keypair.generate();
  const mintY = Keypair.generate();
  createMint(svm, payer, mintX, 6);
  createMint(svm, payer, mintY, 6);

  // Create all ATAs
  createAta(svm, payer, feeRecipient, mintX.publicKey);
  createAta(svm, payer, feeRecipient, mintY.publicKey);
  const payerAtaX = createAta(svm, payer, payer.publicKey, mintX.publicKey);
  const payerAtaY = createAta(svm, payer, payer.publicKey, mintY.publicKey);

  // Mint large supply
  sendTx(svm, payer, [
    createMintToInstruction(mintX.publicKey, payerAtaX, payer.publicKey, BigInt("1000000000000000000")),
    createMintToInstruction(mintY.publicKey, payerAtaY, payer.publicKey, BigInt("1000000000000000000")),
  ]);
  logMem("setup complete");

  console.log("\nStep 3: Create pool + curves + deposit + SWAP (one at a time)");
  for (let i = 0; i < 20; i++) {
    try {
      const { instructions, poolAddress } = Hadron.initialize(payer.publicKey, {
        seed: BigInt(i),
        mintX: mintX.publicKey,
        mintY: mintY.publicKey,
        authority: payer.publicKey,
        initialMidpriceQ32: toQ32(150.0),
      });
      sendTx(svm, payer, instructions);

      const pool = loadPool(svm, poolAddress);

      // Set curves
      sendTx(svm, payer, [
        pool.setCurve(payer.publicKey, { side: Side.Bid, defaultInterpolation: Interpolation.Linear, slot: 0,
          points: [{ amountIn: 0n, priceFactor: 1.0 }, { amountIn: 500000000n, priceFactor: 0.995 }, { amountIn: 1000000000n, priceFactor: 0.98 }] }),
        pool.setCurve(payer.publicKey, { side: Side.Ask, defaultInterpolation: Interpolation.Linear, slot: 0,
          points: [{ amountIn: 0n, priceFactor: 1.0 }, { amountIn: 75000000000n, priceFactor: 0.995 }, { amountIn: 150000000000n, priceFactor: 0.98 }] }),
      ]);

      // Set risk curves
      sendTx(svm, payer, [
        pool.setRiskCurve(payer.publicKey, { side: Side.Bid, defaultInterpolation: Interpolation.Linear, slot: 0,
          points: [{ pctBase: 0.0, priceFactor: 1.005 }, { pctBase: 0.5, priceFactor: 1.0 }, { pctBase: 1.0, priceFactor: 0.99 }] }),
        pool.setRiskCurve(payer.publicKey, { side: Side.Ask, defaultInterpolation: Interpolation.Linear, slot: 0,
          points: [{ pctBase: 0.0, priceFactor: 0.99 }, { pctBase: 0.5, priceFactor: 1.0 }, { pctBase: 1.0, priceFactor: 1.005 }] }),
      ]);

      // Create vault ATAs + deposit
      createAta(svm, payer, pool.addresses.config, mintX.publicKey);
      createAta(svm, payer, pool.addresses.config, mintY.publicKey);
      sendTx(svm, payer, [
        pool.deposit(payer.publicKey, { amountX: 5000000000n, amountY: 750000000000n }),
      ]);

      // SWAP
      sendTx(svm, payer, [
        pool.swap(payer.publicKey, { isX: true, amountIn: 100000000n, minOut: 0n, feeRecipient }),
      ]);

      logMem(`pool ${i} (init+curves+deposit+swap)`);
    } catch (e) {
      console.log(`  FAILED at pool ${i}: ${e.message.slice(0, 200)}`);
      logMem("at failure");
      break;
    }
  }

  console.log("\nDone!");
  logMem("final");
}

main().catch(e => { console.error(e); process.exit(1); });
