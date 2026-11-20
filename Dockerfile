# DiceCloud self-hosted image, built from this checkout.
#
# Recipe from https://github.com/arbel-arad/DiceCloud (develop @ 2089275), which produced
# the image forgejo.spacetime.technology/arbel/dicecloud built 2025-03-25. Changes from
# that file:
#   - installs `libarchive-tools` instead of the `bsdtar` package name
#   - copies the app source after installing Meteor, so the install layer stays cached
#   - adds OCI labels
# See README.md, "Self-hosted Docker image".

# ===== STAGE 1: Meteor builder =====
FROM node:16-slim AS builder

ENV METEOR_ALLOW_SUPERUSER=true \
    METEOR_DISABLE_OPTIMISTIC_CACHING=true \
    METEOR_NO_RELEASE_CHECK=true \
    METEOR_DISABLE_OPLOG=false \
    METEOR_HOME=/base/.meteor

RUN adduser --system --group --home /base mt && chown -R mt:mt /base
WORKDIR /base

RUN apt-get update && apt-get install --no-install-recommends -y \
    curl ca-certificates openssl git libarchive-tools g++ build-essential procps python3 && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /base/dc/bundle/programs/server && chown -R mt:mt /base

# Meteor 2.16 matches app/.meteor/release. The installer's tar call is swapped for bsdtar,
# which copes with container filesystems that reject the ownership bits in the tarball.
USER mt
RUN curl -fsSL https://install.meteor.com/\?release\=2.16 -o /tmp/install-meteor.sh && \
    sed -i "s/tar -xzf.*/bsdtar -xf \"\$TARBALL_FILE\" -C \"\$INSTALL_TMPDIR\"/g" /tmp/install-meteor.sh && \
    sh /tmp/install-meteor.sh && rm /tmp/install-meteor.sh

COPY --chown=mt:mt app /base/app

WORKDIR /base/app
RUN export PATH=$PATH:/base/.meteor && \
    meteor npm ci --omit=dev && \
    meteor build --directory /base/dc --architecture os.linux.x86_64 && \
    rm -rf /base/.meteor ~/.npm ~/.cache

# Trim the bundle. fibers is removed here and rebuilt in the runtime stage for musl.
WORKDIR /base/dc/bundle/programs/server
RUN npm install && npm ci --omit=dev && npm uninstall fibers && \
    rm -rf /base/app /base/dc/bundle/programs/server/dev_bundle /base/dc/bundle/programs/web.browser.legacy /base/dc/bundle/programs/web.cordova && \
    find . -type f \( -name "*.md" -o -name "*.ts" -o -name "*.log" -o -name "*.d.ts" \) -delete && \
    find . -type d -name "tests" -exec rm -rf {} + && npm cache clean --force

# ===== STAGE 2: Runtime =====
FROM node:15-alpine AS runtime

LABEL org.opencontainers.image.title="DiceCloud" \
      org.opencontainers.image.description="DiceCloud v2 self-hosted build" \
      org.opencontainers.image.source="https://github.com/faultoverload/DiceCloud" \
      org.opencontainers.image.licenses="GPL-3.0"

RUN apk add python3 make g++ git
RUN adduser -D -h /app -s /bin/sh -u 1001 mt
USER mt
COPY --from=builder --chown=mt:mt /base/dc/bundle /app

WORKDIR /app/programs/server/
RUN npm install fibers
USER root
RUN apk del python3 make g++ && rm -r /app/.npm /app/.cache

USER mt
WORKDIR /app
EXPOSE 3000

CMD ["node", "--trace-warnings", "main.js"]
