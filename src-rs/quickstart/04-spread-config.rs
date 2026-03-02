/// Example: Configure spread triggers and observe their effect on swaps.
///
/// Loads the pool created by the TS init script (from output/pool-config.json)
/// and demonstrates the spread config system:
///
///   1. Initialize a spread config on the pool
///   2. Swap at base spread (baseline)
///   3. Add spread triggers
///   4. Swap with triggers active
///   5. Update triggers (upsert + tighten)
///   6. Clear all triggers
///   7. Final swap at base spread
///
/// Prerequisites:
///   Run the TypeScript init script first: npm run init
///
/// Run:
///   cargo run --bin spread-config
///   POOL=<address> cargo run --bin spread-config
#[allow(dead_code, deprecated)]
#[path = "../setup.rs"]
mod setup;

use hadron_sdk::{
    accounts::{decode_fee_config, decode_spread_config},
    helpers::derive::{get_fee_config_address, get_spread_config_address},
    types::*,
    Hadron,
};
use solana_sdk::pubkey::Pubkey;
use setup::*;

fn log_triggers(label: &str, triggers: &[SpreadTriggerInput]) {
    if triggers.is_empty() {
        log_info(label, "(none)");
    } else {
        for t in triggers {
            let short = &t.account.to_string()[..8];
            log_info(label, &format!("{}… → {} bps", short, t.spread_bps));
        }
    }
}

fn read_spread_config(
    rpc: &solana_client::rpc_client::RpcClient,
    spread_config_pda: &Pubkey,
) -> Option<DecodedSpreadConfig> {
    let acct = rpc.get_account(spread_config_pda).ok()?;
    decode_spread_config(&acct.data).ok()
}

