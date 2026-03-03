/// Example: Authority transfer and quoting authority delegation.
///
/// Demonstrates the full authority management lifecycle:
///
///   1. nominateAuthority — current authority nominates a successor
///   2. acceptAuthority   — nominee accepts (updates Config.authority)
///   3. setQuotingAuthority — new authority delegates quoting to a bot
///   4. Verify the bot can update the midprice
///
/// Run:
///   cargo run --bin authority
///   POOL=<address> cargo run --bin authority
#[allow(dead_code, deprecated)]
#[path = "../setup.rs"]
mod setup;

use hadron_sdk::{
    helpers::math::{from_q32, to_q32},
    types::*,
    Hadron,
};
use solana_sdk::signature::Keypair;
use setup::*;

fn main() {
    let entry = load_pool_config();
    let pool_address = parse_pool_address(&entry);
    let authority = load_authority(&entry);
    let payer = load_wallet();
    let rpc = rpc_client();

    log_header("Load existing pool");
    log_info("Pool:", &pool_address.to_string());
    log_info("Authority:", &authority.pubkey().to_string());

    let pool = Hadron::load(&rpc, &pool_address).expect("Failed to load pool");

    // ------------------------------------------------------------------
    // 1. Nominate a new authority
    // ------------------------------------------------------------------
    let new_authority = Keypair::new();
    // Fund the new authority for tx fees
    let transfer_ix = solana_sdk::system_instruction::transfer(
        &payer.pubkey(),
        &new_authority.pubkey(),
        10_000_000, // 0.01 SOL
    );
    send_ix(&rpc, transfer_ix, &payer, &[]);

    log_header("Step 1 — Nominate new authority");
    log_info("New authority:", &new_authority.pubkey().to_string());

    let ix = pool.nominate_authority(
        &authority.pubkey(),
        &NominateAuthorityParams {
            new_authority: new_authority.pubkey(),
            expiry_slot: 999_999_999,
        },
    );
    let sig = send_ix(&rpc, ix, &payer, &[&authority]);
    log_tx("Nominate", &sig);

    // ------------------------------------------------------------------
    // 2. Accept authority transfer
    //    Only updates Config.authority. Quoting authority on oracle,
    //    curveMeta, curveUpdates is managed via SetQuotingAuthority.
    // ------------------------------------------------------------------
    log_header("Step 2 — Accept authority transfer");

    let ix = pool.accept_authority(&new_authority.pubkey());
    let sig = send_ix(&rpc, ix, &payer, &[&new_authority]);
    log_tx("Accept", &sig);

    // Reload pool to verify
    let pool = Hadron::load(&rpc, &pool_address).expect("Failed to reload pool");
    log_info("Config authority:", &pool.config.authority.to_string());
    log_info("Expected:", &new_authority.pubkey().to_string());
    assert_eq!(
        pool.config.authority,
        new_authority.pubkey(),
        "Authority transfer failed!"
    );

    // ------------------------------------------------------------------
    // 3. Set quoting authority — delegate to a bot
    //    The pool authority can delegate quoting (midprice/curve updates)
    //    to a separate key. This allows a bot to quote without holding
    //    the pool authority key.
    // ------------------------------------------------------------------
    let quoting_bot = Keypair::new();
    let transfer_ix = solana_sdk::system_instruction::transfer(
        &payer.pubkey(),
        &quoting_bot.pubkey(),
        10_000_000,
    );
    send_ix(&rpc, transfer_ix, &payer, &[]);

    log_header("Step 3 — Delegate quoting authority to a bot");
    log_info("Quoting bot:", &quoting_bot.pubkey().to_string());

    let ix = pool.set_quoting_authority(
        &new_authority.pubkey(),
        &SetQuotingAuthorityParams {
            new_quoting_authority: quoting_bot.pubkey(),
            spread_config_pda: None,
        },
    );
    let sig = send_ix(&rpc, ix, &payer, &[&new_authority]);
    log_tx("Set quoting authority", &sig);

    // ------------------------------------------------------------------
    // 4. Verify the bot can update the midprice
    // ------------------------------------------------------------------
    log_header("Step 4 — Bot updates midprice");

    let new_mid = 160.0;
    let ix = pool.update_midprice(
        &quoting_bot.pubkey(),
        &UpdateMidpriceParams {
            midprice_q32: to_q32(new_mid),
            sequence: None,
        },
    );
    let sig = send_ix(&rpc, ix, &payer, &[&quoting_bot]);
    log_tx(&format!("Midprice → {}", new_mid), &sig);

    // Read back and verify
    let pool = Hadron::load(&rpc, &pool_address).expect("Failed to reload pool");
    let readback = from_q32(pool.oracle.midprice_q32);
    log_info("Midprice readback:", &format!("{:.4}", readback));

    log_header("Done! Authority transferred and quoting delegated.");
    log_info("Pool authority:", &new_authority.pubkey().to_string());
    log_info("Quoting bot:", &quoting_bot.pubkey().to_string());
}
