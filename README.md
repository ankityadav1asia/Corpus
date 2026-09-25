# Corpus — team RAG workspaces (Next.js + Postgres/pgvector + open-source models)

Collect files, scans, images, recordings, web pages, YouTube transcripts, notes and whole apps
(Google Drive, Notion, GitHub, websites) into **notebooks**, ask questions answered only from those
sources with numbered citations, turn them into audio overviews, mind maps, reports and images, and
share everything with your team.

- **Workspaces & roles** — a private personal workspace for everyone, plus team workspaces with Admin / Editor / Viewer roles, per-notebook overrides, email invitations and an audit log
- **Advanced retrieval** — hybrid search (pgvector + full-text, Reciprocal Rank Fusion), multi-query expansion, step-back prompting and HyDE in deep mode, then re-ranking (LLM grader or Cohere Rerank)
- **Source guardrail** — when nothing relevant enough is found, the reply is exactly *“Insufficient context in knowledge base.”* instead of a guess
- **Multimodal sources & OCR** — PDFs, text formats, images (vision description + OCR), scanned PDFs (Tesseract OCR, page by page), audio and video (timestamped transcripts); up to 50 MB per file, indexed in the background
- **Connectors** — Google Drive files and folders, Notion pages and databases, GitHub repositories (docs), websites (sitemap or crawl, robots.txt respected); incremental, scheduled sync
- **Audio overviews** — NotebookLM-style two-host conversations (deep dive, brief, critique, debate; 16 languages incl. Hindi and Hinglish) with a timed transcript
- **Mind maps** — an interactive topic tree across your sources; click a topic to ask about it in chat
- **Open-source models** — Gemma via the Gemini API, or any OpenAI-compatible server (Ollama, vLLM, LM Studio, LocalAI, Groq …) for chat, embeddings, vision, transcription and speech; re-embed a workspace after switching
- **Fast answers** — helper calls (re-ranking, planning, judging) skip the model's thinking phase and can use a smaller model; each helper stage has a time limit; repeated questions reuse their embeddings
- **Follow-up questions** — three suggested next questions under each answer, generated after it has been delivered
- **Inline charts** — answers that compare numbers include a bar, line or pie chart drawn from the cited figures
- **PDF viewer** — citations open the original PDF at the cited passage, highlighted
- **Share links** — read-only public snapshots of a chat or report; view counts; revoke any time
- **Slack & Microsoft Teams bots** — your team asks from chat; answers come from a chosen notebook, with sources
- **Voice chat** — talk to your notebooks and hear the answers (spoken sentence by sentence while they stream)
- **Studio** — reports (executive summary, comparison table, slide outline) and knowledge-grounded images, both traceable to their sources
- **Chunk editor** — edit text (re-embedded automatically), labels and metadata; add or delete chunks; inspect vectors
- **Quality** — faithfulness, answer relevance and context precision for live answers (LLM-as-judge), context recall from benchmarks, thumbs up/down feedback
- Command palette, notifications, pinned conversations, light and dark themes; Google / GitHub / email-code sign-in, SSRF-safe fetching, rate limits, a background job queue in Postgres

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and
[docs/SECURITY-AUDIT.md](docs/SECURITY-AUDIT.md) for what was wrong with the previous version.

## Quick start

Requirements: Node.js 20.9+, a Postgres database with the `vector` extension (Neon works out of the
box), and either a Gemini API key or an OpenAI-compatible model server.

```bash
npm install
# create .env with POSTGRES_URL, AUTH_SECRET (openssl rand -hex 32) and GOOGLE_API_KEY (+ APP_URL for production)
npm run db:migrate            # creates/upgrades the app schema; safe to re-run
npm run dev                   # http://localhost:3000
```

Every setting is declared and validated in [server/env.ts](server/env.ts); the Configuration section below lists the notable ones.

On Windows PowerShell, if scripts are blocked (`npm.ps1 cannot be loaded`), use `npm.cmd run …`.

Without an email provider, `npm run dev` prints sign-in codes to the server console.
To try the app without a database server, set `POSTGRES_URL=pglite:./.data/pglite` (in-process
Postgres + pgvector, for local development only).

### Running on open-source models

```bash
# Gemma 4 (open weights) through the Gemini API — no other change needed
GEMINI_CHAT_MODEL=gemma-4-26b-a4b-it

# Fully local with Ollama: ollama pull qwen3:8b && ollama pull nomic-embed-text
CHAT_PROVIDER=openai-compatible
EMBEDDING_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1
OPENAI_COMPATIBLE_CHAT_MODEL=qwen3:8b
OPENAI_COMPATIBLE_EMBEDDING_MODEL=nomic-embed-text
```

