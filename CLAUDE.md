# CLAUDE.md

Guidance for AI coding agents working in this repository. Read `docs/ARCHITECTURE.md` for the full design,
`docs/CODE-STANDARDS.md` for the enforced code rules, and `docs/DEPLOYMENT.md` / `docs/SECURITY.md` for operations.

## What this is

Corpus: a multi-tenant RAG app. Next.js 15 (App Router, React 19), Postgres + pgvector (Neon in
production, PGlite in tests/local dev). Models are Gemini by default (embeddings, generation,
re-ranking, judging, vision, transcription, speech, images); Gemma or any OpenAI-compatible server
can take over per capability (`server/env.ts`), and OCR is Tesseract. Users work in **workspaces**
(personal + team) with Admin / Editor / Viewer roles; notebooks (collections) hold documents →
chunks (text + 3072-dim vector + `embedding_model` in one row). Sources come from uploads (text,
PDF, scans, images, audio, video), URLs, YouTube and connectors (Google Drive, Notion, GitHub,
websites). The studio makes reports, images, audio overviews and mind maps.

## Commands

```bash
npm test                 # all tests (node:test + tsx + PGlite), no network; ~40 s
npm run typecheck        # tsc --noEmit
npm run lint             # ESLint code standards (size, complexity, layering); fails on any warning
npm run build            # production build
npm run db:migrate       # apply migrations to POSTGRES_URL
npm run worker           # process background jobs
npm run build:scripts    # bundle worker / migrations / re-seal into dist/scripts (production image)
npm run secrets:reseal   # re-encrypt stored credentials after rotating AUTH_SECRET
npx prettier --write <files>
```

Windows PowerShell may block `npm.ps1`; use `npm.cmd …` (or Git Bash). Never change the execution policy for the user.
Run a single test file: `node --conditions=react-server --import tsx --test tests/guardrail.test.ts`.

## Architecture rules

- **Routes are thin**: `app/api/**/route.ts` = parse (zod, byte caps) → authorise → call a service → `json()`. Use the wrappers in `server/http/route.ts`: `workspaceRoute` (session + `X-Workspace-Id` membership, non-members 404), `workspaceParamRoute` (workspace id in the path), `authedRoute`, `publicRoute`. Never read cookies or headers for auth yourself (`requestedWorkspaceId(req)` parses the workspace header).
- **Authorisation**: permissions live only in `server/auth/permissions.ts` (`PERMISSIONS` map, roles weakest first). Check with `requireWorkspacePermission(access, …)` or `requireCollectionPermission(repos, access, collectionId, …)` (applies per-notebook overrides; workspace admins always win). The UI mirrors roles via `lib/roles.ts` only to hide controls.
- **All SQL in `server/repositories/*`**, parameterised (`$1…`), and scoped by `workspace_id` (conversations also by `owner_id`). A foreign id must behave like a missing one (return null/false → 404). Documents (lifecycle, search), chunks (editor, re-embedding) and media (stored bytes, pages, original files) are separate repositories.
- **Schema changes = a new migration** appended to `server/db/migrations.ts` (never edit a released one). Neon's HTTP driver runs one statement per string; a migration is a list of statements applied in one transaction.
- **Contracts** (request schemas + response types) live in `lib/contracts/*` (one file per area, re-exported by `@/lib/contracts`); client components import types only (`import type`).
- **Configuration** is read only through `server/env.ts` (lint enforces it). A production server or worker refuses to start with unsafe settings (`server/config-check.ts`); keep that check in sync when adding required settings.
- **AI access** only through `AiProvider` (`server/ai/provider.ts`), `Reranker` (`server/rag/rerank.ts`), `VisionModel` / `Transcriber` / `SpeechSynthesizer` (`server/ai/media.ts`), `OcrEngine` (`server/media/ocr.ts`) and `ImageGenerator` (`server/ai/image.ts`); get instances from `getServices()` (`server/services.ts`) — optional capabilities return `null` when not configured, so hide the feature instead of failing. Never hard-code a provider: each has a Gemini and an OpenAI-compatible implementation. Tests use the fakes in `tests/helpers/fake-ai.ts` (`createFakeAi`, `createFakeVision`, `createFakeTranscriber`, `createFakeSpeech`, `createFakeOcr`, `createFakeImages`).
- **Embeddings**: store `ai.embeddingModel` with every chunk you write; vector search must filter by the active model (vectors are zero-padded to 3072).
- **Speed**: short helper calls (re-ranking, planning, judging, suggestions) pass `fast: true` to `ai.complete` (thinking off, optional `GEMINI_FAST_MODEL`); give optional stages a deadline (`withDeadline`, `STAGE_TIMEOUTS_MS`) and fall back instead of waiting. Never add work between the question and the first streamed words that could run after the answer instead (follow-ups are a separate request).
- **Public surfaces** are only `server/auth/public-paths.ts` (exact paths + anchored single-segment patterns for `/s/:token`, `/api/public/shares/:token` and the Slack/Teams webhooks). Webhooks authenticate in the handler (Slack signature, Bot Framework JWT) and acknowledge fast, then answer in the `answer_bot_message` job.
- **pdf.js** is loaded from `public/` (copied by `scripts/copy-pdf-worker.mjs` on install/dev/build) outside webpack; do not import `pdfjs-dist` at runtime in client code (types only).
- **Heavy work goes to the job queue** (`app.jobs`; each job type is one entry in `server/jobs/definitions.ts`: run, retry progress, failure notice): enqueue with `repos.jobs.enqueue(type, payload, { maxAttempts: JOB_ATTEMPTS[type] })`, then call `processJobsAfterResponse()`. Handlers must be idempotent (jobs can be retried) and resumable: persist progress as you go and return `'more'` when the time budget runs out. Throw `PermanentJobError` (`server/jobs/errors.ts`) for failures a retry cannot fix.
- **Connectors** implement `Connector` (`server/connectors/types.ts`: `browse`, `list`, `fetchItem`) and are registered in `server/connectors/registry.ts`; the sync engine (`sync.ts`) handles versions, pruning and resume. Outbound web requests go through the SSRF-safe fetcher (`server/security/ssrf.ts`); third-party tokens are stored only via `server/security/secrets.ts` (encrypted) and never returned to clients.
- **Untrusted text in prompts** must go through `escapeSourceText` and inside our delimiters (`<source>`, `<passage>`, `<document>`); tell the model it is data.
- **Errors**: throw `Errors.*` / `AppError` from `server/http/errors.ts`; unknown errors become a generic 500 with a request id. Never return internal messages to clients.
- Server-only modules import `'server-only'` where they touch env/secrets; scripts run with `--conditions=react-server` when they need them.

