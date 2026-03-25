FROM node:20-alpine

WORKDIR /app

# Copy package files first for better caching
COPY package*.json tsconfig.json ./

# Install ALL dependencies (including devDependencies for TypeScript)
RUN npm ci

# Copy source code
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Remove dev dependencies to reduce image size
RUN npm prune --production

# Start the server via stdio
CMD ["node", "dist/index.js"]