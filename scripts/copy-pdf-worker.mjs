/**
 * The in-app PDF viewer runs pdf.js. Bundling pdf.js with webpack breaks it at runtime, so the
 * library and its worker are copied to public/ from the installed pdfjs-dist (same version for
 * both) and loaded as plain modules. Runs after install and before dev/build.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'

for (const file of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
  const source = path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'build', file)
  const target = path.join(process.cwd(), 'public', file)
  if (!existsSync(source)) {
    console.warn(`pdfjs-dist/build/${file} is missing; the PDF viewer will be unavailable.`)
    continue
  }
  if (!existsSync(target) || statSync(target).size !== statSync(source).size || statSync(target).mtimeMs < statSync(source).mtimeMs) {
    mkdirSync(path.dirname(target), { recursive: true })
    copyFileSync(source, target)
  }
}
