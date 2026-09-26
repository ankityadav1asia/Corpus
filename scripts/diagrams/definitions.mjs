/**
 * The README architecture diagrams. Each card sits on a grid cell (col, row); arrows are drawn
 * between cards, or to a group frame ("group:<id>"). Icons are lucide names (plus vercel, gemini).
 */
import { TONES } from './page.mjs'

const system = {
  name: 'system',
  columns: [220, 230, 230, 230],
  nodes: [
    { id: 'browser', col: 1, row: 1, tone: 'client', icon: 'monitor', title: 'Browser app', lines: ['Next.js, React 19'] },
    { id: 'chat', col: 1, row: 2, tone: 'client', icon: 'slack', title: 'Slack / Teams', lines: ['signed webhooks'] },
    { id: 'public', col: 1, row: 3, tone: 'client', icon: 'share-2', title: 'Shared page', lines: ['/s/:token, read-only'] },
    { id: 'mw', col: 2, row: 1, tone: 'web', icon: 'shield', title: 'Middleware', lines: ['session signature, CSP nonce'] },
    { id: 'routes', col: 2, row: 2, tone: 'web', icon: 'route', title: 'API routes', lines: ['validate, authorise, call a service'] },
    { id: 'jobs', col: 2, row: 3, tone: 'jobs', icon: 'timer', title: 'Background jobs', lines: ['after responses and on Vercel Cron'] },
    { id: 'services', col: 3, row: 1, tone: 'web', icon: 'layers', title: 'Services', lines: ['RAG, ingestion, studio, connectors, sharing'] },
    { id: 'repos', col: 3, row: 2, tone: 'web', icon: 'table', title: 'Repositories', lines: ['parameterised SQL, scoped by workspace'] },
    { id: 'ai', col: 4, row: 1, tone: 'ai', icon: 'gemini', title: 'AI models', lines: ['Gemini, Gemma, OpenAI-compatible', 'chat, embeddings, vision, speech'] },
    { id: 'db', col: 4, row: 2, tone: 'data', icon: 'database', title: 'PostgreSQL + pgvector', lines: ['Neon, us-east-2'] },
    { id: 'ext', col: 4, row: 3, tone: 'external', icon: 'globe', title: 'Sources', lines: ['Google Drive, Notion, GitHub, websites, YouTube'] },
  ],
  groups: [
    { id: 'clients', label: 'Clients', color: TONES.client, members: ['browser', 'chat', 'public'] },
    { id: 'app', label: 'Next.js 15 on Vercel', color: TONES.web, members: ['mw', 'routes', 'jobs', 'services', 'repos'] },
  ],
  edges: [
    { from: 'browser', to: 'mw' },
    { from: 'mw', to: 'routes' },
    { from: 'chat', to: 'routes' },
    { from: 'public', to: 'routes' },
    { from: 'routes', to: 'services', fromSide: 'right', toSide: 'left' },
    { from: 'services', to: 'repos' },
    { from: 'repos', to: 'db' },
    { from: 'services', to: 'ai' },
    { from: 'jobs', to: 'db', label: 'claim jobs' },
    { from: 'jobs', to: 'ext' },
  ],
}

const answering = {
  name: 'answering',
  columns: [215, 215, 215, 215],
  gap: [70, 70],
  nodes: [
    { id: 'q', col: 1, row: 1, tone: 'client', icon: 'message-circle', title: 'Question', lines: ['notebook and mode'] },
    { id: 'check', col: 2, row: 1, tone: 'safe', icon: 'shield-check', title: 'Checks', lines: ['session, workspace role, rate limit'] },
    { id: 'plan', col: 3, row: 1, tone: 'ai', icon: 'brain', title: 'Query planner', lines: ['deep mode: rewrites, step-back, HyDE', 'in parallel, 8 s limit'] },
    {
      id: 'retrieve',
      col: 4,
      row: 1,
      tone: 'data',
      icon: 'search',
      title: 'Hybrid retrieval',
      lines: ['all queries embedded in one batch', 'vectors + full text, fused with RRF'],
    },
    { id: 'rerank', col: 4, row: 2, tone: 'ai', icon: 'list-ordered', title: 'Re-ranker', lines: ['LLM grader or Cohere', 'keeps the top K'] },
    { id: 'guard', col: 3, row: 2, tone: 'safe', icon: 'shield', title: 'Guardrail', lines: ['is the best passage relevant enough?'] },
    { id: 'answer', col: 2, row: 2, tone: 'ai', icon: 'gemini', title: 'Streamed answer', lines: ['sources [1]…[K] first', 'passages marked as data, [n] citations'] },
    { id: 'judge', col: 1, row: 2, tone: 'jobs', icon: 'list-checks', title: 'Answer quality', lines: ['scored later by an LLM judge', 'follow-ups: separate request'] },
    { id: 'refuse', col: 3, row: 3, tone: 'danger', icon: 'ban', title: 'Insufficient context', lines: ['fixed reply, no model call'] },
  ],
  edges: [
    { from: 'q', to: 'check' },
    { from: 'check', to: 'plan' },
    { from: 'plan', to: 'retrieve' },
    { from: 'retrieve', to: 'rerank' },
    { from: 'rerank', to: 'guard' },
    { from: 'guard', to: 'answer', label: 'relevant' },
    { from: 'answer', to: 'judge', label: 'job' },
    { from: 'guard', to: 'refuse', label: 'too weak', color: TONES.danger },
  ],
}

