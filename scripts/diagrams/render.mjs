/**
 * Renders the README architecture diagrams (scripts/diagrams/definitions.mjs) to PNG images in
 * docs/images/diagrams, with a headless Chromium browser (Edge or Chrome) driven over DevTools.
 *   npm run diagrams              every diagram
 *   npm run diagrams -- system    only the named ones
 * Set BROWSER to the browser's path when it is not in a usual place.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { DIAGRAMS } from './definitions.mjs'
import { pageHtml } from './page.mjs'

const OUT = path.join(process.cwd(), 'docs/images/diagrams')
const PORT = 9337
const CANDIDATES = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/microsoft-edge',
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function connect(profile) {
  const browser = CANDIDATES.find((candidate) => candidate && existsSync(candidate))
  if (!browser) throw new Error('No Chrome or Edge found: set BROWSER to its path.')
  const child = spawn(
    browser,
    ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--allow-file-access-from-files', 'about:blank'],
    {
      stdio: 'ignore',
    },
  )
  let url
  for (let i = 0; i < 100 && !url; i++) {
    try {
      url = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((target) => target.type === 'page')?.webSocketDebuggerUrl
    } catch {
      // not listening yet
    }
    if (!url) await sleep(200)
  }
  const ws = new WebSocket(url)
  await new Promise((resolve) => (ws.onopen = resolve))
  let id = 0
  const waiting = new Map()
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    waiting.get(message.id)?.(message.result)
  }
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      waiting.set(++id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const close = () => {
    ws.close()
    child.kill()
  }
  return { send, close }
}

async function render(send, diagram, dir) {
  const file = path.join(dir, `${diagram.name}.html`)
  writeFileSync(file, diagram.html ? diagram.html() : pageHtml(diagram))
  await send('Page.navigate', { url: pathToFileURL(file).href })
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true }))?.result?.value
  for (let i = 0; i < 100 && !(await evaluate('window.__ready === true')); i++) await sleep(100)
  const clip = await evaluate(
    `(() => { const r = document.getElementById('canvas').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height, scale: 1 } })()`,
  )
  const { data } = await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true })
  writeFileSync(path.join(OUT, `${diagram.name}.png`), Buffer.from(data, 'base64'))
  console.log(`✓ docs/images/diagrams/${diagram.name}.png (${Math.round(clip.width)}×${Math.round(clip.height)})`)
}

async function main() {
  const only = process.argv.slice(2)
  const diagrams = only.length ? DIAGRAMS.filter((diagram) => only.includes(diagram.name)) : DIAGRAMS
  mkdirSync(OUT, { recursive: true })
  const dir = mkdtempSync(path.join(os.tmpdir(), 'corpus-diagrams-'))
  const { send, close } = await connect(path.join(dir, 'profile'))
  try {
    await send('Page.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 1800, height: 1400, deviceScaleFactor: 2, mobile: false })
    await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
    for (const diagram of diagrams) await render(send, diagram, dir)
  } finally {
    close()
    await sleep(300)
    rmSync(dir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
