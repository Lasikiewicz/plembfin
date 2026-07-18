# plembfin - self-hosted watch-state bridge (Sonarr/Radarr-style).
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=5055

# Install gosu for clean privilege-drop in the entrypoint.
RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/*

# Install production dependencies. better-sqlite3 and sharp ship prebuilt
# binaries for linux/glibc, so no compiler is needed for the common case.
COPY package.json package-lock.json* ./
COPY scripts/install-git-hooks.js ./scripts/install-git-hooks.js
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY scripts/check-worker-health.js ./scripts/check-worker-health.js
RUN npm ci --omit=dev && chmod +x /usr/local/bin/docker-entrypoint.sh

# Application code.
COPY server ./server
COPY public ./public
COPY changelog.json ./changelog.json

# node:22-slim already provides a 'node' user at uid 1000; rename it to
# 'plembfin' for clarity and set up the data directory.
RUN usermod -l plembfin node && groupmod -n plembfin node \
    && mkdir -p /data && chown plembfin:plembfin /data /app

VOLUME ["/data"]
EXPOSE 5055

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:5055/api/ping',r=>{process.exit(r.statusCode===200?0:1)})"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server/server.js"]
