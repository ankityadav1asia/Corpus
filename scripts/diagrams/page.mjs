/**
 * Builds the HTML page for one diagram: cards on a CSS grid, then (in the page) group frames and
 * curved arrows measured from the laid-out cards.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

const LUCIDE = path.join(process.cwd(), 'node_modules/lucide-react/dist/esm/icons')

/** Marks that lucide does not have. */
const CUSTOM_ICONS = {
  vercel: '<path d="M12 3 22.5 20.5h-21z" fill="currentColor" stroke="none"/>',
  gemini: '<path d="M12 2c.6 5.3 4.7 9.4 10 10-5.3.6-9.4 4.7-10 10-.6-5.3-4.7-9.4-10-10 5.3-.6 9.4-4.7 10-10z" fill="currentColor" stroke="none"/>',
}

export const TONES = {
  client: '#2563eb',
  web: '#7c3aed',
  data: '#059669',
  ai: '#d97706',
  external: '#475569',
  jobs: '#db2777',
  safe: '#0d9488',
  danger: '#dc2626',
  build: '#0f172a',
}

export const escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A lucide icon as inline SVG, read from the installed lucide-react package. */
export function icon(name) {
  const custom = CUSTOM_ICONS[name]
  const body =
    custom ??
    [...readFileSync(path.join(LUCIDE, `${name}.js`), 'utf8').matchAll(/\[\s*"(\w+)",\s*\{([^}]*)\}\s*\]/g)]
      .map(([, tag, attrs]) => {
        const pairs = [...attrs.matchAll(/(\w+): "([^"]*)"/g)].filter(([, key]) => key !== 'key').map(([, key, value]) => `${key}="${value}"`)
        return `<${tag} ${pairs.join(' ')}/>`
      })
      .join('')
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
}

function nodeHtml(node) {
  const place = `grid-column:${node.col} / span ${node.span ?? 1};grid-row:${node.row} / span ${node.rowSpan ?? 1}`
  const lines = (node.lines ?? []).map((line) => `<div class="line">${escapeHtml(line)}</div>`).join('')
  return `<div class="node" id="n-${node.id}" style="${place};--tone:${TONES[node.tone]}">
    <div class="badge">${icon(node.icon)}</div>
    <div class="text"><div class="title">${escapeHtml(node.title)}</div>${lines}</div>
  </div>`
}

const STYLE = `
  * { box-sizing: border-box; margin: 0; }
  html, body { background: transparent; }
  body { font-family: 'Segoe UI', 'Inter', system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  #canvas { position: relative; display: inline-block; padding: 64px 56px 56px; border-radius: 28px;
    background: radial-gradient(circle at 1px 1px, #e2e8f0 1px, transparent 0) 0 0 / 22px 22px, linear-gradient(160deg, #ffffff, #f1f5f9); border: 1px solid #e2e8f0; }
  .grid { position: relative; z-index: 2; display: grid; align-items: center; }
  .node { display: flex; gap: 12px; align-items: flex-start; padding: 14px 14px 14px 12px; background: #fff; border: 1px solid #e2e8f0;
    border-top: 3px solid var(--tone); border-radius: 14px; box-shadow: 0 1px 2px rgba(15,23,42,.06), 0 8px 24px -12px rgba(15,23,42,.25); }
  .badge { flex: none; width: 38px; height: 38px; border-radius: 11px; display: grid; place-items: center; color: #fff;
    background: linear-gradient(145deg, var(--tone), color-mix(in srgb, var(--tone) 70%, #000)); }
  .badge svg { width: 21px; height: 21px; }
  .title { font-size: 15px; font-weight: 700; color: #0f172a; line-height: 1.25; }
  .line { font-size: 12.5px; color: #475569; line-height: 1.4; margin-top: 3px; }
  .group { position: absolute; z-index: 0; border-radius: 20px; border: 1.5px dashed color-mix(in srgb, var(--tone) 45%, transparent);
    background: color-mix(in srgb, var(--tone) 6%, transparent); }
  .group span { position: absolute; top: 9px; left: 16px; font-size: 11.5px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--tone); }
  #wires, #labels { position: absolute; inset: 0; z-index: 1; overflow: visible; width: 100%; height: 100%; }
  #labels { z-index: 3; pointer-events: none; }
  .label { font-size: 11.5px; font-weight: 600; fill: #334155; }
`

