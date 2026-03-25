# Meteora DLMM MCP Server

An MCP (Model Context Protocol) server that gives AI coding agents the ability to interact with Meteora DLMM concentrated liquidity pools on Solana. It combines the Meteora REST API, the `@meteora-ag/dlmm` on-chain SDK, and the `@meteora-ag/zap-sdk` into 18 tools covering pool discovery, position management, swaps, liquidity operations, and protocol analytics -- all accessible through natural language via agents like Claude Code.

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/fciaf420/Meteora-DLMM-MCP.git
cd meteora-dlmm-mcp
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```bash
# Required: Solana RPC endpoint
RPC_URL=https://your-rpc-endpoint.com

# Optional: wallet private key (base64 or JSON array) for write operations
WALLET_PRIVATE_KEY=

# Optional: enable debug logging
DEBUG=false
```

### 3. Build and run

```bash
npm run build
npm start
```

### 4. Connect to your coding agent

See the Claude Code configuration section below to wire the server into your agent.

## Claude Code Configuration

Add the following to your Claude Code MCP configuration file (`~/.claude/claude_desktop_config.json` or the project-level `.mcp.json`):

```json
{
  "mcpServers": {
    "meteora-dlmm": {
      "command": "node",
      "args": ["~/meteora-dlmm-mcp/dist/index.js"],
      "env": {
        "RPC_URL": "your-rpc-url",
        "WALLET_PRIVATE_KEY": "optional-base64-key"
      }
    }
  }
}
```

Replace the path with your actual install location and fill in your RPC URL. The `WALLET_PRIVATE_KEY` field is only needed if you want the agent to execute write operations (swaps, liquidity changes, fee claims).

Once configured, restart Claude Code. The 18 Meteora tools will appear in the agent's tool list and can be invoked through natural language.

## Use Cases -- What Can Your AI Agent Do?

This is where the server shines. Instead of manually calling APIs, constructing transactions, or navigating dashboards, you describe what you want in plain language and the agent handles the rest.

### Portfolio Analysis

> "Show me all my DLMM positions and tell me which ones have unclaimed fees."

The agent calls `meteora_get_user_positions` with your wallet address to enumerate every open position across all pools, then calls `meteora_get_position_details` for each pool to pull bin ranges, token balances, and accumulated fees. It returns a consolidated summary showing each position, its current value breakdown, and any claimable fees.

### Pool Discovery and Research

> "Find the top 5 DLMM pools by volume and compare their fee structures."

The agent calls `meteora_search_pools` sorted by volume with a limit of 5, then calls `meteora_get_pool_fees` for each returned pool address. It presents a comparison table with base fee rate, max fee rate, protocol fee share, and current dynamic fee for each pool alongside their 24-hour volume and liquidity figures.

### Swap Execution with Safety Checks

> "Swap 1 SOL for USDC on the best DLMM pool."

The agent searches for SOL/USDC pools using `meteora_search_pools`, retrieves quotes from the top candidates with `meteora_get_swap_quote`, and presents the best option including expected output, fee cost, and price impact. Only after you confirm does it execute the trade via `meteora_swap` and return the Solscan transaction link.

### Position Management

> "Close my position on the SOL-USDC pool and claim all rewards."

The agent uses `meteora_get_user_positions` to find your position in the target pool, calls `meteora_claim_all_rewards` to harvest any outstanding fees and liquidity mining rewards, then calls `meteora_remove_liquidity` with `claim_and_close` set to true to withdraw 100% of liquidity and close the position. It provides transaction links for each step.

### Market Monitoring

> "What is the current price on the JUP-SOL pool and how has volume trended?"

The agent calls `meteora_get_active_bin` to retrieve the live on-chain price from the active bin, then calls `meteora_get_pool_volume` for historical volume data. It can also pull `meteora_get_pool_ohlcv` candlestick data if you want a more detailed price history, and summarizes the trends in a readable format.

### Liquidity Provision Strategy

> "I want to add $500 of liquidity to the SOL-USDC pool using a Spot strategy."

The agent looks up the pool with `meteora_get_pool`, checks the current active bin via `meteora_get_active_bin`, inspects the surrounding liquidity distribution with `meteora_get_bin_liquidity`, and calculates an appropriate bin range. It then walks you through the `meteora_add_liquidity` call with the Spot strategy, showing the exact parameters before execution.

### Protocol Overview

> "Give me an overview of Meteora DLMM protocol -- TVL, volume, top pools."

The agent calls `meteora_get_protocol_stats` for aggregate metrics (total value locked, cumulative volume, fee revenue), then calls `meteora_search_pools` sorted by liquidity and by volume to identify the leading pools. It assembles a protocol-level report with key figures and top pool rankings.

### Fee Harvesting

> "Check all my positions and claim fees from any that have more than $1 worth."

The agent scans your wallet with `meteora_get_user_positions`, retrieves fee details for each position via `meteora_get_position_details`, evaluates the dollar value of unclaimed fees using current pool prices, and then calls `meteora_claim_fees` on each qualifying position. It reports which positions were claimed and the transaction signatures.

