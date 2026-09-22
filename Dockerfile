# GD Insta Scheduler — multi-arch (ARM64 + x86_64, Raspberry Pi / PC)
# Il tag versione viene da package.json (workflow: .github/workflows/docker-publish.yml).
# Build manuale: docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/danyx67800/insta-scheduler:$(node -p "require('./package.json').version") --push .

FROM --platform=$BUILDPLATFORM node:20-alpine AS deps
RUN apk add --no-cache python3 make g++ sqlite-dev
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

FROM node:20-alpine AS runner
RUN apk add --no-cache sqlite-libs tzdata su-exec && rm -rf /var/cache/apk/*
ENV NODE_ENV=production \
    PORT=8757 \
    DATA_DIR=/data \
    TZ=Europe/Rome
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY server.js package.json entrypoint.sh ./
COPY public ./public
RUN mkdir -p /data/uploads \
  && adduser -D -H app \
  && chown -R app:app /app /data \
  && chmod +x /app/entrypoint.sh
# Niente `USER`: l'entrypoint parte da root, sistema i permessi del volume
# /data montato da Umbrel e poi esegue node come utente `app` (su-exec).
EXPOSE 8757
VOLUME ["/data"]
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:8757/api/health || exit 1
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "server.js"]
