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
      "@solana/spl-token",
      "dotenv"
    ],
    target: "node18",
    minify: true, // Enable minification for production
    platform: "node",
    bundle: false, // Don't bundle, just transpile
  },
};