OCR uses Tesseract on the server by default (no API calls). Vision, transcription and speech can also
point at open-source servers (e.g. Qwen2.5-VL, faster-whisper, Kokoro) — see [server/env.ts](server/env.ts).
Workspace settings → **AI models** shows what each capability uses; after changing the embedding model,
an admin re-embeds the workspace there (until then, older passages are found by keyword search only).

### Upgrading an existing database

`npm run db:migrate` applies every pending migration in order (v1 → v14): workspaces and roles
(moving each user's data into their personal workspace), chunk labels, jobs and evaluation, reports,
background ingestion, images, feedback / notifications / audit, embedding-model tagging and media,
audio overviews and mind maps, connectors, follow-ups / share links / original PDFs / chat apps,
server-side sessions, and chat-app notebook scope. Take a backup (a Neon branch) first. From v13 on,
sessions live in the database, so everyone signs in again once after upgrading. Data written by the
very first version of the app can be imported with `npm run db:import-legacy -- --email you@example.com`.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js development server / production build / production server |
| `npm test` | 335 tests (unit, Postgres-in-WASM integration, HTTP routes) — no network needed |
| `npm run typecheck` / `lint` | TypeScript, and ESLint with the code standards ([docs/CODE-STANDARDS.md](docs/CODE-STANDARDS.md)); lint fails on any warning |
| `npm run db:migrate` | Apply pending schema migrations |
| `npm run worker` | Process background jobs (indexing, OCR, transcription, audio, mind maps, syncs, reports, images, evaluations) in a loop; `-- --once` drains the queue |
| `npm run build:scripts` / `start:worker` | Bundle the worker, migration and re-seal scripts into `dist/scripts` / run the bundled worker (production images) |
| `npm run secrets:reseal` | Re-encrypt stored credentials with a new `AUTH_SECRET` ([docs/SECURITY.md](docs/SECURITY.md)) |
| `npm run db:import-legacy -- --email …` | Import data from the previous version |
| `npm run seed -- --email …` | Add a sample document to that user's personal workspace |

Background jobs also run right after the request that queued them and while the UI polls for their
results; on serverless hosts, schedule `/api/jobs/run` with `Authorization: Bearer $CRON_SECRET`
(this also starts scheduled connector syncs). Long work (OCR of a big scan, recording a long audio
overview, syncing a large folder) continues across job runs.

## Deployment

Production runs the same Docker image twice — the web server and the background worker — next to a
Neon database, with migrations applied before each release. [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
explains the recommended setup (Render, from [render.yaml](render.yaml); any Docker host works) and
why this app is not a good fit for Vercel's serverless functions (4.5 MB request bodies, no
long-running worker). Security operations — secrets, rotation, the production checklist — are in
[docs/SECURITY.md](docs/SECURITY.md).

## API

All routes except health, sign-in and the cron endpoint require a session cookie; write requests
must come from the same origin. Workspace-scoped routes need an `X-Workspace-Id` header
(non-members get 404; missing roles get 403).

| Route | Methods | Purpose |
|---|---|---|
| `/api/auth`, `/api/auth/otp/*`, `/api/auth/oauth/*` | GET, POST, DELETE | Session, email code, Google / GitHub sign-in; `DELETE /api/auth?scope=all` signs out of every device |
| `/api/workspaces`, `/api/workspaces/:id` | GET, POST, PATCH, DELETE | List/create workspaces; rename, retrieval & guardrail settings, delete |
| `/api/workspaces/:id/members`, `…/members/:userId`, `…/invites` | GET, POST, PATCH, DELETE | Members, invitations, roles, leave |
| `/api/workspaces/:id/audit` | GET | Workspace activity log (admins) |
| `/api/workspaces/:id/shares` | GET | Every active public link in the workspace (admins) |
| `/api/workspaces/:id/models`, `…/reembed` | GET, POST | Which model does what; re-embed the workspace with the active embedding model (admins) |
| `/api/chat` | POST | Ask a question; streams NDJSON (`start`, `status`, `sources`, `delta`, `done`, `error`) |
| `/api/collections`, `/api/collections/:id`, `/api/collections/:id/roles` | GET, POST, PATCH, PUT, DELETE | Notebooks and per-notebook role overrides |
| `/api/corpus`, `/api/corpus/documents/:id`, `…/chunks`, `…/retry` | GET, POST, DELETE | Documents (with indexing progress); append a chunk; retry a failed source |
| `/api/corpus/chunks`, `/api/corpus/chunks/:id` | GET, PATCH, DELETE | Chunk editor (filters: notebook, document, label, text) |
| `/api/learn`, `/api/learn/upload`, `/api/learn/url`, `/api/learn/youtube` | POST | Add text, files (documents, images, audio, video, scans), a web page, a YouTube transcript |
| `/api/connectors` | GET | Available apps, your connections and the workspace's synced sources |
| `/api/connectors/connections`, `…/:id`, `…/:id/browse` | POST, DELETE, GET | Connect Notion / GitHub with a token; browse or search an account |
| `/api/connectors/google-drive/start`, `…/callback` | GET | Google Drive OAuth (read-only) |
| `/api/connectors/sources`, `…/:id`, `…/:id/sync` | POST, PATCH, DELETE | Sync items or a website into a notebook; schedule; sync now; remove |
| `/api/audio`, `/api/audio/:id`, `/api/audio/:id/file` | GET, POST, DELETE | Queue (202) and play audio overviews (MP3 with HTTP Range) |
| `/api/mindmaps`, `/api/mindmaps/:id` | GET, POST, DELETE | Queue (202) and read mind maps |
| `/api/reports`, `/api/reports/:id` | GET, POST, DELETE | Queue (202) and read synthesis reports |
| `/api/images`, `/api/images/:id`, `/api/images/:id/file` | GET, POST, DELETE | Queue (202) and read knowledge-grounded images |
| `/api/conversations`, `/api/conversations/:id`, `/api/conversations/:id/branch` | GET, PATCH, DELETE, POST | Private history (`?q=` searches titles and message text), rename, pin, delete, fork |
| `/api/messages/:id/feedback` | PUT | Rate an answer (up, down or cleared) |
| `/api/messages/:id/followups` | POST | Suggested follow-up questions for an answer (generated once, then stored) |
| `/api/shares`, `/api/shares/:id` | GET, POST, DELETE | Read-only public links to a chat or report; revoke |
| `/api/public/shares/:token`, page `/s/:token` | GET | The shared snapshot (no sign-in) |
| `/api/corpus/documents/:id/file` | GET | The original PDF, for the viewer |
| `/api/workspaces/:id/integrations`, `…/:integrationId` | GET, POST, DELETE | Slack / Teams bots (admins) |
| `/api/integrations/slack/:id/events`, `/api/integrations/teams/:id/messages` | POST | Webhooks (Slack signature / Bot Framework JWT) |
| `/api/notifications`, `/api/notifications/read` | GET, POST | In-app notifications |
| `/api/evaluations`, `/api/evaluations/cases`, `/api/evaluations/runs` | GET, POST, DELETE | Quality summary, benchmark questions, benchmark runs (202) |
| `/api/stats`, `/api/analytics` | GET | Schema/feature status and totals; usage and latency (`?scope=workspace` for admins) |
| `/api/jobs/run` | GET, POST | Process queued jobs (Bearer `CRON_SECRET`; 404 when unset) |
| `/api/health` | GET | Public liveness check |

## Configuration

Every variable is declared and validated in [server/env.ts](server/env.ts). Notable settings:

- `AUTH_SECRET` is mandatory (≥ 32 characters); there is no default. It signs sessions and derives the key that encrypts connector and chat-app credentials; rotate it with `AUTH_SECRET_PREVIOUS` and `npm run secrets:reseal` ([docs/SECURITY.md](docs/SECURITY.md)).
- `TRUST_PROXY` = the number of reverse proxies in front of the app (1 on Render, Railway or Fly), so per-IP rate limits see real client addresses; `WEB_RUNS_JOBS=false` when a dedicated worker processes the job queue.
- `APP_URL` is required in production; OAuth redirect URIs are `<APP_URL>/api/auth/oauth/callback?provider=google|github` and, for the Google Drive connector, `<APP_URL>/api/connectors/google-drive/callback` (also enable the Drive API and the `drive.readonly` scope).
- `AUTH_ALLOWED_EMAILS` / `AUTH_ALLOWED_DOMAINS` restrict who can sign in (invitations do not bypass them).
- Models: `GEMINI_*_MODEL`, or `CHAT_PROVIDER` / `EMBEDDING_PROVIDER` / `VISION_PROVIDER` / `TRANSCRIPTION_PROVIDER` / `TTS_PROVIDER` = `openai-compatible` with `OPENAI_COMPATIBLE_*`; `OCR_ENGINE` (`tesseract` · `vision` · `none`) and `OCR_LANGUAGES`.
- `RERANKER` (`auto` · `llm` · `cohere` · `none`) with `COHERE_API_KEY`; `CRON_SECRET` enables `/api/jobs/run`.
- A production server or worker refuses to start without `AUTH_SECRET`, a Postgres `POSTGRES_URL` (not PGlite) and an https `APP_URL`; it logs a warning for missing optional features.
- Retrieval, guardrail and evaluation settings are per workspace (Workspace settings in the app).
- Slack: create an app with the bot scopes `app_mentions:read`, `chat:write`, `im:history`, connect it in Workspace settings → Chat apps with its bot token and signing secret, then paste the shown Request URL into Event Subscriptions (`app_mention`, `message.im`). Teams: create an Azure Bot, connect it with its App ID, client secret and tenant, and set the shown messaging endpoint.
- Gemini free-tier quotas are small (and image generation needs billing); a daily-quota error fails jobs fast with a readable message instead of retrying all day.
