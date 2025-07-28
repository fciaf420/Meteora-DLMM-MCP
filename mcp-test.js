#!/usr/bin/env node

// MCP server standalone runner for testing
require('dotenv').config();

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { z } = require("zod");
const { DLMM } = require("@meteora-ag/dlmm");
const { Connection, PublicKey, Keypair } = require("@solana/web3.js");

// Configuration from environment
const config = {
  rpcUrl: process.env.RPC_URL || "https://api.mainnet-beta.solana.com",
  walletPrivateKey: process.env.WALLET_PRIVATE_KEY,
  debug: process.env.DEBUG === 'true',
  maxRetries: parseInt(process.env.MAX_RETRIES || '3'),
  rpcTimeout: parseInt(process.env.RPC_TIMEOUT || '30000')
};

const connection = new Connection(config.rpcUrl);

// Initialize wallet if private key provided
let wallet = null;
if (config.walletPrivateKey) {
  try {
    wallet = Keypair.fromSecretKey(Buffer.from(config.walletPrivateKey, 'base64'));
    console.log(`Wallet loaded: ${wallet.publicKey.toString()}`);
  } catch (error) {
    console.error("Invalid private key format. Expected base64 encoded private key.");
  }
}

const server = new McpServer({
  name: "Meteora DLMM MCP Server",
  version: "1.0.0",
});

// Tool 1: Get Pool Information
server.tool(
  "get_pool_info",
  "Get detailed information about a Meteora DLMM pool",
  {
    poolAddress: z.string().describe("DLMM pool address"),
  },
  async ({ poolAddress }) => {
    try {
      console.log(`Fetching info for pool: ${poolAddress}`);
      const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
      const activeBin = await dlmmPool.getActiveBin();
      
      const result = {
        poolAddress,
        tokenX: dlmmPool.tokenX.mint.toString(),
        tokenY: dlmmPool.tokenY.mint.toString(),
        tokenXSymbol: dlmmPool.tokenX.symbol,
        tokenYSymbol: dlmmPool.tokenY.symbol,
        activeBinId: activeBin.binId,
        activePrice: activeBin.price,
      };
      
      console.log('Pool info result:', result);
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error) {
      console.error('Pool info error:', error);
      return {
        content: [{
          type: "text",
          text: `Error fetching pool info: ${error.message}`
        }]
      };
    }
  }
);

// Tool 2: Get Popular Pools (simplified for testing)
server.tool(
  "get_popular_pools",
  "Get list of popular Meteora DLMM pools",
  {
    limit: z.number().optional().default(5).describe("Number of pools to return"),
  },
  async ({ limit }) => {
    try {
      console.log(`Fetching ${limit} popular pools...`);
      
      // For testing, return some known pool addresses
      const knownPools = [
        {
          address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
          description: "SOL/USDC Pool"
        },
        {
          address: "Bqhq7H7MdU7MBvFMKQHmCQMUc6pKvN8W6s8k7xFp3jCj",
          description: "Example Pool 2"
        }
      ].slice(0, limit);
      
      console.log('Popular pools result:', knownPools);
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(knownPools, null, 2)
        }]
      };
    } catch (error) {
      console.error('Popular pools error:', error);
      return {
        content: [{
          type: "text",
          text: `Error fetching pools: ${error.message}`
        }]
      };
    }
  }
);

console.log('🚀 Meteora DLMM MCP Server starting...');
console.log('📡 RPC URL:', config.rpcUrl);
console.log('🔑 Wallet:', wallet ? 'Configured' : 'Not configured (read-only mode)');

// Start the server
server.serve({
  transport: {
    type: "stdio"
  }
}).catch(console.error);

console.log('✅ MCP Server is running on stdio transport');
console.log('💡 Use MCP Inspector or Claude to connect!');