# Synapse REST API
# Node 22-LTS — pnpm@latest verwendet intern node:sqlite, was Node 22+ erfordert.
FROM node:22-alpine

# pnpm installieren
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Dependencies kopieren
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/rest-api/package.json ./packages/rest-api/
COPY packages/web-ui/package.json ./packages/web-ui/

# Install
RUN pnpm install --frozen-lockfile

# Source kopieren
COPY tsconfig.base.json ./
COPY packages/core ./packages/core
COPY packages/rest-api ./packages/rest-api
COPY packages/web-ui ./packages/web-ui

# Build
RUN pnpm -r --filter @synapse/core --filter @synapse/rest-api --filter @synapse/web-ui run build

# Port
EXPOSE 3456

# Start REST API
CMD ["node", "packages/rest-api/dist/index.js"]
