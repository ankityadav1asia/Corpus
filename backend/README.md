# Corpus Go API

The API is moving from TypeScript (Next.js route handlers) to Go, one group of routes at a time.
Pages, routing and media processing (OCR, PDFs, audio, YouTube) stay in TypeScript. Each route
that moves keeps the exact contract of the TypeScript route it replaces: the same path, methods,
status codes, JSON shapes and error bodies. The browser app does not change. Both sides share one
PostgreSQL database, one session cookie and one `AUTH_SECRET`, so someone signed in through Next.js
is signed in for the Go routes too.

| Part | What it does |
|---|---|
| `../api/go.go` | the Vercel Go Function: builds the handler once per instance and serves every Go path |
| `cmd/dev` | the same handler on a local port, for development |
| `api` | route wrappers (session, workspace access, CSRF origin check), handlers; `admin.go`/`settings.go` (group 2), `conversations.go` (group 3), `chat.go` (group 4a), `studio.go` (group 4b), `usage.go` (AI usage metering and `GET /api/usage`) |
| `monitoring` | Sentry reporting of logged errors and recovered panics, when a DSN is set |
| `ai` | model vendors over REST: Gemini (streaming, embeddings, thinking control, retry hints, daily quotas) and OpenAI-compatible servers; configuration from the same variables as `server/env.ts` |
| `rag` | prompts, query planning, Reciprocal Rank Fusion, re-ranking (LLM grader or Cohere), guardrail, follow-ups and the answer judge, checked against outputs of the TypeScript code (`testdata/golden.json`, `npm run go:fixtures`) |
| `auth` | session cookie verification (HMAC-SHA256, key rotation, revocation), the role-permission table, workspace access |
| `store` | all SQL (pgx), parameterised and scoped by workspace |
| `httpx`, `apperr`, `jsstr` | JSON responses and errors, byte-capped bodies, zod-compatible validation, JavaScript string lengths |
| `config`, `logx` | the same environment variables as `server/env.ts`, structured logs |

## Migration status

| Group | Routes | Status |
|---|---|---|
| 1 | `GET /api/health`, `GET·POST /api/workspaces`, `GET·POST /api/collections` | Go |
| 2 | Workspace administration: `GET·PATCH·DELETE /api/workspaces/:id` (settings, rename, delete), `…/members`, `…/members/:userId`, `…/invites`, `…/audit`; `PATCH·DELETE /api/collections/:id`, `GET·PUT /api/collections/:id/roles` | Go |
| 3 | `GET /api/conversations` (`?q=` search), `GET·PATCH·DELETE /api/conversations/:id`, `POST …/:id/branch`, `PUT /api/messages/:id/feedback`, `GET /api/notifications`, `POST /api/notifications/read`, `GET /api/analytics` | Go |
| – | Still TypeScript from the workspace area: `…/shares` (opens sealed share tokens), `…/models` and `…/reembed` (AI configuration and a background job) | later, with the parts they depend on |
| 4a | `POST /api/chat` (the whole pipeline: deep-mode query planning, hybrid search, RRF, re-ranking, guardrail, streamed NDJSON answer), `POST /api/messages/:id/followups`; polling a conversation runs its answer's queued evaluation | Go |
| 4b | Studio: `GET·POST /api/reports`, `GET·DELETE /api/reports/:id`. Go queues reports; the TypeScript job runner writes them, started by the browser through `POST /api/jobs/nudge` while it polls | Go |
| – | Staying TypeScript: media processing (uploads, OCR, transcription, audio), the connectors' sync jobs, the job runner and cron, `GET /api/stats` (reports the OCR, email and OAuth configuration of the TypeScript side) | by decision |

Everything not listed as Go is still served by Next.js.

## Routing

`GO_API_PATHS` in `next.config.mjs` lists the Go paths:

- **On Vercel**, Next.js rewrites each of them to `/api/go`, the Go Function. The function sees the original path and routes on it (`api.Server.Handler`).
- **In development**, Next.js proxies them to `GO_API_URL`, which defaults to `http://localhost:8080`.

`tests/go-backend.test.ts` checks three things:

- every Go path is rewritten;
- every Go path is registered in the Go router;
- no Next.js `route.ts` is left for a Go path.

## Running it locally

```bash
POSTGRES_URL=… AUTH_SECRET=… npm run go:dev   # Go API on :8080 (needs Go 1.25+)
npm run dev                                   # Next.js, proxying the Go paths to it
```

For a throwaway database, run `npm run db:pglite-server`: a migrated in-memory PostgreSQL on port
54329. Use the URL it prints as `POSTGRES_URL`.

## Tests

```bash
npm run go:test                                  # handler, auth, config and validation tests
CORPUS_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/postgres?sslmode=disable npm run go:test
npm run go:fixtures                              # session cookies signed by the Next.js code
```

Without `CORPUS_TEST_DATABASE_URL`, the database tests are skipped. The in-memory handler tests
still run.

CI (`.github/workflows/ci.yml`, job `go`) runs these checks:

- the fixture check;
- `gofmt` and `go vet`;
- the full tests against a migrated database;
- a build of the function and the dev server.

## Database

No migration is needed. The Go code uses the same schema (`app.*`). The TypeScript migrations
(`server/db/migrations.ts`, `npm run db:migrate`) still own the schema.
