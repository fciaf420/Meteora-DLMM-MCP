module.exports = {
  esbuild: {
    // Mark problematic packages as external to avoid bundling issues
    external: [
      "@solana/web3.js",
      "@meteora-ag/dlmm", 
      "bn.js",
      "buffer",
      "crypto",
      "tweetnacl",
      "borsh",
      "@solana/spl-token"
    ],
    target: "node18",
    minify: false, // Keep false during development
    platform: "node",
  },
};