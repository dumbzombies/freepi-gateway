FROM oven/bun:1-slim

WORKDIR /app

# Zero runtime dependencies: copy source only.
COPY package.json bunfig.toml ./
COPY src ./src

# Writable state: usage log, session id, client version, free-pi credentials.
RUN mkdir -p /data && chown -R bun:bun /app /data

ENV NODE_ENV=production \
    FREEPI_HOST=0.0.0.0 \
    FREEPI_PROXY_PORT=8452 \
    FREEPI_DATA_DIR=/data \
    FREEPI_CREDENTIALS_PATH=/data/credentials.json

USER bun
EXPOSE 8452

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:8452/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "src/main.ts"]
