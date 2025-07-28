# Meteora DLMM MCP Server

A personal MCP server for managing Meteora DLMM positions through Claude AI.

## Quick Start

1. **Clone and install dependencies:**
   ```bash
   npm install
   ```

2. **Configure your environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your RPC URL and optionally your wallet private key
   ```

3. **Start development server:**
   ```bash
   npm run dev
   ```

## Features

- 🔍 **get_pool_info**: Get detailed pool information
- 👤 **get_user_positions**: View all your DLMM positions
- 💰 **get_claimable_fees**: Check claimable fees for positions
- 🎯 **claim_fees**: Claim accumulated fees (requires wallet)
- 📊 **get_popular_pools**: Discover popular DLMM pools

## Security

- Your private keys stay with you
- Environment variables for sensitive data
- No third-party key sharing required

## Deployment

1. Push to GitHub (excluding .env file)
2. Deploy on Smithery
3. Configure environment variables in Smithery dashboard
4. Connect to Claude AI

## Configuration

Required environment variables:
- `RPC_URL`: Solana RPC endpoint
- `WALLET_PRIVATE_KEY`: Base64 encoded private key (optional, for transactions)

Optional:
- `DEBUG`: Enable debug logging
- `MAX_RETRIES`: RPC retry attempts
- `RPC_TIMEOUT`: RPC timeout in milliseconds