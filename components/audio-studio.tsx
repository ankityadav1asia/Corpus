'use client'

import { AlertTriangle, Download, FastForward, Headphones, Loader2, MessagesSquare, Pause, Play, RotateCcw, Rewind, Scale, Sparkles, Trash2, Zap } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'

import { SourcePicker, hasSelection, type SourceSelection } from '@/components/studio/source-picker'
import { Button } from '@/components/ui/button'
import { EmptyState, Skeleton } from '@/components/ui/feedback-primitives'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import { useWorkspaceContext } from '@/components/workspace-provider'
import { useAudioOverview, useAudioOverviews } from '@/hooks/use-api'
import { apiJson, errorMessage } from '@/lib/api-client'
import { AUDIO_LANGUAGES, STUDIO_LIMITS, type AudioFormat, type AudioLanguage, type AudioLength } from '@/lib/constants'
import type { AudioDetail, AudioSummary, Collection, SessionUser } from '@/lib/contracts'
import { formatBytes, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { canManageOwned } from '@/lib/roles'

const FORMATS: Array<{ id: AudioFormat; label: string; description: string; icon: typeof Headphones }> = [
  { id: 'deep_dive', label: 'Deep dive', description: 'A lively conversation that unpacks and connects the ideas', icon: Headphones },
  { id: 'brief', label: 'Brief', description: 'The essential points in a few minutes', icon: Zap },
  { id: 'critique', label: 'Critique', description: 'Strengths, gaps and questions a reviewer would ask', icon: Scale },
  { id: 'debate', label: 'Debate', description: 'Two hosts argue different positions from the sources', icon: MessagesSquare },
]
const FORMAT_LABEL = Object.fromEntries(FORMATS.map((format) => [format.id, format.label])) as Record<AudioFormat, string>

const LENGTHS: Array<{ id: AudioLength; label: string; hint: string }> = [
  { id: 'short', label: 'Short', hint: '~3 min' },
  { id: 'default', label: 'Default', hint: '~6 min' },
  { id: 'long', label: 'Long', hint: '~11 min' },
]

const RATES = [1, 1.25, 1.5, 2]

function clock(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds)) return '0:00'
  const total = Math.floor(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** Animated bars shown while an overview is being written or recorded. */
function Equalizer({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn('flex h-5 items-end gap-0.5', className)}>
      {[0, 0.2, 0.4, 0.1, 0.3].map((delay) => (
        <span key={delay} className="h-full w-1 origin-bottom animate-eq rounded-full bg-brand-gradient" style={{ animationDelay: `${delay}s` }} />
      ))}
    </span>
  )
}

