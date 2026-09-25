# Deployment

Corpus runs as **two processes from one Docker image** next to a Postgres database:

| Process | Command | Does |
|---|---|---|
| Web server | the image's default command (`next start` on `$PORT`) | pages, API, streaming answers |
| Worker | `node --conditions=react-server dist/scripts/worker.cjs` | the job queue: indexing, OCR, transcription, audio overviews, mind maps, reports, images, connector syncs, chat-app answers, evaluations |
| Migrations | `node --conditions=react-server dist/scripts/init-db.cjs` | applies pending schema migrations (idempotent, locked); run before each release |

The database stays on **Neon** (Postgres + pgvector, region `aws-us-east-2`, Ohio).

## Recommended platform: Render

Render runs both processes from the repository's [render.yaml](../render.yaml) Blueprint:

- **A real worker process.** Scanned PDFs, recordings and audio overviews take minutes of CPU. On Render
  they run in a background worker, not inside web requests.
- **No small body limit.** Uploads of up to 50 MB, and serving the original PDFs and MP3s, work as
  written.
- **Same region as the database.** The `ohio` region sits next to Neon's `us-east-2`, and every
  question makes several database round trips.
- **Safe releases.** Migrations run before the new version takes traffic (`preDeployCommand`), traffic
  switches only once `/api/health` answers, and deploys wait for CI (`autoDeployTrigger: checksPass`).
