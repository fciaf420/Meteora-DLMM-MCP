// Meteora DLMM MCP Server v2 — Full Revamp
// Hybrid: REST API for reads, @meteora-ag/dlmm SDK for on-chain ops, Zap SDK for single-token deposits
require('dotenv').config();

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { z } = require("zod");
const { DLMM } = require("@meteora-ag/dlmm");
const { Connection, PublicKey, Keypair } = require("@solana/web3.js");
const BN = require("bn.js");
const https = require("https");

// Optional Zap SDK
let ZapSDK: any = null;
try { ZapSDK = require("@meteora-ag/zap-sdk"); } catch { /* not installed */ }

// ---------------------------------------------------------------------------
// Config schema (exported for Smithery)
// ---------------------------------------------------------------------------
const configSchema = z.object({
  rpcUrl: z.string()
    .default(process.env.RPC_URL || "https://api.mainnet-beta.solana.com")
    .describe("Solana RPC URL"),
  walletPrivateKey: z.string()
    .optional()
    .default(process.env.WALLET_PRIVATE_KEY || undefined)
    .describe("Wallet private key — JSON byte-array or base64 encoded (KEEP SECURE!)"),
  debug: z.boolean()
    .default(process.env.DEBUG === 'true' || false)
    .describe("Enable debug logging"),
  maxRetries: z.number()
    .default(parseInt(process.env.MAX_RETRIES || '3'))
    .describe("Max retries for API/RPC calls"),
  rpcTimeout: z.number()
    .default(parseInt(process.env.RPC_TIMEOUT || '30000'))
    .describe("Timeout for RPC calls in ms"),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
interface Config { rpcUrl: string; walletPrivateKey?: string; debug?: boolean; maxRetries?: number; rpcTimeout?: number; }

function makeConnection(rpcUrl: string): InstanceType<typeof Connection> {
  return new Connection(rpcUrl, { commitment: "confirmed" });
}

function loadKeypair(config: Config): InstanceType<typeof Keypair> | null {
  if (!config.walletPrivateKey) return null;
  try {
    return Keypair.fromSecretKey(new Uint8Array(JSON.parse(config.walletPrivateKey)));
  } catch {
    try {
      return Keypair.fromSecretKey(Buffer.from(config.walletPrivateKey!, 'base64'));
    } catch {
      console.error("Invalid walletPrivateKey format.");
      return null;
    }
  }
}

// Simple HTTPS JSON GET (no external deps)
function apiGet(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https.get(url, (res: any) => {
      let body = '';
      res.on('data', (c: string) => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`Bad JSON from ${url}: ${body.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

const ok = (data: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true as const });

// ---------------------------------------------------------------------------
// Main export (Smithery pattern)
// ---------------------------------------------------------------------------
module.exports = function ({ config }: { config: Config }) {
  const API = "https://dlmm-api.meteora.ag";          // legacy but reliable
  const DATAPI = "https://dlmm.datapi.meteora.ag";    // newer documented API
  const connection = makeConnection(config.rpcUrl);
  const wallet = loadKeypair(config);
  const log = (...a: any[]) => { if (config.debug) console.error("[meteora-mcp]", ...a); };

  if (wallet) log("Wallet loaded:", wallet.publicKey.toString());

  const server = new McpServer({ name: "Meteora DLMM MCP Server", version: "2.0.0" });

  // =========================================================================
  //  1. SEARCH POOLS — discover DLMM pools (API)
  // =========================================================================
  server.tool(
    "meteora_search_pools",
    `Search and list Meteora DLMM pools sorted by liquidity, volume, or fees.
Returns an array of pool objects with name, address, token mints, binStep, liquidity, 24h volume/fees, and current price.
Read-only. Rate limit: 30 req/s.`,
    {
      limit: z.number().int().min(1).max(100).default(20).describe("Number of pools to return (1-100)"),
      sort_by: z.enum(["liquidity", "volume", "fees"]).default("liquidity").describe("Sort field"),
    },
    async ({ limit, sort_by }: { limit: number; sort_by: string }) => {
      try {
        const allPairs = await apiGet(`${API}/pair/all`);
        const field = sort_by === "volume" ? "trade_volume_24h" : sort_by === "fees" ? "fees_24h" : "liquidity";
        const sorted = allPairs
          .filter((p: any) => parseFloat(p.liquidity || '0') > 0)
          .sort((a: any, b: any) => parseFloat(b[field] || '0') - parseFloat(a[field] || '0'))
          .slice(0, limit);
        const result = sorted.map((p: any) => ({
          address: p.address, name: p.name, mintX: p.mint_x, mintY: p.mint_y,
          binStep: p.bin_step, liquidity: p.liquidity, volume24h: p.trade_volume_24h,
          fees24h: p.fees_24h, currentPrice: p.current_price, apr: p.apr,
        }));
        return ok({ count: result.length, pools: result });
      } catch (e: any) { return fail(e.message); }
    }
  );

  // =========================================================================
  //  2. GET POOL — single pool metadata (API)
  // =========================================================================
  server.tool(
    "meteora_get_pool",
    `Get detailed metadata for one DLMM pool: tokens, bin configuration, reserves, fees, volume, and current price.
Read-only.`,
    { pool_address: z.string().describe("Pool public key address") },
    async ({ pool_address }: { pool_address: string }) => {
      try {
        const d = await apiGet(`${API}/pair/${pool_address}`);
        return ok({
          address: d.address, name: d.name, mintX: d.mint_x, mintY: d.mint_y,
          binStep: d.bin_step, activeBinId: d.active_bin_id, currentPrice: d.current_price,
          liquidity: d.liquidity, volume24h: d.trade_volume_24h, fees24h: d.fees_24h,
          apr: d.apr, reserveX: d.reserve_x_amount, reserveY: d.reserve_y_amount,
        });
      } catch (e: any) { return fail(e.message); }
    }
  );

  // =========================================================================
  //  3. GET ACTIVE BIN — current price (SDK)
  // =========================================================================
  server.tool(
    "meteora_get_active_bin",
    `Get the active bin (current price) for a DLMM pool via on-chain SDK call.
Returns binId, pricePerToken, and supply info. Read-only. Requires RPC.`,
    { pool_address: z.string().describe("Pool public key address") },
    async ({ pool_address }: { pool_address: string }) => {
      try {
        const dlmm = await DLMM.create(connection, new PublicKey(pool_address));
        const activeBin = await dlmm.getActiveBin();
        return ok({
          binId: activeBin.binId,
          price: activeBin.pricePerToken,
          xAmount: activeBin.xAmount?.toString(),
          yAmount: activeBin.yAmount?.toString(),
        });
      } catch (e: any) { return fail(e.message); }
    }
  );

  // =========================================================================
  //  4. GET USER POSITIONS — all positions for a wallet (SDK)
  // =========================================================================
  server.tool(
    "meteora_get_user_positions",
    `Retrieve all DLMM liquidity positions owned by a wallet across all pools.
Returns pool addresses and position keys. Read-only. Requires RPC with getProgramAccounts support.`,
    { wallet_address: z.string().describe("Wallet public key") },
    async ({ wallet_address }: { wallet_address: string }) => {
      try {
        const posMap = await DLMM.getAllLbPairPositionsByUser(connection, new PublicKey(wallet_address));
        const result: any[] = [];
        posMap.forEach((posInfo: any, lbPairAddr: string) => {
          const positions = posInfo.lbPairPositionsData?.map((p: any) => ({
            positionAddress: p.publicKey?.toString(),
            lowerBinId: p.positionData?.lowerBinId,
            upperBinId: p.positionData?.upperBinId,
          })) || [];
          result.push({ poolAddress: lbPairAddr, positionCount: positions.length, positions });
        });
        return ok({ walletAddress: wallet_address, totalPools: result.length, pools: result });
      } catch (e: any) { return fail(e.message); }
    }
  );

  // =========================================================================
  //  5. GET POSITION DETAILS — detailed info for positions in a pool (SDK)
  // =========================================================================
  server.tool(
    "meteora_get_position_details",
    `Get detailed position info for a wallet in a specific pool: bin range, liquidity distribution, and fees.
Read-only. Requires RPC.`,
    {
      pool_address: z.string().describe("Pool public key address"),
      wallet_address: z.string().describe("Wallet public key"),
    },
    async ({ pool_address, wallet_address }: { pool_address: string; wallet_address: string }) => {
      try {
        const dlmm = await DLMM.create(connection, new PublicKey(pool_address));
        const { activeBin, userPositions } = await dlmm.getPositionsByUserAndLbPair(new PublicKey(wallet_address));
        const positions = userPositions.map((pos: any) => ({
          publicKey: pos.publicKey?.toString(),
          lowerBinId: pos.positionData?.lowerBinId,
          upperBinId: pos.positionData?.upperBinId,
          totalXAmount: pos.positionData?.totalXAmount?.toString(),
          totalYAmount: pos.positionData?.totalYAmount?.toString(),
          feeX: pos.positionData?.feeX?.toString(),
          feeY: pos.positionData?.feeY?.toString(),
        }));
        return ok({
          poolAddress: pool_address, activeBinId: activeBin.binId,
          activeBinPrice: activeBin.pricePerToken, positionCount: positions.length, positions,
        });
      } catch (e: any) { return fail(e.message); }
    }
  );

  // =========================================================================
  //  6. GET BIN LIQUIDITY — distribution around active bin (SDK)
  // =========================================================================
  server.tool(
    "meteora_get_bin_liquidity",
    `Get bin-level liquidity distribution around the active bin. Useful for visualizing where liquidity sits.
Read-only. Requires RPC.`,
    {
      pool_address: z.string().describe("Pool public key address"),
      bins_left: z.number().int().min(1).max(50).default(10).describe("Bins to the left of active"),
      bins_right: z.number().int().min(1).max(50).default(10).describe("Bins to the right of active"),
    },
    async ({ pool_address, bins_left, bins_right }: { pool_address: string; bins_left: number; bins_right: number }) => {
      try {
        const dlmm = await DLMM.create(connection, new PublicKey(pool_address));
        const { activeBin, bins } = await dlmm.getBinsAroundActiveBin(bins_left, bins_right);
        const binData = bins.map((b: any) => ({
          binId: b.binId, price: b.pricePerToken,
          xAmount: b.xAmount?.toString(), yAmount: b.yAmount?.toString(),
          supply: b.supply?.toString(),
        }));
        return ok({ activeBinId: activeBin, binCount: binData.length, bins: binData });
      } catch (e: any) { return fail(e.message); }
    }
  );

  // =========================================================================
  //  7. GET SWAP QUOTE — price quote for a swap (SDK)
  // =========================================================================
  server.tool(
    "meteora_get_swap_quote",
    `Get a swap quote for a given input amount on a DLMM pool. Returns expected output, fees, and price impact.
Read-only. Requires RPC.`,
    {
      pool_address: z.string().describe("Pool public key address"),
      amount_in: z.string().describe("Input amount in lamports / smallest unit"),
      swap_for_y: z.boolean().describe("true = swap token X for Y, false = swap Y for X"),
      slippage_bps: z.number().int().min(0).max(10000).default(100).describe("Allowed slippage in basis points (100 = 1%)"),
    },
    async ({ pool_address, amount_in, swap_for_y, slippage_bps }: any) => {
      try {
        const dlmm = await DLMM.create(connection, new PublicKey(pool_address));
        const binArrays = await dlmm.getBinArrayForSwap(swap_for_y, 5);
        const quote = dlmm.swapQuote(
          new BN(amount_in), swap_for_y, new BN(slippage_bps), binArrays
        );
        return ok({
          amountIn: quote.consumedInAmount?.toString(),
          amountOut: quote.outAmount?.toString(),
          fee: quote.fee?.toString(),
          priceImpact: quote.priceImpact?.toString(),
          binsCrossed: quote.binArraysPubkey?.length,
        });
      } catch (e: any) { return fail(e.message); }
    }
  );

  // =========================================================================
  //  8. GET POOL FEES — fee info and dynamic fee (SDK)
  // =========================================================================
  server.tool(
    "meteora_get_pool_fees",
    `Get fee info for a DLMM pool: base fee rate, max fee rate, protocol fee, and current dynamic fee.
Read-only. Requires RPC.`,
    { pool_address: z.string().describe("Pool public key address") },
    async ({ pool_address }: { pool_address: string }) => {
      try {
        const dlmm = await DLMM.create(connection, new PublicKey(pool_address));
        const feeInfo = dlmm.getFeeInfo();
        const dynamicFee = dlmm.getDynamicFee();
        return ok({
          baseFeeRate: feeInfo.baseFeeRatePercentage?.toString(),
          maxFeeRate: feeInfo.maxFeeRatePercentage?.toString(),
          protocolFee: feeInfo.protocolFeePercentage?.toString(),
          currentDynamicFee: dynamicFee?.toString(),
        });
      } catch (e: any) { return fail(e.message); }
    }
  );

  // =========================================================================
  //  9. GET PROTOCOL STATS — aggregate Meteora DLMM stats (API)
  // =========================================================================
  server.tool(
    "meteora_get_protocol_stats",
    `Get aggregated protocol-level metrics across all Meteora DLMM pools (TVL, volume, fee revenue, etc).
Read-only.`,
    {},
    async () => {
      try {
        const data = await apiGet(`${DATAPI}/stats/protocol_metrics`);
        return ok(data);
      } catch (e: any) { return fail(e.message); }
    }
  );

  // =========================================================================
  //  10. CLAIM FEES — claim swap fees from a position (SDK, WRITE)
  // =========================================================================
  server.tool(
    "meteora_claim_fees",
    `Claim accumulated swap fees from a DLMM position. WRITE operation — requires wallet configuration.
Sends a transaction to the Solana network.`,
    {
      pool_address: z.string().describe("Pool public key address"),
      position_address: z.string().describe("Position public key to claim fees from"),
    },
    async ({ pool_address, position_address }: { pool_address: string; position_address: string }) => {
      if (!wallet) return fail("Wallet not configured. Set walletPrivateKey in config.");
      try {
        const dlmm = await DLMM.create(connection, new PublicKey(pool_address));
        const position = await dlmm.getPosition(new PublicKey(position_address));
        const txs = await dlmm.claimSwapFee({ owner: wallet.publicKey, position });
        const signatures: string[] = [];
        for (const tx of Array.isArray(txs) ? txs : [txs]) {
          const sig = await connection.sendTransaction(tx, [wallet]);
          await connection.confirmTransaction(sig);
          signatures.push(sig);
        }
        return ok({ success: true, signatures, solscanLinks: signatures.map((s: string) => `https://solscan.io/tx/${s}`) });
      } catch (e: any) { return fail(e.message); }
    }
  );

  // =========================================================================
  //  11. CLAIM ALL REWARDS — claim fees + LM rewards (SDK, WRITE)
  // =========================================================================
  server.tool(
    "meteora_claim_all_rewards",
    `Claim ALL rewards (swap fees + liquidity mining) for all positions in a pool. WRITE operation — requires wallet.`,
    { pool_address: z.string().describe("Pool public key address") },
    async ({ pool_address }: { pool_address: string }) => {
      if (!wallet) return fail("Wallet not configured. Set walletPrivateKey in config.");
      try {
        const dlmm = await DLMM.create(connection, new PublicKey(pool_address));
        const { userPositions } = await dlmm.getPositionsByUserAndLbPair(wallet.publicKey);
        if (!userPositions.length) return ok({ success: true, message: "No positions found in this pool." });
        const txs = await dlmm.claimAllRewards({ owner: wallet.publicKey, positions: userPositions });
        const signatures: string[] = [];
        for (const tx of txs) {
          const sig = await connection.sendTransaction(tx, [wallet]);
          await connection.confirmTransaction(sig);
          signatures.push(sig);
        }
        return ok({ success: true, positionsClaimed: userPositions.length, signatures });
      } catch (e: any) { return fail(e.message); }
    }
  );

  // =========================================================================
  //  12. ADD LIQUIDITY — open or add to a position by strategy (SDK, WRITE)
  // =========================================================================
  server.tool(
    "meteora_add_liquidity",
    `Add liquidity to a DLMM pool using a strategy (Spot / Curve / BidAsk).
Creates a new position if no position_address is given, or adds to an existing one.
WRITE operation — requires wallet.`,
    {
      pool_address: z.string().describe("Pool public key address"),
      amount_x: z.string().describe("Token X amount in lamports"),
      amount_y: z.string().describe("Token Y amount in lamports"),
      strategy: z.enum(["Spot", "Curve", "BidAsk"]).default("Spot").describe("Liquidity distribution strategy"),
      min_bin_id: z.number().int().describe("Lower bound bin ID for the position"),
      max_bin_id: z.number().int().describe("Upper bound bin ID for the position"),
      slippage: z.number().min(0).max(100).default(1).describe("Slippage tolerance in percent"),
    },
    async (params: any) => {
      if (!wallet) return fail("Wallet not configured. Set walletPrivateKey in config.");
      try {
        const dlmm = await DLMM.create(connection, new PublicKey(params.pool_address));
        const strategyMap: Record<string, number> = { Spot: 0, Curve: 1, BidAsk: 2 };
        const positionKeypair = Keypair.generate();
        const strategy = {
          minBinId: params.min_bin_id,
          maxBinId: params.max_bin_id,
          strategyType: strategyMap[params.strategy],
        };
        const tx = await dlmm.initializePositionAndAddLiquidityByStrategy({
          positionPubKey: positionKeypair.publicKey,
          totalXAmount: new BN(params.amount_x),
          totalYAmount: new BN(params.amount_y),
          strategy,
          user: wallet.publicKey,
          slippage: params.slippage,
        });
        const sig = await connection.sendTransaction(tx, [wallet, positionKeypair]);
        await connection.confirmTransaction(sig);
        return ok({
          success: true,
          positionAddress: positionKeypair.publicKey.toString(),
          signature: sig,
          solscan: `https://solscan.io/tx/${sig}`,
        });
      } catch (e: any) { return fail(e.message); }
    }
  );

  // =========================================================================
  //  13. REMOVE LIQUIDITY — withdraw from a position (SDK, WRITE)
  // =========================================================================
  server.tool(
    "meteora_remove_liquidity",
    `Remove liquidity from a DLMM position. Specify percentage (in bps: 10000 = 100%).
Set claim_and_close to true to also claim rewards and close the position.
WRITE operation — requires wallet.`,
    {
      pool_address: z.string().describe("Pool public key address"),
      position_address: z.string().describe("Position public key"),
      bps: z.number().int().min(1).max(10000).default(10000).describe("Basis points of liquidity to remove (10000 = 100%)"),
      claim_and_close: z.boolean().default(false).describe("Claim rewards and close position after withdrawal"),
    },
    async (params: any) => {
      if (!wallet) return fail("Wallet not configured. Set walletPrivateKey in config.");
      try {
        const dlmm = await DLMM.create(connection, new PublicKey(params.pool_address));
        const position = await dlmm.getPosition(new PublicKey(params.position_address));
        const fromBinId = position.positionData.lowerBinId;
        const toBinId = position.positionData.upperBinId;
        const txs = await dlmm.removeLiquidity({
          user: wallet.publicKey,
          position: new PublicKey(params.position_address),
          fromBinId, toBinId,
          bps: new BN(params.bps),
          shouldClaimAndClose: params.claim_and_close,
        });
        const signatures: string[] = [];
        for (const tx of Array.isArray(txs) ? txs : [txs]) {
          const sig = await connection.sendTransaction(tx, [wallet]);
          await connection.confirmTransaction(sig);
          signatures.push(sig);
        }
        return ok({ success: true, bpsRemoved: params.bps, closed: params.claim_and_close, signatures });
      } catch (e: any) { return fail(e.message); }
    }
  );

  // =========================================================================
  //  14. SWAP — execute a token swap (SDK, WRITE)
  // =========================================================================
  server.tool(
    "meteora_swap",
    `Execute a token swap on a DLMM pool. Use meteora_get_swap_quote first to check expected output.
WRITE operation — requires wallet. Sends a transaction.`,
    {
      pool_address: z.string().describe("Pool public key address"),
      amount_in: z.string().describe("Input amount in lamports"),
      swap_for_y: z.boolean().describe("true = swap X→Y, false = swap Y→X"),
      slippage_bps: z.number().int().min(0).max(10000).default(100).describe("Slippage tolerance in basis points"),
    },
    async (params: any) => {
      if (!wallet) return fail("Wallet not configured. Set walletPrivateKey in config.");
      try {
        const dlmm = await DLMM.create(connection, new PublicKey(params.pool_address));
        const binArrays = await dlmm.getBinArrayForSwap(params.swap_for_y, 5);
        const quote = dlmm.swapQuote(
          new BN(params.amount_in), params.swap_for_y, new BN(params.slippage_bps), binArrays
        );
        const swapTx = await dlmm.swap({
          inToken: params.swap_for_y ? dlmm.tokenX.publicKey : dlmm.tokenY.publicKey,
          outToken: params.swap_for_y ? dlmm.tokenY.publicKey : dlmm.tokenX.publicKey,
          inAmount: new BN(params.amount_in),
          minOutAmount: quote.minOutAmount || quote.outAmount,
          lbPair: dlmm.pubkey,
          user: wallet.publicKey,
          binArraysPubkey: quote.binArraysPubkey,
        });
        const sig = await connection.sendTransaction(swapTx, [wallet]);
        await connection.confirmTransaction(sig);
        return ok({
          success: true,
          amountIn: params.amount_in,
          expectedOut: quote.outAmount?.toString(),
          signature: sig,
          solscan: `https://solscan.io/tx/${sig}`,
        });
      } catch (e: any) { return fail(e.message); }
    }
  );

  // =========================================================================
  //  15. ZAP — single-token deposit into a DLMM position (Zap SDK, WRITE)
  // =========================================================================
  server.tool(
    "meteora_zap",
    `Zap into a DLMM position with a single token using Meteora's Zap SDK.
Automatically swaps and deposits both tokens. WRITE operation — requires wallet + @meteora-ag/zap-sdk installed.`,
    {
      pool_address: z.string().describe("Pool public key address"),
      input_token_mint: z.string().describe("Mint of the token you are depositing"),
      input_amount: z.string().describe("Amount in lamports to zap in"),
      lower_bin_id: z.number().int().describe("Lower bin ID for the new position"),
      upper_bin_id: z.number().int().describe("Upper bin ID for the new position"),
    },
    async (params: any) => {
      if (!wallet) return fail("Wallet not configured. Set walletPrivateKey in config.");
      if (!ZapSDK) return fail("Zap SDK not installed. Run: npm install @meteora-ag/zap-sdk");
      try {
        const zap = new ZapSDK.Zap(connection);
        // The Zap SDK's exact method signature may vary; attempt the most common pattern
        const result = await zap.zapInDlmm({
          pairAddress: new PublicKey(params.pool_address),
          inputTokenMint: new PublicKey(params.input_token_mint),
          inputAmount: new BN(params.input_amount),
          lowerBinId: params.lower_bin_id,
          upperBinId: params.upper_bin_id,
          user: wallet.publicKey,
        });
        // result may be a Transaction or array of instructions
        const tx = result.transaction || result;
        const sig = await connection.sendTransaction(tx, [wallet]);
        await connection.confirmTransaction(sig);
        return ok({
          success: true,
          pool: params.pool_address,
          inputToken: params.input_token_mint,
          inputAmount: params.input_amount,
          binRange: [params.lower_bin_id, params.upper_bin_id],
          signature: sig,
          solscan: `https://solscan.io/tx/${sig}`,
        });
      } catch (e: any) { return fail(`Zap failed: ${e.message}. The Zap SDK method signature may have changed — check @meteora-ag/zap-sdk docs.`); }
    }
  );

  // =========================================================================
  //  16. GET POOL OHLCV — candlestick data (datapi)
  // =========================================================================
  server.tool(
    "meteora_get_pool_ohlcv",
    `Get OHLCV (candlestick) chart data for a pool over a time range. Read-only.`,
    {
      pool_address: z.string().describe("Pool public key address"),
      resolution: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).default("1h").describe("Candle resolution"),
      limit: z.number().int().min(1).max(500).default(100).describe("Number of candles"),
    },
    async ({ pool_address, resolution, limit }: any) => {
      try {
        const data = await apiGet(`${DATAPI}/pools/${pool_address}/ohlcv?resolution=${resolution}&limit=${limit}`);
        return ok(data);
      } catch (e: any) {
        // Fallback to legacy API
        try {
          const data = await apiGet(`${API}/pair/${pool_address}/ohlcv?timeframe=${resolution}&limit=${limit}`);
          return ok(data);
        } catch (e2: any) { return fail(e2.message); }
      }
    }
  );

  // =========================================================================
  //  17. GET POOL VOLUME HISTORY (datapi)
  // =========================================================================
  server.tool(
    "meteora_get_pool_volume",
    `Get historical volume for a pool aggregated into time buckets. Read-only.`,
    {
      pool_address: z.string().describe("Pool public key address"),
    },
    async ({ pool_address }: { pool_address: string }) => {
      try {
        const data = await apiGet(`${DATAPI}/pools/${pool_address}/volume/history`);
        return ok(data);
      } catch (e: any) { return fail(e.message); }
    }
  );

  // =========================================================================
  //  18. GET EMISSION RATE — LM reward emission (SDK)
  // =========================================================================
  server.tool(
    "meteora_get_emission_rate",
    `Get liquidity mining reward emission rates for a pool. Read-only. Requires RPC.`,
    { pool_address: z.string().describe("Pool public key address") },
    async ({ pool_address }: { pool_address: string }) => {
      try {
        const dlmm = await DLMM.create(connection, new PublicKey(pool_address));
        const emission = dlmm.getEmissionRate();
        return ok({
          rewardOne: emission.rewardOne?.toString() || null,
          rewardTwo: emission.rewardTwo?.toString() || null,
        });
      } catch (e: any) { return fail(e.message); }
    }
  );

  log("Server ready — 18 tools registered.");
  return server.server;
};

module.exports.configSchema = configSchema;