const ingestion = {
  name: 'ingestion',
  columns: [215, 215, 215, 215],
  nodes: [
    { id: 'in', col: 2, row: 1, span: 2, tone: 'client', icon: 'upload', title: 'A new source', lines: ['upload, web page, YouTube, text or an item from a connected app'] },
    { id: 'pdf', col: 1, row: 2, tone: 'external', icon: 'file-text', title: 'PDF or text', lines: ['text extracted at once'] },
    { id: 'scan', col: 2, row: 2, tone: 'external', icon: 'scan-text', title: 'Scanned PDF', lines: ['OCR page by page', 'Tesseract or a vision model'] },
    { id: 'image', col: 3, row: 2, tone: 'external', icon: 'image', title: 'Image', lines: ['vision description + OCR'] },
    { id: 'media', col: 4, row: 2, tone: 'external', icon: 'audio-lines', title: 'Audio or video', lines: ['timestamped transcript'] },
    { id: 'text', col: 2, row: 3, span: 2, tone: 'web', icon: 'notebook-text', title: 'Plain text', lines: ['progress saved per page, so long reads resume'] },
    { id: 'split', col: 1, row: 4, tone: 'web', icon: 'scissors', title: 'Split', lines: ['overlapping passages'] },
    { id: 'embed', col: 2, row: 4, tone: 'ai', icon: 'binary', title: 'Embed in batches', lines: ['3072-dimension vectors, model recorded'] },
    { id: 'store', col: 3, row: 4, tone: 'data', icon: 'database', title: 'Passages', lines: ['text + vector + full-text index'] },
    { id: 'ready', col: 4, row: 4, tone: 'jobs', icon: 'bell', title: 'Ready', lines: ['the person who added it is notified'] },
  ],
  edges: [
    { from: 'in', to: 'pdf', fromSide: 'bottom', toSide: 'top' },
    { from: 'in', to: 'scan', fromSide: 'bottom', toSide: 'top' },
    { from: 'in', to: 'image', fromSide: 'bottom', toSide: 'top' },
    { from: 'in', to: 'media', fromSide: 'bottom', toSide: 'top' },
    { from: 'pdf', to: 'text', fromSide: 'bottom', toSide: 'top' },
    { from: 'scan', to: 'text', fromSide: 'bottom', toSide: 'top' },
    { from: 'image', to: 'text', fromSide: 'bottom', toSide: 'top' },
    { from: 'media', to: 'text', fromSide: 'bottom', toSide: 'top' },
    { from: 'text', to: 'split', fromSide: 'bottom', toSide: 'top' },
    { from: 'split', to: 'embed' },
    { from: 'embed', to: 'store' },
    { from: 'store', to: 'ready' },
  ],
}

