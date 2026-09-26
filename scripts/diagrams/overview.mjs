/**
 * The architecture overview: one layered picture of the whole system (clients, the app on Vercel,
 * data / AI / sources), rather than a flow chart.
 */
import { TONES, escapeHtml, icon } from './page.mjs'

const tile = ({ tone, glyph, title, text }) => `<div class="tile" style="--tone:${TONES[tone]}">
  <div class="glyph">${icon(glyph)}</div>
  <div><div class="t">${escapeHtml(title)}</div>${text ? `<div class="d">${escapeHtml(text)}</div>` : ''}</div>
</div>`

const chip = (text) => `<span class="chip">${escapeHtml(text)}</span>`

const band = ({ tone, glyph, label, body }) => `<section class="band" style="--tone:${TONES[tone]}">
  <div class="band-label"><div class="band-glyph">${icon(glyph)}</div>${escapeHtml(label)}</div>
  <div class="band-body">${body}</div>
</section>`

const link = (text) => `<div class="link"><div class="pipe"></div>${chip(text)}<div class="pipe"></div></div>`

const panel = ({ tone, glyph, title, items }) => `<div class="panel" style="--tone:${TONES[tone]}">
  <div class="panel-head"><div class="glyph">${icon(glyph)}</div>${escapeHtml(title)}</div>
  ${items.map(tile).join('')}
</div>`

const CLIENTS = [
  { tone: 'client', glyph: 'monitor', title: 'Browser app', text: 'chat, sources, studio, settings' },
  { tone: 'client', glyph: 'slack', title: 'Slack', text: 'mentions and direct messages' },
  { tone: 'client', glyph: 'message-square', title: 'Microsoft Teams', text: 'bot conversations' },
  { tone: 'client', glyph: 'share-2', title: 'Shared links', text: 'read-only answers and reports' },
]

const SERVICES = [
  { tone: 'web', glyph: 'search', title: 'RAG pipeline', text: 'grounded answers with citations' },
  { tone: 'web', glyph: 'file-text', title: 'Ingestion', text: 'files, scans, audio, video, web' },
  { tone: 'web', glyph: 'presentation', title: 'Studio', text: 'reports, mind maps, audio, images' },
  { tone: 'web', glyph: 'folder-sync', title: 'Connectors', text: 'Drive, Notion, GitHub, websites' },
  { tone: 'web', glyph: 'bot', title: 'Sharing and bots', text: 'share links, Slack and Teams' },
]

const vercel = `
  <div class="row">
    ${tile({ tone: 'safe', glyph: 'shield', title: 'Edge middleware', text: 'session signature, CSP nonce, sign-in redirect' })}
    ${tile({ tone: 'web', glyph: 'layout-dashboard', title: 'Pages', text: 'Next.js 15 App Router, React 19' })}
    ${tile({ tone: 'web', glyph: 'route', title: 'API routes', text: 'zod validation, roles, rate limits' })}
  </div>
  <div class="sub">Services</div>
  <div class="row five">${SERVICES.map(tile).join('')}</div>
  <div class="pipeline">${['Plan the query', 'Hybrid search', 'Re-rank', 'Guardrail', 'Stream the answer'].map(chip).join('<span class="arrow">→</span>')}</div>
  <div class="sub">Background work</div>
  <div class="row">
    ${tile({ tone: 'jobs', glyph: 'timer', title: 'Job runner', text: 'after each response and while the UI waits' })}
    ${tile({ tone: 'jobs', glyph: 'calendar-clock', title: 'Vercel Cron', text: '/api/jobs/run, daily' })}
    ${tile({ tone: 'jobs', glyph: 'refresh-cw', title: 'Resumable jobs', text: 'indexing, OCR, audio, syncs, evaluation' })}
  </div>`

const foundation = `<div class="panels">
  ${panel({
    tone: 'data',
    glyph: 'database',
    title: 'Data',
    items: [
      { tone: 'data', glyph: 'database', title: 'Neon PostgreSQL', text: 'workspaces, documents, jobs, sessions' },
      { tone: 'data', glyph: 'binary', title: 'pgvector', text: '3072-dimension vectors + full-text search' },
    ],
  })}
  ${panel({
    tone: 'ai',
    glyph: 'gemini',
    title: 'AI models',
    items: [
      { tone: 'ai', glyph: 'gemini', title: 'Gemini or Gemma', text: 'chat, embeddings, vision, speech, images' },
      { tone: 'ai', glyph: 'cpu', title: 'OpenAI-compatible', text: 'Ollama, vLLM, Groq; Tesseract OCR' },
    ],
  })}
  ${panel({
    tone: 'external',
    glyph: 'globe',
    title: 'Sources',
    items: [
      { tone: 'external', glyph: 'hard-drive', title: 'Google Drive, Notion', text: 'synced on a schedule' },
      { tone: 'external', glyph: 'github', title: 'GitHub, websites, YouTube', text: 'fetched through an SSRF-safe client' },
    ],
  })}
</div>`

