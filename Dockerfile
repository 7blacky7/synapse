# Synapse REST API
FROM node:20-alpine

WORKDIR /app

# Dependencies kopieren
COPY package*.json ./
COPY packages/core/package*.json ./packages/core/
COPY packages/rest-api/package*.json ./packages/rest-api/

# Install
RUN npm install

# Source kopieren
COPY tsconfig.base.json ./
COPY packages/core ./packages/core
COPY packages/rest-api ./packages/rest-api

# Build
RUN npm run build

# Port
EXPOSE 3456

# Start REST API
CMD ["node", "packages/rest-api/dist/index.js"]
