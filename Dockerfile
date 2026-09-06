# Source is the pinned upstream revision plus patches/. No host toolchain needed.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS source-fetcher
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /source
COPY UPSTREAM_COMMIT ./
COPY patches patches
COPY scripts/fetch-upstream.sh scripts/fetch-upstream.sh
RUN sh scripts/fetch-upstream.sh

FROM source-fetcher AS source-builder
COPY . .
RUN sh scripts/package-source.sh

FROM rust:1.93-bookworm AS host-builder
RUN apt-get update && apt-get install -y --no-install-recommends libopus-dev pkg-config cmake && rm -rf /var/lib/apt/lists/*
ARG BPANE_BUILD_JOBS=2
WORKDIR /build
COPY --from=source-fetcher /source/upstream/Cargo.toml /source/upstream/Cargo.lock ./
COPY --from=source-fetcher /source/upstream/code/shared code/shared
COPY --from=source-fetcher /source/upstream/code/apps code/apps
RUN cargo build --release --locked -j "$BPANE_BUILD_JOBS" -p bpane-host

FROM host-builder AS gateway-builder
RUN cargo build --release --locked -j "$BPANE_BUILD_JOBS" -p bpane-gateway

FROM node:22-bookworm-slim AS web-builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY --from=source-fetcher /source/upstream/code/web/bpane-client/js upstream/code/web/bpane-client/js
COPY --from=source-fetcher /source/upstream/code/integrations/mcp-bridge/src/playwright-mcp-runtime.ts upstream/code/integrations/mcp-bridge/src/playwright-mcp-runtime.ts
COPY scripts/build.mjs scripts/build.mjs
COPY client client
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime-base
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium chromium-sandbox xserver-xorg-core xserver-xorg-video-dummy \
    x11-xserver-utils x11-utils xcvt openbox ffmpeg dbus-x11 xclip libopus0 \
    pipewire pipewire-pulse wireplumber pulseaudio-utils socat python3 \
    fonts-liberation fonts-dejavu-core fonts-noto-color-emoji curl tini openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 10000 bpane && useradd -u 10000 -g bpane -m -s /bin/bash bpane
FROM runtime-base
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="BrowserPane Hermes" \
      org.opencontainers.image.description="One persistent shared Chromium session for people and a Hermes agent" \
      org.opencontainers.image.source="https://github.com/grattis-digital/browserpane-hermes" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.revision="$VCS_REF"
WORKDIR /app
COPY --from=host-builder /build/target/release/bpane-host /usr/local/bin/bpane-host
COPY --from=gateway-builder /build/target/release/bpane-gateway /usr/local/bin/bpane-gateway
COPY --from=web-builder /app/node_modules node_modules
COPY --from=web-builder /app/dist dist
COPY --from=web-builder /app/package.json package.json
COPY --from=source-builder /source/upstream/deploy/xorg-dummy.conf /etc/X11/xorg-dummy.conf
COPY --from=source-builder /source/upstream/deploy/start-host.sh /app/upstream/start-host.sh
COPY --from=source-builder /source/upstream/deploy/bpane-ext /home/bpane/bpane-ext
COPY --from=source-builder /source/upstream/deploy/chromium-policies/managed /etc/chromium/policies/managed
COPY runtime/chromium-policy.json /etc/chromium/policies/managed/browserpane-hermes.json
COPY runtime/wireplumber-headless.lua /etc/wireplumber/bluetooth.lua.d/51-headless.lua
COPY runtime/start.sh runtime/healthcheck.sh runtime/watch-x11.sh runtime/watch-gpu.sh /app/runtime/
COPY runtime/chromium-wrapper.sh /usr/local/bin/chromium
COPY server server
COPY LICENSE UPSTREAM.md /app/
COPY --from=source-builder /source/source.tar.gz /app/source.tar.gz
RUN mkdir -p /data/profile /shared/downloads && chown -R bpane:bpane /data /shared /home/bpane && chmod +x /app/runtime/*.sh /usr/local/bin/chromium
USER 10000:10000
ENV DISPLAY=:99 XDG_RUNTIME_DIR=/tmp/runtime-bpane \
    BPANE_UPLOAD_DIR=/shared/downloads BPANE_DOWNLOAD_DIR=/shared/downloads \
    BPANE_PROFILE_DIR=/data/profile BPANE_SOCKET_PATH=/tmp/bpane/agent.sock \
    BPANE_CDP_ENDPOINT=http://127.0.0.1:9222
EXPOSE 8090 8931 4433/udp
ENTRYPOINT ["/usr/bin/tini", "--", "/bin/bash", "/app/runtime/start.sh"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 CMD ["/app/runtime/healthcheck.sh"]
