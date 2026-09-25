'use client'

import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  GitBranch,
  Loader2,
  RotateCcw,
  SearchX,
  Send,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Volume2,
  VolumeX,
  Wand2,
} from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'

import { CitationList } from '@/components/citation-list'
import Markdown from '@/components/markdown'
import { EvaluationBadges } from '@/components/quality-badges'
import { TypingIndicator } from '@/components/typing-indicator'
import { Avatar } from '@/components/ui/feedback-primitives'
import { Tooltip } from '@/components/ui/tooltip'
import type { UiMessage } from '@/hooks/use-rag-chat'
import { INSUFFICIENT_CONTEXT_MESSAGE, LIMITS } from '@/lib/constants'
import type { SessionUser } from '@/lib/contracts'
import { cn } from '@/lib/utils'

export interface ChatMessageActions {
  onBranch?: (messageId: string) => void
  /** Rate an answer: 1, -1, or 0 to clear. */
  onFeedback?: (messageId: string, rating: 1 | -1 | 0, comment?: string) => Promise<void>
  /** Turn the question behind this answer into an image. */
  onVisualize?: () => void
  /** Ask the question behind this answer again. */
  onRetry?: () => void
  onOpenSource?: (documentId: string, chunkId: string | null) => void
}

interface ChatMessageProps extends ChatMessageActions {
  message: UiMessage
  user: SessionUser
}

