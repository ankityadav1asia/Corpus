# The Corpus Go API with the Rust RAG core, as one container (Vercel Services, runtime "container").
# Build context: backend/
#   docker build -t corpus-api backend

# 1. Rust core → WebAssembly
FROM rust:1-bookworm AS rust
RUN rustup target add wasm32-unknown-unknown
WORKDIR /src/rust
COPY rust/Cargo.toml rust/Cargo.lock* ./
COPY rust/src ./src
RUN cargo build --release --target wasm32-unknown-unknown

# 2. Go API, with the module embedded
FROM golang:1-bookworm AS go
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
COPY --from=rust /src/rust/target/wasm32-unknown-unknown/release/corpus_core.wasm ./internal/core/corpus_core.wasm
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

# 3. Runtime: a static binary and CA certificates (TLS to Neon)
FROM gcr.io/distroless/static-debian12
COPY --from=go /out/server /server
# Vercel's container router sends traffic to $PORT (80 unless the project sets PORT).
ENV PORT=80
EXPOSE 80
ENTRYPOINT ["/server"]
