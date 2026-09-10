FROM rust:1.93-bookworm@sha256:7c4ae649a84014c467d79319bbf17ce2632ae8b8be123ac2fb2ea5be46823f31 AS build
RUN apt-get update && apt-get install -y --no-install-recommends libepoxy-dev libgbm-dev libegl-mesa0 libgl1-mesa-dri \
    && rm -rf /var/lib/apt/lists/*
RUN rustup component add clippy rustfmt
# Epoxy loads the GLES dispatch library at runtime (not a link dependency).
RUN apt-get update && apt-get install -y --no-install-recommends libgles2 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /compact
COPY native/gpu-compact/ ./
RUN cargo fmt --all --check && cargo test --locked --offline \
    && cargo clippy --locked --offline --all-targets -- -D warnings \
    && RUSTDOCFLAGS='-D warnings' cargo doc --locked --offline --no-deps \
    && cargo build --locked --offline --release
USER 10000:10000
ENV LIBGL_ALWAYS_SOFTWARE=1
RUN /compact/target/release/bpane-gpu-compact-probe --software-test
RUN /compact/target/release/bpane-gpu-compact-probe --software-test --deduplicate
RUN /compact/target/release/bpane-gpu-compact-probe --software-test --profile-stages

FROM scratch AS artifacts
COPY --from=build /compact/target/release/bpane-gpu-compact-probe /bpane-gpu-compact-probe
