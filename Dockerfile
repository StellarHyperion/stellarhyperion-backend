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
    KEEPER_ENABLED=false
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
COPY deployments/testnet.json ./deployments/testnet.json
USER node
CMD ["sh", "-c", "npm run migrate:up && exec node dist/main.js"]
