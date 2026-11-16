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
    ROLLOUT_LEASE_TTL_MS=20000 \
    ROLLOUT_DRAIN_GRACE_MS=3000 \
    SHUTDOWN_TIMEOUT_MS=15000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
COPY deployments/testnet.json ./deployments/testnet.json
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.HTTP_PORT || '8080') + '/ready').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
USER node
CMD ["sh", "-c", "npm run migrate:up && exec node dist/main.js"]
