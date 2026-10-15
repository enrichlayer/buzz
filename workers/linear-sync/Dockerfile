# syntax=docker/dockerfile:1.7
# Build remotely. Runtime credentials and source records never enter this image.
FROM rust:1.95-bookworm AS cli
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /source
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY examples ./examples
COPY schema ./schema
COPY migrations ./migrations
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/source/target \
    cargo build --locked --release -p buzz-cli --bin buzz && cp target/release/buzz /usr/local/bin/buzz

FROM node:24-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app/workers/linear-sync
COPY workers/linear-sync/package.json workers/linear-sync/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY workers/linear-sync/*.cjs ./
COPY scripts/linear-sync.mjs scripts/linear-sync-outbox.mjs scripts/linear-project-snapshot.mjs /app/scripts/
COPY --from=cli /usr/local/bin/buzz /usr/local/bin/buzz
ENV PATH="/app/workers/linear-sync/node_modules/.bin:${PATH}"
USER node
CMD ["node", "worker.cjs"]
