// Test both Meteora API and SDK approaches
require('dotenv').config();

const https = require('https');
const DLMM = require("@meteora-ag/dlmm").default;
const { Connection, PublicKey } = require("@solana/web3.js");

const config = {
  rpcUrl: process.env.RPC_URL || "https://solana-rpc.publicnode.com",
  apiBase: "https://dlmm-api.meteora.ag"
};

const connection = new Connection(config.rpcUrl);

// Helper function to make API calls
function apiCall(endpoint) {
  return new Promise((resolve, reject) => {
    const url = `${config.apiBase}${endpoint}`;
    console.log(`API Call: ${url}`);
    
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

async function testMeteoraAPI() {
  console.log('\n🌐 Testing Meteora API Approach...');
  
  try {
    // Test 1: Get all pairs
    console.log('📊 Fetching all DLMM pairs...');
    const pairs = await apiCall('/pair/all');
    console.log(`✅ Found ${pairs.length} pairs via API`);
    
    if (pairs.length > 0) {
      const samplePair = pairs[0];
      console.log('📋 Sample pair:', {
        address: samplePair.address,
        tokenX: samplePair.mint_x,
        tokenY: samplePair.mint_y,
        tokenXSymbol: samplePair.name.split('-')[0],
        tokenYSymbol: samplePair.name.split('-')[1]
      });
      
      // Test 2: Get specific pair info
      console.log(`\n🔍 Fetching details for pair: ${samplePair.address}`);
      const pairDetails = await apiCall(`/pair/${samplePair.address}`);
      console.log('✅ Pair details:', {
        fees24h: pairDetails.fees_24h,
        volume24h: pairDetails.volume_24h,
        liquidity: pairDetails.liquidity,
        activeBin: pairDetails.active_bin_id
      });
    }
    
    return true;
  } catch (error) {
    console.error('❌ API Error:', error.message);
    return false;
  }
}

async function testMeteoraSDK() {
  console.log('\n🛠️  Testing Meteora SDK Approach...');
  
  try {
    // Test 1: Get pairs using SDK static method
    console.log('📊 Fetching pairs via SDK...');
    const pairs = await DLMM.getLbPairs(connection);
    console.log(`✅ Found ${pairs.length} pairs via SDK`);
    
    if (pairs.length > 0) {
      const samplePairAddress = pairs[0].publicKey;
      console.log(`🔍 Testing pair: ${samplePairAddress.toString()}`);
      
      // Test 2: Create DLMM instance
      console.log('🏗️  Creating DLMM instance...');
      const dlmmPool = await DLMM.create(connection, samplePairAddress);
      console.log('✅ DLMM instance created');
      
      // Test 3: Get active bin (read operation)
      console.log('📈 Fetching active bin...');
      const activeBin = await dlmmPool.getActiveBin();
      console.log('✅ Active bin:', {
        binId: activeBin.binId,
        price: activeBin.price
      });
      
      // Test 4: Check available methods for transactions
      console.log('🔧 Available transaction methods:');
      const txMethods = [
        'claimSwapFee', 'claimAllSwapFee', 'addLiquidityByStrategy', 
        'removeLiquidity', 'swap', 'createPosition'
      ];
      
      txMethods.forEach(method => {
        const hasMethod = typeof dlmmPool[method] === 'function';
        console.log(`  ${hasMethod ? '✅' : '❌'} ${method}`);
      });
    }
    
    return true;
  } catch (error) {
    console.error('❌ SDK Error:', error.message);
    return false;
  }
}

async function testUserPositions() {
  console.log('\n👤 Testing User Position Queries...');
  
  // Test wallet (you can replace with a real wallet that has positions)
  const testWallet = "11111111111111111111111111111112"; // System program - won't have positions
  
  try {
    // API approach
    console.log('🌐 API approach for positions...');
    try {
      const positions = await apiCall(`/user/${testWallet}`);
      console.log(`✅ API: Found ${positions.length} positions`);
    } catch (error) {
      console.log('ℹ️  API: Position endpoint might not exist or wallet has no positions');
    }
    
    // SDK approach  
    console.log('🛠️  SDK approach for positions...');
    const positions = await DLMM.getAllLbPairPositionsByUser(connection, new PublicKey(testWallet));
    console.log(`✅ SDK: Found ${positions.length} positions`);
    
    return true;
  } catch (error) {
    console.error('❌ Position query error:', error.message);
    return false;
  }
}

async function runComparison() {
  console.log('🚀 Meteora DLMM: API vs SDK Comparison Test');
  console.log('=' .repeat(60));
  
  const tests = [
    { name: 'Meteora API', fn: testMeteoraAPI },
    { name: 'Meteora SDK', fn: testMeteoraSDK },
    { name: 'User Positions', fn: testUserPositions }
  ];
  
  const results = {};
  
  for (const test of tests) {
    console.log(`\n🧪 Testing: ${test.name}`);
    try {
      results[test.name] = await test.fn();
    } catch (error) {
      console.error(`❌ ${test.name} failed:`, error.message);
      results[test.name] = false;
    }
  }
  
  console.log('\n' + '=' .repeat(60));
  console.log('📊 COMPARISON RESULTS:');
  console.log('=' .repeat(60));
  
  Object.entries(results).forEach(([name, success]) => {
    console.log(`${success ? '✅' : '❌'} ${name}: ${success ? 'SUCCESS' : 'FAILED'}`);
  });
  
  console.log('\n💡 RECOMMENDATIONS:');
  console.log('📖 READ Operations: Use Meteora API (simpler, faster)');
  console.log('✍️  WRITE Operations: Use Meteora SDK (required for transactions)');
  console.log('🔄 HYBRID Approach: API for reads + SDK for writes');
  
  console.log('\n🎯 NEXT STEPS:');
  console.log('1. Update MCP server to use API for read operations');
  console.log('2. Keep SDK for transaction operations (claiming fees, etc.)');
  console.log('3. Test with real wallet addresses that have positions');
}

runComparison().catch(console.error);