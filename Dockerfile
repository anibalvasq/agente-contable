# ── build ───────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ── runtime ─────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY config ./config
COPY web ./web
COPY panel ./panel

# Las migraciones corren al arrancar (ver docker-entrypoint.sh). Se saltean
# solas si STORE=memory (no hay Postgres que migrar).
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Usuario no-root. Cambia el nombre si quieres, es cosmético.
RUN addgroup -S app && adduser -S app -G app
# data/: el panel con STORE=memory. inbox/: archivos que llegan por Telegram.
# Sin esto el usuario app no puede escribir en /app.
RUN mkdir -p /app/data /app/inbox && chown app:app /app/data /app/inbox
USER app

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