const jobs = {
  name: 'jobs',
  columns: [215, 225, 260],
  gap: [90, 22],
  nodes: [
    {
      id: 'queue',
      col: 1,
      row: 3,
      rowSpan: 3,
      tone: 'data',
      icon: 'database',
      title: 'Job queue',
      lines: ['a table in Postgres', 'claimed with FOR UPDATE SKIP LOCKED', 'retries with growing waits'],
    },
    {
      id: 'runner',
      col: 2,
      row: 3,
      rowSpan: 3,
      tone: 'jobs',
      icon: 'timer',
      title: 'Job runner',
      lines: ['after responses, while the UI polls, on Vercel Cron', 'resumes long work across runs'],
    },
    { id: 'j1', col: 3, row: 1, tone: 'web', icon: 'file-text', title: 'Read and index', lines: ['read_media, ingest_document'] },
    { id: 'j2', col: 3, row: 2, tone: 'web', icon: 'presentation', title: 'Reports and mind maps', lines: ['generate_report, generate_mindmap'] },
    { id: 'j3', col: 3, row: 3, tone: 'web', icon: 'volume-2', title: 'Audio and images', lines: ['generate_audio, generate_image'] },
    { id: 'j4', col: 3, row: 4, tone: 'web', icon: 'folder-sync', title: 'Connector sync', lines: ['sync_connector'] },
    { id: 'j5', col: 3, row: 5, tone: 'web', icon: 'bot', title: 'Chat-app answers', lines: ['answer_bot_message'] },
    { id: 'j6', col: 3, row: 6, tone: 'web', icon: 'list-checks', title: 'Evaluation', lines: ['evaluate_answer, run_benchmark'] },
    { id: 'j7', col: 3, row: 7, tone: 'web', icon: 'refresh-cw', title: 'Re-embedding', lines: ['reembed_workspace'] },
  ],
  edges: [{ from: 'queue', to: 'runner' }, ...['j1', 'j2', 'j3', 'j4', 'j5', 'j6', 'j7'].map((to) => ({ from: 'runner', to, fromSide: 'right', toSide: 'left' }))],
}

const studio = {
  name: 'studio',
  columns: [200, 200, 200, 200, 200],
  gap: [64, 36],
  nodes: [
    { id: 'sel', col: 1, row: 2, rowSpan: 2, tone: 'client', icon: 'book-open', title: 'Chosen sources', lines: ['notebooks or documents'] },
    { id: 'notes', col: 2, row: 2, tone: 'ai', icon: 'notebook-text', title: 'Source notes', lines: ['one summary per document'] },
    { id: 'report', col: 3, row: 1, tone: 'web', icon: 'presentation', title: 'Report', lines: ['summary, comparison or slides'] },
    { id: 'map', col: 3, row: 2, tone: 'web', icon: 'network', title: 'Mind map', lines: ['validated topic tree'] },
    { id: 'script', col: 3, row: 3, tone: 'ai', icon: 'mic', title: 'Two-host script' },
    { id: 'voice', col: 4, row: 3, tone: 'ai', icon: 'audio-lines', title: 'Speech', lines: ['segment by segment'] },
    { id: 'mp3', col: 5, row: 3, tone: 'data', icon: 'volume-2', title: 'MP3', lines: ['with a timed transcript'] },
    { id: 'brief', col: 2, row: 4, tone: 'ai', icon: 'search', title: 'Image brief', lines: ['from the most relevant passages'] },
    { id: 'imodel', col: 3, row: 4, tone: 'ai', icon: 'gemini', title: 'Image model' },
    { id: 'image', col: 4, row: 4, tone: 'data', icon: 'image', title: 'Checked image', lines: ['stored in the workspace'] },
  ],
  edges: [
    { from: 'sel', to: 'notes' },
    { from: 'sel', to: 'brief' },
    { from: 'notes', to: 'report' },
    { from: 'notes', to: 'map' },
    { from: 'notes', to: 'script' },
    { from: 'script', to: 'voice' },
    { from: 'voice', to: 'mp3' },
    { from: 'brief', to: 'imodel' },
    { from: 'imodel', to: 'image' },
  ],
}

const connectors = {
  name: 'connectors',
  columns: [215, 230, 230, 215],
  gap: [80, 70],
  nodes: [
    { id: 'sched', col: 1, row: 1, tone: 'jobs', icon: 'calendar-clock', title: 'Schedule', lines: ['sources that are due become jobs'] },
    { id: 'sync', col: 2, row: 1, tone: 'jobs', icon: 'folder-sync', title: 'Sync job', lines: ["the member's current rights", 'resumes from its saved position'] },
    { id: 'api', col: 3, row: 1, tone: 'external', icon: 'globe', title: 'App API', lines: ['Google Drive, Notion, GitHub, websites'] },
    { id: 'lock', col: 4, row: 1, tone: 'safe', icon: 'key-round', title: 'Encrypted tokens', lines: ['never sent to the browser'] },
    { id: 'ingest', col: 3, row: 2, tone: 'web', icon: 'layers', title: 'Ingestion', lines: ['like an upload: OCR or transcription when needed'] },
    { id: 'prune', col: 2, row: 2, tone: 'danger', icon: 'trash-2', title: 'Clean up', lines: ['documents whose item disappeared'] },
    { id: 'notify', col: 1, row: 2, tone: 'client', icon: 'bell', title: 'Notification', lines: ['added, updated, removed, failed'] },
  ],
  edges: [
    { from: 'sched', to: 'sync' },
    { from: 'sync', to: 'api', label: 'list, fetch if changed' },
    { from: 'lock', to: 'api', dashed: true },
    { from: 'api', to: 'ingest', label: 'each changed item' },
    { from: 'sync', to: 'prune' },
    { from: 'prune', to: 'notify' },
  ],
}

