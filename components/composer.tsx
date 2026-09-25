'use client'

import { ArrowUp, Mic, MicOff, Square } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'

import { Tooltip } from '@/components/ui/tooltip'
import { useSpeechInput } from '@/hooks/use-speech-input'
import { LIMITS } from '@/lib/constants'
import { cn } from '@/lib/utils'

interface ComposerProps {
  disabled?: boolean
  isStreaming: boolean
  placeholder: string
  footer: ReactNode
  /** Controls shown before the text field (e.g. the deep-mode toggle). */
  tools?: ReactNode
  /** Hide the dictation button on phones (when voice chat is offered instead), to keep the field wide. */
  compactDictation?: boolean
  onSend: (text: string) => void
  onStop: () => void
}

export function Composer({ disabled, isStreaming, placeholder, footer, tools, compactDictation, onSend, onStop }: ComposerProps) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const speech = useSpeechInput((text) => setValue((current) => (current ? `${current.trimEnd()} ${text}` : text)))

  useEffect(() => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`
  }, [value])

  const tooLong = value.length > LIMITS.chatMessageChars
  const canSend = !disabled && !isStreaming && value.trim().length > 0 && !tooLong

  function submit(event?: FormEvent) {
    event?.preventDefault()
    if (!canSend) return
    if (speech.listening) speech.stop()
    onSend(value.trim())
    setValue('')
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <form onSubmit={submit} className="mx-auto max-w-3xl">
      <div className="composer flex items-end gap-2 p-2 shadow-lg shadow-black/5">
        {tools}
        {speech.supported && (
          <span className={cn('contents', compactDictation && 'max-sm:hidden')}>
            <Tooltip label={speech.listening ? 'Stop dictation' : 'Dictate'} align="start">
              <button
                type="button"
                aria-label={speech.listening ? 'Stop dictation' : 'Dictate'}
                onClick={speech.listening ? speech.stop : speech.start}
                disabled={disabled}
                className={cn(
                  'flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors',
                  speech.listening ? 'animate-pulse bg-red-500/20 text-red-500' : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                )}
              >
                {speech.listening ? <MicOff className="size-4" /> : <Mic className="size-4" />}
              </button>
            </Tooltip>
          </span>
        )}
        <div className="flex-1">
          <label htmlFor="chat-input" className="sr-only">
            Message
          </label>
          <textarea
            id="chat-input"
            ref={textareaRef}
            rows={1}
            value={value}
            disabled={disabled}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={speech.listening ? 'Listening…' : placeholder}
            className="max-h-[180px] min-h-[40px] w-full resize-none bg-transparent px-2 py-2 text-sm leading-6 placeholder:text-muted-foreground focus:outline-none disabled:opacity-50"
          />
          {speech.interim && <p className="px-2 pb-1 text-xs italic text-muted-foreground">{speech.interim}</p>}
        </div>
        {isStreaming ? (
          <Tooltip label="Stop generating" align="end">
            <button
              type="button"
              aria-label="Stop generating"
              onClick={onStop}
              className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-secondary text-foreground hover:bg-secondary/80"
            >
              <Square className="size-3.5 fill-current" />
            </button>
          </Tooltip>
        ) : (
          <button
            type="submit"
            aria-label="Send"
            disabled={!canSend}
            className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand-gradient text-white shadow-md transition-all hover:shadow-lg active:scale-95 disabled:opacity-40 disabled:shadow-none"
          >
            <ArrowUp className="size-4" strokeWidth={2.25} />
          </button>
        )}
      </div>
      <div className="mt-1 flex items-center justify-between px-1 font-mono text-[10px] text-muted-foreground">
        {tooLong ? (
          <span className="text-destructive">
            {value.length.toLocaleString()} / {LIMITS.chatMessageChars.toLocaleString()} characters
          </span>
        ) : (
          <span className="hidden sm:inline">Enter to send · Shift+Enter for a new line</span>
        )}
        <span className="ml-auto truncate">{footer}</span>
      </div>
    </form>
  )
}
