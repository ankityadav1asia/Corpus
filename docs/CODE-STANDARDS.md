# Code standards

These are the rules every change follows:

- `npm run lint` enforces most of them (ESLint, [.eslintrc.cjs](../.eslintrc.cjs); it fails on any
  warning).
- `npm run typecheck` enforces the types (TypeScript strict mode).
- The rest are checked in review. The architecture is described in [ARCHITECTURE.md](ARCHITECTURE.md).

## Before every commit

```bash
npm run typecheck && npm run lint && npm test
npx prettier --write <changed files>     # no semicolons, single quotes, 180-column lines
```

CI ([.github/workflows/ci.yml](../.github/workflows/ci.yml)) runs the same checks. It also builds the
app and the scripts, audits production dependencies, and builds the Docker image.

## Enforced by ESLint

| Rule | Limit | Why |
|---|---|---|
| `max-lines` | 500 lines of code per file (tests 700; `server/db/migrations.ts` is exempt: released migrations are never edited or moved) | A file does one job. Split by responsibility, e.g. `components/app-sidebar/`, `lib/contracts/`, `server/repositories/{documents,chunks,media}.ts`. |
| `complexity` | 20 per function; 30 in React components, where JSX conditions count | Branchy code hides bugs. Extract steps (`server/connectors/sync.ts`) or use a table (`server/jobs/definitions.ts`, the Notion block renderers). |
| `max-params` | 5 | From four parameters on, pass an options object: `planRetrieval(ai, request, settings)`. |
| `no-restricted-syntax` on `process.env.X` | only in `server/env.ts` (plus the edge middleware, `next.config.mjs`, scripts and tests); `NODE_ENV` and `NEXT_RUNTIME` are allowed | Configuration has one validated, typed and cached source, which tests can reset with `resetEnvCache()`. |
| `no-console` | `console.warn` / `console.error` only; scripts and `server/logger.ts` are exempt | Server logs are structured JSON through `server/logger.ts`. |
| `no-restricted-imports` | `components/`, `hooks/` and `lib/` cannot import `@/server/*` or `server-only`; `app/` cannot import `@/server/db/*` | Secrets and SQL never reach the browser bundle, and routes reach data through services and repositories. |
| `@typescript-eslint/consistent-type-imports` | `import type` or inline `type` | Imports used only as types never pull runtime code (zod schemas) into client bundles. |
| `eqeqeq` (smart), `prefer-const`, `no-var`, `object-shorthand`, `@typescript-eslint/no-unused-vars` (`_` prefix to ignore) | | Consistency, and no dead code. |
| `next/core-web-vitals`, `next/typescript` | | React hook rules, Next.js pitfalls, and the recommended TypeScript rules (no `any`). |

Breaking a rule needs a reason on the line:
`// eslint-disable-next-line <rule> -- <why>`. Unused disable comments are reported too. Changing a
limit in `.eslintrc.cjs` needs a matching change in this table.

## Structure

- **Routes are thin.** An `app/api/**/route.ts` does four things in order:
  1. parse the input (zod, byte caps);
  2. authorise, through `authedRoute`, `workspaceRoute`, `workspaceParamRoute` or `publicRoute`;
  3. call a service;
  4. return `json()`.

  It never reads cookies or headers for auth itself.
- **One place for each concern.**
  - Permissions: `server/auth/permissions.ts`.
  - SQL: `server/repositories/*`, parameterised and scoped by workspace.
  - Configuration: `server/env.ts`.
  - Request and response shapes: `lib/contracts/*`, one file per area, re-exported by
    `@/lib/contracts`.
  - Model access: `AiProvider` and friends, obtained from `getServices()`.
- **Background work** is one entry in `server/jobs/definitions.ts`. The entry says how to run the job,
  what to show while a retry waits, and how to record a final failure. Jobs are idempotent: they can
  be retried or resumed.
- **Schema changes** are a new migration appended to `server/db/migrations.ts`.
- **Components** move into a folder once they need several files: `index.tsx` exports the public
  component, and the other files hold its parts and hooks.
- **Data in the UI.**
  - SWR hooks (`hooks/use-api.ts`) for reading.
  - `useBusyAction` for a request with a progress state and an error toast.
  - `useErrorToast` when only the toast is needed.

## Writing code

- Names use the product's words: workspace, notebook, source, passage, studio.
- Comments explain *why* (a constraint, a trade-off, a security reason), not what the next line does.
  Exported functions that are not self-explanatory get a one-line doc comment.
- Keep logic in small pure functions with unit tests; keep I/O at the edges (repositories, adapters,
  routes).
- Fail closed:
  - validate at the boundary;
  - throw `Errors.*` / `AppError` (`server/http/errors.ts`);
  - unknown errors become a generic 500 with a request id.
- Text from users, documents or chat apps is data. It goes into prompts only through
  `escapeSourceText` and inside our delimiters.
- Delete dead code. Don't leave unused exports behind.

## Tests

- Pure logic: unit tests.
- SQL: against PGlite (`tests/helpers/db.ts` runs the real migrations).
- Routes: through their exported handlers.
- Authorization changes: role-matrix tests.
- Background jobs: call `runJobs(...)` explicitly.
- The suite stays offline and deterministic: fake AI (`tests/helpers/fake-ai.ts`), no network, no
  timers longer than a few milliseconds.
