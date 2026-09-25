/**
 * Bundles the operational scripts (worker, migrations, secret re-sealing) into dist/scripts, so a
 * production image runs plain JavaScript without tsx. Packages stay external (installed with
 * `npm ci --omit=dev`); the `@/` path aliases are resolved from tsconfig.json.
 *   npm run build:scripts
 *   node --conditions=react-server dist/scripts/worker.cjs
 */
import { build } from 'esbuild'

const ENTRY_POINTS = {
  worker: 'scripts/worker.ts',
  'init-db': 'scripts/init-db.ts',
  'reseal-secrets': 'scripts/reseal-secrets.ts',
}

await build({
  entryPoints: ENTRY_POINTS,
  outdir: 'dist/scripts',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  // CommonJS, as tsx runs these scripts today (package.json has no "type": "module").
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  packages: 'external',
  tsconfig: 'tsconfig.json',
  sourcemap: true,
  logLevel: 'info',
})
