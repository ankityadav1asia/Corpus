/**
 * Builds the Rust RAG core (backend/rust) to WebAssembly and copies it where the Go backend embeds
 * it (backend/internal/core/corpus_core.wasm).
 *   npm run core:build
 * Needs Rust with the wasm32-unknown-unknown target (`rustup target add wasm32-unknown-unknown`).
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const crate = path.join(process.cwd(), 'backend/rust')
const home = os.homedir()
const cargo = [process.env.CARGO, 'cargo', path.join(home, '.cargo/bin/cargo'), path.join(home, '.cargo/bin/cargo.exe')].find((candidate) => {
  if (!candidate) return false
  return spawnSync(candidate, ['--version'], { stdio: 'ignore' }).status === 0
})
if (!cargo) {
  console.error('Rust is not installed: see https://rustup.rs, then `rustup target add wasm32-unknown-unknown`.')
  process.exit(1)
}

const result = spawnSync(cargo, ['build', '--release', '--target', 'wasm32-unknown-unknown'], { cwd: crate, stdio: 'inherit' })
if (result.status !== 0) process.exit(result.status ?? 1)

const built = path.join(crate, 'target/wasm32-unknown-unknown/release/corpus_core.wasm')
const target = path.join(process.cwd(), 'backend/internal/core/corpus_core.wasm')
if (!existsSync(built)) {
  console.error(`Expected ${built} after the build.`)
  process.exit(1)
}
copyFileSync(built, target)
console.log(`✓ ${path.relative(process.cwd(), target)} (${Math.round(statSync(target).size / 1024)} KB)`)