function ActionButton({ label, onClick, active, children }: { label: string; onClick: () => void; active?: boolean; children: ReactNode }) {
  return (
    <Tooltip label={label} align="end">
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        onClick={onClick}
        className={cn(
          'flex size-7 items-center justify-center rounded-lg transition-all hover:bg-secondary active:scale-90',
          active ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        {children}
      </button>
    </Tooltip>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard unavailable (permission or insecure context): nothing to show
    }
  }
  return (
    <ActionButton label="Copy" onClick={copy}>
      {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
    </ActionButton>
  )
}

function BranchButton({ onBranch }: { onBranch: () => void }) {
  return (
    <ActionButton label="Branch from here" onClick={onBranch}>
      <GitBranch className="size-3.5" />
    </ActionButton>
  )
}

/** Reads text aloud with the browser's speech synthesis, where there is one. */
function useReadAloud(text: string) {
  const [supported, setSupported] = useState(false)
  const [speaking, setSpeaking] = useState(false)

  useEffect(() => {
    setSupported('speechSynthesis' in window)
  }, [])

  useEffect(() => {
    if (!speaking) return
    return () => window.speechSynthesis.cancel()
  }, [speaking])

  function toggle() {
    window.speechSynthesis.cancel()
    if (speaking) return setSpeaking(false)
    const utterance = new SpeechSynthesisUtterance(text.replace(/[*#_`>[\]]/g, ''))
    utterance.onend = () => setSpeaking(false)
    utterance.onerror = () => setSpeaking(false)
    setSpeaking(true)
    window.speechSynthesis.speak(utterance)
  }

  return { supported, speaking, toggle }
}

function UserMessage({ message, user, onBranch }: { message: UiMessage; user: SessionUser; onBranch?: () => void }) {
  return (
    <article className="group flex animate-fade-up justify-end gap-3 py-3 pl-10">
      <div className="max-w-[85%] rounded-2xl rounded-tr-md border border-primary/25 bg-primary/10 px-4 py-3">
        <p className="whitespace-pre-wrap text-[14.5px] leading-7">{message.content}</p>
        <div className="-mb-1 mt-1 flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <CopyButton text={message.content} />
          {onBranch && <BranchButton onBranch={onBranch} />}
        </div>
      </div>
      <Avatar name={user.name} email={user.email} className="mt-1 size-7 text-[10px]" />
    </article>
  )
}

/** The retrieval steps behind an answer, collapsed by default. */
function ResearchSteps({ steps, insufficient }: { steps: UiMessage['steps']; insufficient: boolean }) {
  const [open, setOpen] = useState(false)
  if (steps.length === 0) return null
  return (
    <div className="mb-3 rounded-xl border border-border/60 bg-card/50 px-3 py-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="flex items-center gap-1.5">
          {insufficient ? <SearchX className="size-3.5 text-warning" /> : <Sparkles className="size-3.5 text-primary" />}
          How this answer was researched
        </span>
        {open ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
      </button>
      {open && (
        <dl className="mt-2 animate-slide-down space-y-1.5 border-t border-border/50 pt-2 text-xs text-muted-foreground">
          {steps.map((step) => (
            <div key={step.label}>
              <dt className="font-medium text-foreground/85">{step.label}</dt>
              <dd>{step.detail}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

function InsufficientContextNote() {
  return (
    <div role="note" className="flex items-start gap-2.5 rounded-2xl border border-warning/40 bg-warning/10 p-3.5">
      <SearchX className="mt-1 size-4 shrink-0 text-warning" />
      <div>
        <p className="font-medium">{INSUFFICIENT_CONTEXT_MESSAGE}</p>
        <p className="text-xs leading-5 text-muted-foreground">
          Nothing in the selected notebooks was relevant enough to answer from, so no answer was generated. Add sources that cover this topic, pick another notebook, or rephrase
          the question.
        </p>
      </div>
    </div>
  )
}

/** The answer text, the "not enough context" note, or the pipeline stage while nothing is written yet. */
function AnswerBody({ message, insufficient }: { message: UiMessage; insufficient: boolean }) {
  const waiting = message.status === 'streaming' && !message.content
  return (
    <div className="text-[14.5px] leading-7">
      {insufficient ? <InsufficientContextNote /> : message.content ? <Markdown content={message.content} /> : null}
      {waiting && (
        <div className="flex items-center gap-2" aria-live="polite">
          {message.statusText ? (
            <span className="flex items-center gap-2 rounded-full border border-primary/25 bg-primary/5 px-3 py-1">
              <Loader2 className="size-3.5 animate-spin text-primary" />
              <span className="text-xs text-muted-foreground">{message.statusText}</span>
            </span>
          ) : (
            <TypingIndicator />
          )}
        </div>
      )}
    </div>
  )
}

function AnswerError({ error, onRetry }: { error: UiMessage['error']; onRetry?: () => void }) {
  return (
    <div role="alert" className="mt-3 flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
      <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
      <span className="flex-1">{error ?? 'Something went wrong.'}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="flex shrink-0 items-center gap-1 font-medium hover:underline">
          <RotateCcw className="size-3" /> Try again
        </button>
      )}
    </div>
  )
}

interface AnswerActionsProps {
  message: UiMessage
  /** Present when the answer can be rated. */
  onRate?: (rating: 1 | -1) => void
  onVisualize?: () => void
  onRetry?: () => void
  onBranch?: () => void
}

/** Copy, read aloud, rate, visualize, ask again and branch. */
function AnswerActions({ message, onRate, onVisualize, onRetry, onBranch }: AnswerActionsProps) {
  const speech = useReadAloud(message.content)
  const rating = message.feedback?.rating
  return (
    <div className="mt-2 flex flex-wrap items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
      <CopyButton text={message.content} />
      {speech.supported && (
        <ActionButton label={speech.speaking ? 'Stop reading' : 'Read aloud'} onClick={speech.toggle} active={speech.speaking}>
          {speech.speaking ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
        </ActionButton>
      )}
      {onRate && (
        <>
          <ActionButton label="Helpful" onClick={() => onRate(1)} active={rating === 1}>
            <ThumbsUp className={cn('size-3.5', rating === 1 && 'fill-current')} />
          </ActionButton>
          <ActionButton label="Not helpful" onClick={() => onRate(-1)} active={rating === -1}>
            <ThumbsDown className={cn('size-3.5', rating === -1 && 'fill-current')} />
          </ActionButton>
        </>
      )}
      {onVisualize && (
        <ActionButton label="Visualize as an image" onClick={onVisualize}>
          <Wand2 className="size-3.5" />
        </ActionButton>
      )}
      {onRetry && (
        <ActionButton label="Ask again" onClick={onRetry}>
          <RotateCcw className="size-3.5" />
        </ActionButton>
      )}
      {onBranch && <BranchButton onBranch={onBranch} />}
    </div>
  )
}

/** Asked after a thumbs-down: what was wrong or missing. */
function FeedbackComment({ onSubmit }: { onSubmit: (comment: string) => Promise<void> }) {
  const [comment, setComment] = useState('')
  const [sending, setSending] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!comment.trim()) return
    setSending(true)
    try {
      await onSubmit(comment.trim())
      setComment('')
    } finally {
      setSending(false)
    }
  }

  return (
    <form onSubmit={submit} className="mt-2 flex animate-slide-down items-center gap-2 rounded-xl border border-border/70 bg-card/70 p-1.5 pl-3">
      <input
        autoFocus
        value={comment}
        maxLength={LIMITS.feedbackCommentChars}
        onChange={(event) => setComment(event.target.value)}
        placeholder="What was wrong or missing? (optional)"
        className="min-w-0 flex-1 bg-transparent text-xs focus:outline-none"
      />
      <button
        type="submit"
        disabled={sending || !comment.trim()}
        className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground disabled:opacity-40"
      >
        {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
      </button>
    </form>
  )
}

export function ChatMessage({ message, user, onBranch, onFeedback, onVisualize, onRetry, onOpenSource }: ChatMessageProps) {
  const [commenting, setCommenting] = useState(false)
  const done = message.status === 'done'
  const branch = onBranch && message.persisted && done ? () => onBranch(message.id) : undefined

  if (message.role === 'user') return <UserMessage message={message} user={user} onBranch={branch} />

  const insufficient = message.content.trim() === INSUFFICIENT_CONTEXT_MESSAGE

  async function rate(rating: 1 | -1) {
    if (!onFeedback) return
    if (message.feedback?.rating === rating) {
      setCommenting(false)
      return onFeedback(message.id, 0)
    }
    await onFeedback(message.id, rating)
    setCommenting(rating === -1)
  }

  async function sendComment(comment: string) {
    if (!onFeedback) return
    await onFeedback(message.id, -1, comment)
    setCommenting(false)
  }

  return (
    <article className="group flex animate-fade-up gap-3 py-3">
      <div className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-gradient shadow-sm">
        <Sparkles className="size-3.5 text-white" />
      </div>
      <div className="min-w-0 flex-1">
        <ResearchSteps steps={message.steps} insufficient={insufficient} />
        <AnswerBody message={message} insufficient={insufficient} />
        {message.status === 'error' && <AnswerError error={message.error} onRetry={onRetry} />}
        {message.evaluation && <EvaluationBadges scores={message.evaluation} />}
        <CitationList citations={message.citations} onOpenSource={onOpenSource} />
        {message.status !== 'streaming' && message.content && (
          <AnswerActions
            message={message}
            onRate={onFeedback && message.persisted && done && !insufficient ? (rating) => void rate(rating) : undefined}
            onVisualize={done && !insufficient ? onVisualize : undefined}
            onRetry={done ? onRetry : undefined}
            onBranch={branch}
          />
        )}
        {commenting && <FeedbackComment onSubmit={sendComment} />}
      </div>
    </article>
  )
}