- **Cost.** Two small instances: web `0.5c-512mb` (formerly "Starter") and worker `1c-2g` (formerly
  "Standard"). A light workload can start the worker on `0.5c-512mb`. Background workers have no free
  plan. Check [Render's pricing](https://render.com/pricing) for current prices.

Railway, Fly.io or any Docker host (a VPS with Docker Compose, AWS ECS, Google Cloud Run with a separate
worker) run the same image with the same three commands. See "Any Docker host" below.

### Why not Vercel (for this app)

Vercel suits the Next.js front end, but this app's back end runs into its function limits
([Vercel Functions limits](https://vercel.com/docs/functions/limitations)):

- **4.5 MB request and response bodies.** Vercel returns `413` above that, so 50 MB uploads fail.
  Original PDFs and audio overviews above 4.5 MB cannot be served either. Fixing this means uploading
  to object storage (e.g. Vercel Blob) from the browser, and redirecting file downloads to it.
- **No long-running worker.** Jobs would run only inside `after()` (at most 300 s on Hobby, 800 s on
  Pro) and through a cron call to `/api/jobs/run`. Long scans and audio overviews would crawl forward
  one short run at a time.
- **Heavy dependencies.** Tesseract (WebAssembly OCR) and pdf.js make the function bundles large and
  cold starts slow.
- **The Hobby plan is for personal, non-commercial use.** A company deployment needs Pro.

Vercel becomes a good fit once uploads and file downloads go through object storage, and the heavy
jobs run somewhere else (for example the worker image on Render).

## Before the first deploy

1. **Put the code on GitHub.** The repository has no remote yet. Render deploys from GitHub, GitLab or
   Bitbucket:
   ```bash
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
   CI ([.github/workflows/ci.yml](../.github/workflows/ci.yml)) then runs typecheck, lint, tests,
   builds, a dependency audit and a Docker build on every push.
2. **Back up the database.** Create a Neon branch of the production database (a copy you can restore).
   The first release migrates the schema up to the latest version (v14), and migrations only move
   forward. To rehearse, run `npm run db:migrate` against a Neon branch first.
3. **Decide the public URL.** Render names the web service `https://corpus-web.onrender.com`. If that
   name is taken it adds a suffix, and a custom domain can come later. `APP_URL` must be exactly this
   https origin, because it decides cookies, OAuth redirects and chat-app endpoints.
4. **Sign-in.** At least one method is needed:
   - Google OAuth: register `<APP_URL>/api/auth/oauth/callback?provider=google`.
   - GitHub OAuth: register `<APP_URL>/api/auth/oauth/callback?provider=github`.
   - Email codes: Resend, or SMTP / Gmail.
   `AUTH_ALLOWED_EMAILS` / `AUTH_ALLOWED_DOMAINS` restrict who can sign in.
   For the Google Drive connector, also register `<APP_URL>/api/connectors/google-drive/callback`.

## Deploy on Render

1. In the Render Dashboard choose **New → Blueprint** and connect the repository. Render reads
   `render.yaml` and proposes `corpus-web` (web) and `corpus-worker` (worker).
2. Enter the three secrets it asks for:
   - `POSTGRES_URL`: the Neon connection string (pooled host, `sslmode=require`).
   - `APP_URL`: the service URL from step 3 above.
   - `GOOGLE_API_KEY`: your Gemini API key.

   Render generates `AUTH_SECRET`. The worker copies all four values from the web service.
3. **Apply.** Render then:
   1. builds the image (Next.js build and bundled scripts, about 5–10 minutes);
   2. runs the migrations as the pre-deploy step;
   3. starts both services;
   4. routes traffic once `/api/health` answers.
4. **Add the optional settings to both services.** Create an Environment Group in the dashboard,
   e.g. `corpus-settings`, and link it to `corpus-web` and `corpus-worker`:
   - sign-in: `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`,
     `RESEND_API_KEY` / `RESEND_FROM_EMAIL` or the SMTP settings, `AUTH_ALLOWED_EMAILS` /
     `AUTH_ALLOWED_DOMAINS`;
   - models: `GEMINI_*_MODEL`, `CHAT_PROVIDER` / `OPENAI_COMPATIBLE_*`, `RERANKER` / `COHERE_API_KEY`,
     `OCR_ENGINE`, `OCR_LANGUAGES`.

   The worker needs the Google client too: it refreshes Google Drive tokens during syncs.
5. **Check the release:**
   - `https://<APP_URL>/api/health` returns `{"ok":true,"database":"up"}`;
   - the web logs show no `Configuration:` errors;
   - you can sign in and upload a PDF;
   - the worker logs show `✓ 1 job(s) done`, and the document becomes ready.

Every later push to `main` redeploys both services once CI passes.

### Settings in render.yaml

| Variable | Value | Why |
|---|---|---|
| `TRUST_PROXY` | `1` | Render's proxy appends the client address to `X-Forwarded-For`; per-IP rate limits (sign-in codes, shared pages) need it. Use `2` if you put a CDN such as Cloudflare in front. |
| `WEB_RUNS_JOBS` | `false` | The worker processes the queue; OCR, transcription and audio stay out of the 512 MB web instance. |
| `maxShutdownDelaySeconds` (worker) | `120` | On deploy or restart the worker finishes the job in progress (and takes no new one) before it stops. |

## Operating it

- **Logs.** Both processes log one JSON object per line: `level`, `msg`, `requestId`, `jobId`, and
  never secrets. Failed requests show a request id that matches the response.
- **Scaling.**
  - Web: more instances or a bigger plan.
  - Worker: several workers are safe, because jobs are claimed with `FOR UPDATE SKIP LOCKED`. Gemini
    quotas are usually the limit before CPU is.
- **Rollbacks.** Render can redeploy an earlier build. Migrations are additive, so older code keeps
  working on the newer schema.
- **Backups.** Neon keeps point-in-time history (the retention depends on your plan). Branch before
  risky changes.
- **Rotating `AUTH_SECRET`**, the production security checklist and incident steps are in
  [SECURITY.md](SECURITY.md).
- **Costs to watch.** Gemini usage: re-ranking, deep mode, evaluation and audio overviews each add
  model calls. Evaluation sampling is a per-workspace setting.

## Any Docker host

```bash
docker build -t corpus .

# once per release, before starting the new version
docker run --rm --env-file .env.production corpus node --conditions=react-server dist/scripts/init-db.cjs

docker run -d --name corpus-web    --env-file .env.production -p 3000:3000 corpus
docker run -d --name corpus-worker --env-file .env.production corpus node --conditions=react-server dist/scripts/worker.cjs
```

- `.env.production` needs:
  - `POSTGRES_URL`, `AUTH_SECRET`, `APP_URL` (https) and the model key;
  - `TRUST_PROXY` = the number of reverse proxies in front of the app (usually 1);
  - `WEB_RUNS_JOBS=false` when the worker runs.
- Put a TLS-terminating reverse proxy in front (Caddy, nginx, a cloud load balancer). The app sends
  HSTS and expects https.
- The image runs as the unprivileged `node` user. Its application files are read-only to that user,
  and it contains no source code, dev dependencies or `.env` files (see `.dockerignore`).
- Health check: `GET /api/health` (200 when the database answers, 503 otherwise).

## Serverless (Vercel or similar), if you must

Keep uploads under 4.5 MB, set `CRON_SECRET`, and schedule `GET /api/jobs/run` with
`Authorization: Bearer $CRON_SECRET` as often as the plan allows. Leave `WEB_RUNS_JOBS` unset, so jobs
also run after each request. Everything else in this document applies.
