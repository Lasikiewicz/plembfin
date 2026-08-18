# plembfin - self-hosted watch-state bridge (Sonarr/Radarr-style).
FROM node:22-slim

WORKDIR /app
ARG BUILD_CHANNEL=release
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=5055 \
    BUILD_CHANNEL=$BUILD_CHANNEL

# Install gosu for clean privilege-drop in the entrypoint.
RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/*

# Install production dependencies. better-sqlite3 and sharp ship prebuilt
# binaries for linux/glibc, so no compiler is needed.
#
# `--ignore-scripts` is what keeps that true. better-sqlite3 carries a
# `binding.gyp`, and npm treats any such package as a gyp build: it runs
# `node-gyp rebuild` on install even though the package already contains the
# binary for this platform under `prebuilds/`. node-gyp needs Python before it
# can so much as read the gyp file, which this image deliberately does not
# carry. Skipping install scripts leaves the shipped prebuilt binary in place,
# which is what `lib/binding.js` prefers anyway. better-sqlite3 is the only
# dependency in the production tree with an install script, so nothing else
# loses anything here.
COPY package.json package-lock.json* ./
COPY scripts/install-git-hooks.js ./scripts/install-git-hooks.js
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY scripts/check-worker-health.js ./scripts/check-worker-health.js
RUN npm ci --omit=dev --ignore-scripts && chmod +x /usr/local/bin/docker-entrypoint.sh

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
