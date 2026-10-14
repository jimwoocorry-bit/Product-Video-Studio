FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates ffmpeg chromium xvfb x11vnc openbox novnc websockify \
    espeak-ng dbus-x11 fonts-noto-cjk python3 python3-venv make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN node /usr/local/lib/node_modules/npm/bin/npm-cli.js ci --ignore-scripts
COPY prisma ./prisma
RUN node node_modules/prisma/build/index.js generate --schema prisma/schema.prisma
COPY vendor/douyin-cli ./vendor/douyin-cli
RUN cd vendor/douyin-cli && node /usr/local/lib/node_modules/npm/bin/npm-cli.js ci --omit=dev
COPY src ./src
COPY tests ./tests
COPY tsconfig.json ./
RUN node node_modules/typescript/lib/tsc.js -p tsconfig.json
COPY config ./config
COPY scripts ./scripts
COPY runtime ./runtime
COPY THIRD_PARTY_NOTICES.md ./
ENV NODE_ENV=production PVS_RUNTIME_MODE=fnos PVS_DATA_ROOT=/data PVS_LISTEN_PORT=3090 \
    FFMPEG_PATH=/usr/bin/ffmpeg FFPROBE_PATH=/usr/bin/ffprobe DISPLAY=:99
RUN test -x /usr/bin/flock && mkdir -p /data && chown node:node /data
USER node
EXPOSE 3090
HEALTHCHECK --interval=20s --timeout=5s --start-period=90s CMD node -e "fetch('http://127.0.0.1:3090/__pvs/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["/usr/bin/flock", "--nonblock", "--no-fork", "/data/.pvs-runtime.lock", "/usr/bin/env", "PVS_PROFILE_LOCK_HELD=1", "node", "runtime/linux-supervisor.mjs"]
