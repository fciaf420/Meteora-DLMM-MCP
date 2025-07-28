// Hybrid Meteora DLMM MCP Server - API for reads, SDK for writes
require('dotenv').config();

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { z } = require("zod");
const { DLMM } = require("@meteora-ag/dlmm");
const { Connection, PublicKey, Keypair } = require("@solana/web3.js");
const https = require('https');

// Configuration schema
const configSchema = z.object({
  rpcUrl: z.string()
    .default(process.env.RPC_URL || "https://solana-rpc.publicnode.com")
    .describe("Solana RPC URL (e.g., https://solana-rpc.publicnode.com)"),
  walletPrivateKey: z.string()
    .optional()
    .default(process.env.WALLET_PRIVATE_KEY || undefined)
    .describe("Base64 encoded wallet private key for transactions (KEEP SECURE!)"),
  debug: z.boolean()
    .default(process.env.DEBUG === 'true' || false)
    .describe("Enable debug logging"),
  maxRetries: z.number()
    .default(parseInt(process.env.MAX_RETRIES || '3'))
    .describe("Maximum retries for failed RPC calls"),
  rpcTimeout: z.number()
    .default(parseInt(process.env.RPC_TIMEOUT || '30000'))
    .describe("Timeout for RPC calls in milliseconds")
});

