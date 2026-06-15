# plembfinfire — self-hosted watch-state bridge (Sonarr/Radarr-style).
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=5055

# Install production dependencies. better-sqlite3 and sharp ship prebuilt
# binaries for linux/glibc, so no compiler is needed for the common case.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Application code.
COPY server ./server
COPY public ./public
COPY changelog.json ./changelog.json

VOLUME ["/data"]
EXPOSE 5055

CMD ["node", "server/server.js"]
