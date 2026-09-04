FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM mcr.microsoft.com/playwright:v1.52.0-noble
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
ENV NODE_ENV=production
ENTRYPOINT ["node", "dist/index.js"]
