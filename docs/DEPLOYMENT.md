# Deployment

Corpus deploys to **Vercel**, which runs the pages, the API, streaming answers and the background
jobs, with the database on **Neon** (Postgres + pgvector, region `aws-us-east-2`, Ohio).

| Piece | On Vercel |
|---|---|
| Web app and API | Vercel Functions (Node.js, Fluid compute), region `cle1` |
| Background jobs | after each response, while someone waits, and on Vercel Cron |
| Migrations | the production build (`scripts/vercel-build.mjs`) |

## How the app fits Vercel's limits

[Vercel Functions limits](https://vercel.com/docs/functions/limitations) shaped the code:

| Limit | What the app does |
|---|---|
| Request bodies up to 4.5 MB | Files up to 4 MB go up in one request. Larger ones (up to 50 MB) go in 4 MB parts: `POST /api/learn/uploads`, `PUT …/parts/:n` (retried on its own if the network drops), `POST …/complete`. |
| Buffered response bodies up to 4.5 MB | Original PDFs, audio overviews and images are streamed, which the limit does not cover. Recordings answer byte ranges so players can seek. |
| No long-running process | Jobs run right after the response that queued them (Next.js `after()`, up to 50 s per pass), each time the UI polls while someone waits, and when Vercel Cron calls `/api/jobs/run`. Long jobs save their progress and continue in the next pass. |
| Up to 300 s per function (Hobby) | Uploads, chat, URL and YouTube imports and the cron endpoint allow 300 s, so work that runs after the response has room. |
| Only `/tmp` is writable | OCR keeps the language data of `OCR_LANGUAGES` other than English there. Nothing else is written to disk. |
| Latency to the database | `vercel.json` places the functions in `cle1` (Cleveland, AWS `us-east-2`), the region of the Neon database. Every question makes several database round trips. |

### Hobby or Pro

- **Hobby** (free) is for personal, non-commercial use only. Vercel Cron runs at most once a day,
  here at 03:00 UTC (give or take an hour). Work left in the queue when nobody uses the app waits
  until then.
- **Pro** allows commercial use, cron every minute (change the schedule in `vercel.json` to
  `*/5 * * * *` or `* * * * *`), and functions of up to 800 s.
- Background jobs count as function usage: many scanned PDFs, long recordings or audio overviews
  use more of the plan's function time.

## Before the first deploy

1. **Back up the database.** Create a Neon branch of the production database (a copy you can restore).
   The first production build migrates the schema to the latest version (v15), and migrations only
   move forward. To rehearse, run `npm run db:migrate` against a Neon branch first.
2. **Generate the secrets:** `openssl rand -hex 24` for `CRON_SECRET`, and `openssl rand -hex 32` for
   `AUTH_SECRET` on a new database. A database that already has data needs the `AUTH_SECRET` that
   encrypted its stored credentials (connector and chat-app tokens); change it only by rotating
   ([SECURITY.md](SECURITY.md)).
3. **Pick a sign-in method.** At least one is needed:
   - Google OAuth or GitHub OAuth (register the redirect URIs after the first deploy, when you know the domain);
   - email codes through Resend, or SMTP / Gmail.

   `AUTH_ALLOWED_EMAILS` / `AUTH_ALLOWED_DOMAINS` restrict who can sign in.

## Deploy on Vercel

1. On [vercel.com](https://vercel.com) choose **Add New → Project** and import the GitHub repository.
   Vercel detects Next.js; [vercel.json](../vercel.json) sets the build command, the region, Fluid
   compute and the cron job.
2. Add the **environment variables** for the Production environment:

   | Variable | Value |
   |---|---|
   | `POSTGRES_URL` | the Neon connection string (pooled host, `sslmode=require`) |
   | `AUTH_SECRET` | the generated secret (at least 32 characters) |
   | `GOOGLE_API_KEY` | your Gemini API key (or the `CHAT_PROVIDER=openai-compatible` settings) |
   | `CRON_SECRET` | the generated secret; Vercel Cron sends it to `/api/jobs/run` |
   | Sign-in | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`, or `RESEND_API_KEY` / `RESEND_FROM_EMAIL` or the SMTP settings |
   | Optional | `AUTH_ALLOWED_EMAILS`, `AUTH_ALLOWED_DOMAINS`, `GEMINI_*_MODEL`, `RERANKER` / `COHERE_API_KEY`, `OCR_ENGINE`, `OCR_LANGUAGES` |

   Leave these unset:
   - `APP_URL`: Vercel's production domain is used automatically. Set it when you add a custom
     domain, so OAuth redirects and links always use that domain.
   - `NODE_ENV`: Vercel sets it. Setting it to `production` for the build would skip the dev
     dependencies the build needs.
   - `TRUST_PROXY`: Vercel is detected.
   - `WEB_RUNS_JOBS`: on Vercel the functions run the jobs.
3. **Deploy.** A production build first applies pending migrations (idempotent and locked), then runs
   `next build`. If a migration fails, the build fails and the running version keeps serving. To
   migrate by hand instead, set `SKIP_MIGRATIONS=1` and run `npm run db:migrate` before each release.
4. **Register the OAuth redirect URIs** with the production domain:
   - Google: `https://<domain>/api/auth/oauth/callback?provider=google`
   - GitHub: `https://<domain>/api/auth/oauth/callback?provider=github`
   - Google Drive connector: `https://<domain>/api/connectors/google-drive/callback`
5. **Check the release:**
   - `https://<domain>/api/health` returns `{"ok":true,"database":"up"}`;
   - the function logs show no `Configuration:` errors;
   - you can sign in, and upload a PDF larger than 5 MB (it goes up in parts);
   - the document becomes ready, and **Settings → Cron Jobs** lists `/api/jobs/run`.

Every push to `main` deploys to production. Pull requests get preview deployments, which never
migrate the database: if you give the Preview environment variables, point `POSTGRES_URL` at a Neon
branch (the Neon integration for Vercel can create one per preview), never at the production database.

## Without Vercel

Vercel is the supported deployment. For a machine of your own, the [Dockerfile](../Dockerfile) builds one image for three commands:

| Process | Command |
|---|---|
| Web server | the default command (`next start` on `$PORT`) |
| Worker | `node --conditions=react-server dist/scripts/worker.cjs` |
| Migrations | `node --conditions=react-server dist/scripts/init-db.cjs` (before each release) |

```bash
docker build -t corpus .
docker run --rm --env-file .env.production corpus node --conditions=react-server dist/scripts/init-db.cjs
docker run -d --name corpus-web    --env-file .env.production -p 3000:3000 corpus
docker run -d --name corpus-worker --env-file .env.production corpus node --conditions=react-server dist/scripts/worker.cjs
```

- `.env.production` needs `POSTGRES_URL`, `AUTH_SECRET`, `APP_URL` (https) and the model key, plus
  `TRUST_PROXY` (the number of reverse proxies in front, usually 1) and `WEB_RUNS_JOBS=false` when
  the worker runs.
- Put a TLS-terminating reverse proxy in front (Caddy, nginx, a cloud load balancer). The app sends
  HSTS and expects https.
- The image runs as the unprivileged `node` user. Its application files are read-only to that user,
  and it contains no source code, dev dependencies or `.env` files (see `.dockerignore`).
- Health check: `GET /api/health` (200 when the database answers, 503 otherwise).

[render.yaml](../render.yaml) deploys the same two processes on Render as a Blueprint (web service
and background worker in Ohio, migrations as the pre-deploy step).

## Operating it

- **Logs.** Every process logs one JSON object per line: `level`, `msg`, `requestId`, `jobId`, and
  never secrets. A failed request shows a request id that matches the log line (Vercel: the
  project's Logs).
- **Scaling.** Vercel scales the functions by itself; jobs are claimed with `FOR UPDATE SKIP LOCKED`,
  so parallel runs never do the same job twice. Model quotas are usually the limit before CPU is.
- **Rollbacks.** Vercel's Instant Rollback serves an earlier deployment again. Migrations are
  additive, so older code keeps working on the newer schema.
- **Backups.** Neon keeps point-in-time history (the retention depends on your plan). Branch before
  risky changes.
- **Secrets.** Rotating `AUTH_SECRET`, the production checklist and incident steps are in
  [SECURITY.md](SECURITY.md).
- **Costs to watch.** Gemini usage: re-ranking, deep mode, evaluation and audio overviews each add
  model calls. Evaluation sampling is a per-workspace setting. On Vercel, background jobs add function
  time.