const sharing = {
  name: 'sharing',
  columns: [215, 235, 215],
  gap: [80, 110],
  nodes: [
    { id: 'editor', col: 1, row: 1, tone: 'client', icon: 'user', title: 'Editor', lines: ['shares a chat or a report'] },
    { id: 'snap', col: 2, row: 1, tone: 'data', icon: 'link', title: 'Snapshot + token', lines: ['192 random bits, stored hashed and encrypted'] },
    { id: 'anyone', col: 3, row: 1, tone: 'external', icon: 'users', title: 'Anyone with the link', lines: ['/s/:token, noindex'] },
    { id: 'ask', col: 1, row: 2, tone: 'client', icon: 'message-circle', title: 'Mention or DM', lines: ['in Slack or Teams'] },
    { id: 'hook', col: 2, row: 2, tone: 'safe', icon: 'webhook', title: 'Webhook', lines: ['signature or JWT checked', 'acknowledged at once'] },
    { id: 'bot', col: 3, row: 2, tone: 'jobs', icon: 'bot', title: 'answer_bot_message', lines: ['answers from the chosen notebook'] },
  ],
  groups: [
    { id: 'links', label: 'Share links', color: TONES.data, members: ['editor', 'snap', 'anyone'] },
    { id: 'bots', label: 'Slack and Teams', color: TONES.jobs, members: ['ask', 'hook', 'bot'] },
  ],
  edges: [
    { from: 'editor', to: 'snap', label: 'create' },
    { from: 'anyone', to: 'snap', label: 'view' },
    { from: 'ask', to: 'hook' },
    { from: 'hook', to: 'bot', label: 'job' },
    { from: 'bot', to: 'ask', fromSide: 'bottom', toSide: 'bottom', label: 'reply in the thread' },
  ],
}

const access = {
  name: 'access',
  columns: [215, 215, 215, 230],
  gap: [70, 60],
  nodes: [
    { id: 'signin', col: 1, row: 1, tone: 'client', icon: 'key-round', title: 'Sign in', lines: ['Google, GitHub or an email code'] },
    { id: 'session', col: 2, row: 1, tone: 'safe', icon: 'lock', title: 'Session', lines: ['stored server-side', 'signed httpOnly cookie'] },
    { id: 'mw', col: 3, row: 1, tone: 'safe', icon: 'shield', title: 'Middleware', lines: ['signature and expiry'] },
    { id: 'handler', col: 4, row: 1, tone: 'web', icon: 'route', title: 'Handler', lines: ['session not revoked', 'workspace membership'] },
    { id: 'perm', col: 4, row: 2, tone: 'safe', icon: 'users', title: 'Permission table', lines: ['Viewer, Editor, Admin', '+ notebook overrides'] },
    { id: 'sql', col: 3, row: 2, tone: 'data', icon: 'database', title: 'Scoped SQL', lines: ['parameterised, one workspace'] },
    { id: 'deny', col: 4, row: 3, tone: 'danger', icon: 'ban', title: 'Refused', lines: ['403, or 404 for non-members'] },
  ],
  edges: [
    { from: 'signin', to: 'session' },
    { from: 'session', to: 'mw' },
    { from: 'mw', to: 'handler' },
    { from: 'handler', to: 'perm' },
    { from: 'perm', to: 'sql', label: 'allowed' },
    { from: 'perm', to: 'deny', label: 'not allowed', color: TONES.danger },
  ],
}

