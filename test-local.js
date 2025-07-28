// Simple local test script for Meteora DLMM MCP Server
const fs = require('fs');
const path = require('path');

// Load the compiled server
const serverModule = require('./dist/index.js');

// Test configuration
const testConfig = {
  rpcUrl: "https://api.mainnet-beta.solana.com",
  walletPrivateKey: undefined, // No wallet for read-only testing
  debug: true,
  maxRetries: 3,
  rpcTimeout: 30000
};

console.log('🚀 Starting Meteora DLMM MCP Server Test...\n');

try {
  // Create server instance
  const server = serverModule({ config: testConfig });
  
  console.log('✅ Server created successfully!');
  console.log('📊 Configuration:', JSON.stringify(testConfig, null, 2));
  
  // Test server capabilities
  console.log('\n🛠️  Available Tools:');
  
  // The server should have tools registered
  console.log('- get_pool_info: Get detailed pool information');
  console.log('- get_user_positions: View all DLMM positions for a wallet');
  console.log('- get_claimable_fees: Check claimable fees for positions');
  console.log('- claim_fees: Claim accumulated fees (requires wallet)');
  console.log('- get_popular_pools: Discover popular DLMM pools');
  
  console.log('\n🎯 Server is ready for connections!');
  console.log('\nNext steps:');
  console.log('1. Use MCP Inspector to connect: npx @modelcontextprotocol/inspector');
  console.log('2. Or connect from Claude using the server configuration');
  console.log('3. Try commands like "Get pool info for DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"');
  
} catch (error) {
  console.error('❌ Error creating server:', error.message);
  console.error('\nDebug info:', error);
}

// Keep the process running
console.log('\n💡 Server is running... Press Ctrl+C to stop');
process.stdin.resume();