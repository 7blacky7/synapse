# Synapse REST API
FROM node:20-alpine

# pnpm installieren
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Dependencies kopieren
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/rest-api/package.json ./packages/rest-api/

# Install
RUN pnpm install --frozen-lockfile

# Source kopieren
COPY tsconfig.base.json ./
COPY packages/core ./packages/core
COPY packages/rest-api ./packages/rest-api

# Build
RUN pnpm -r --filter @synapse/core --filter @synapse/rest-api run build

# Port
EXPOSE 3456

# Start REST API
CMD ["node", "packages/rest-api/dist/index.js"]