const dataModel = {
  name: 'data-model',
  columns: [215, 215, 215, 215],
  gap: [70, 50],
  nodes: [
    { id: 'users', col: 1, row: 1, tone: 'client', icon: 'user', title: 'users' },
    { id: 'sessions', col: 1, row: 2, tone: 'safe', icon: 'lock', title: 'sessions' },
    { id: 'members', col: 2, row: 1, tone: 'client', icon: 'users', title: 'workspace_members', lines: ['role per workspace'] },
    { id: 'ws', col: 2, row: 2, tone: 'web', icon: 'boxes', title: 'workspaces', lines: ['settings, personal or team'] },
    { id: 'jobsT', col: 1, row: 3, tone: 'jobs', icon: 'timer', title: 'jobs' },
    { id: 'coll', col: 2, row: 3, tone: 'web', icon: 'book-open', title: 'collections', lines: ['notebooks, role overrides'] },
    { id: 'docs', col: 2, row: 4, tone: 'data', icon: 'file-text', title: 'documents', lines: ['status, progress, source'] },
    { id: 'chunks', col: 2, row: 5, tone: 'data', icon: 'binary', title: 'chunks', lines: ['text, vector(3072), model', 'full-text, labels, metadata'] },
    { id: 'sources', col: 1, row: 4, tone: 'external', icon: 'folder-sync', title: 'connector_sources' },
    { id: 'conv', col: 3, row: 2, tone: 'client', icon: 'message-square', title: 'conversations', lines: ['private to the author'] },
    { id: 'msgs', col: 3, row: 3, tone: 'client', icon: 'message-circle', title: 'messages' },
    { id: 'evals', col: 3, row: 4, tone: 'jobs', icon: 'list-checks', title: 'evaluations' },
    { id: 'shares', col: 3, row: 1, tone: 'data', icon: 'link', title: 'share_links' },
    { id: 'reports', col: 4, row: 2, tone: 'ai', icon: 'presentation', title: 'reports' },
    { id: 'maps', col: 4, row: 3, tone: 'ai', icon: 'network', title: 'mind_maps' },
    { id: 'audio', col: 4, row: 4, tone: 'ai', icon: 'volume-2', title: 'audio_overviews' },
    { id: 'images', col: 4, row: 5, tone: 'ai', icon: 'image', title: 'images' },
  ],
  groups: [{ id: 'studio', label: 'Studio, per workspace', color: TONES.ai, members: ['reports', 'maps', 'audio', 'images'] }],
  edges: [
    { from: 'users', to: 'members' },
    { from: 'users', to: 'sessions' },
    { from: 'ws', to: 'members' },
    { from: 'ws', to: 'coll' },
    { from: 'ws', to: 'jobsT', fromSide: 'left', toSide: 'right' },
    { from: 'ws', to: 'conv' },
    { from: 'conv', to: 'shares', label: 'snapshots' },
    { from: 'coll', to: 'docs' },
    { from: 'docs', to: 'chunks' },
    { from: 'coll', to: 'sources', fromSide: 'left', toSide: 'right' },
    { from: 'conv', to: 'msgs' },
    { from: 'msgs', to: 'evals' },
  ],
}

const deployment = {
  name: 'deployment',
  columns: [190, 190, 215, 230, 215],
  gap: [64, 60],
  nodes: [
    { id: 'push', col: 1, row: 1, tone: 'build', icon: 'git-commit-horizontal', title: 'git push', lines: ['to main'] },
    { id: 'gh', col: 2, row: 1, tone: 'build', icon: 'github', title: 'GitHub' },
    { id: 'build', col: 3, row: 1, tone: 'build', icon: 'vercel', title: 'Vercel build', lines: ['migrations, then next build'] },
    { id: 'fn', col: 4, row: 1, tone: 'build', icon: 'vercel', title: 'Vercel Functions', lines: ['region cle1', 'pages, API, streaming answers, jobs'] },
    { id: 'neon', col: 5, row: 1, tone: 'data', icon: 'database', title: 'Neon Postgres', lines: ['+ pgvector, us-east-2'] },
    { id: 'ci', col: 2, row: 2, tone: 'safe', icon: 'test-tube', title: 'GitHub Actions', lines: ['typecheck, lint, 349 tests, build, audit'] },
    { id: 'cron', col: 4, row: 2, tone: 'jobs', icon: 'calendar-clock', title: 'Vercel Cron', lines: ['/api/jobs/run'] },
    { id: 'ai', col: 5, row: 2, tone: 'ai', icon: 'gemini', title: 'AI models', lines: ['Gemini or OpenAI-compatible'] },
  ],
  edges: [
    { from: 'push', to: 'gh' },
    { from: 'gh', to: 'build' },
    { from: 'gh', to: 'ci' },
    { from: 'build', to: 'fn', label: 'deploy' },
    { from: 'fn', to: 'neon' },
    { from: 'fn', to: 'ai', fromSide: 'right', toSide: 'left' },
    { from: 'cron', to: 'fn' },
  ],
}

export const DIAGRAMS = [system, answering, ingestion, jobs, studio, connectors, sharing, access, dataModel, deployment]
