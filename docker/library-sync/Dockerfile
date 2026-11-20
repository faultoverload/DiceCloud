# Sidecar that copies community libraries from dicecloud.com into a self-hosted DiceCloud
# database. Build from this directory:
#   docker build -t dicecloud-library-sync docker/library-sync
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY schema-keys.json ./
COPY src ./src

USER node
ENTRYPOINT ["node", "src/sync.mjs"]
CMD ["--config", "/config/config.yml"]
