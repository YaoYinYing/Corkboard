# Self-hosted Node.js 24 + SQLite + local blob build. No secrets are copied
# into either stage; the operator supplies them at run time through a
# read-only mounted file (see docs/docker.md).

FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
RUN npm run build

FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS runtime
WORKDIR /app

# Non-secret defaults only. The real keys come from the mounted secrets file.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    CORKBOARD_DATA_DIR=/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force

# dist already contains dist/migrations (scripts/copy-migrations.ts).
COPY --from=build /app/dist ./dist
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# The named volume inherits this ownership and mode when it is first created.
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh \
  && mkdir -p /data \
  && chown 1000:1000 /data \
  && chmod 0700 /data

USER 1000:1000
EXPOSE 8787
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT ?? '8787') + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/scripts/corkboard.js", "serve"]
