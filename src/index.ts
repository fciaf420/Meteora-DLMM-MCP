// Meteora DLMM MCP Server v3
// Hybrid: REST API for reads, @meteora-ag/dlmm SDK for on-chain ops, Zap SDK for single-token deposits
require("dotenv").config();

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const DLMM = require("@meteora-ag/dlmm");
const { Connection, PublicKey, Keypair, ComputeBudgetProgram } = require("@solana/web3.js");
const BN = require("bn.js");
const bs58 = require("bs58");
const https = require("https");

// Optional Zap SDK
let ZapSDK: { Zap: any; estimateDlmmDirectSwap: any; estimateDlmmIndirectSwap: any; [key: string]: any } | null = null;
try {
  ZapSDK = require("@meteora-ag/zap-sdk");
} catch {
  /* not installed */
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CHARACTER_LIMIT = 25000;
const DATAPI = "https://dlmm.datapi.meteora.ag";

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------
const RPC_URL: string = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const WALLET_PRIVATE_KEY: string | undefined = process.env.WALLET_PRIVATE_KEY || undefined;
const DEBUG: boolean = process.env.DEBUG === "true";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------
interface PoolSummary {
  address: string;
  name: string;
  mintX: string;
  mintY: string;
  binStep: number;
  liquidity: string;
  volume24h: string;
  fees24h: string;
  currentPrice: string;
  apr: string;
}

interface PoolDetail {
  address: string;
  name: string;
  mintX: string;
  mintY: string;
  binStep: number;
  activeBinId: number;
  currentPrice: string;
  liquidity: string;
  volume24h: string;
  fees24h: string;
  apr: string;
  reserveX: string;
  reserveY: string;
}

interface BinInfo {
  binId: number;
  price: string;
  xAmount: string;
  yAmount: string;
  supply: string;
}

interface PositionInfo {
  publicKey: string;
  lowerBinId: number;
  upperBinId: number;
  totalXAmount: string;
  totalYAmount: string;
  feeX: string;
  feeY: string;
}

interface PositionSummary {
  positionAddress: string;
  lowerBinId: number;
  upperBinId: number;
}

interface ToolTextContent {
  type: "text";
  text: string;
}

interface ToolResult {
  content: ToolTextContent[];
  isError?: true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeConnection(rpcUrl: string): InstanceType<typeof Connection> {
  return new Connection(rpcUrl, { commitment: "confirmed" });
}

function loadKeypair(privateKey?: string): InstanceType<typeof Keypair> | null {
  if (!privateKey) return null;
  // Try JSON byte-array
  try {
    return Keypair.fromSecretKey(new Uint8Array(JSON.parse(privateKey)));
  } catch { /* not JSON */ }
  // Try base58
  try {
    return Keypair.fromSecretKey(bs58.decode(privateKey));
  } catch { /* not base58 */ }
  // Try base64
  try {
    return Keypair.fromSecretKey(Buffer.from(privateKey, "base64"));
  } catch {
    console.error("[meteora-dlmm-mcp] Invalid WALLET_PRIVATE_KEY format (tried JSON, base58, base64).");
    return null;
  }
}

function apiGet(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res: { on: Function }) => {
        let body = "";
        res.on("data", (c: string) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error(`Bad JSON from ${url}: ${body.slice(0, 200)}`));
          }
        });
      })
      .on("error", reject);
  });
}

function truncate(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    "\n\n[Response truncated — exceeded " +
    CHARACTER_LIMIT +
    " character limit. Narrow your query to get complete results.]"
  );
}

function ok(data: unknown): ToolResult {
  const raw = JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text: truncate(raw) }] };
}

function fail(msg: string): ToolResult {
  return {
    content: [{ type: "text" as const, text: `Error: ${msg}` }],
    isError: true as const,
  };
}

function walletError(): ToolResult {
  return fail(
    "Wallet not configured. Set WALLET_PRIVATE_KEY environment variable to a JSON byte-array or base64-encoded Solana private key."
  );
}

function rpcError(e: Error): ToolResult {
  return fail(
    `RPC request failed: ${e.message}. Check your RPC_URL configuration and ensure the endpoint supports getProgramAccounts.`
  );
}

function invalidAddressError(address: string): ToolResult {
  return fail(
    `Invalid public key format for "${address}". Expected a base58-encoded Solana address.`
  );
}

function isInvalidPublicKeyError(e: Error): boolean {
  const msg = e.message.toLowerCase();
  return msg.includes("invalid public key") || msg.includes("non-base58");
}

function isRpcError(e: Error): boolean {
  const msg = e.message.toLowerCase();
  return (
    msg.includes("failed to fetch") ||
    msg.includes("network request failed") ||
    msg.includes("429") ||
    msg.includes("503") ||
    msg.includes("timeout") ||
    msg.includes("econnrefused") ||
    msg.includes("getprogramaccounts")
  );
}

function classifyError(e: Error, addressHint?: string): ToolResult {
  if (isInvalidPublicKeyError(e)) return invalidAddressError(addressHint || "unknown");
  if (isRpcError(e)) return rpcError(e);
  return fail(e.message);
}

const log = (...a: unknown[]) => {
  if (DEBUG) console.error("[meteora-dlmm-mcp]", ...a);
};

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------
const connection = makeConnection(RPC_URL);
const wallet = loadKeypair(WALLET_PRIVATE_KEY);

if (wallet) log("Wallet loaded:", wallet.publicKey.toString());

// ---------------------------------------------------------------------------
// Annotation presets
// ---------------------------------------------------------------------------
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = new McpServer({
  name: "meteora-dlmm-mcp-server",
  version: "3.0.0",
});

