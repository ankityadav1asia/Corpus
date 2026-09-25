'use client'

import { ArrowDown, AudioLines, CornerDownRight, Database, Sparkles } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { ChatMessage, type ChatMessageActions } from '@/components/chat-message'
import { Composer } from '@/components/composer'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { VoiceMode, voiceChatSupported } from '@/components/voice-mode'
import type { UiMessage } from '@/hooks/use-rag-chat'
import type { ChatMode } from '@/lib/constants'
import type { SessionUser } from '@/lib/contracts'
import { cn } from '@/lib/utils'

const SUGGESTIONS = [
  'What are the core topics and findings?',
  'Summarize the key takeaways and action items',
  'Which numbers, dates or metrics are mentioned?',
  'Where do the sources disagree?',
]

interface ChatPanelProps extends Omit<ChatMessageActions, 'onVisualize' | 'onRetry'> {
  messages: UiMessage[]
  isStreaming: boolean
  disabled: boolean
  scopeLabel: string
  chunkCount: number
  mode: ChatMode
  onModeChange: (mode: ChatMode) => void
  user: SessionUser
  onSend: (text: string) => void
  onStop: () => void
  onAddSources: () => void
  /** Turn a question into a knowledge-grounded image. */
  onVisualize: (question: string) => void
  /** Shown under the welcome message (getting-started steps). */
  onboarding?: ReactNode
}

/** Deep mode searches several ways (multi-query, step-back, HyDE) before answering. */
function DeepModeToggle({ mode, disabled, onChange }: { mode: ChatMode; disabled: boolean; onChange: (mode: ChatMode) => void }) {
  const deep = mode === 'deep'
  return (
    <Tooltip label={deep ? 'Deep mode is on: multi-query, step-back and HyDE' : 'Deep mode: research more thoroughly (slower)'} align="start">
      <button
        type="button"
        aria-label="Deep mode"
        aria-pressed={deep}
        disabled={disabled}
        onClick={() => onChange(deep ? 'standard' : 'deep')}
        className={cn(
          'flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors disabled:opacity-40 max-sm:w-9 max-sm:justify-center max-sm:px-0',
          deep ? 'bg-primary/15 text-primary ring-1 ring-primary/30' : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
        )}
      >
        <Sparkles className="size-3.5" />
        <span className="hidden sm:inline">Deep</span>
      </button>
    </Tooltip>
  )
}

/** Suggested next questions under the latest answer; one click asks it. */
function FollowupChips({ questions, disabled, onAsk }: { questions: string[]; disabled: boolean; onAsk: (question: string) => void }) {
  return (
    <div className="-mt-2 mb-6 ml-11 animate-fade-up" aria-label="Suggested follow-up questions">
      <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <CornerDownRight className="size-3.5" /> Ask next
      </p>
      <div className="flex flex-wrap gap-2">
        {questions.map((question) => (
          <button
            key={question}
            type="button"
            disabled={disabled}
            onClick={() => onAsk(question)}
            className="rounded-full border border-border/70 bg-card/70 px-3.5 py-1.5 text-left text-xs text-secondary-foreground transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:bg-accent disabled:opacity-40"
          >
            {question}
          </button>
        ))}
      </div>
    </div>
  )
}

