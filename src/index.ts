// Load environment variables from .env file
require('dotenv').config();

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { z } = require("zod");
const { DLMM } = require("@meteora-ag/dlmm");
const { Connection, PublicKey, Keypair } = require("@solana/web3.js");

// Configuration schema - reads from environment variables OR runtime config
const configSchema = z.object({
  rpcUrl: z.string()
    .default(process.env.RPC_URL || "https://api.mainnet-beta.solana.com")
    .describe("Solana RPC URL (e.g., https://api.mainnet-beta.solana.com)"),
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

module.exports = function ({ config }: { config: z.infer<typeof configSchema> }) {
  const connection = new Connection(config.rpcUrl);
  
  // Initialize wallet if private key provided
  let wallet: Keypair | null = null;
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
        const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
        const activeBin = await dlmmPool.getActiveBin();
        const poolInfo = await dlmmPool.getPoolInfo();
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              poolAddress,
              tokenX: dlmmPool.tokenX.mint.toString(),
              tokenY: dlmmPool.tokenY.mint.toString(),
              tokenXSymbol: dlmmPool.tokenX.symbol,
              tokenYSymbol: dlmmPool.tokenY.symbol,
              activeBinId: activeBin.binId,
              activePrice: activeBin.price,
              binStep: poolInfo.binStep,
              fees24h: poolInfo.fees24h,
              volume24h: poolInfo.volume24h,
            }, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error fetching pool info: ${error.message}`
          }]
        };
      }
    }
  );

  // Tool 2: Get User Positions
  server.tool(
    "get_user_positions",
    "Get all user positions for a wallet address",
    {
      userWallet: z.string().describe("User wallet address"),
    },
    async ({ userWallet }) => {
      try {
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

        const positionDetails = await Promise.all(
          userPositions.map(async (position) => {
            try {
              const dlmmPool = await DLMM.create(connection, position.lbPair);
              const positionData = await dlmmPool.getPositionInfo(position.publicKey);
              
              return {
                positionAddress: position.publicKey.toString(),
                poolAddress: position.lbPair.toString(),
                tokenX: dlmmPool.tokenX.symbol || dlmmPool.tokenX.mint.toString(),
                tokenY: dlmmPool.tokenY.symbol || dlmmPool.tokenY.mint.toString(),
                totalXAmount: positionData.totalXAmount,
                totalYAmount: positionData.totalYAmount,
                binIds: positionData.positionBinData.map(bin => bin.binId),
              };
            } catch (error) {
              return {
                positionAddress: position.publicKey.toString(),
                error: `Failed to fetch position details: ${error.message}`
              };
            }
          })
        );
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(positionDetails, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error fetching positions: ${error.message}`
          }]
        };
      }
    }
  );

  // Tool 3: Get Claimable Fees
  server.tool(
    "get_claimable_fees",
    "Get claimable fees for a specific position",
    {
      poolAddress: z.string().describe("DLMM pool address"),
      positionAddress: z.string().describe("Position address"),
    },
    async ({ poolAddress, positionAddress }) => {
      try {
        const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
        const fees = await dlmmPool.getClaimableFee(new PublicKey(positionAddress));
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              positionAddress,
              poolAddress,
              claimableTokenXFees: fees.feeX.toString(),
              claimableTokenYFees: fees.feeY.toString(),
              tokenXSymbol: dlmmPool.tokenX.symbol,
              tokenYSymbol: dlmmPool.tokenY.symbol,
              tokenXMint: dlmmPool.tokenX.mint.toString(),
              tokenYMint: dlmmPool.tokenY.mint.toString(),
            }, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error getting claimable fees: ${error.message}`
          }]
        };
      }
    }
  );

  // Tool 4: Claim Fees (requires wallet)
  server.tool(
    "claim_fees",
    "Claim accumulated fees from a position (requires wallet configuration)",
    {
      poolAddress: z.string().describe("DLMM pool address"),
      positionAddress: z.string().describe("Position address"),
    },
    async ({ poolAddress, positionAddress }) => {
      if (!wallet) {
        return {
          content: [{
            type: "text",
            text: "❌ Error: Wallet not configured. Please provide 'walletPrivateKey' in the server configuration to perform transactions."
          }]
        };
      }

      try {
        const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
        
        // Get fees before claiming
        const feesBefore = await dlmmPool.getClaimableFee(new PublicKey(positionAddress));
        
        const claimFeeTx = await dlmmPool.claimFee({
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
Claimed Token X: ${feesBefore.feeX.toString()}
Claimed Token Y: ${feesBefore.feeY.toString()}
            
View on Solscan: https://solscan.io/tx/${signature}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `❌ Error claiming fees: ${error.message}`
          }]
        };
      }
    }
  );

  // Tool 5: Get Pool List
  server.tool(
    "get_popular_pools",
    "Get list of popular Meteora DLMM pools",
    {
      limit: z.number().optional().default(10).describe("Number of pools to return"),
    },
    async ({ limit }) => {
      try {
        const pools = await DLMM.getAllLbPairs(connection);
        const popularPools = pools.slice(0, limit);
        
        const poolInfo = popularPools.map(pool => ({
          address: pool.publicKey.toString(),
          tokenX: pool.tokenXMint.toString(),
          tokenY: pool.tokenYMint.toString(),
          binStep: pool.binStep,
        }));
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(poolInfo, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error fetching pools: ${error.message}`
          }]
        };
      }
    }
  );

  return server.server;
}

module.exports.configSchema = configSchema;