# 🧪 Local Testing Guide - Meteora DLMM MCP Server

Your Meteora DLMM MCP server is ready for local testing! This guide shows you how to test and use it while waiting for Smithery deployment.

## ✅ Current Status

- **Server Structure**: ✅ Working perfectly
- **RPC Connection**: ✅ Connected to https://solana-rpc.publicnode.com  
- **5 MCP Tools**: ✅ All registered and ready
- **Configuration**: ✅ Environment variables loaded
- **Security**: ✅ Read-only mode active (no wallet configured)

## 🚀 Quick Test

Run this to verify everything works:

```bash
node server-test.js
```

Expected output:
```
🚀 Meteora DLMM MCP Server - Structure Test
✅ 1. Loading server module...
✅ 2. Creating server instance...
✅ 3. Server created successfully!
🎯 Server Status: READY
```

## 🛠️ Available Tools

Your MCP server provides these 5 tools:

1. **`get_pool_info`** - Get detailed information about a DLMM pool
2. **`get_user_positions`** - View all positions for a wallet address  
3. **`get_claimable_fees`** - Check claimable fees for a position
4. **`claim_fees`** - Claim accumulated fees (requires wallet)
5. **`get_popular_pools`** - Discover popular DLMM pools

## 🔧 Configuration Options

### Read-Only Mode (Current)
```bash
RPC_URL=https://solana-rpc.publicnode.com
WALLET_PRIVATE_KEY=  # Empty = read-only
DEBUG=false
```

### Transaction Mode (Optional)
```bash
RPC_URL=https://solana-rpc.publicnode.com
WALLET_PRIVATE_KEY=your_base64_encoded_key
DEBUG=false
```

## 🌐 Connecting to Claude

### Option 1: Direct Server Connection (Advanced)
1. Run: `node mcp-test.js`
2. Connect Claude to the server using MCP configuration

### Option 2: Wait for Smithery Deployment (Recommended)
1. Smithery will provide a public URL
2. Add the URL to Claude's MCP servers
3. Start using natural language commands

## 📖 Example Commands for Claude

Once connected, you can ask Claude:

**Pool Information:**
- *"Get pool info for DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"*
- *"What's the current price in pool ABC123?"*

**Position Management:**
- *"Show me all my Meteora positions for wallet [your-wallet]"*
- *"Check my DLMM positions"*

**Fee Management:**  
- *"How much fees can I claim from position XYZ?"*
- *"Claim fees from all my positions"* (requires wallet)

**Discovery:**
- *"Show me popular DLMM pools"*
- *"What are the most active Meteora pools?"*

## ⚠️ Important Notes

### RPC Limitations
- **Current RPC**: Works for basic server operations
- **Full Functionality**: Requires paid RPC (Helius, QuickNode, Alchemy)
- **Free RPCs**: Often restrict advanced Solana operations

### Security
- **No Wallet**: Currently read-only mode (viewing only)
- **With Wallet**: Can perform transactions (claiming fees, etc.)
- **Private Keys**: Never shared, always stay with you

### Performance
- **Local Server**: Instant responses
- **RPC Calls**: Depends on endpoint performance
- **Smithery Deployment**: Global CDN, fastest performance

## 🔑 Adding Your Wallet (Optional)

To enable transactions:

1. **Get your private key** from Phantom/Solflare wallet
2. **Convert to base64**:
   ```javascript
   // If you have array format [1,2,3...]
   Buffer.from([your,private,key,array]).toString('base64')
   
   // If you have hex format
   Buffer.from('hexstring', 'hex').toString('base64')
   ```
3. **Add to .env**:
   ```bash
   WALLET_PRIVATE_KEY=your_base64_key_here
   ```

## 🚨 Troubleshooting

### "Server not responding"
- Check if RPC URL is correct
- Verify internet connection
- Try running `node server-test.js`

### "Tool errors"
- Normal with free RPC endpoints
- Upgrade to paid RPC for full functionality
- Server structure still works for Claude connection

### "Configuration errors"
- Check .env file exists
- Verify RPC_URL is set correctly
- Ensure no typos in environment variables

## 🎯 Next Steps

1. **✅ Server is ready** - You can connect to Claude now
2. **🔄 Wait for Smithery** - Easier deployment option  
3. **💰 Upgrade RPC** - For full DLMM functionality
4. **🔐 Add wallet** - For transaction capabilities

Your Meteora DLMM MCP server is working and ready to use! 🎉