module.exports = function ({ config }: { config: any }) {
  const connection = new Connection(config.rpcUrl);
  const apiBase = "https://dlmm-api.meteora.ag";
  
  // Initialize wallet if private key provided
  let wallet: any = null;
  if (config.walletPrivateKey) {
    try {
      wallet = Keypair.fromSecretKey(Buffer.from(config.walletPrivateKey, 'base64'));
      console.log(`Wallet loaded: ${wallet.publicKey.toString()}`);
    } catch (error: any) {
      console.error("Invalid private key format. Expected base64 encoded private key.");
    }
  }

  // Helper function for API calls
  function apiCall(endpoint: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const url = `${apiBase}${endpoint}`;
      if (config.debug) console.log(`API Call: ${url}`);
      
      https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(new Error(`Failed to parse JSON: ${error.message}`));
          }
        });
      }).on('error', reject);
    });
  }

  const server = new McpServer({
    name: "Meteora DLMM MCP Server (Hybrid)",
    version: "2.0.0",
  });

  // Tool 1: Get Pool Information (API-based)
  server.tool(
    "get_pool_info",
    "Get detailed information about a Meteora DLMM pool",
    {
      poolAddress: z.string().describe("DLMM pool address"),
    },
    async ({ poolAddress }: { poolAddress: string }) => {
      try {
        const poolData = await apiCall(`/pair/${poolAddress}`);
        
        const result = {
          poolAddress,
          name: poolData.name,
          tokenX: poolData.mint_x,
          tokenY: poolData.mint_y,
          activeBinId: poolData.active_bin_id,
          fees24h: poolData.fees_24h || 0,
          volume24h: poolData.volume_24h || 0,
          liquidity: poolData.liquidity || "0",
          currentPrice: poolData.current_price,
          binStep: poolData.bin_step
        };
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Error fetching pool info: ${error.message}`
          }]
        };
      }
    }
  );

  // Tool 2: Get User Positions (API-based)
  server.tool(
    "get_user_positions",
    "Get all user positions for a wallet address",
    {
      userWallet: z.string().describe("User wallet address"),
    },
    async ({ userWallet }: { userWallet: string }) => {
      try {
        // Try API approach first
        try {
          const positions = await apiCall(`/user/${userWallet}`);
          if (positions && positions.length > 0) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify(positions, null, 2)
              }]
            };
          }
        } catch (apiError) {
          if (config.debug) console.log('API user endpoint not available, using SDK fallback');
        }
        
        // Fallback to SDK (might fail with restricted RPC)
        const userPositions = await DLMM.getAllLbPairPositionsByUser(
          connection, 
          new PublicKey(userWallet)
        );
        
        if (userPositions.length === 0) {
          return {
            content: [{
              type: "text",
              text: "No DLMM positions found for this wallet."
            }]
          };
        }

        const positionDetails = userPositions.map((position: any) => ({
          positionAddress: position.publicKey.toString(),
          poolAddress: position.lbPair.toString(),
        }));
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(positionDetails, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Error fetching positions: ${error.message}`
          }]
        };
      }
    }
  );

  // Tool 3: Get Popular Pools (API-based)
  server.tool(
    "get_popular_pools",
    "Get list of popular Meteora DLMM pools",
    {
      limit: z.number().optional().default(10).describe("Number of pools to return"),
    },
    async ({ limit }: { limit?: number }) => {
      try {
        const allPairs = await apiCall('/pair/all');
        
        // Sort by liquidity and take top pools
        const sortedPairs = allPairs
          .filter((pair: any) => parseFloat(pair.liquidity || '0') > 0)
          .sort((a: any, b: any) => parseFloat(b.liquidity || '0') - parseFloat(a.liquidity || '0'))
          .slice(0, limit || 10);
        
        const poolInfo = sortedPairs.map((pool: any) => ({
          address: pool.address,
          name: pool.name,
          tokenX: pool.mint_x,
          tokenY: pool.mint_y,
          liquidity: pool.liquidity,
          volume24h: pool.volume_24h || 0,
          fees24h: pool.fees_24h || 0
        }));
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(poolInfo, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Error fetching pools: ${error.message}`
          }]
        };
      }
    }
  );

  // Tool 4: Get Claimable Fees (Hybrid: API for pool info, SDK for fee calc)
  server.tool(
    "get_claimable_fees",
    "Get claimable fees for a specific position",
    {
      poolAddress: z.string().describe("DLMM pool address"),
      positionAddress: z.string().describe("Position address"),
    },
    async ({ poolAddress, positionAddress }: { poolAddress: string; positionAddress: string }) => {
      try {
        // Get pool info from API
        const poolData = await apiCall(`/pair/${poolAddress}`);
        
        // For now, return pool info - fee calculation would need SDK with unrestricted RPC
        const result = {
          positionAddress,
          poolAddress,
          poolName: poolData.name,
          note: "Fee calculation requires SDK with unrestricted RPC endpoint",
          suggestion: "Use a paid RPC provider (Helius, QuickNode) for fee calculations"
        };
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Error getting claimable fees: ${error.message}`
          }]
        };
      }
    }
  );

  // Tool 5: Claim Fees (SDK-based transaction)
  server.tool(
    "claim_fees",
    "Claim accumulated fees from a position (requires wallet configuration)",
    {
      poolAddress: z.string().describe("DLMM pool address"),
      positionAddress: z.string().describe("Position address"),
    },
    async ({ poolAddress, positionAddress }: { poolAddress: string; positionAddress: string }) => {
      if (!wallet) {
        return {
          content: [{
            type: "text",
            text: "❌ Error: Wallet not configured. Please provide 'walletPrivateKey' in the server configuration to perform transactions."
          }]
        };
      }

      try {
        // This requires SDK and unrestricted RPC
        const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
        
        const claimFeeTx = await dlmmPool.claimSwapFee({
          owner: wallet.publicKey,
          position: new PublicKey(positionAddress),
        });

        const signature = await connection.sendTransaction(claimFeeTx, [wallet]);
        await connection.confirmTransaction(signature);
        
        return {
          content: [{
            type: "text",
            text: `✅ Fees claimed successfully!
            
Transaction: ${signature}
            
View on Solscan: https://solscan.io/tx/${signature}`
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `❌ Error claiming fees: ${error.message}

Note: This operation requires an unrestricted RPC endpoint. Consider upgrading to a paid RPC provider.`
          }]
        };
      }
    }
  );

  return server.server;
}

module.exports.configSchema = configSchema;