fn main() {
    let entry = load_pool_config();
    let pool_address = parse_pool_address(&entry);
    let authority = load_authority(&entry);
    let payer = load_wallet();
    let rpc = rpc_client();

    log_header("Load existing pool");
    log_info("Pool:", &pool_address.to_string());
    log_info("Authority:", &authority.pubkey().to_string());
    log_info("Payer:", &payer.pubkey().to_string());

    let mut pool = Hadron::load(&rpc, &pool_address).expect("Failed to load pool");
    let program_id = pool.program_id;

    // Resolve fee recipient
    let (fee_config_pda, _) = get_fee_config_address(&program_id);
    let fee_config_acct = rpc.get_account(&fee_config_pda).expect("Fee config not found");
    let fee_config = decode_fee_config(&fee_config_acct.data).expect("Failed to decode fee config");
    let fee_recipient = fee_config.fee_recipient;

    let (spread_config_pda, _) = get_spread_config_address(&pool_address, &program_id);

    // Fund authority with tokens for swapping
    log_header("Setup: fund authority for swaps");
    let mint_x = pool.config.mint_x;
    let mint_y = pool.config.mint_y;
    let user_ata_x = create_ata(&rpc, &payer, &authority.pubkey(), &mint_x);
    let user_ata_y = create_ata(&rpc, &payer, &authority.pubkey(), &mint_y);
    create_ata(&rpc, &payer, &fee_recipient, &mint_x);
    create_ata(&rpc, &payer, &fee_recipient, &mint_y);
    mint_to(&rpc, &payer, &mint_x, &user_ata_x, 10_000_000_000);
    mint_to(&rpc, &payer, &mint_y, &user_ata_y, 10_000_000_000);
    log_info("Minted:", "10,000 X + 10,000 Y to authority");

    // ------------------------------------------------------------------
    // 1. Initialize spread config
    // ------------------------------------------------------------------
    log_header("1. Initialize spread config");

    if pool.config.spread_config_initialized {
        log_info("Spread config:", "already initialized — skipping");
    } else {
        let ix = pool.initialize_spread_config(
            &payer.pubkey(),
            &authority.pubkey(),
            &InitializeSpreadConfigParams {
                admin: authority.pubkey(),
            },
        );
        let sig = send_ix(&rpc, ix, &payer, &[&authority]);
        log_tx("initializeSpreadConfig()", &sig);

        // Reload pool so spread_config_initialized is true
        pool = Hadron::load(&rpc, &pool_address).expect("Failed to reload pool");
    }
    log_info("Spread config PDA:", &spread_config_pda.to_string());

    // Clear any leftover triggers
    if let Some(existing) = read_spread_config(&rpc, &spread_config_pda) {
        if existing.num_triggers > 0 {
            log_info(
                "Clearing:",
                &format!("{} leftover triggers from previous run", existing.num_triggers),
            );
            let ix = pool.update_spread_config(
                &authority.pubkey(),
                &UpdateSpreadConfigParams { triggers: vec![] },
            );
            let _ = send_ix(&rpc, ix, &payer, &[&authority]);
        }
    }

    // ------------------------------------------------------------------
    // 2. Swap at base spread (no triggers)
    // ------------------------------------------------------------------
    log_header("2. Swap at base spread (no triggers)");
    let ix = pool.swap(
        &authority.pubkey(),
        &SwapParams {
            is_x: true,
            amount_in: 10_000_000,
            min_out: 0,
            fee_recipient,
            expiration: None,
        },
    );
    let sig = send_ix(&rpc, ix, &payer, &[&authority]);
    log_tx("Swap 10 X → Y (base spread only)", &sig);

    // ------------------------------------------------------------------
    // 3. Add spread triggers
    // ------------------------------------------------------------------
    log_header("3. Add spread triggers (30 + 50 bps)");

    let trigger1 = Pubkey::new_unique();
    let trigger2 = Pubkey::new_unique();

    let ix = pool.update_spread_config(
        &authority.pubkey(),
        &UpdateSpreadConfigParams {
            triggers: vec![
                SpreadTriggerInput { account: trigger1, spread_bps: 30 },
                SpreadTriggerInput { account: trigger2, spread_bps: 50 },
            ],
        },
    );
    let sig = send_ix(&rpc, ix, &payer, &[&authority]);
    log_tx("updateSpreadConfig() — 2 triggers", &sig);

    if let Some(state) = read_spread_config(&rpc, &spread_config_pda) {
        log_info("On-chain triggers:", &format!("{}", state.num_triggers));
        log_triggers("  trigger", &state.triggers);
    }

    // ------------------------------------------------------------------
    // 4. Swap with triggers active
    // ------------------------------------------------------------------
    log_header("4. Swap with triggers active");
    let ix = pool.swap(
        &authority.pubkey(),
        &SwapParams {
            is_x: true,
            amount_in: 10_000_000,
            min_out: 0,
            fee_recipient,
            expiration: None,
        },
    );
    let sig = send_ix(&rpc, ix, &payer, &[&authority]);
    log_tx("Swap 10 X → Y (triggers: +30/+50 bps)", &sig);

    // ------------------------------------------------------------------
    // 5. Replace triggers — tighten to 5 bps
    // ------------------------------------------------------------------
    log_header("5. Replace triggers — tighten to 5 bps");
    let ix = pool.update_spread_config(
        &authority.pubkey(),
        &UpdateSpreadConfigParams {
            triggers: vec![SpreadTriggerInput {
                account: trigger1,
                spread_bps: 5,
            }],
        },
    );
    let sig = send_ix(&rpc, ix, &payer, &[&authority]);
    log_tx("updateSpreadConfig() — replace all → 1 at 5 bps", &sig);

    if let Some(state) = read_spread_config(&rpc, &spread_config_pda) {
        log_info("On-chain triggers:", &format!("{}", state.num_triggers));
        log_triggers("  trigger", &state.triggers);
    }

    // ------------------------------------------------------------------
    // 6. Swap with tight trigger
    // ------------------------------------------------------------------
    log_header("6. Swap with tight trigger");
    let ix = pool.swap(
        &authority.pubkey(),
        &SwapParams {
            is_x: true,
            amount_in: 50_000_000,
            min_out: 0,
            fee_recipient,
            expiration: None,
        },
    );
    let sig = send_ix(&rpc, ix, &payer, &[&authority]);
    log_tx("Swap 50 X → Y (trigger: +5 bps)", &sig);

    // ------------------------------------------------------------------
    // 7. Clear all triggers
    // ------------------------------------------------------------------
    log_header("7. Clear all triggers");
    let ix = pool.update_spread_config(
        &authority.pubkey(),
        &UpdateSpreadConfigParams { triggers: vec![] },
    );
    let sig = send_ix(&rpc, ix, &payer, &[&authority]);
    log_tx("updateSpreadConfig() — clear all", &sig);

    if let Some(state) = read_spread_config(&rpc, &spread_config_pda) {
        log_info("On-chain triggers:", &format!("{}", state.num_triggers));
        log_triggers("  trigger", &state.triggers);
    }

    // ------------------------------------------------------------------
    // 8. Final swap at base spread
    // ------------------------------------------------------------------
    log_header("8. Swap at base spread (triggers cleared)");
    let ix = pool.swap(
        &authority.pubkey(),
        &SwapParams {
            is_x: true,
            amount_in: 10_000_000,
            min_out: 0,
            fee_recipient,
            expiration: None,
        },
    );
    let sig = send_ix(&rpc, ix, &payer, &[&authority]);
    log_tx("Swap 10 X → Y (base spread only)", &sig);

    log_header("Done! Spread config lifecycle complete.");
}
