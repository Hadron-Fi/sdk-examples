const { LiteSVM, FeatureSet } = require("litesvm");
const { PublicKey, Keypair, Transaction } = require("@solana/web3.js");
const { TOKEN_PROGRAM_ID, MintLayout, getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction } = require("@solana/spl-token");
const { Hadron, toQ32, Interpolation, Side, HADRON_PROGRAM_ID } = require("@hadron-fi/sdk");
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

console.log("Step 1: Create SVM + load program");
logMem("start");

const svm = LiteSVM.default()
  .withFeatureSet(FeatureSet.allEnabled())
  .withSigverify(false)
  .withBuiltins()
  .withSysvars()
  .withDefaultPrograms()
  .withLamports(1000000000000000n);
svm.addProgramFromFile(PROGRAM_ID, PROGRAM_PATH);
logMem("svm created");

const payer = Keypair.generate();
svm.airdrop(payer.publicKey, 100000000000000n);
logMem("payer funded");

console.log("\nStep 2: Create mints");
const mintX = Keypair.generate();
const mintY = Keypair.generate();
createMint(svm, payer, mintX, 6);
createMint(svm, payer, mintY, 6);
logMem("mints created");

console.log("\nStep 3: Initialize pool");
const { instructions, poolAddress } = Hadron.initialize(payer.publicKey, {
  mintX: mintX.publicKey,
  mintY: mintY.publicKey,
  authority: payer.publicKey,
  initialMidpriceQ32: toQ32(150.0),
});
sendTx(svm, payer, instructions);
logMem("pool initialized");

console.log("\nStep 4: Initialize 10 more pools...");
for (let i = 0; i < 10; i++) {
  const { instructions: ixs } = Hadron.initialize(payer.publicKey, {
    seed: BigInt(i + 1),
    mintX: mintX.publicKey,
    mintY: mintY.publicKey,
    authority: payer.publicKey,
    initialMidpriceQ32: toQ32(150.0),
  });
  sendTx(svm, payer, ixs);
  logMem(`pool ${i + 1}`);
}

console.log("\nStep 5: Initialize 50 pools with curves + deposit...");
for (let i = 0; i < 50; i++) {
  try {
    const { instructions: ixs, poolAddress: addr } = Hadron.initialize(payer.publicKey, {
      seed: BigInt(100 + i),
      mintX: mintX.publicKey,
      mintY: mintY.publicKey,
      authority: payer.publicKey,
      initialMidpriceQ32: toQ32(150.0),
    });
    sendTx(svm, payer, ixs);

    // Load pool to set curves
    const { decodeConfig, decodeMidpriceOracle, decodeCurveMeta, derivePoolAddresses } = require("@hadron-fi/sdk");
    const configData = svm.getAccount(addr);
    const config = decodeConfig(new Uint8Array(configData.data));
    const addrs = derivePoolAddresses(config.seed, config.mintX, config.mintY, config.tokenProgramX, config.tokenProgramY, HADRON_PROGRAM_ID);
    const oracleData = svm.getAccount(addrs.midpriceOracle);
    const curveMetaData = svm.getAccount(addrs.curveMeta);
    const curvePrefabsData = svm.getAccount(addrs.curvePrefabs);
    const pool = new Hadron(null, addr, addrs, config, decodeMidpriceOracle(new Uint8Array(oracleData.data)), decodeCurveMeta(new Uint8Array(curveMetaData.data)), new Uint8Array(curvePrefabsData.data), HADRON_PROGRAM_ID);

    // Set price curves
    sendTx(svm, payer, [
      pool.setCurve(payer.publicKey, {
        side: Side.Bid,
        defaultInterpolation: Interpolation.Linear,
        slot: 0,
        points: [
          { amountIn: 0n, priceFactor: 1.0 },
          { amountIn: 500000000n, priceFactor: 0.995 },
          { amountIn: 1000000000n, priceFactor: 0.98 },
        ],
      }),
    ]);

    if (i % 10 === 9) logMem(`pool+curves ${i + 1}`);
  } catch (e) {
    console.log(`  FAILED at pool ${i}: ${e.message}`);
    logMem("at failure");
    break;
  }
}

console.log("\nAll done!");
logMem("final");
