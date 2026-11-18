FROM rust:1.98.1-bookworm AS build
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY crates/buzz-meetings-server ./crates/buzz-meetings-server
RUN cargo build --locked --release -p buzz-meetings-server

FROM debian:bookworm-slim
COPY --from=build /build/target/release/buzz-meetings-server /usr/local/bin/
RUN install -d -o 65534 -g 65534 -m 700 /identity
USER 65534:65534
ENTRYPOINT ["/usr/local/bin/buzz-meetings-server"]
