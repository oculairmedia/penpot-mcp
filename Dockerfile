# Multi-stage build for Penpot MCP Server
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY common/package*.json ./common/
COPY mcp-server/package*.json ./mcp-server/
COPY penpot-plugin/package*.json ./penpot-plugin/

# Install dependencies for all components
RUN npm install
RUN cd common && npm install
RUN cd mcp-server && npm install
RUN cd penpot-plugin && npm install

# Copy source code
COPY common/ ./common/
COPY mcp-server/ ./mcp-server/
COPY penpot-plugin/ ./penpot-plugin/

# Build all components
RUN cd common && npm run build
RUN cd mcp-server && npm run build
RUN cd penpot-plugin && npm run build

# Production stage
FROM node:22-alpine

WORKDIR /app

# Copy built artifacts and dependencies
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules/
COPY --from=builder /app/common ./common/
COPY --from=builder /app/mcp-server ./mcp-server/
COPY --from=builder /app/penpot-plugin ./penpot-plugin/

# Expose ports
# 4401 - MCP Server (HTTP/SSE endpoints)
# 4400 - Plugin Server (serves the plugin UI)
EXPOSE 4401 4400

# Start both servers using concurrently
CMD ["npm", "run", "start:all"]
