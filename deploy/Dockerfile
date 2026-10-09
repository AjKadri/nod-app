# The Nod relay, alone. Build from the repo root:
#   docker build -f deploy/Dockerfile -t nod-relay .
FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    RELAY_STATE_FILE=/data/relay-state.json

RUN apk add --no-cache su-exec

WORKDIR /app
COPY relay/package.json relay/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY relay/server.js ./server.js
COPY deploy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /data && chown node:node /data

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q -O /dev/null http://127.0.0.1:8787/health || exit 1

# Starts as root only to make the mounted volume writable, then runs as "node".
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server.js"]