/** Runs in the page once the grid is laid out: frames the groups and draws the arrows. */
const LAYOUT_SCRIPT = `
const canvas = document.getElementById('canvas')
const svg = document.getElementById('wires')
const base = canvas.getBoundingClientRect()
const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height } }
const boxes = {}
for (const el of document.querySelectorAll('.node')) boxes[el.id.slice(2)] = box(el)
for (const group of DATA.groups) {
  const members = group.members.map((id) => boxes[id])
  const x = Math.min(...members.map((b) => b.x)) - 18, y = Math.min(...members.map((b) => b.y)) - 40
  const right = Math.max(...members.map((b) => b.x + b.w)) + 18, bottom = Math.max(...members.map((b) => b.y + b.h)) + 18
  const el = document.createElement('div')
  el.className = 'group'
  el.style.cssText = 'left:' + x + 'px;top:' + y + 'px;width:' + (right - x) + 'px;height:' + (bottom - y) + 'px;--tone:' + group.color
  el.innerHTML = '<span>' + group.label + '</span>'
  canvas.appendChild(el)
  boxes['group:' + group.id] = { x, y, w: right - x, h: bottom - y }
}
const NORMAL = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] }
const anchor = (b, side) => side === 'left' ? [b.x, b.y + b.h / 2] : side === 'right' ? [b.x + b.w, b.y + b.h / 2] : side === 'top' ? [b.x + b.w / 2, b.y] : [b.x + b.w / 2, b.y + b.h]
function sides(a, b) {
  if (b.x > a.x + a.w + 8) return ['right', 'left']
  if (b.x + b.w < a.x - 8) return ['left', 'right']
  return b.y > a.y ? ['bottom', 'top'] : ['top', 'bottom']
}
const ns = 'http://www.w3.org/2000/svg'
const add = (tag, attrs, parent = svg) => { const el = document.createElementNS(ns, tag); for (const k in attrs) el.setAttribute(k, attrs[k]); parent.appendChild(el); return el }
const labels = document.getElementById('labels')
const defs = add('defs', {})
const marker = add('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 8.5, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs)
add('path', { d: 'M0 0L10 5L0 10z', fill: '#64748b' }, marker)
for (const edge of DATA.edges) {
  const a = boxes[edge.from], b = boxes[edge.to]
  const [sa, sb] = sides(a, b)
  const fromSide = edge.fromSide || sa, toSide = edge.toSide || sb
  const p0 = anchor(a, fromSide), p3 = anchor(b, toSide)
  const vertical = NORMAL[fromSide][0] === 0 && NORMAL[toSide][0] === 0
  const horizontal = NORMAL[fromSide][1] === 0 && NORMAL[toSide][1] === 0
  const k = vertical ? Math.max(28, Math.abs(p3[1] - p0[1]) * 0.5) : horizontal ? Math.max(28, Math.abs(p3[0] - p0[0]) * 0.5) : Math.max(36, Math.hypot(p3[0] - p0[0], p3[1] - p0[1]) * 0.38)
  const p1 = [p0[0] + NORMAL[fromSide][0] * k, p0[1] + NORMAL[fromSide][1] * k]
  const p2 = [p3[0] + NORMAL[toSide][0] * k, p3[1] + NORMAL[toSide][1] * k]
  const end = [p3[0] + NORMAL[toSide][0] * 3, p3[1] + NORMAL[toSide][1] * 3]
  add('path', { d: 'M' + p0 + 'C' + p1 + ' ' + p2 + ' ' + end, fill: 'none', stroke: edge.color || '#94a3b8', 'stroke-width': 2, 'stroke-dasharray': edge.dashed ? '6 5' : 'none', 'marker-end': 'url(#arrow)' })
  if (edge.label) {
    const t = edge.at ?? 0.5, u = 1 - t
    const x = u*u*u*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t*t*t*end[0]
    const y = u*u*u*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t*t*t*end[1]
    const g = add('g', {}, labels)
    const text = add('text', { x, y: y + 4, 'text-anchor': 'middle', class: 'label' }, g)
    text.textContent = edge.label
    const w = text.getBBox().width + 16
    const pill = add('rect', { x: x - w / 2, y: y - 11, width: w, height: 22, rx: 11, fill: '#fff', stroke: '#cbd5e1' })
    g.insertBefore(pill, text)
  }
}
window.__ready = true
`

export function pageHtml(diagram) {
  const columns = diagram.columns.map((width) => `${width}px`).join(' ')
  const data = { groups: diagram.groups ?? [], edges: diagram.edges }
  return `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body>
<div id="canvas"><svg id="wires"></svg><svg id="labels"></svg>
  <div class="grid" style="grid-template-columns:${columns};column-gap:${diagram.gap?.[0] ?? 72}px;row-gap:${diagram.gap?.[1] ?? 60}px">
    ${diagram.nodes.map(nodeHtml).join('\n')}
  </div>
</div>
<script>const DATA = ${JSON.stringify(data)};
document.fonts.ready.then(() => { ${LAYOUT_SCRIPT} })</script>
</body></html>`
}
