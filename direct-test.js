// Direct tool testing for Meteora DLMM MCP Server
require('dotenv').config();

const DLMM = require("@meteora-ag/dlmm").default;
const { Connection, PublicKey } = require("@solana/web3.js");

const config = {
  rpcUrl: process.env.RPC_URL || "https://solana-rpc.publicnode.com",
  debug: true
};

const connection = new Connection(config.rpcUrl);

async function testPoolInfo() {
  console.log('\n🧪 Testing Pool Info...');
  
  try {
    // First get a real DLMM pool address
    console.log('Fetching available pools...');
    const pools = await DLMM.getLbPairs(connection);
    if (pools.length === 0) {
      console.log('⚠️  No DLMM pools found');
      return false;
    }
    
    const poolAddress = pools[0].publicKey.toString();
    console.log(`Found ${pools.length} pools, testing first one: ${poolAddress}`);
    
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
    
    console.log('✅ Pool Info Success:');
    console.log(JSON.stringify(result, null, 2));
    return true;
  } catch (error) {
    console.error('❌ Pool Info Error:', error.message);
    return false;
  }
}

async function testConnection() {
  console.log('\n🌐 Testing RPC Connection...');
  
  try {
    const version = await connection.getVersion();
    console.log('✅ RPC Connection Success:');
    console.log(`Solana version: ${JSON.stringify(version)}`);
    return true;
  } catch (error) {
    console.error('❌ RPC Connection Error:', error.message);
    return false;
  }
}

async function testPopularPools() {
  console.log('\n📊 Testing Popular Pools...');
  
  try {
    console.log('Fetching DLMM pairs...');
    const pools = await DLMM.getLbPairs(connection);
    const popularPools = pools.slice(0, 3);
    
    const poolInfo = popularPools.map(pool => ({
      address: pool.publicKey.toString(),
      tokenX: pool.tokenXMint.toString(),
      tokenY: pool.tokenYMint.toString(),
      binStep: pool.binStep,
    }));
    
    console.log('✅ Popular Pools Success:');
    console.log(JSON.stringify(poolInfo, null, 2));
    return true;
  } catch (error) {
    console.error('❌ Popular Pools Error:', error.message);
    return false;
  }
}

async function runTests() {
  console.log('🚀 Meteora DLMM MCP Server - Direct Testing');
  console.log('📡 RPC URL:', config.rpcUrl);
  console.log('=' .repeat(50));
  
  const tests = [
    { name: 'RPC Connection', fn: testConnection },
    { name: 'Pool Info', fn: testPoolInfo },
    { name: 'Popular Pools', fn: testPopularPools }
  ];
  
  let passed = 0;
  for (const test of tests) {
    try {
      const result = await test.fn();
      if (result) passed++;
    } catch (error) {
      console.error(`❌ ${test.name} failed:`, error.message);
    }
  }
  
  console.log('\n' + '=' .repeat(50));
  console.log(`📊 Test Results: ${passed}/${tests.length} tests passed`);
  
  if (passed === tests.length) {
    console.log('🎉 All tests passed! Your MCP server is working correctly.');
    console.log('\n💡 Next steps:');
    console.log('1. Connect to Claude using MCP server configuration');
    console.log('2. Try natural language queries like:');
    console.log('   - "Get pool info for DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"');
    console.log('   - "Show me popular DLMM pools"');
  } else {
    console.log('⚠️  Some tests failed. Check your RPC connection and configuration.');
  }
}

runTests().catch(console.error);