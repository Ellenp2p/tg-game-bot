# syntax=docker/dockerfile:1.7

FROM node:22-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/engine/package.json packages/engine/
COPY packages/bot/package.json packages/bot/
RUN corepack enable \
 && pnpm install --frozen-lockfile
COPY packages ./packages
RUN pnpm run build

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/engine/package.json packages/engine/
COPY packages/bot/package.json packages/bot/
RUN corepack enable \
 && pnpm install --prod --frozen-lockfile --config.node-linker=hoisted

FROM node:22-slim
ENV NODE_ENV=production PORT=3000 DATA_FILE=/app/data/bot.sqlite
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY --from=build /app/packages/engine/dist ./packages/engine/dist
COPY --from=build /app/packages/bot/dist ./packages/bot/dist
COPY package.json ./
COPY public ./public
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "packages/bot/dist/index.js"]