## RAG pipeline (server/rag)

`chat-service.ts` streams NDJSON events (`lib/stream-protocol.ts`): `start` → `status` (planning / searching / reranking / generating) → `sources` → `delta`* → `done` | `error`.
Stages: `query-transform.ts` (deep mode: multi-query 3–5, step-back, HyDE — concurrent, each may fail) → `retrieval.ts` (embed all queries in one batch, vector + full-text per query, RRF top N) → `rerank.ts` (top K) → `guardrail.ts` → generation.
The guardrail reply must be exactly `INSUFFICIENT_CONTEXT_MESSAGE` (`'Insufficient context in knowledge base.'`) and the model must not be called in that case. Thresholds and pipeline knobs are per-workspace settings (`workspaceSettingsSchema`).

## Testing expectations

- Every feature needs tests: pure logic in unit tests; SQL against PGlite (`tests/helpers/db.ts` runs the real migrations); routes via their exported handlers (`tests/http.test.ts` pattern, with `setServicesForTests` and `setJobAutorun(false)`).
- Authorization changes need role-matrix tests (`tests/authorization.test.ts`, `tests/http.test.ts`).
- Background jobs: call `runJobs(...)` explicitly in tests.
- Keep the suite offline and deterministic (fake AI, mocked `fetch` for connectors, no timers longer than a few ms). PDFs for OCR tests are generated by `tests/helpers/pdf.ts`.

## Local verification without Neon

`POSTGRES_URL=pglite:./.data/<name>` uses an in-process database (`server/db/pglite.ts`). Migrate it
first with the same URL. Only one process can open a data directory at a time. Do not point
experiments at the user's Neon database, and do not run migrations or imports against it
without asking.

## Housekeeping

- File size, function complexity and parameter counts are lint errors: split by responsibility instead of raising limits (`docs/CODE-STANDARDS.md`).
- Deployment: `Dockerfile` (one image for web + worker), `render.yaml` (Render Blueprint), `.github/workflows/ci.yml`. Pushing or deploying is outward-facing: only when asked.
- Commit only when asked; never commit `.env`, `.data/` or `dist/`.
