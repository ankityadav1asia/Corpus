/**
 * Builds the Rust RAG core (core/) to WebAssembly: core/dist/corpus_core.wasm, which the server
 * loads (server/core). The module is committed, so the app runs and deploys without Rust.
 *   npm run core:build            build and replace core/dist/corpus_core.wasm
 *   npm run core:build -- --check  build and fail if the committed module differs (CI)
 * Needs Rust (https://rustup.rs); core/rust-toolchain.toml pins the version and the target. Paths
 * are remapped, so the same toolchain builds the same bytes on any machine.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const check = process.argv.includes('--check')
const crate = path.join(process.cwd(), 'core')
const home = os.homedir()
const cargo = [process.env.CARGO, 'cargo', path.join(home, '.cargo/bin/cargo'), path.join(home, '.cargo/bin/cargo.exe')].find(
  (candidate) => candidate && spawnSync(candidate, ['--version'], { cwd: crate, stdio: 'ignore' }).status === 0,
)
if (!cargo) {
  console.error('Rust is not installed: see https://rustup.rs (core/rust-toolchain.toml selects the version).')
  process.exit(1)
}

// rustc applies the last matching remap, so the crate (inside home) comes last.
const env = { ...process.env, RUSTFLAGS: `--remap-path-prefix=${home}=/home --remap-path-prefix=${crate}=/corpus-core` }
const locked = existsSync(path.join(crate, 'Cargo.lock')) ? ['--locked'] : []
const result = spawnSync(cargo, ['build', '--release', ...locked, '--target', 'wasm32-unknown-unknown'], { cwd: crate, stdio: 'inherit', env })
if (result.status !== 0) process.exit(result.status ?? 1)

const built = path.join(crate, 'target/wasm32-unknown-unknown/release/corpus_core.wasm')
const committed = path.join(crate, 'dist/corpus_core.wasm')
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
if (check) {
  if (!existsSync(committed) || sha(built) !== sha(committed)) {
    console.error(`core/dist/corpus_core.wasm is out of date (built ${sha(built).slice(0, 12)}). Run \`npm run core:build\` and commit it.`)
    process.exit(1)
  }
  console.log(`✓ core/dist/corpus_core.wasm matches the source (${sha(built).slice(0, 12)})`)
} else {
  mkdirSync(path.dirname(committed), { recursive: true })
  copyFileSync(built, committed)
  console.log(`✓ core/dist/corpus_core.wasm (${Math.round(readFileSync(committed).length / 1024)} KB, ${sha(committed).slice(0, 12)})`)
}