export function ChatPanel(props: ChatPanelProps) {
  const { messages, isStreaming, disabled, scopeLabel, chunkCount, user } = props
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [canVoice, setCanVoice] = useState(false)
  useEffect(() => setCanVoice(voiceChatSupported()), [])

  // Follow the stream only while the user is already at the bottom (don't yank them while reading).
  useEffect(() => {
    const element = scrollRef.current
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight
  }, [messages])

  function onScroll() {
    const element = scrollRef.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    stickToBottom.current = distance < 80
    setShowJump(distance > 400)
  }

  function jumpToBottom() {
    const element = scrollRef.current
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
  }

  /** The question an answer responded to (the closest earlier user message). */
  function questionBefore(index: number): string | null {
    for (let i = index - 1; i >= 0; i--) if (messages[i]!.role === 'user') return messages[i]!.content
    return null
  }

  const lastAssistant = messages.map((message) => message.role).lastIndexOf('assistant')

  return (
    <main className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto" aria-live="polite">
        {messages.length === 0 ? (
          <div className="flex min-h-full flex-col items-center justify-center gap-8 px-4 py-12 text-center">
            <div className="max-w-xl animate-fade-up">
              <div className="relative mx-auto mb-6 size-16">
                <div aria-hidden className="absolute inset-0 rounded-3xl bg-brand-gradient opacity-40 blur-xl" />
                <div className="relative flex size-16 animate-float items-center justify-center rounded-3xl bg-brand-gradient shadow-lg">
                  <Sparkles className="size-7 text-white" />
                </div>
              </div>
              <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
                {chunkCount > 0 ? (
                  <>
                    Ask <span className="text-gradient">your knowledge base</span>
                  </>
                ) : (
                  <>
                    Start with <span className="text-gradient">a source</span>
                  </>
                )}
              </h2>
              <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
                {chunkCount > 0
                  ? `${chunkCount.toLocaleString()} passage${chunkCount === 1 ? '' : 's'} indexed in ${scopeLabel}. Answers cite their sources — and say so when the sources don't cover a question.`
                  : 'Add files up to 50 MB — documents, scans, images, audio, video — web pages, YouTube videos or notes, or connect Google Drive, Notion and GitHub. Then ask questions and create reports, audio overviews, mind maps and images grounded in them.'}
              </p>
              {chunkCount === 0 ? (
                <Button type="button" variant="brand" className="mt-6" onClick={props.onAddSources}>
                  <Database className="mr-2 size-4" />
                  Add your first source
                </Button>
              ) : (
                <div className="stagger mt-6 flex flex-wrap justify-center gap-2">
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      disabled={disabled || isStreaming}
                      onClick={() => props.onSend(suggestion)}
                      className="rounded-full border border-border/70 bg-card/70 px-4 py-2 text-xs text-secondary-foreground transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:bg-accent hover:shadow-md disabled:opacity-40"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {props.onboarding}
          </div>
        ) : (
          <div className="mx-auto max-w-3xl px-4 py-6">
            {messages.map((message, index) => {
              const question = message.role === 'assistant' ? questionBefore(index) : null
              return (
                <ChatMessage
                  key={message.id}
                  message={message}
                  user={user}
                  onBranch={isStreaming ? undefined : props.onBranch}
                  onFeedback={props.onFeedback}
                  onOpenSource={props.onOpenSource}
                  onVisualize={question ? () => props.onVisualize(question) : undefined}
                  onRetry={question && index === lastAssistant && !isStreaming ? () => props.onSend(question) : undefined}
                />
              )
            })}
            {!isStreaming && lastAssistant >= 0 && (messages[lastAssistant]!.followups?.length ?? 0) > 0 && (
              <FollowupChips questions={messages[lastAssistant]!.followups!} disabled={disabled} onAsk={props.onSend} />
            )}
          </div>
        )}
      </div>

      {showJump && (
        <button
          type="button"
          onClick={jumpToBottom}
          aria-label="Jump to the latest message"
          className="absolute bottom-28 left-1/2 flex size-9 -translate-x-1/2 animate-fade-up items-center justify-center rounded-full border border-border/70 bg-card text-muted-foreground shadow-lg transition-colors hover:text-foreground"
        >
          <ArrowDown className="size-4" />
        </button>
      )}

      <div className="px-4 pb-4 pt-2">
        <Composer
          disabled={disabled}
          isStreaming={isStreaming}
          placeholder={disabled ? 'Chat is unavailable until the server is configured' : `Ask about ${scopeLabel}…`}
          footer={`${props.mode === 'deep' ? 'Deep mode' : 'Standard'} · ${scopeLabel}`}
          compactDictation={canVoice}
          tools={
            <>
              <DeepModeToggle mode={props.mode} disabled={disabled} onChange={props.onModeChange} />
              {canVoice && (
                <Tooltip label="Voice chat: talk and hear answers" align="start">
                  <button
                    type="button"
                    aria-label="Voice chat"
                    disabled={disabled}
                    onClick={() => setVoiceOpen(true)}
                    className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40"
                  >
                    <AudioLines className="size-4" />
                  </button>
                </Tooltip>
              )}
            </>
          }
          onSend={props.onSend}
          onStop={props.onStop}
        />
      </div>
      <VoiceMode
        open={voiceOpen}
        onClose={() => setVoiceOpen(false)}
        messages={messages}
        isStreaming={isStreaming}
        disabled={disabled}
        onSend={props.onSend}
        onStop={props.onStop}
      />
    </main>
  )
}
