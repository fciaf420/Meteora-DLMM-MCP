FROM node:18-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Build TypeScript
RUN npm run compile

# Expose port
EXPOSE 8000

# Start the server
CMD ["node", "dist/index.js"]