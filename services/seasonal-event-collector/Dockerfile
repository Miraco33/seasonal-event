FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM mcr.microsoft.com/playwright:v1.55.1-noble
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY config ./config
ENV NODE_ENV=production
ENTRYPOINT ["node", "dist/index.js"]
