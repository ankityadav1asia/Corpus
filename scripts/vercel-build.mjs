/**
 * Vercel's build command (vercel.json → buildCommand, `npm run vercel-build`).
 *
 * Production deployments first apply pending database migrations (idempotent and locked, like
 * Render's pre-deploy step), so new code never runs against an older schema. Migrations are
 * additive: the deployment still serving traffic keeps working on the newer schema. A failed
 * migration fails the build, and nothing is deployed.
 *
 * Preview deployments only build: they never change the database. Set SKIP_MIGRATIONS=1 on the
 * project to migrate by hand instead (`npm run db:migrate`).
 */
import { spawnSync } from 'node:child_process'

function run(script) {
  const result = spawnSync('npm', ['run', script], { stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const environment = process.env.VERCEL_ENV ?? 'local'
if (environment === 'production' && process.env.SKIP_MIGRATIONS !== '1') run('db:migrate')
else console.log(`Not migrating the database (VERCEL_ENV=${environment}${process.env.SKIP_MIGRATIONS === '1' ? ', SKIP_MIGRATIONS=1' : ''}).`)
run('build')
