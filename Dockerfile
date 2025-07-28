FROM node:18-alpine

WORKDIR /app

# Copy package files first for better caching
COPY package*.json tsconfig.json ./

# Install ALL dependencies (including devDependencies for TypeScript)
RUN npm ci

# Copy source code
COPY src/ ./src/
COPY smithery.config.js ./

# Build TypeScript
RUN npm run compile

# Remove dev dependencies to reduce image size
RUN npm prune --production

# Expose port
EXPOSE 8000

# Start the server
CMD ["node", "dist/index.js"]