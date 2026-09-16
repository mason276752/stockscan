# stockscan: Node server (SEC iXBRL scraper + API) serving the built Vue app.
# node:sqlite needs Node 22.13+ / 24; the image is Node 24.

# ---- build the web app ----
FROM node:24-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json* ./
RUN npm ci
COPY web/ ./
COPY shared/ /src/shared/
# relative asset URLs: one build serves any BASE_URL (the server injects the prefix)
RUN npx vite build
# the licensed TradingView Advanced Charts library (optional): web/assets/tradingview/
RUN mkdir -p assets

# ---- runtime ----
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
# --ignore-scripts: skip the postinstall that installs web/ dev deps
RUN npm ci --omit=dev --ignore-scripts
COPY server/ ./server/
COPY shared/ ./shared/
COPY --from=web /src/web/dist ./web/dist
COPY --from=web /src/web/assets ./web/assets
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
VOLUME ["/app/data"]
# PORT / BASE_URL / SEC_USER_AGENT / STOCKSCAN_CRAWL / TV_ENABLED / IB_* : see README
ENV PORT=3000 STOCKSCAN_DB=/app/data/stockscan.sqlite
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s \
  CMD wget -qO- "http://127.0.0.1:${PORT}${BASE_URL:-}/api/status" > /dev/null || exit 1
CMD ["node", "server/index.js"]
