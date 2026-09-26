# Deployment

Corpus deploys to **Vercel**, which runs the pages, the API, streaming answers and the background
jobs, with the database on **Neon** (Postgres + pgvector, region `aws-us-east-2`, Ohio). When the
background work outgrows serverless functions, the same code runs as a **worker on Kubernetes**.
The whole app can also run on Kubernetes, or on any Docker host.

| Piece | On Vercel | On Kubernetes (optional) |
|---|---|---|
| Web app and API | Vercel Functions (Node.js, Fluid compute), region `cle1` | Deployment `corpus-web` + Ingress |
| Background jobs | after each response, while someone waits, and on Vercel Cron | Deployment `corpus-worker` |
| Migrations | the production build (`scripts/vercel-build.mjs`) | Job `corpus-migrate` |

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
- Background jobs count as function usage. For many scanned PDFs, long recordings or audio
  overviews, add the [Kubernetes worker](#worker-on-kubernetes-next-to-vercel).

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
   - `WEB_RUNS_JOBS`: only `false` once a worker runs elsewhere.
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

## Kubernetes

### The image

CI builds the Docker image on every push. To publish it to the GitHub Container Registry, set the
repository variable `PUBLISH_IMAGE` to `true` (Settings → Secrets and variables → Actions →
Variables). Each push to `main` then publishes `ghcr.io/ankityadav1asia/corpus:main` and
`:sha-<commit>` once the checks pass; **Actions → CI → Run workflow** publishes on demand.

Check the package's visibility (GitHub → your profile → Packages → corpus). A public package needs
nothing more. For a private one, give the cluster a pull secret and add
`imagePullSecrets: [{ name: ghcr }]` to the pod specs:

```bash
kubectl -n corpus create secret docker-registry ghcr --docker-server=ghcr.io \
  --docker-username=<github user> --docker-password=<token with read:packages>
```

The settings go into one Secret, from a local file that git ignores (`.env.production`, the same
variables as on Vercel; `APP_URL` is required here):

```bash
kubectl apply -f deploy/kubernetes/worker/namespace.yaml
kubectl -n corpus create secret generic corpus-env --from-env-file=.env.production
```

### Worker on Kubernetes, next to Vercel

The web app stays on Vercel; OCR, transcription, audio overviews and the other jobs move to the cluster.

```bash
kubectl apply -k deploy/kubernetes/worker
kubectl -n corpus logs deploy/corpus-worker -f     # "✓ 1 job(s) done, 0 failed" once work arrives
```

Then set `WEB_RUNS_JOBS=false` on Vercel and redeploy. Vercel Cron keeps calling `/api/jobs/run`,
which is harmless next to the worker (each job is claimed once); remove `CRON_SECRET` to stop it.

After each release, restart the worker so it pulls the new image:
`kubectl -n corpus rollout restart deployment/corpus-worker`. A worker that is still on the older
version leaves job types it does not know in the queue, for the new one to pick up.

The worker runs as the image's unprivileged `node` user with a read-only root filesystem, drops all
capabilities, and has about two minutes to finish its current job when it is stopped.

### The whole app on Kubernetes

1. Edit [deploy/kubernetes/full/ingress.yaml](../deploy/kubernetes/full/ingress.yaml): your domain,
   the ingress class and the TLS issuer. It is written for ingress-nginx and cert-manager, and allows
   52 MB request bodies (ingress-nginx allows 1 MB by default).
2. Put `APP_URL=https://<your domain>` into `.env.production` and create the Secret as above.
3. Apply the migrations, then the app:
   ```bash
   kubectl apply -f deploy/kubernetes/migrate-job.yaml
   kubectl -n corpus wait --for=condition=complete job/corpus-migrate --timeout=300s
   kubectl apply -k deploy/kubernetes/full
   ```
4. The web pods are ready once `/api/health` answers. The web Deployment sets `TRUST_PROXY=1` (the
   ingress controller) and `WEB_RUNS_JOBS=false` (the worker does the jobs).

Each release: publish the image, run the migration Job again (delete the finished one first:
`kubectl -n corpus delete job corpus-migrate`), then
`kubectl -n corpus rollout restart deployment/corpus-web deployment/corpus-worker`.
To pin a release instead of following `main`:
`cd deploy/kubernetes/full && kustomize edit set image corpus=ghcr.io/ankityadav1asia/corpus:sha-<commit>`.

## Other hosts

The [Dockerfile](../Dockerfile) builds one image for three commands:

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
  never secrets. A failed request shows a request id that matches the log line. On Vercel: the
  project's Logs; on Kubernetes: `kubectl -n corpus logs`.
- **Scaling.** Vercel scales the functions by itself. Workers can run several replicas, because jobs
  are claimed with `FOR UPDATE SKIP LOCKED`. Model quotas are usually the limit before CPU is.
- **Rollbacks.** Vercel's Instant Rollback serves an earlier deployment again. Migrations are
  additive, so older code keeps working on the newer schema.
- **Backups.** Neon keeps point-in-time history (the retention depends on your plan). Branch before
  risky changes.
- **Secrets.** Rotating `AUTH_SECRET`, the production checklist and incident steps are in
  [SECURITY.md](SECURITY.md).
- **Costs to watch.** Gemini usage: re-ranking, deep mode, evaluation and audio overviews each add
  model calls. Evaluation sampling is a per-workspace setting. On Vercel, background jobs add function
  time; the worker moves that work to the cluster.