// =========================================================================
//  1. SEARCH POOLS
// =========================================================================
server.registerTool(
  "meteora_search_pools",
  {
    title: "Search DLMM Pools",
    description:
      "Search and list Meteora DLMM liquidity pools with powerful sorting and filtering. " +
      "Returns pool objects with name, address, tokens (with symbol/decimals/price), bin config, " +
      "TVL, multi-timeframe volume/fees/fee_tvl_ratio, APR/APY, and current price. " +
      "Read-only operation.\n\n" +
      "sort_by format: '<metric>_<window>:<direction>' for time-windowed, or '<field>:<direction>' for non-windowed.\n" +
      "Windows: 5m, 30m, 1h, 2h, 4h, 12h, 24h\n" +
      "Time-windowed metrics: volume, fee, fee_tvl_ratio, apr\n" +
      "Non-windowed fields: tvl, fee_pct, bin_step, pool_created_at, farm_apy\n" +
      "Examples: 'volume_1h:desc' (trending by hourly volume), 'pool_created_at:desc' (newest), " +
      "'fee_tvl_ratio_24h:desc' (best fee/TVL), 'tvl:desc' (highest TVL)\n\n" +
      "filter_by format: '<field><op><value>' joined by ' && '.\n" +
      "Numeric fields: tvl, volume_*, fee_*, fee_tvl_ratio_*, apr_*\n" +
      "Boolean: is_blacklisted\n" +
      "Text: pool_address, name, token_x, token_y\n" +
      "Operators: = > >= < <= for numeric; =true/=false for boolean; =[val1|val2] for multi-value OR\n" +
      "Examples: 'tvl>1000 && is_blacklisted=false', 'volume_24h>=50000', 'token_x=SOL'",
    inputSchema: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Number of pools to return per page (1-50)"),
      page: z
        .number()
        .int()
        .min(1)
        .default(1)
        .describe("Page number (1-based)"),
      sort_by: z
        .string()
        .default("volume_24h:desc")
        .describe("Sort expression. Examples: 'volume_1h:desc', 'pool_created_at:desc', 'fee_tvl_ratio_24h:desc', 'tvl:desc'"),
      query: z
        .string()
        .optional()
        .describe("Search query to match pools by name, token symbol, or address"),
      filter_by: z
        .string()
        .optional()
        .describe("Filter expression. Examples: 'tvl>1000', 'is_blacklisted=false && volume_24h>=50000', 'token_x=SOL'"),
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  async ({ limit, page, sort_by, query, filter_by }: { limit: number; page: number; sort_by: string; query?: string; filter_by?: string }) => {
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("page_size", String(limit));
      params.set("sort_by", sort_by);
      if (query) params.set("query", query);
      if (filter_by) params.set("filter_by", filter_by);
      const url = `${DATAPI}/pools?${params.toString()}`;
      const data = (await apiGet(url)) as { total: number; pages: number; current_page: number; page_size: number; data: Array<Record<string, unknown>> };
      const pools = (data.data || []).map((p: Record<string, unknown>) => {
        const tokenX = p.token_x as Record<string, unknown> || {};
        const tokenY = p.token_y as Record<string, unknown> || {};
        const volume = p.volume as Record<string, number> || {};
        const fees = p.fees as Record<string, number> || {};
        const feeTvl = p.fee_tvl_ratio as Record<string, number> || {};
        const config = p.pool_config as Record<string, unknown> || {};
        return {
          address: p.address,
          name: p.name,
          tokenX: { symbol: tokenX.symbol, mint: tokenX.address, decimals: tokenX.decimals },
          tokenY: { symbol: tokenY.symbol, mint: tokenY.address, decimals: tokenY.decimals },
          binStep: config.bin_step,
          tvl: p.tvl,
          volume: { "1h": volume["1h"], "4h": volume["4h"], "24h": volume["24h"] },
          fees: { "1h": fees["1h"], "4h": fees["4h"], "24h": fees["24h"] },
          feeTvlRatio: { "1h": feeTvl["1h"], "4h": feeTvl["4h"], "24h": feeTvl["24h"] },
          currentPrice: p.current_price,
          apr: p.apr,
          apy: p.apy,
          dynamicFeePct: p.dynamic_fee_pct,
          createdAt: p.created_at,
        };
      });
      return ok({
        total: data.total,
        pages: data.pages,
        currentPage: data.current_page,
        count: pools.length,
        pools,
      });
    } catch (e: unknown) {
      return fail((e as Error).message);
    }
  }
);

