FROM oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04

RUN apt-get update \
    && apt-get install -y --no-install-recommends nginx tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --chown=bun:bun frontend ./frontend
USER bun
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bash", "/app/frontend/start.sh"]
