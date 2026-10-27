# Corpus backend: Go API + Rust RAG core

The backend is moving from TypeScript (Next.js route handlers) to **Go** for the API and **Rust**
for the retrieval core, step by step. The browser app does not change: each migrated route keeps
the exact contract of the TypeScript route it replaces (paths, methods, status codes, JSON shapes,
error bodies), and both backends share one PostgreSQL database, one session cookie and one
`AUTH_SECRET`. A user signed in on the Next.js side is signed in on the Go side too.

| Part | Language | What it does |
|---|---|---|
| `cmd/server`, `internal/api` | Go | HTTP API: route wrappers, access checks, handlers |
| `internal/auth` | Go | session cookie verification (HMAC-SHA256, key rotation), the role-permission table, workspace access |
| `internal/store` | Go (pgx) | all SQL, parameterised and scoped by workspace |
| `internal/httpx`, `apperr`, `jsstr` | Go | JSON responses and errors, byte-capped bodies, CSRF origin check, zod-compatible validation |
| `rust/` (`corpus-core`) | Rust | text splitting, Reciprocal Rank Fusion, the relevance guardrail, prompt escaping |
| `internal/core` | Go (wazero) | runs the Rust core, built to WebAssembly, inside the Go process (no cgo, no extra service) |

## Migration status

| Step | Routes / parts | Status |
|---|---|---|
| 1 | `GET /api/health`, `GET·POST /api/workspaces`, `GET·POST /api/collections`; auth, permissions, store; Rust core with golden tests | done |
| 2 | Retrieval and chat (`POST /api/chat`): AI provider adapters, embeddings, hybrid search, re-ranking, NDJSON streaming, using the Rust core | next |
| 3 | Sources and ingestion (`/api/learn/*`, `/api/corpus/*`), background jobs | planned |
| 4 | Studio, connectors, shares, chat-app bots, analytics, the remaining workspace administration routes | planned |

Next.js still serves every other `/api` path. The list of Go paths lives in `next.config.mjs`
(`GO_API_PATHS`) and `vercel.json`; `tests/go-backend.test.ts` keeps them in step.

## Database

No database migration is needed: the Go API uses the same PostgreSQL schema (`app.*`, pgvector),
which the TypeScript migrations (`server/db/migrations.ts`, `npm run db:migrate`) still own.

## Compatibility with the TypeScript code

- `npm run core:fixtures` writes `rust/tests/fixtures/golden.json` (inputs and the outputs the
  TypeScript RAG code gives) and `internal/auth/testdata/tokens.json` (session cookies signed by the
  Next.js app). The Rust tests and the Go tests must reproduce every output exactly.
- Lengths and trimming follow JavaScript (UTF-16 code units, `String.prototype.trim`), so limits
  such as "80 characters" mean the same on both sides.

## Running it

```bash
npm run core:build          # Rust → backend/internal/core/corpus_core.wasm (needs Rust + wasm32-unknown-unknown)
npm run core:test           # Rust unit and golden tests
npm run db:pglite-server    # a migrated PostgreSQL on 127.0.0.1:54329 (PGlite), or use any database
POSTGRES_URL=… AUTH_SECRET=… npm run backend:dev    # Go API on :8080
GO_API_URL=http://localhost:8080 npm run dev        # Next.js, proxying the Go paths to it
CORPUS_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/postgres?sslmode=disable npm run backend:test
```

Without `CORPUS_TEST_DATABASE_URL`, the database tests are skipped and the in-memory handler tests
still run. CI (`.github/workflows/ci.yml`) runs everything: the Rust tests and WebAssembly build,
the fixtures check, `go vet`, the Go tests against a migrated database, and the container build.

## Deployment

Vercel Services (Beta): `vercel.json` declares the Next.js app (`web`) and this API (`api`, built
from `Dockerfile` as a container) in one project. Top-level rewrites send the Go paths to `api`
and everything else to `web`. The container listens on `$PORT` (80 by default); it needs
`POSTGRES_URL` and `AUTH_SECRET` (the same values as the Next.js app) and refuses to start in
production without them.