const STYLE = `
  * { box-sizing: border-box; margin: 0; }
  html, body { background: transparent; }
  body { font-family: 'Segoe UI', 'Inter', system-ui, sans-serif; -webkit-font-smoothing: antialiased; color: #0f172a; }
  #canvas { display: inline-block; width: 1360px; padding: 44px 48px 48px; border-radius: 28px; border: 1px solid #e2e8f0;
    background: radial-gradient(circle at 1px 1px, #e2e8f0 1px, transparent 0) 0 0 / 22px 22px, linear-gradient(160deg, #ffffff, #eef2f7); }
  header { display: flex; align-items: baseline; gap: 16px; margin-bottom: 26px; }
  h1 { font-size: 26px; font-weight: 800; letter-spacing: -.02em; }
  header p { font-size: 14px; color: #64748b; }
  .band { display: grid; grid-template-columns: 150px 1fr; gap: 20px; padding: 20px; border-radius: 22px;
    background: color-mix(in srgb, var(--tone) 7%, #fff); border: 1.5px solid color-mix(in srgb, var(--tone) 30%, transparent); }
  .band-label { display: flex; flex-direction: column; justify-content: center; gap: 10px; font-size: 13px; font-weight: 800;
    letter-spacing: .08em; text-transform: uppercase; color: var(--tone); }
  .band-glyph { width: 52px; height: 52px; border-radius: 15px; display: grid; place-items: center; color: #fff;
    background: linear-gradient(145deg, var(--tone), color-mix(in srgb, var(--tone) 65%, #000)); box-shadow: 0 10px 24px -10px var(--tone); }
  .band-glyph svg { width: 28px; height: 28px; }
  .band-body { display: flex; flex-direction: column; gap: 12px; }
  .row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .row.four { grid-template-columns: repeat(4, 1fr); }
  .row.five { grid-template-columns: repeat(5, 1fr); }
  .sub { font-size: 11.5px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #64748b; margin-top: 4px; }
  .tile { display: flex; gap: 12px; align-items: flex-start; padding: 13px; background: #fff; border-radius: 14px; border: 1px solid #e2e8f0;
    box-shadow: 0 1px 2px rgba(15,23,42,.05), 0 8px 20px -14px rgba(15,23,42,.35); }
  .glyph { flex: none; width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; color: #fff;
    background: linear-gradient(145deg, var(--tone), color-mix(in srgb, var(--tone) 68%, #000)); }
  .glyph svg { width: 22px; height: 22px; }
  .t { font-size: 14.5px; font-weight: 700; line-height: 1.25; }
  .d { font-size: 12.5px; color: #475569; line-height: 1.4; margin-top: 3px; }
  .pipeline { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 10px; border-radius: 14px;
    background: #fff; border: 1px dashed color-mix(in srgb, var(--tone) 45%, transparent); }
  .arrow { color: var(--tone); font-weight: 800; }
  .chip { display: inline-block; padding: 5px 12px; border-radius: 999px; font-size: 12.5px; font-weight: 600; color: #334155;
    background: #fff; border: 1px solid #cbd5e1; white-space: nowrap; }
  .link { display: flex; flex-direction: column; align-items: center; margin: 2px 0; }
  .pipe { width: 2px; height: 14px; background: #94a3b8; }
  .panels { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
  .panel { display: flex; flex-direction: column; gap: 10px; padding: 14px; border-radius: 18px; background: color-mix(in srgb, var(--tone) 6%, #fff);
    border: 1px solid color-mix(in srgb, var(--tone) 28%, transparent); }
  .panel-head { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 13px; letter-spacing: .06em; text-transform: uppercase; color: var(--tone); }
  .panel-head .glyph { width: 30px; height: 30px; border-radius: 9px; }
  .panel-head .glyph svg { width: 17px; height: 17px; }
`

export function overviewHtml() {
  const body = [
    band({ tone: 'client', glyph: 'users', label: 'Clients', body: `<div class="row four">${CLIENTS.map(tile).join('')}</div>` }),
    link('HTTPS · session cookie · signed webhooks'),
    band({ tone: 'build', glyph: 'vercel', label: 'Vercel · cle1', body: vercel }),
    link('parameterised SQL · model APIs · SSRF-safe fetches'),
    band({ tone: 'data', glyph: 'layers', label: 'Data, AI and sources', body: foundation }),
  ].join('\n')
  return `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body>
<div id="canvas">
  <header><h1>Corpus architecture</h1><p>Next.js 15 on Vercel · Neon PostgreSQL + pgvector · Gemini or open-source models</p></header>
  ${body}
</div>
<script>document.fonts.ready.then(() => { window.__ready = true })</script>
</body></html>`
}
