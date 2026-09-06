# syntax=docker/dockerfile:1
# A source checkout + locked Python core/MCP, not upstream's all-in-one UI image.
FROM debian:13.4@sha256:e2d08da6f42ef4b09b165d55528a12727aeed8240dc9edf888e3ec07e10ef9da AS sqlite-builder
RUN apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
    build-essential ca-certificates curl && rm -rf /var/lib/apt/lists/*
# Keep the upstream Hermes WAL-safety and FTS5/trigram guarantee.
RUN curl -fsSL --retry 3 --retry-all-errors --connect-timeout 15 --max-time 180 \
      https://sqlite.org/2026/sqlite-autoconf-3530400.tar.gz -o /tmp/sqlite.tar.gz && \
    echo '0e9483900e92cd5de8fd48d16bf9200145a61f7fd5be542a5ac81d8a9516eb9c  /tmp/sqlite.tar.gz' | sha256sum -c - && \
    tar -xzf /tmp/sqlite.tar.gz -C /tmp && \
    cd /tmp/sqlite-autoconf-3530400 && \
    CFLAGS='-O2 -DSQLITE_ENABLE_FTS3 -DSQLITE_ENABLE_FTS3_PARENTHESIS -DSQLITE_ENABLE_FTS4 -DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_RTREE -DSQLITE_ENABLE_COLUMN_METADATA -DSQLITE_ENABLE_UNLOCK_NOTIFY -DSQLITE_ENABLE_DBSTAT_VTAB -DSQLITE_ENABLE_MATH_FUNCTIONS -DSQLITE_SECURE_DELETE -DSQLITE_THREADSAFE=1 -DSQLITE_MAX_VARIABLE_NUMBER=250000' \
      ./configure --prefix=/opt/sqlite-fixed --disable-static && make -j2 && make install

FROM ghcr.io/astral-sh/uv:0.11.6-python3.13-trixie@sha256:b3c543b6c4f23a5f2df22866bd7857e5d304b67a564f4feab6ac22044dde719b AS uv-source

FROM debian:13.4@sha256:e2d08da6f42ef4b09b165d55528a12727aeed8240dc9edf888e3ec07e10ef9da AS python-base
RUN apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
    python3 python3-venv ca-certificates git curl ripgrep tini libatomic1 && \
    rm -rf /var/lib/apt/lists/*
COPY --from=sqlite-builder /opt/sqlite-fixed/lib/libsqlite3.so.3.53.4 /usr/local/lib/
RUN ln -s libsqlite3.so.3.53.4 /usr/local/lib/libsqlite3.so.0 && \
    ln -s libsqlite3.so.3.53.4 /usr/local/lib/libsqlite3.so && \
    echo /usr/local/lib > /etc/ld.so.conf.d/000-sqlite-fixed.conf && ldconfig
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1

FROM python-base AS hermes-builder
COPY --from=uv-source /usr/local/bin/uv /usr/local/bin/uv
WORKDIR /checkout
RUN git init && git remote add origin https://github.com/NousResearch/hermes-agent.git && \
    git fetch --depth=1 origin ee5b5ec21e576ccf9b941f9ff71330418415a5cb && \
    git checkout --detach FETCH_HEAD && \
    test "$(git rev-parse HEAD)" = ee5b5ec21e576ccf9b941f9ff71330418415a5cb && \
    mkdir /opt/hermes && git archive HEAD | tar -x -C /opt/hermes
WORKDIR /opt/hermes
ENV UV_PROJECT_ENVIRONMENT=/opt/venv UV_PYTHON_DOWNLOADS=never
# Editable is upstream's supported source-install path; keep source read-only at runtime.
RUN uv sync --frozen --no-dev --extra mcp --python /usr/bin/python3 && \
    echo docker > .install_method && \
    echo ee5b5ec21e576ccf9b941f9ff71330418415a5cb > .hermes_build_sha

FROM python-base
LABEL org.opencontainers.image.title="BrowserPane Hermes agent" \
      org.opencontainers.image.source="https://github.com/grattis-digital/browserpane-hermes" \
      io.browserpane.hermes.revision="ee5b5ec21e576ccf9b941f9ff71330418415a5cb"
COPY --from=hermes-builder /opt/hermes /opt/hermes
COPY --from=hermes-builder /opt/venv /opt/venv
COPY bootstrap.py config.yaml healthcheck.py verify.py /opt/hermes-bundle/
COPY --chmod=0755 entrypoint.sh /opt/hermes-bundle/entrypoint.sh
RUN groupadd -g 10000 hermes && useradd -u 10000 -g hermes -m -d /opt/data -s /bin/bash hermes && \
    mkdir -p /opt/data /shared && chown 10000:10000 /opt/data /shared
ENV PATH=/opt/venv/bin:$PATH HERMES_HOME=/opt/data \
    HERMES_WRITE_SAFE_ROOT=/opt/data:/shared HERMES_DISABLE_LAZY_INSTALLS=1
USER 10000:10000
WORKDIR /shared
RUN HERMES_HOME=/tmp/hermes-build-check python /opt/hermes-bundle/verify.py && \
    rm -r /tmp/hermes-build-check
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/hermes-bundle/entrypoint.sh"]
CMD ["gateway", "run"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 CMD ["python", "/opt/hermes-bundle/healthcheck.py"]
