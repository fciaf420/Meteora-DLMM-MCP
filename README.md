# Meteora DLMM MCP Server v2.0

A comprehensive MCP server for managing Meteora DLMM positions through Claude AI. Combines the DLMM REST API, on-chain SDK, and Zap SDK into 18 tools covering pool discovery, position management, swaps, liquidity ops, and analytics.

## Quick Start

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure your environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your RPC URL and optionally your wallet private key
   ```

3. **Build and start:**
   ```bash
   npm run build
   npm start
   ```

4. **Development mode (ts-node):**
   ```bash
   npm run dev
   ```

## Tools (18 total)

### Read-Only — API

| Tool | Description |
|------|-------------|
| `meteora_search_pools` | Search/list DLMM pools sorted by liquidity, volume, or fees |
| `meteora_get_pool` | Get detailed metadata for a single pool |
| `meteora_get_protocol_stats` | Aggregate protocol-level metrics (TVL, volume, fees) |
| `meteora_get_pool_ohlcv` | OHLCV candlestick data for a pool |
| `meteora_get_pool_volume` | Historical volume data for a pool |

### Read-Only — SDK (requires RPC)

| Tool | Description |
|------|-------------|
| `meteora_get_active_bin` | Current active bin (price) for a pool |
| `meteora_get_user_positions` | All DLMM positions owned by a wallet |
| `meteora_get_position_details` | Detailed position info (bin range, amounts, fees) |
| `meteora_get_bin_liquidity` | Bin-level liquidity distribution around active bin |
| `meteora_get_swap_quote` | Swap quote with expected output, fees, price impact |
| `meteora_get_pool_fees` | Fee info: base rate, max rate, protocol fee, dynamic fee |
| `meteora_get_emission_rate` | Liquidity mining reward emission rates |

### Write Operations — SDK (requires wallet)

| Tool | Description |
|------|-------------|
| `meteora_claim_fees` | Claim accumulated swap fees from a position |
| `meteora_claim_all_rewards` | Claim all rewards (fees + LM) for positions in a pool |
| `meteora_add_liquidity` | Add liquidity using Spot/Curve/BidAsk strategy |
| `meteora_remove_liquidity` | Remove liquidity (partial or full, with optional close) |
| `meteora_swap` | Execute a token swap on a DLMM pool |
| `meteora_zap` | Single-token deposit via Zap SDK |

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `RPC_URL` | Yes | Solana RPC endpoint |
| `WALLET_PRIVATE_KEY` | No | Base64 or JSON array encoded private key (for write ops) |
| `DEBUG` | No | Enable debug logging (`true`/`false`) |
| `MAX_RETRIES` | No | Max retries for RPC calls (default: 3) |
| `RPC_TIMEOUT` | No | RPC timeout in ms (default: 30000) |

### Smithery Deployment

The server exports a Smithery-compatible factory function with a Zod config schema. Deploy by:

1. Push to GitHub (excluding `.env`)
2. Deploy on Smithery
3. Configure environment variables in the Smithery dashboard
4. Connect to Claude AI

## Architecture

- **API layer**: Uses `https://dlmm-api.meteora.ag` (legacy, reliable) and `https://dlmm.datapi.meteora.ag` (newer endpoints for OHLCV, volume, stats)
- **SDK layer**: `@meteora-ag/dlmm` for on-chain reads and transaction building
- **Zap layer**: `@meteora-ag/zap-sdk` (optional) for single-token deposits
- **Transport**: CommonJS module export for Smithery; stdio via `McpServer`

## Security

- Private keys stay local — configured via env vars only
- Write operations require explicit wallet configuration
- No third-party key sharing
- `.env` is gitignored

## Dependencies

- `@meteora-ag/dlmm` — Meteora DLMM SDK
- `@meteora-ag/zap-sdk` — Meteora Zap SDK (optional)
- `@modelcontextprotocol/sdk` — MCP server framework
- `@solana/web3.js` — Solana Web3
- `bn.js` — Big number support
- `zod` — Schema validation