// =========================================================================
//  2. GET POOL
// =========================================================================
server.registerTool(
  "meteora_get_pool",
  {
    title: "Get Pool Details",
    description:
      "Get detailed metadata for a single DLMM pool by address. Returns token mints, bin step, " +
      "active bin ID, current price, liquidity, 24h volume, 24h fees, APR, and reserve amounts. " +
      "Read-only operation.",
    inputSchema: {
      pool_address: z
        .string()
        .describe("Pool public key address (base58-encoded Solana address)"),
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  async ({ pool_address }: { pool_address: string }) => {
    try {
      const d = (await apiGet(`${DATAPI}/pools/${pool_address}`)) as Record<string, unknown>;
      const tokenX = d.token_x as Record<string, unknown> || {};
      const tokenY = d.token_y as Record<string, unknown> || {};
      const volume = d.volume as Record<string, number> || {};
      const fees = d.fees as Record<string, number> || {};
      const feeTvl = d.fee_tvl_ratio as Record<string, number> || {};
      const config = d.pool_config as Record<string, unknown> || {};
      return ok({
        address: d.address,
        name: d.name,
        tokenX: { symbol: tokenX.symbol, mint: tokenX.address, decimals: tokenX.decimals, price: tokenX.price },
        tokenY: { symbol: tokenY.symbol, mint: tokenY.address, decimals: tokenY.decimals, price: tokenY.price },
        binStep: config.bin_step,
        baseFeePct: config.base_fee_pct,
        tvl: d.tvl,
        currentPrice: d.current_price,
        volume24h: volume["24h"],
        fees24h: fees["24h"],
        feeTvlRatio24h: feeTvl["24h"],
        apr: d.apr,
        apy: d.apy,
        dynamicFeePct: d.dynamic_fee_pct,
        tokenXAmount: d.token_x_amount,
        tokenYAmount: d.token_y_amount,
      });
    } catch (e: unknown) {
      return classifyError(e as Error, pool_address);
    }
  }
);

// =========================================================================
//  3. GET ACTIVE BIN
// =========================================================================
server.registerTool(
  "meteora_get_active_bin",
  {
    title: "Get Active Bin",
    description:
      "Get the active bin (current price bin) for a DLMM pool via on-chain SDK call. " +
      "Returns binId, pricePerToken, and token amounts in the bin. " +
      "Read-only operation. Requires RPC access.",
    inputSchema: {
      pool_address: z
        .string()
        .describe("Pool public key address (base58-encoded Solana address)"),
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
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
    } catch (e: unknown) {
      return classifyError(e as Error, pool_address);
    }
  }
);

// =========================================================================
//  4. GET USER POSITIONS
// =========================================================================
server.registerTool(
  "meteora_get_user_positions",
  {
    title: "Get User Positions",
    description:
      "Retrieve all DLMM liquidity positions owned by a wallet across all pools. " +
      "Returns pool addresses, position counts, and position keys with bin ranges. " +
      "Read-only operation. Requires RPC endpoint that supports getProgramAccounts.",
    inputSchema: {
      wallet_address: z
        .string()
        .describe("Wallet public key (base58-encoded Solana address)"),
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  async ({ wallet_address }: { wallet_address: string }) => {
    try {
      const posMap = await DLMM.getAllLbPairPositionsByUser(
        connection,
        new PublicKey(wallet_address)
      );
      const result: Array<{
        poolAddress: string;
        positionCount: number;
        positions: PositionSummary[];
      }> = [];
      posMap.forEach(
        (posInfo: { lbPairPositionsData?: Array<{ publicKey?: { toString(): string }; positionData?: { lowerBinId: number; upperBinId: number } }> }, lbPairAddr: string) => {
          const positions: PositionSummary[] =
            posInfo.lbPairPositionsData?.map(
              (p: { publicKey?: { toString(): string }; positionData?: { lowerBinId: number; upperBinId: number } }) => ({
                positionAddress: p.publicKey?.toString() || "",
                lowerBinId: p.positionData?.lowerBinId || 0,
                upperBinId: p.positionData?.upperBinId || 0,
              })
            ) || [];
          result.push({
            poolAddress: lbPairAddr,
            positionCount: positions.length,
            positions,
          });
        }
      );
      return ok({
        walletAddress: wallet_address,
        totalPools: result.length,
        pools: result,
      });
    } catch (e: unknown) {
      return classifyError(e as Error, wallet_address);
    }
  }
);

// =========================================================================
//  5. GET POSITION DETAILS
// =========================================================================
server.registerTool(
  "meteora_get_position_details",
  {
    title: "Get Position Details",
    description:
      "Get detailed position info for a wallet in a specific DLMM pool. Returns bin range, " +
      "liquidity distribution (X and Y amounts per position), accumulated fees, and the active bin price. " +
      "Read-only operation. Requires RPC access.",
    inputSchema: {
      pool_address: z
        .string()
        .describe("Pool public key address (base58-encoded Solana address)"),
      wallet_address: z
        .string()
        .describe("Wallet public key (base58-encoded Solana address)"),
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  async ({
    pool_address,
    wallet_address,
  }: {
    pool_address: string;
    wallet_address: string;
  }) => {
    try {
      const dlmm = await DLMM.create(connection, new PublicKey(pool_address));
      const { activeBin, userPositions } = await dlmm.getPositionsByUserAndLbPair(
        new PublicKey(wallet_address)
      );
      const positions: PositionInfo[] = userPositions.map(
        (pos: {
          publicKey?: { toString(): string };
          positionData?: {
            lowerBinId: number;
            upperBinId: number;
            totalXAmount?: { toString(): string };
            totalYAmount?: { toString(): string };
            feeX?: { toString(): string };
            feeY?: { toString(): string };
          };
        }) => ({
          publicKey: pos.publicKey?.toString() || "",
          lowerBinId: pos.positionData?.lowerBinId || 0,
          upperBinId: pos.positionData?.upperBinId || 0,
          totalXAmount: pos.positionData?.totalXAmount?.toString() || "0",
          totalYAmount: pos.positionData?.totalYAmount?.toString() || "0",
          feeX: pos.positionData?.feeX?.toString() || "0",
          feeY: pos.positionData?.feeY?.toString() || "0",
        })
      );
      return ok({
        poolAddress: pool_address,
        activeBinId: activeBin.binId,
        activeBinPrice: activeBin.pricePerToken,
        positionCount: positions.length,
        positions,
      });
    } catch (e: unknown) {
      return classifyError(e as Error, pool_address);
    }
  }
);

// =========================================================================
//  6. GET BIN LIQUIDITY
// =========================================================================
server.registerTool(
  "meteora_get_bin_liquidity",
  {
    title: "Get Bin Liquidity",
    description:
      "Get bin-level liquidity distribution around the active bin of a DLMM pool. " +
      "Returns an array of bins with binId, price, xAmount, yAmount, and supply. " +
      "Useful for visualizing where liquidity is concentrated. " +
      "Read-only operation. Requires RPC access.",
    inputSchema: {
      pool_address: z
        .string()
        .describe("Pool public key address (base58-encoded Solana address)"),
      bins_left: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Number of bins to return to the left of the active bin"),
      bins_right: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Number of bins to return to the right of the active bin"),
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  async ({
    pool_address,
    bins_left,
    bins_right,
  }: {
    pool_address: string;
    bins_left: number;
    bins_right: number;
  }) => {
    try {
      const dlmm = await DLMM.create(connection, new PublicKey(pool_address));
      const { activeBin, bins } = await dlmm.getBinsAroundActiveBin(bins_left, bins_right);
      const binData: BinInfo[] = bins.map(
        (b: {
          binId: number;
          pricePerToken: string;
          xAmount?: { toString(): string };
          yAmount?: { toString(): string };
          supply?: { toString(): string };
        }) => ({
          binId: b.binId,
          price: b.pricePerToken,
          xAmount: b.xAmount?.toString() || "0",
          yAmount: b.yAmount?.toString() || "0",
          supply: b.supply?.toString() || "0",
        })
      );
      return ok({
        activeBinId: activeBin,
        binCount: binData.length,
        bins: binData,
      });
    } catch (e: unknown) {
      return classifyError(e as Error, pool_address);
    }
  }
);

// =========================================================================
//  7. GET SWAP QUOTE
// =========================================================================
server.registerTool(
  "meteora_get_swap_quote",
  {
    title: "Get Swap Quote",
    description:
      "Get a swap quote for a given input amount on a DLMM pool. Returns expected output amount, " +
      "fee charged, price impact percentage, and number of bins crossed. " +
      "Use this before executing a swap to preview the trade. " +
      "Read-only operation. Requires RPC access.",
    inputSchema: {
      pool_address: z
        .string()
        .describe("Pool public key address (base58-encoded Solana address)"),
      amount_in: z
        .string()
        .describe("Input amount in lamports / smallest token unit"),
      swap_for_y: z
        .boolean()
        .describe("true = swap token X for token Y, false = swap token Y for token X"),
      slippage_bps: z
        .number()
        .int()
        .min(0)
        .max(10000)
        .default(100)
        .describe("Allowed slippage in basis points (100 = 1%)"),
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  async ({
    pool_address,
    amount_in,
    swap_for_y,
    slippage_bps,
  }: {
    pool_address: string;
    amount_in: string;
    swap_for_y: boolean;
    slippage_bps: number;
  }) => {
    try {
      const dlmm = await DLMM.create(connection, new PublicKey(pool_address));
      const binArrays = await dlmm.getBinArrayForSwap(swap_for_y, 5);
      const quote = dlmm.swapQuote(
        new BN(amount_in),
        swap_for_y,
        new BN(slippage_bps),
        binArrays
      );
      return ok({
        amountIn: quote.consumedInAmount?.toString(),
        amountOut: quote.outAmount?.toString(),
        fee: quote.fee?.toString(),
        priceImpact: quote.priceImpact?.toString(),
        binsCrossed: quote.binArraysPubkey?.length,
      });
    } catch (e: unknown) {
      return classifyError(e as Error, pool_address);
    }
  }
);

// =========================================================================
//  8. GET POOL FEES
// =========================================================================
server.registerTool(
  "meteora_get_pool_fees",
  {
    title: "Get Pool Fees",
    description:
      "Get fee configuration for a DLMM pool. Returns base fee rate percentage, max fee rate percentage, " +
      "protocol fee percentage, and the current dynamic fee. " +
      "Read-only operation. Requires RPC access.",
    inputSchema: {
      pool_address: z
        .string()
        .describe("Pool public key address (base58-encoded Solana address)"),
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
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
    } catch (e: unknown) {
      return classifyError(e as Error, pool_address);
    }
  }
);

// =========================================================================
//  9. GET PROTOCOL STATS
// =========================================================================
server.registerTool(
  "meteora_get_protocol_stats",
  {
    title: "Get Protocol Stats",
    description:
      "Get aggregated protocol-level metrics across all Meteora DLMM pools. " +
      "Returns total value locked (TVL), total volume, total fee revenue, pool count, and other " +
      "protocol-wide statistics. Read-only operation.",
    inputSchema: {},
    annotations: READ_ONLY_ANNOTATIONS,
  },
  async () => {
    try {
      const data = await apiGet(`${DATAPI}/stats/protocol_metrics`);
      return ok(data);
    } catch (e: unknown) {
      return fail((e as Error).message);
    }
  }
);

// =========================================================================
//  10. CLAIM FEES
// =========================================================================
server.registerTool(
  "meteora_claim_fees",
  {
    title: "Claim Fees",
    description:
      "Claim accumulated swap fees from a specific DLMM position. Sends one or more transactions " +
      "to the Solana network. Returns transaction signatures and Solscan links. " +
      "WRITE operation — requires WALLET_PRIVATE_KEY environment variable.",
    inputSchema: {
      pool_address: z
        .string()
        .describe("Pool public key address (base58-encoded Solana address)"),
      position_address: z
        .string()
        .describe("Position public key to claim fees from (base58-encoded Solana address)"),
    },
    annotations: WRITE_ANNOTATIONS,
  },
  async ({
    pool_address,
    position_address,
  }: {
    pool_address: string;
    position_address: string;
  }) => {
    if (!wallet) return walletError();
    try {
      const dlmm = await DLMM.create(connection, new PublicKey(pool_address));
      const position = await dlmm.getPosition(new PublicKey(position_address));
      const txs = await dlmm.claimSwapFee({ owner: wallet.publicKey, position });
      const signatures: string[] = [];
      for (const tx of Array.isArray(txs) ? txs : [txs]) {
        const sig: string = await connection.sendTransaction(tx, [wallet]);
        await connection.confirmTransaction(sig);
        signatures.push(sig);
      }
      return ok({
        success: true,
        signatures,
        solscanLinks: signatures.map((s: string) => `https://solscan.io/tx/${s}`),
      });
    } catch (e: unknown) {
      return classifyError(e as Error, pool_address);
    }
  }
);

// =========================================================================
//  11. CLAIM ALL REWARDS
// =========================================================================
server.registerTool(
  "meteora_claim_all_rewards",
  {
    title: "Claim All Rewards",
    description:
      "Claim ALL rewards (swap fees + liquidity mining rewards) for all positions the configured " +
      "wallet holds in a specific DLMM pool. Sends one or more transactions. Returns position count " +
      "claimed and transaction signatures. " +
      "WRITE operation — requires WALLET_PRIVATE_KEY environment variable.",
    inputSchema: {
      pool_address: z
        .string()
        .describe("Pool public key address (base58-encoded Solana address)"),
    },
    annotations: WRITE_ANNOTATIONS,
  },
  async ({ pool_address }: { pool_address: string }) => {
    if (!wallet) return walletError();
    try {
      const dlmm = await DLMM.create(connection, new PublicKey(pool_address));
      const { userPositions } = await dlmm.getPositionsByUserAndLbPair(wallet.publicKey);
      if (!userPositions.length)
        return ok({ success: true, message: "No positions found in this pool." });
      const txs = await dlmm.claimAllRewards({
        owner: wallet.publicKey,
        positions: userPositions,
      });
      const signatures: string[] = [];
      for (const tx of txs) {
        const sig: string = await connection.sendTransaction(tx, [wallet]);
        await connection.confirmTransaction(sig);
        signatures.push(sig);
      }
      return ok({
        success: true,
        positionsClaimed: userPositions.length,
        signatures,
      });
    } catch (e: unknown) {
      return classifyError(e as Error, pool_address);
    }
  }
);

// =========================================================================
//  12. ADD LIQUIDITY
// =========================================================================
server.registerTool(
  "meteora_add_liquidity",
  {
    title: "Add Liquidity",
    description:
      "Add liquidity to a DLMM pool using a distribution strategy (Spot, Curve, or BidAsk). " +
      "Creates a new position with the specified bin range and deposits token X and token Y. " +
      "Returns the new position address, transaction signature, and Solscan link. " +
      "WRITE operation — requires WALLET_PRIVATE_KEY environment variable.",
    inputSchema: {
      pool_address: z
        .string()
        .describe("Pool public key address (base58-encoded Solana address)"),
      amount_x: z
        .string()
        .describe("Token X amount in lamports / smallest unit"),
      amount_y: z
        .string()
        .describe("Token Y amount in lamports / smallest unit"),
      strategy: z
        .enum(["Spot", "Curve", "BidAsk"])
        .default("Spot")
        .describe("Liquidity distribution strategy: Spot (uniform), Curve (concentrated), or BidAsk (split)"),
      min_bin_id: z
        .number()
        .int()
        .describe("Lower bound bin ID for the position"),
      max_bin_id: z
        .number()
        .int()
        .describe("Upper bound bin ID for the position"),
      slippage: z
        .number()
        .min(0)
        .max(100)
        .default(1)
        .describe("Slippage tolerance in percent (e.g. 1 = 1%)"),
    },
    annotations: WRITE_ANNOTATIONS,
  },
  async (params: {
    pool_address: string;
    amount_x: string;
    amount_y: string;
    strategy: string;
    min_bin_id: number;
    max_bin_id: number;
    slippage: number;
  }) => {
    if (!wallet) return walletError();
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
      const sig: string = await connection.sendTransaction(tx, [wallet, positionKeypair]);
      await connection.confirmTransaction(sig);
      return ok({
        success: true,
        positionAddress: positionKeypair.publicKey.toString(),
        signature: sig,
        solscan: `https://solscan.io/tx/${sig}`,
      });
    } catch (e: unknown) {
      return classifyError(e as Error, params.pool_address);
    }
  }
);

// =========================================================================
//  13. REMOVE LIQUIDITY
// =========================================================================
server.registerTool(
  "meteora_remove_liquidity",
  {
    title: "Remove Liquidity",
    description:
      "Remove liquidity from a DLMM position. Specify the percentage to withdraw in basis points " +
      "(10000 = 100%). Optionally claim rewards and close the position in the same transaction. " +
      "Returns transaction signatures and withdrawal details. " +
      "WRITE operation — requires WALLET_PRIVATE_KEY environment variable.",
    inputSchema: {
      pool_address: z
        .string()
        .describe("Pool public key address (base58-encoded Solana address)"),
      position_address: z
        .string()
        .describe("Position public key (base58-encoded Solana address)"),
      bps: z
        .number()
        .int()
        .min(1)
        .max(10000)
        .default(10000)
        .describe("Basis points of liquidity to remove (10000 = 100%)"),
      claim_and_close: z
        .boolean()
        .default(false)
        .describe("If true, also claim rewards and close the position after withdrawal"),
    },
    annotations: WRITE_ANNOTATIONS,
  },
  async (params: {
    pool_address: string;
    position_address: string;
    bps: number;
    claim_and_close: boolean;
  }) => {
    if (!wallet) return walletError();
    try {
      const dlmm = await DLMM.create(connection, new PublicKey(params.pool_address));
      const position = await dlmm.getPosition(new PublicKey(params.position_address));
      const fromBinId: number = position.positionData.lowerBinId;
      const toBinId: number = position.positionData.upperBinId;
      const txs = await dlmm.removeLiquidity({
        user: wallet.publicKey,
        position: new PublicKey(params.position_address),
        fromBinId,
        toBinId,
        bps: new BN(params.bps),
        shouldClaimAndClose: params.claim_and_close,
      });
      const signatures: string[] = [];
      for (const tx of Array.isArray(txs) ? txs : [txs]) {
        const sig: string = await connection.sendTransaction(tx, [wallet]);
        await connection.confirmTransaction(sig);
        signatures.push(sig);
      }
      return ok({
        success: true,
        bpsRemoved: params.bps,
        closed: params.claim_and_close,
        signatures,
      });
    } catch (e: unknown) {
      return classifyError(e as Error, params.pool_address);
    }
  }
);

// =========================================================================
//  14. SWAP
// =========================================================================
server.registerTool(
  "meteora_swap",
  {
    title: "Execute Swap",
    description:
      "Execute a token swap on a DLMM pool. Use meteora_get_swap_quote first to preview the expected " +
      "output and price impact. Sends a transaction to the Solana network. Returns the transaction " +
      "signature, expected output, and Solscan link. " +
      "WRITE operation — requires WALLET_PRIVATE_KEY environment variable.",
    inputSchema: {
      pool_address: z
        .string()
        .describe("Pool public key address (base58-encoded Solana address)"),
      amount_in: z
        .string()
        .describe("Input amount in lamports / smallest token unit"),
      swap_for_y: z
        .boolean()
        .describe("true = swap token X for token Y, false = swap token Y for token X"),
      slippage_bps: z
        .number()
        .int()
        .min(0)
        .max(10000)
        .default(100)
        .describe("Slippage tolerance in basis points (100 = 1%)"),
    },
    annotations: WRITE_ANNOTATIONS,
  },
  async (params: {
    pool_address: string;
    amount_in: string;
    swap_for_y: boolean;
    slippage_bps: number;
  }) => {
    if (!wallet) return walletError();
    try {
      const dlmm = await DLMM.create(connection, new PublicKey(params.pool_address));
      const binArrays = await dlmm.getBinArrayForSwap(params.swap_for_y, 5);
      const quote = dlmm.swapQuote(
        new BN(params.amount_in),
        params.swap_for_y,
        new BN(params.slippage_bps),
        binArrays
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
      const sig: string = await connection.sendTransaction(swapTx, [wallet]);
      await connection.confirmTransaction(sig);
      return ok({
        success: true,
        amountIn: params.amount_in,
        expectedOut: quote.outAmount?.toString(),
        signature: sig,
        solscan: `https://solscan.io/tx/${sig}`,
      });
    } catch (e: unknown) {
      return classifyError(e as Error, params.pool_address);
    }
  }
);

// =========================================================================
//  15. ZAP
// =========================================================================
server.registerTool(
  "meteora_zap",
  {
    title: "Zap Into Position",
    description:
      "Zap into a DLMM position with a single token using Meteora's Zap SDK. Automatically swaps " +
      "the input token into both pool tokens and deposits them as a new position. " +
      "Uses delta bin IDs relative to the active bin (e.g. min_delta=-34, max_delta=34 for 69 bins centered). " +
      "Supports Spot (0), Curve (1), and BidAsk (2) strategies. " +
      "Returns transaction signature(s) and position details. " +
      "WRITE operation — requires WALLET_PRIVATE_KEY and the @meteora-ag/zap-sdk package installed.",
    inputSchema: {
      pool_address: z
        .string()
        .describe("Pool public key address (base58-encoded Solana address)"),
      input_token_mint: z
        .string()
        .describe("Mint address of the token you are depositing (base58-encoded)"),
      input_amount: z
        .string()
        .describe("Amount in lamports / smallest unit to zap in"),
      min_delta_id: z
        .number()
        .int()
        .describe("Min bin delta relative to active bin (negative = below active bin)"),
      max_delta_id: z
        .number()
        .int()
        .describe("Max bin delta relative to active bin (positive = above active bin)"),
      strategy: z
        .enum(["Spot", "Curve", "BidAsk"])
        .default("Spot")
        .describe("Liquidity distribution strategy"),
      slippage_bps: z
        .number()
        .int()
        .min(0)
        .max(10000)
        .default(100)
        .describe("Swap slippage tolerance in basis points (100 = 1%)"),
    },
    annotations: WRITE_ANNOTATIONS,
  },
  async (params: {
    pool_address: string;
    input_token_mint: string;
    input_amount: string;
    min_delta_id: number;
    max_delta_id: number;
    strategy: string;
    slippage_bps: number;
  }) => {
    if (!wallet) return walletError();
    if (!ZapSDK)
      return fail(
        "Zap SDK not installed. Install it with: npm install @meteora-ag/zap-sdk"
      );
    try {
      const lbPair = new PublicKey(params.pool_address);
      const inputTokenMint = new PublicKey(params.input_token_mint);
      const amountIn = new BN(params.input_amount);
      const strategyMap: Record<string, number> = { Spot: 0, Curve: 1, BidAsk: 2 };
      const strategy = strategyMap[params.strategy] || 0;

      // Direct route if input is a pool token, indirect (Jupiter) if external
      const dlmm = await DLMM.create(connection, lbPair);
      const isPoolToken = dlmm.tokenX.publicKey.equals(inputTokenMint) || dlmm.tokenY.publicKey.equals(inputTokenMint);
      const zap = new ZapSDK.Zap(connection);

      let zapParams: unknown;
      if (isPoolToken) {
        const estimate = await ZapSDK.estimateDlmmDirectSwap({
          amountIn, inputTokenMint, lbPair, connection,
          swapSlippageBps: params.slippage_bps,
          minDeltaId: params.min_delta_id, maxDeltaId: params.max_delta_id, strategy,
        });
        zapParams = await zap.getZapInDlmmDirectParams({
          user: wallet.publicKey, lbPair, inputTokenMint, amountIn,
          maxActiveBinSlippage: 5,
          minDeltaId: params.min_delta_id, maxDeltaId: params.max_delta_id, strategy,
          favorXInActiveId: false, maxAccounts: 30,
          swapSlippageBps: params.slippage_bps,
          maxTransferAmountExtendPercentage: 5,
          directSwapEstimate: estimate.result,
        });
      } else {
        const estimate = await ZapSDK.estimateDlmmIndirectSwap({
          amountIn, inputTokenMint, lbPair, connection,
          swapSlippageBps: params.slippage_bps,
          minDeltaId: params.min_delta_id, maxDeltaId: params.max_delta_id, strategy,
        });
        zapParams = await zap.getZapInDlmmIndirectParams({
          user: wallet.publicKey, lbPair, inputTokenMint, amountIn,
          maxActiveBinSlippage: 5,
          minDeltaId: params.min_delta_id, maxDeltaId: params.max_delta_id, strategy,
          favorXInActiveId: false, maxAccounts: 30,
          swapSlippageBps: params.slippage_bps,
          maxTransferAmountExtendPercentage: 5,
          indirectSwapEstimate: estimate.result,
        });
      }

      const positionKeypair = Keypair.generate();
      const zapResult = await zap.buildZapInDlmmTransaction({
        ...(zapParams as Record<string, unknown>),
        position: positionKeypair.publicKey,
      });

      // ZapInDlmmResponse: setupTransaction?, swapTransactions[], ledgerTransaction, zapInTransaction, cleanUpTransaction
      // Each tx is a legacy Transaction. Only zapInTransaction needs the position keypair as signer.
      const sendOpts = { skipPreflight: true };
      const signatures: string[] = [];

      // Prepend compute budget + priority fee to a legacy transaction
      function addComputeBudget(tx: any, units: number, priorityMicroLamports: number): void {
        tx.instructions.unshift(
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }),
          ComputeBudgetProgram.setComputeUnitLimit({ units }),
        );
      }

      async function sendAndConfirm(tx: unknown, signers: unknown[]): Promise<string> {
        const sig: string = await connection.sendTransaction(tx as any, signers as any[], sendOpts);
        await connection.confirmTransaction(sig, "confirmed");
        return sig;
      }

      if (zapResult.setupTransaction) {
        signatures.push(await sendAndConfirm(zapResult.setupTransaction, [wallet]));
      }
      for (const tx of zapResult.swapTransactions || []) {
        signatures.push(await sendAndConfirm(tx, [wallet]));
      }
      if (zapResult.ledgerTransaction) {
        signatures.push(await sendAndConfirm(zapResult.ledgerTransaction, [wallet]));
      }
      if (zapResult.zapInTransaction) {
        addComputeBudget(zapResult.zapInTransaction, 1_400_000, 1_000);
        signatures.push(await sendAndConfirm(zapResult.zapInTransaction, [wallet, positionKeypair]));
      }
      if (zapResult.cleanUpTransaction) {
        signatures.push(await sendAndConfirm(zapResult.cleanUpTransaction, [wallet]));
      }
      return ok({
        success: true,
        pool: params.pool_address,
        inputToken: params.input_token_mint,
        inputAmount: params.input_amount,
        positionAddress: positionKeypair.publicKey.toString(),
        binRange: { minDelta: params.min_delta_id, maxDelta: params.max_delta_id },
        strategy: params.strategy,
        signatures,
        solscanLinks: signatures.map((s: string) => `https://solscan.io/tx/${s}`),
      });
    } catch (e: unknown) {
      return fail(
        `Zap failed: ${(e as Error).message}`
      );
    }
  }
);

// =========================================================================
//  15b. ZAP OUT — remove position and convert to single token via Jupiter
// =========================================================================
server.registerTool(
  "meteora_zap_out",
  {
    title: "Zap Out of Position",
    description:
      "Remove liquidity from a DLMM position and convert everything to a single output token via Jupiter. " +
      "Removes 100% of liquidity, claims fees, closes the position, then swaps all tokens to the desired output. " +
      "WRITE operation — requires WALLET_PRIVATE_KEY and @meteora-ag/zap-sdk.",
    inputSchema: {
      pool_address: z
        .string()
        .describe("Pool public key address (base58-encoded Solana address)"),
      position_address: z
        .string()
        .describe("Position public key to zap out from (base58-encoded)"),
      output_token_mint: z
        .string()
        .describe("Mint of the token you want to receive (e.g. SOL mint for all SOL)"),
      slippage_bps: z
        .number()
        .int()
        .min(0)
        .max(10000)
        .default(200)
        .describe("Swap slippage tolerance in basis points (200 = 2%)"),
    },
    annotations: WRITE_ANNOTATIONS,
  },
  async (params: {
    pool_address: string;
    position_address: string;
    output_token_mint: string;
    slippage_bps: number;
  }) => {
    if (!wallet) return walletError();
    if (!ZapSDK)
      return fail("Zap SDK not installed. Install it with: npm install @meteora-ag/zap-sdk");
    try {
      const lbPair = new PublicKey(params.pool_address);
      const positionPubkey = new PublicKey(params.position_address);
      const outputMint = new PublicKey(params.output_token_mint);
      const sendOpts = { skipPreflight: true };
      const signatures: string[] = [];

      async function sendAndConfirm(tx: unknown, signers: unknown[]): Promise<string> {
        const sig: string = await connection.sendTransaction(tx as any, signers as any[], sendOpts);
        await connection.confirmTransaction(sig, "confirmed");
        return sig;
      }

      // 1. Remove all liquidity, claim fees, close position
      const dlmm = await DLMM.create(connection, lbPair);
      const position = await dlmm.getPosition(positionPubkey);
      const fromBinId: number = position.positionData.lowerBinId;
      const toBinId: number = position.positionData.upperBinId;
      const removeTxs = await dlmm.removeLiquidity({
        user: wallet.publicKey,
        position: positionPubkey,
        fromBinId,
        toBinId,
        bps: new BN(10000),
        shouldClaimAndClose: true,
      });
      for (const tx of Array.isArray(removeTxs) ? removeTxs : [removeTxs]) {
        signatures.push(await sendAndConfirm(tx, [wallet]));
      }

      // 2. Determine which token needs swapping to output via Jupiter
      const tokenXMint = dlmm.tokenX.publicKey;
      const tokenYMint = dlmm.tokenY.publicKey;
      const tokenToSwap = outputMint.equals(tokenXMint) ? tokenYMint : tokenXMint;

      // 3. Get token balance to swap
      const tokenAccounts = await connection.getTokenAccountsByOwner(wallet.publicKey, { mint: tokenToSwap });
      if (tokenAccounts.value.length > 0) {
        const accountInfo = await connection.getTokenAccountBalance(tokenAccounts.value[0].pubkey);
        const swapAmount = accountInfo.value.amount;

        if (swapAmount !== "0" && parseInt(swapAmount) > 0) {
          // 4. Jupiter quote -> swap instruction -> zapOutThroughJupiter
          const inputTokenProgram = await ZapSDK.getTokenProgramFromMint(connection, tokenToSwap);
          const outputTokenProgram = await ZapSDK.getTokenProgramFromMint(connection, outputMint);

          const jupQuote = await ZapSDK.getJupiterQuote(
            tokenToSwap, outputMint, new BN(swapAmount),
            40, params.slippage_bps, true, true, true,
          );
          if (jupQuote) {
            const jupSwapInstruction = await ZapSDK.getJupiterSwapInstruction(
              wallet.publicKey, jupQuote,
            );

            const zap = new ZapSDK.Zap(connection);
            const zapOutTx = await zap.zapOutThroughJupiter({
              user: wallet.publicKey,
              inputMint: tokenToSwap,
              outputMint,
              inputTokenProgram,
              outputTokenProgram,
              jupiterSwapResponse: jupSwapInstruction,
              maxSwapAmount: new BN(swapAmount),
              percentageToZapOut: 100,
            });
            signatures.push(await sendAndConfirm(zapOutTx, [wallet]));
          }
        }
      }

      return ok({
        success: true,
        pool: params.pool_address,
        positionClosed: params.position_address,
        outputToken: params.output_token_mint,
        signatures,
        solscanLinks: signatures.map((s: string) => `https://solscan.io/tx/${s}`),
      });
    } catch (e: unknown) {
      return fail(`Zap out failed: ${(e as Error).message}`);
    }
  }
);

// =========================================================================
//  16. GET POOL OHLCV
// =========================================================================
server.registerTool(
  "meteora_get_pool_ohlcv",
  {
    title: "Get Pool OHLCV",
    description:
      "Get OHLCV (open/high/low/close/volume) candlestick chart data for a DLMM pool. " +
      "Supports multiple resolutions from 1-minute to 1-day candles. Returns an array of candle objects. " +
      "Read-only operation.",
    inputSchema: {
      pool_address: z
        .string()
        .describe("Pool public key address (base58-encoded Solana address)"),
      resolution: z
        .enum(["1m", "5m", "15m", "1h", "4h", "1d"])
        .default("1h")
        .describe("Candle resolution / time interval"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe("Number of candles to return (1-500)"),
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  async ({
    pool_address,
    resolution,
    limit,
  }: {
    pool_address: string;
    resolution: string;
    limit: number;
  }) => {
    try {
      const data = await apiGet(
        `${DATAPI}/pools/${pool_address}/ohlcv?resolution=${resolution}&limit=${limit}`
      );
      return ok(data);
    } catch (e: unknown) {
      return classifyError(e as Error, pool_address);
    }
  }
);

// =========================================================================
//  17. GET POOL VOLUME HISTORY
// =========================================================================
server.registerTool(
  "meteora_get_pool_volume",
  {
    title: "Get Pool Volume History",
    description:
      "Get historical trading volume data for a DLMM pool aggregated into time buckets. " +
      "Returns an array of volume data points over time. Useful for analyzing pool activity trends. " +
      "Read-only operation.",
    inputSchema: {
      pool_address: z
        .string()
        .describe("Pool public key address (base58-encoded Solana address)"),
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  async ({ pool_address }: { pool_address: string }) => {
    try {
      const data = await apiGet(`${DATAPI}/pools/${pool_address}/volume/history`);
      return ok(data);
    } catch (e: unknown) {
      return classifyError(e as Error, pool_address);
    }
  }
);

// =========================================================================
//  18. GET EMISSION RATE
// =========================================================================
server.registerTool(
  "meteora_get_emission_rate",
  {
    title: "Get Emission Rate",
    description:
      "Get liquidity mining (LM) reward emission rates for a DLMM pool. Returns reward token " +
      "emission rates for up to two reward tokens (rewardOne and rewardTwo). " +
      "Read-only operation. Requires RPC access.",
    inputSchema: {
      pool_address: z
        .string()
        .describe("Pool public key address (base58-encoded Solana address)"),
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  async ({ pool_address }: { pool_address: string }) => {
    try {
      const dlmm = await DLMM.create(connection, new PublicKey(pool_address));
      const emission = dlmm.getEmissionRate();
      return ok({
        rewardOne: emission.rewardOne?.toString() || null,
        rewardTwo: emission.rewardTwo?.toString() || null,
      });
    } catch (e: unknown) {
      return classifyError(e as Error, pool_address);
    }
  }
);

// ---------------------------------------------------------------------------
// Main — connect to stdio transport
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.error("[meteora-dlmm-mcp] Starting server with 18 tools...");
  console.error(`[meteora-dlmm-mcp] RPC: ${RPC_URL}`);
  console.error(
    `[meteora-dlmm-mcp] Wallet: ${wallet ? wallet.publicKey.toString() : "not configured"}`
  );
  console.error(`[meteora-dlmm-mcp] Zap SDK: ${ZapSDK ? "available" : "not installed"}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[meteora-dlmm-mcp] Server connected to stdio transport.");
}

main().catch((err: Error) => {
  console.error("[meteora-dlmm-mcp] Fatal error:", err.message);
  process.exit(1);
});