function AudioPlayer({ overview, onOpenSource }: { overview: AudioDetail; onOpenSource: (documentId: string) => void }) {
  const audio = useRef<HTMLAudioElement>(null)
  const transcriptRef = useRef<HTMLOListElement>(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(overview.durationSeconds ?? 0)
  const [rate, setRate] = useState(1)
  const src = `/api/audio/${overview.id}/file`
  const active = overview.transcript.findIndex((line) => current >= line.start && current < line.end)

  useEffect(() => {
    if (active < 0) return
    transcriptRef.current?.querySelector(`[data-line="${active}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [active])

  function seek(seconds: number) {
    const element = audio.current
    if (!element) return
    element.currentTime = Math.max(0, Math.min(seconds, duration || element.duration || 0))
    setCurrent(element.currentTime)
  }

  function toggle() {
    const element = audio.current
    if (!element) return
    if (element.paused) void element.play()
    else element.pause()
  }

  function cycleRate() {
    const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length]!
    setRate(next)
    if (audio.current) audio.current.playbackRate = next
  }

  return (
    <div className="space-y-4">
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => Number.isFinite(event.currentTarget.duration) && setDuration(event.currentTarget.duration)}
      />
      <div className="rounded-2xl border border-primary/25 bg-brand-soft p-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-label="Back 15 seconds"
            onClick={() => seek(current - 15)}
            className="rounded-full p-2 text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
          >
            <Rewind className="size-4" />
          </button>
          <button
            type="button"
            aria-label={playing ? 'Pause' : 'Play'}
            onClick={toggle}
            className="flex size-12 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-white shadow-lg transition-transform hover:scale-105 active:scale-95"
          >
            {playing ? <Pause className="size-5" /> : <Play className="ml-0.5 size-5" />}
          </button>
          <button
            type="button"
            aria-label="Forward 15 seconds"
            onClick={() => seek(current + 15)}
            className="rounded-full p-2 text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
          >
            <FastForward className="size-4" />
          </button>
          <div className="min-w-0 flex-1">
            <input
              type="range"
              aria-label="Position"
              min={0}
              max={Math.max(duration, 0.1)}
              step={0.1}
              value={Math.min(current, duration || 0)}
              onChange={(event) => seek(Number(event.target.value))}
              className="h-1.5 w-full cursor-pointer accent-[hsl(var(--primary))]"
            />
            <div className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground">
              <span>{clock(current)}</span>
              <span>{clock(duration)}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={cycleRate}
            className="rounded-lg border border-border/60 bg-card/70 px-2 py-1 font-mono text-[11px] font-semibold"
            aria-label="Playback speed"
          >
            {rate}×
          </button>
          <a
            href={`${src}?download=1`}
            aria-label="Download MP3"
            title={overview.byteSize ? `Download MP3 (${formatBytes(overview.byteSize)})` : 'Download MP3'}
            className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
          >
            <Download className="size-4" />
          </a>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_240px]">
        <section>
          <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Transcript</h4>
          <ol ref={transcriptRef} className="max-h-80 space-y-1 overflow-y-auto pr-1">
            {overview.transcript.map((line, index) => (
              <li key={index} data-line={index}>
                <button
                  type="button"
                  onClick={() => seek(line.start + 0.01)}
                  className={cn(
                    'flex w-full gap-3 rounded-xl px-3 py-2 text-left text-xs leading-relaxed transition-colors',
                    index === active ? 'bg-primary/10 text-foreground' : 'text-foreground/80 hover:bg-secondary/60',
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 h-fit shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold',
                      line.speaker === 0 ? 'bg-primary/15 text-primary' : 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
                    )}
                  >
                    Host {line.speaker + 1}
                  </span>
                  <span>{line.text}</span>
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">{clock(line.start)}</span>
                </button>
              </li>
            ))}
          </ol>
        </section>
        <aside className="space-y-2">
          <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Based on</h4>
          <ul className="space-y-1">
            {overview.sources.map((source) => (
              <li key={source.documentId}>
                <button
                  type="button"
                  onClick={() => onOpenSource(source.documentId)}
                  className="w-full truncate rounded-lg px-2 py-1 text-left text-xs text-primary hover:bg-primary/10"
                  title={source.source}
                >
                  {source.title}
                </button>
              </li>
            ))}
          </ul>
          <p className="pt-2 text-[10px] text-muted-foreground">
            {[overview.model, overview.voices.length ? `voices ${overview.voices.join(' & ')}` : null, overview.createdByEmail ? `by ${overview.createdByEmail}` : null]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </aside>
      </div>
    </div>
  )
}

function OverviewCard({ overview, selected, onSelect }: { overview: AudioSummary; selected: boolean; onSelect: () => void }) {
  const running = overview.status === 'queued' || overview.status === 'running'
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'group flex w-full animate-fade-up items-center gap-3 rounded-2xl border p-3 text-left transition-all',
        selected ? 'border-primary/60 bg-primary/5 shadow-sm' : 'border-border/60 bg-card/60 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md',
      )}
    >
      <div
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-xl',
          overview.status === 'failed' ? 'bg-destructive/10' : running ? 'bg-brand-soft' : 'bg-brand-gradient shadow-md',
        )}
      >
        {overview.status === 'failed' ? <AlertTriangle className="size-4 text-destructive" /> : running ? <Equalizer /> : <Headphones className="size-4 text-white" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{overview.title}</p>
        <p className="truncate text-[11px] text-muted-foreground">
          {running
            ? (overview.progress ?? 'Queued')
            : overview.status === 'failed'
              ? 'Could not be created'
              : `${FORMAT_LABEL[overview.format]} · ${overview.language} · ${clock(overview.durationSeconds)} · ${timeAgo(overview.createdAt)}`}
        </p>
      </div>
    </button>
  )
}

interface AudioStudioProps {
  collections: Collection[]
  user: SessionUser
  audioEnabled: boolean
  focusId: string | null
  onFocusConsumed: () => void
  onOpenSource: (documentId: string) => void
}

export function AudioStudio({ collections, user, audioEnabled, focusId, onFocusConsumed, onOpenSource }: AudioStudioProps) {
  const { toast } = useToast()
  const { role } = useWorkspaceContext()
  const list = useAudioOverviews()
  const overviews = useMemo(() => list.data?.overviews ?? [], [list.data])
  const [openId, setOpenId] = useState<string | null>(null)
  const detail = useAudioOverview(openId)
  const [format, setFormat] = useState<AudioFormat>('deep_dive')
  const [length, setLength] = useState<AudioLength>('default')
  const [language, setLanguage] = useState<AudioLanguage>('English')
  const [focus, setFocus] = useState('')
  const [selection, setSelection] = useState<SourceSelection>({ collectionIds: collections[0] ? [collections[0].id] : [], documentIds: [] })
  const [busy, setBusy] = useState(false)

  // Default to the first notebook once the notebooks have loaded (only once: the member may clear it).
  const initialized = useRef(false)
  useEffect(() => {
    if (initialized.current || !collections[0]) return
    initialized.current = true
    setSelection((current) => (hasSelection(current) ? current : { collectionIds: [collections[0]!.id], documentIds: [] }))
  }, [collections])

  useEffect(() => {
    if (!focusId) return
    setOpenId(focusId)
    onFocusConsumed()
  }, [focusId, onFocusConsumed])

  useEffect(() => {
    if (!openId && overviews[0]) setOpenId(overviews[0].id)
  }, [openId, overviews])

  async function create(input: { format: AudioFormat; length: AudioLength; language: AudioLanguage; focus?: string } & SourceSelection) {
    setBusy(true)
    try {
      const { overview } = await apiJson<{ overview: AudioSummary }>('/api/audio', { method: 'POST', json: input })
      toast({ title: 'Audio overview started', description: 'The hosts are reading your sources. This takes a few minutes — you can keep working.' })
      setOpenId(overview.id)
      await list.mutate()
      return true
    } catch (error) {
      toast({ variant: 'destructive', description: errorMessage(error) })
      return false
    } finally {
      setBusy(false)
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    await create({ format, length, language, focus: focus.trim() || undefined, ...selection })
  }

  async function remove(overview: AudioDetail) {
    if (!window.confirm(`Delete “${overview.title}”?`)) return
    try {
      await apiJson(`/api/audio/${overview.id}`, { method: 'DELETE' })
      setOpenId(null)
      await list.mutate()
    } catch (error) {
      toast({ variant: 'destructive', description: errorMessage(error) })
    }
  }

  const open = detail.data?.overview
  const canDelete = (email: string | null) => canManageOwned(role, email, user.email)

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto pr-1">
      <form onSubmit={submit} className="relative shrink-0 overflow-hidden rounded-2xl border border-primary/25 bg-brand-soft p-5">
        <div className="mb-4 flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-xl bg-brand-gradient shadow-md">
            <Headphones className="size-4 text-white" />
          </div>
          <div>
            <h3 className="font-display text-sm font-semibold">Create an audio overview</h3>
            <p className="text-[11px] text-muted-foreground">Two AI hosts talk through your sources — facts only from what you added.</p>
          </div>
        </div>

        <fieldset className="grid grid-cols-2 gap-2 lg:grid-cols-4" disabled={!audioEnabled}>
          <legend className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Format</legend>
          {FORMATS.map(({ id, label, description, icon: Icon }) => (
            <button
              key={id}
              type="button"
              aria-pressed={format === id}
              onClick={() => setFormat(id)}
              className={cn(
                'rounded-xl border p-3 text-left transition-all',
                format === id ? 'border-primary/60 bg-card shadow-sm' : 'border-border/60 bg-card/40 hover:border-primary/30',
              )}
            >
              <span className="flex items-center gap-1.5 text-xs font-semibold">
                <Icon className={cn('size-3.5 shrink-0', format === id ? 'text-primary' : 'text-muted-foreground')} /> {label}
              </span>
              <span className="mt-1 block text-[11px] leading-snug text-muted-foreground">{description}</span>
            </button>
          ))}
        </fieldset>

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <SourcePicker collections={collections} value={selection} onChange={setSelection} disabled={!audioEnabled} />
          <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <fieldset disabled={!audioEnabled}>
                <legend className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Length</legend>
                <div className="inline-flex rounded-xl border border-border/60 bg-card/50 p-0.5">
                  {LENGTHS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={length === option.id}
                      onClick={() => setLength(option.id)}
                      className={cn(
                        'rounded-lg px-3 py-1 text-[11px] transition-colors',
                        length === option.id ? 'bg-card font-semibold shadow-sm' : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {option.label} <span className="opacity-60">{option.hint}</span>
                    </button>
                  ))}
                </div>
              </fieldset>
              <div className="w-40">
                <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground" htmlFor="audio-language">
                  Language
                </label>
                <Select id="audio-language" value={language} disabled={!audioEnabled} onChange={(event) => setLanguage(event.target.value as AudioLanguage)}>
                  {AUDIO_LANGUAGES.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground" htmlFor="audio-focus">
                Focus (optional)
              </label>
              <Textarea
                id="audio-focus"
                rows={2}
                value={focus}
                maxLength={STUDIO_LIMITS.focusChars}
                disabled={!audioEnabled}
                onChange={(event) => setFocus(event.target.value)}
                placeholder="e.g. Explain it for new team members; spend most time on the risks"
                className="bg-card/80 text-xs"
              />
            </div>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="text-[11px] text-muted-foreground">
            {audioEnabled ? 'Takes a few minutes; you will get a notification when it is ready.' : 'Audio overviews need a text-to-speech model (TTS_PROVIDER) on the server.'}
          </p>
          <Button type="submit" variant="brand" disabled={!audioEnabled || busy || !hasSelection(selection)}>
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Sparkles className="mr-2 size-4" />}
            Generate
          </Button>
        </div>
      </form>

      <div className="grid shrink-0 gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-sm font-semibold">Your overviews</h3>
            <span className="text-[11px] text-muted-foreground">{overviews.length}</span>
          </div>
          {list.isLoading ? (
            [0, 1, 2].map((key) => <Skeleton key={key} className="h-16 rounded-2xl" />)
          ) : overviews.length === 0 ? (
            <EmptyState icon={Headphones} title="No audio overviews yet" description="Pick sources above and generate a conversation you can listen to on the go." />
          ) : (
            <div className="space-y-2">
              {overviews.map((overview) => (
                <OverviewCard key={overview.id} overview={overview} selected={overview.id === openId} onSelect={() => setOpenId(overview.id)} />
              ))}
            </div>
          )}
        </section>

        <section className="panel min-h-[240px] p-4 sm:p-5">
          {!openId ? (
            <EmptyState icon={Headphones} title="Nothing playing" description="Choose an overview to listen and read along." />
          ) : !open ? (
            <Skeleton className="h-60 rounded-2xl" />
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-display text-lg font-semibold">{open.title}</h3>
                  <p className="text-xs text-muted-foreground">
                    {FORMAT_LABEL[open.format]} · {open.language} · {timeAgo(open.createdAt)}
                    {open.focus ? ` · focus: ${open.focus}` : ''}
                  </p>
                </div>
                <div className="flex gap-1.5">
                  {open.status === 'failed' && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void create({
                          format: open.format,
                          length: open.length,
                          language: open.language,
                          focus: open.focus ?? undefined,
                          collectionIds: open.collectionIds,
                          documentIds: open.documentIds,
                        })
                      }
                    >
                      <RotateCcw className="mr-1.5 size-3.5" /> Try again
                    </Button>
                  )}
                  {canDelete(open.createdByEmail) && (
                    <Button type="button" size="sm" variant="ghost" onClick={() => void remove(open)} aria-label="Delete audio overview">
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </div>
              </div>
              {open.status === 'completed' ? (
                <AudioPlayer key={open.id} overview={open} onOpenSource={onOpenSource} />
              ) : open.status === 'failed' ? (
                <div className="rounded-2xl border border-destructive/40 bg-destructive/5 p-5 text-sm text-destructive">
                  <AlertTriangle className="mb-2 size-5" />
                  {open.error ?? 'The overview could not be created.'}
                </div>
              ) : (
                <div className="generating flex flex-col items-center justify-center rounded-2xl border border-primary/30 p-10 text-center">
                  <Equalizer className="h-10 [&>span]:w-1.5" />
                  <p className="mt-4 text-sm font-semibold">{open.progress ?? 'Queued'}</p>
                  <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                    Reading the sources, writing a script and recording both hosts. Longer overviews take a few minutes.
                  </p>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
