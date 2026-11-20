FROM rust:1.83-bookworm AS builder
WORKDIR /app/backend

COPY backend/Cargo.toml backend/Cargo.lock ./
COPY backend/crates ./crates

RUN cargo build --locked --release --bin bot-server

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -r -s /bin/false botuser

WORKDIR /opt/bot-futures
COPY --from=builder /app/backend/target/release/bot-server /opt/bot-futures/bot-server
RUN chown -R botuser:botuser /opt/bot-futures

USER botuser
ENV SERVER_HOST=0.0.0.0
ENV SERVER_PORT=8080
EXPOSE 8080

CMD ["/opt/bot-futures/bot-server"]
