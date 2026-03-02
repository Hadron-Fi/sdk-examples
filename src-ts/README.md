# TypeScript Examples

All commands run from the project root (`hadron-examples/`).

## Quickstart — devnet pool lifecycle

```
npm run init          Create pool on devnet (mints, curves, deposit)
      │                  ↳ saves pool address to output/pool-config.json
      ▼
npm run read          Inspect pool state (midprice, spread, curves, balances)
      │
      ▼
npm run write         Update midprice, spread, curves, execute swaps
      │
      ▼
npm run spread        Configure spread triggers, swap at different widths
```

> To customize the pool, edit [`quickstart/01-initialize-pool.ts`](quickstart/01-initialize-pool.ts) and re-run `npm run init`.

| # | File | Description |
|---|------|-------------|
| 01 | [Initialize Pool](quickstart/01-initialize-pool.ts) | Creates a pool from scratch: mints, curves, deposit, midprice. |
| 02 | [Read Pool State](quickstart/02-read-pool-state.ts) | Prints midprice, spread, decoded curve points, vault balances, and oracle state. |
| 03 | [Write Pool Updates](quickstart/03-write-pool-updates.ts) | Updates midprice, base spread, and curve points on a live pool, then executes a swap. |
| 04 | [Spread Config](quickstart/04-spread-config.ts) | Full spread trigger lifecycle: initialize, add/update/remove triggers, swap at each stage. |

## Simulations — local LiteSVM

```
npm run depth-curves  Simulate & visualize depth across inventory levels
      │                  ↳ output/depth-curves.html
      ▼
npm run interp        Compare 5 interpolation modes on the same control points
                         ↳ output/interp-comparison.html
```

| # | File | Description |
|---|------|-------------|
| 01 | [Depth Curves](simulations/01-depth-curves.ts) | Recreates the pool in LiteSVM at multiple inventory levels and generates an interactive depth chart. |
| 02 | [Interpolation Comparison](simulations/02-interpolation-comparison.ts) | Compares Step, Linear, Hyperbolic, Quadratic, and Cubic interpolation on the same control points. |

Simulations auto-fetch pool and fee config from devnet on first run, caching to `output/sim-cache.json`. Delete the cache to force a refresh.

## Docker

LiteSVM requires x86_64 Linux. If simulations fail with a native binding error, use Docker:

```bash
npm run docker:build         # build image (once)
npm run docker:depth-curves  # → output/depth-curves.html
npm run docker:interp        # → output/interp-comparison.html
```
