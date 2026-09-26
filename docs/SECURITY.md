# Security

How Corpus protects data, and how to run it safely. The controls are summarised in
[ARCHITECTURE.md → Security model](ARCHITECTURE.md#security-model). The review that led to them is in
[SECURITY-AUDIT.md](SECURITY-AUDIT.md).

## Reporting a problem

Do not open a public issue for a vulnerability. Tell the maintainers privately. Include the route or
file, what an attacker can do, and how to reproduce it.

## Secrets

| Secret | Used for | If it leaks |
|---|---|---|
| `AUTH_SECRET` | signing session cookies and sign-in state; the key (via HKDF) that encrypts connector and chat-app credentials and share tokens | rotate at once, **without** keeping the old value (below) |
| `POSTGRES_URL` | the database | rotate the Neon role's password |
| `GOOGLE_API_KEY`, `COHERE_API_KEY`, `OPENAI_COMPATIBLE_API_KEY` | model calls (cost) | revoke the key with the provider |
| `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_SECRET` | OAuth sign-in and the Drive connector | reset it in the provider's console |
| `RESEND_API_KEY`, `SMTP_PASS` / `GMAIL_APP_PASSWORD` | sign-in codes by email | revoke it with the provider |
| `CRON_SECRET` | `/api/jobs/run` (disabled when unset) | replace it; the endpoint only processes queued jobs |

- Secrets live only in the platform's environment settings, never in the repository, the Docker image
  (`.dockerignore` excludes `.env*`) or logs. The logger never prints them.
- Connector tokens, bot credentials and share tokens are stored encrypted (AES-256-GCM). They are
  never sent to the browser.
- The app has no default secret. Without `AUTH_SECRET` (at least 32 characters) nobody can sign in,
  and a production server refuses to start.

## Rotating AUTH_SECRET

Rotating on a schedule, or because someone who knew it left, keeps everyone signed in:

1. Generate a new secret: `openssl rand -hex 32`.
2. On **both** the web server and the worker, set:
   - `AUTH_SECRET_PREVIOUS` = the current secret;
   - `AUTH_SECRET` = the new one.

   On Vercel: Settings → Environment Variables.
3. Deploy. New sessions and encrypted values use the new secret. Existing sessions and stored
   credentials are still accepted through the previous one.
4. Re-encrypt what is stored: run `npm run secrets:reseal`. In a production container, run
   `node --conditions=react-server dist/scripts/reseal-secrets.cjs`.
   Vercel has no shell: run `npm run secrets:reseal` from a checkout, with `POSTGRES_URL`, `AUTH_SECRET`
   and `AUTH_SECRET_PREVIOUS` set to the production values in your terminal session only.
   It reports how many values it re-sealed and lists any it could not read.
5. After 7 days (the session lifetime), remove `AUTH_SECRET_PREVIOUS` and deploy again. The server logs
   a reminder while it is set.

If the secret **leaked**, do not keep the old value. Set only the new `AUTH_SECRET`, deploy, and run
the re-seal script:

- Every session ends, and everyone signs in again.
- Credentials that cannot be opened any more are listed; their owners reconnect those apps and bots.
- Share links whose token cannot be opened keep working, but cannot be shown again. Revoke them and
  make new ones.

## Sessions

- A session is a signed cookie (httpOnly, SameSite=Lax, Secure) that names a row in `app.sessions`. It
  lasts 7 days.
- **Sign out** revokes that session. **Sign out of all devices** (account menu) revokes every session
  of the account.
- Each server instance caches the "still active" check for up to 30 seconds, so a revoked session
  stops working within 30 seconds everywhere.
- Removing someone from a workspace takes effect on their next request, because membership is checked
  on every request. It also:
  - deletes their connected accounts in that workspace;
  - revokes the public links they created there.

## Production checklist

The server refuses to start, and says why, when any of these is wrong:

- [ ] `AUTH_SECRET` is at least 32 random characters.
- [ ] `POSTGRES_URL` is a real Postgres (Neon), not PGlite.
- [ ] `APP_URL` is the public `https://` origin.

Also check:

- [ ] `TRUST_PROXY` = the number of reverse proxies in front of the app (automatic on Vercel; 1 behind
      one reverse proxy; 2 with a CDN in front). Without it, per-IP limits treat
      every caller as one. Setting it higher than the real number of proxies lets clients pick their
      own address.
- [ ] Sign-in is limited as intended: `AUTH_ALLOWED_EMAILS` / `AUTH_ALLOWED_DOMAINS` for a company
      deployment. Invitations do not bypass the allowlist.
- [ ] OAuth apps list only your `APP_URL` redirect URIs. The Google app uses the read-only Drive scope.
- [ ] `CRON_SECRET` is set (at least 16 random characters) only where a scheduler calls
      `/api/jobs/run`, such as Vercel Cron.
- [ ] Preview deployments never use the production database: give them a Neon branch, or no database.
- [ ] The database role is used only by this app. Neon point-in-time restore is enabled.
- [ ] CI is green: `npm audit --omit=dev --audit-level=high` runs on every push, and Dependabot opens
      update pull requests weekly.

## Built-in protections (for reviewers)

- **Access control.**
  - Every API route goes through `authedRoute`, `workspaceRoute`, `workspaceParamRoute` or
    `publicRoute` (`server/http/route.ts`).
  - Workspace membership is resolved on every request; non-members get 404.
  - Permissions come from one table (`server/auth/permissions.ts`).
  - Every SQL query is parameterised and scoped by workspace.
- **Browser.**
  - A per-request nonce Content-Security-Policy (no unapproved inline scripts, no framing).
  - HSTS, `nosniff`, a strict referrer policy, and COOP/CORP `same-origin`.
  - An `Origin` check on every write request (CSRF).
- **Input.**
  - zod schemas and byte caps on every request.
  - Uploads are identified by content.
  - Fetches of external URLs are SSRF-safe: public addresses only, checked again after redirects,
    with size and time caps.
- **Prompt injection.** Documents, passages, conversation history and chat-app messages reach the
  model escaped and inside delimiters, and the prompts label them as data. Bot replies are escaped
  for Slack.
- **Webhooks.** Slack requests need a valid signature (HMAC, 5-minute window). Teams requests need a
  Bot Framework JWT checked against Microsoft's keys, audience, expiry and service URL.
- **Rate limits.** They are stored in Postgres (so they hold across instances) and cover sign-in
  codes (per address and per IP), chat, ingestion, studio jobs, invitations and shared pages.

## Known gaps

- Admins add members by email without the member accepting, and the reply shows whether an account
  already exists. An invitation-acceptance flow would close both.
- Uploads (up to 50 MB, sent in 4 MB parts above 4 MB) are stored in Postgres. Much larger files
  would be better placed in object storage.
- Voice input uses the browser's speech recognition, so audio is processed by the browser vendor.
