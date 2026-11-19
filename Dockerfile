FROM node:22.22.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json hyperion-protocol-0.1.0.tgz ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22.22.1-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    HTTP_HOST=0.0.0.0 \
    HTTP_PORT=8080 \
    HYPERION_NETWORK=testnet \
    HYPERION_DEPLOYMENTS_FILE=./deployments/testnet.json \
    INDEXER_ENABLED=true \
    RAILS_ENABLED=true \
    KEEPER_ENABLED=false \
    SCHEMA_VERSION=1792000000000_evm-backfill-jobs \
    CATCH_UP_BUDGET_MS=120000 \
    INDEXER_LEASE_TTL_MS=30000
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node --eval "import('http').then(h=>h.get('http://127.0.0.1:8080/ready',r=>process.exit(r.statusCode===200?0:1)))"
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
COPY deployments/testnet.json ./deployments/testnet.json
USER node
CMD ["sh", "-c", "npm run migrate:up && exec node dist/main.js"]
