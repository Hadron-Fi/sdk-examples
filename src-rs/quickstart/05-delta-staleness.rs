/// Example: Configure delta staleness with a 10-slot buffer.
///
/// Loads the pool created by the init script and demonstrates:
///
///   1. Read current delta staleness from pool config
///   2. Fetch the current slot from the cluster
///   3. Set delta staleness to current_slot + 10 (capped to u8::MAX)
///   4. Verify the update on-chain
///
/// Delta staleness controls how many slots old the oracle midprice update
/// can be before the pool considers it stale and rejects swaps. Setting it
/// to a small buffer above the current slot's trailing delta ensures the
/// pool stays live under normal conditions but halts if the oracle goes
/// silent for too long.
///
/// Prerequisites:
///   Run the TypeScript init script first: npm run init
///
/// Run:
///   cargo run --bin delta-staleness
///   POOL=<address> cargo run --bin delta-staleness
#[allow(dead_code, deprecated)]
#[path = "../setup.rs"]
mod setup;

use hadron_sdk::{types::*, Hadron};
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
    // 1. Read current delta staleness
    // ------------------------------------------------------------------
    log_header("1. Current delta staleness");
    log_info("delta_staleness:", &pool.config.delta_staleness.to_string());

    // ------------------------------------------------------------------
    // 2. Set delta staleness to 10 (a 10-slot buffer)
    // ------------------------------------------------------------------
    log_header("2. Update delta staleness (10-slot buffer)");

    let new_staleness: u8 = 10;
    log_info("New value:", &new_staleness.to_string());

    let ix = pool.update_delta_staleness(
        &authority.pubkey(),
        &UpdateDeltaStalenessParams {
            delta_staleness: new_staleness,
        },
    );
    let sig = send_ix(&rpc, ix, &payer, &[&authority]);
    log_tx("updateDeltaStaleness()", &sig);

    // ------------------------------------------------------------------
    // 3. Verify on-chain
    // ------------------------------------------------------------------
    log_header("3. Verify on-chain");
    let pool = Hadron::load(&rpc, &pool_address).expect("Failed to reload pool");
    log_info("delta_staleness:", &pool.config.delta_staleness.to_string());

    assert_eq!(
        pool.config.delta_staleness, new_staleness,
        "Delta staleness mismatch"
    );
    log_info("Verified:", "on-chain value matches expected");

    // ------------------------------------------------------------------
    // 4. Reset delta staleness back to 0
    // ------------------------------------------------------------------
    log_header("4. Reset delta staleness to 0");

    let ix = pool.update_delta_staleness(
        &authority.pubkey(),
        &UpdateDeltaStalenessParams {
            delta_staleness: 0,
        },
    );
    let sig = send_ix(&rpc, ix, &payer, &[&authority]);
    log_tx("updateDeltaStaleness(0)", &sig);

    let pool = Hadron::load(&rpc, &pool_address).expect("Failed to reload pool");
    log_info("delta_staleness:", &pool.config.delta_staleness.to_string());
    assert_eq!(pool.config.delta_staleness, 0);
    log_info("Verified:", "reset to 0");

    log_header("Done! Delta staleness lifecycle complete.");
}