## Tools Reference

The server exposes 18 tools organized into three categories.

### Read-Only -- API

These tools query the Meteora REST API and require no RPC or wallet.

| Tool | Description |
|------|-------------|
| `meteora_search_pools` | Search and list DLMM pools sorted by liquidity, volume, or fees |
| `meteora_get_pool` | Get detailed metadata for a single pool |
| `meteora_get_protocol_stats` | Aggregate protocol-level metrics (TVL, volume, fees) |
| `meteora_get_pool_ohlcv` | OHLCV candlestick chart data for a pool |
| `meteora_get_pool_volume` | Historical volume data for a pool |

### Read-Only -- SDK

These tools use the `@meteora-ag/dlmm` SDK to read on-chain state and require an RPC endpoint.

| Tool | Description |
|------|-------------|
| `meteora_get_active_bin` | Current active bin and price for a pool |
| `meteora_get_user_positions` | All DLMM positions owned by a wallet |
| `meteora_get_position_details` | Detailed position info: bin range, amounts, and fees |
| `meteora_get_bin_liquidity` | Bin-level liquidity distribution around the active bin |
| `meteora_get_swap_quote` | Swap quote with expected output, fees, and price impact |
| `meteora_get_pool_fees` | Fee info: base rate, max rate, protocol fee, dynamic fee |
| `meteora_get_emission_rate` | Liquidity mining reward emission rates |

### Write Operations -- SDK

These tools build and submit transactions to the Solana network. They require both an RPC endpoint and a configured wallet private key.

| Tool | Description |
|------|-------------|
| `meteora_claim_fees` | Claim accumulated swap fees from a position |
| `meteora_claim_all_rewards` | Claim all rewards (fees and LM) for positions in a pool |
| `meteora_add_liquidity` | Add liquidity using Spot, Curve, or BidAsk strategy |
| `meteora_remove_liquidity` | Remove liquidity (partial or full, with optional close) |
| `meteora_swap` | Execute a token swap on a DLMM pool |
| `meteora_zap` | Single-token deposit via the Zap SDK |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `RPC_URL` | Yes | Solana RPC endpoint. Free public endpoints work for reads; a paid endpoint (Helius, QuickNode, Alchemy) is recommended for reliability and `getProgramAccounts` support. |
| `WALLET_PRIVATE_KEY` | No | Base64-encoded or JSON byte-array private key. Required only for write operations (swaps, liquidity, fee claims). |
| `DEBUG` | No | Set to `true` to enable verbose debug logging to stderr. Defaults to `false`. |
| `MAX_RETRIES` | No | Maximum retry attempts for failed API and RPC calls. Defaults to `3`. |
| `RPC_TIMEOUT` | No | Timeout for RPC calls in milliseconds. Defaults to `30000`. |

## Architecture

The server is structured as a hybrid that selects the best data source for each operation:

- **API layer**: Queries `dlmm-api.meteora.ag` (legacy, reliable) and `dlmm.datapi.meteora.ag` (newer endpoints for OHLCV, volume, and protocol stats) for off-chain aggregated data. No RPC needed.
- **SDK layer**: Uses `@meteora-ag/dlmm` for on-chain reads (active bin, positions, bin liquidity, swap quotes, fee info) and transaction construction (swaps, liquidity operations, fee claims).
- **Zap layer**: Uses `@meteora-ag/zap-sdk` for single-token deposits that automatically handle the swap-and-deposit flow.
- **Transport**: stdio, designed for local coding agent integration. The agent spawns the server as a child process and communicates over stdin/stdout using the MCP protocol.

## Security

- **Private keys stay local.** Keys are configured via environment variables and never leave the machine. They are not sent to any external service.
- **Write operations require explicit wallet configuration.** If `WALLET_PRIVATE_KEY` is not set, all write tools return an error. Read-only tools work without a wallet.
- **Agent confirmation before execution.** Coding agents like Claude Code present write operations to the user for approval before executing them. No transaction is sent without your consent.
- **`.env` is gitignored.** The `.env` file containing your secrets is excluded from version control by default.

## Development

```bash
# Run in development mode with ts-node (auto-reloads not included)
npm run dev

# Compile TypeScript to JavaScript
npm run build

# Run the compiled server
npm start

# Type-check without emitting files
npm run compile
```

The server requires Node.js 18 or later.

## Dependencies

| Package | Purpose |
|---------|---------|
| `@meteora-ag/dlmm` | Meteora DLMM SDK for on-chain reads and transactions |
| `@meteora-ag/zap-sdk` | Single-token deposit (zap) functionality |
| `@modelcontextprotocol/sdk` | MCP server framework |
| `@solana/web3.js` | Solana Web3 connection and transaction handling |
| `bn.js` | Big number arithmetic for token amounts |
| `zod` | Schema validation for tool inputs |
| `dotenv` | Environment variable loading from `.env` |

## License

ISC
