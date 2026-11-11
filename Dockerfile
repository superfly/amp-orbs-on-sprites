FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl util-linux && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN curl -fsSL --proto '=https' https://sprites.dev/dl/client/2026-11-03/sprite-linux-x86_64 -o /usr/local/bin/sprite \
 && echo '731af477ecf7328fd188c67b3649874c9107b6f0097c25888d0dd17aad823527  /usr/local/bin/sprite' | sha256sum -c - \
 && chmod 755 /usr/local/bin/sprite
COPY package.json start.mjs dispatch.mjs hosted.mjs retire.mjs ./
COPY src ./src
COPY bootstrap ./bootstrap
RUN node --input-type=module -e "import {ensureAmp} from './src/install-amp.mjs'; await ensureAmp('/app/.tools', {version:'0.0.1793707234-gc72860'});"
ENV SPRITES_STATE_DIR=/data SPRITES_STATUS_FILE=/data/provider-status.json
# flock survives process crashes and releases automatically across restarts.
ENTRYPOINT ["flock", "--no-fork", "-n", "/data/dispatcher.flock", "node", "hosted.mjs"]
