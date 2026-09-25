'use client'

import { Loader2, Mic, MicOff, Square, Volume2, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { getRecognition, type Recognition } from '@/hooks/use-speech-input'
import type { UiMessage } from '@/hooks/use-rag-chat'
import { takeSentences, toSpeakable } from '@/lib/speech-text'
import { cn } from '@/lib/utils'

type Phase = 'idle' | 'listening' | 'thinking' | 'speaking'

const LANGUAGES = [
  { value: '', label: 'Browser language' },
  { value: 'en-IN', label: 'English (India)' },
  { value: 'hi-IN', label: 'हिन्दी (Hindi)' },
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' },
]

/** Voice chat needs speech recognition (Chrome, Edge, Safari) and speech synthesis. */
export function voiceChatSupported(): boolean {
  return typeof window !== 'undefined' && getRecognition() !== null && 'speechSynthesis' in window
}

function pickVoice(lang: string): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices()
  const base = lang.split('-')[0]!.toLowerCase()
  const candidates = voices.filter((voice) => voice.lang.toLowerCase() === lang.toLowerCase() || voice.lang.toLowerCase().startsWith(`${base}-`))
  // Natural / online voices sound far better than the classic offline ones.
  return candidates.find((voice) => /natural|online|google/i.test(voice.name)) ?? candidates[0] ?? null
}

interface VoiceModeProps {
  open: boolean
  onClose: () => void
  messages: UiMessage[]
  isStreaming: boolean
  disabled: boolean
  onSend: (text: string) => void
  onStop: () => void
}

/**
 * Hands-free conversation: listen → ask → speak the answer → listen again. The answer is spoken
 * sentence by sentence while it streams, so talking starts after the first sentence, not the last.
 */
export function VoiceMode({ open, onClose, messages, isStreaming, disabled, onSend, onStop }: VoiceModeProps) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [heard, setHeard] = useState('')
  const [spoken, setSpoken] = useState('')
  const [lang, setLang] = useState('')
  const [error, setError] = useState<string | null>(null)
  const recognitionRef = useRef<Recognition | null>(null)
  const queueRef = useRef(0)
  const spokenUpTo = useRef(0)
  const pendingRest = useRef('')
  const answerIdRef = useRef<string | null>(null)
  const activeRef = useRef(false)

  const language = lang || (typeof navigator !== 'undefined' ? navigator.language : 'en-US') || 'en-US'

  const stopListening = useCallback(() => {
    const recognition = recognitionRef.current
    recognitionRef.current = null
    recognition?.abort()
  }, [])

  const listen = useCallback(() => {
    const Recognition = getRecognition()
    if (!Recognition || !activeRef.current || disabled) return
    stopListening()
    const recognition = new Recognition()
    recognition.continuous = false
    recognition.interimResults = true
    recognition.lang = language
    let finalText = ''
    recognition.onresult = (event) => {
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]!
        if (result.isFinal) finalText += result[0].transcript
        else interim += result[0].transcript
      }
      setHeard((finalText + interim).trim())
    }
    recognition.onerror = () => undefined
    recognition.onend = () => {
      if (recognitionRef.current !== recognition) return
      recognitionRef.current = null
      const question = finalText.trim()
      if (!activeRef.current) return
      if (!question) return setPhase('idle')
      setPhase('thinking')
      setSpoken('')
      spokenUpTo.current = 0
      pendingRest.current = ''
      answerIdRef.current = null
      onSend(question)
    }
    recognitionRef.current = recognition
    setHeard('')
    setError(null)
    setPhase('listening')
    try {
      recognition.start()
    } catch {
      setError('The microphone could not be started. Check the browser’s microphone permission.')
      setPhase('idle')
    }
  }, [disabled, language, onSend, stopListening])

  const speak = useCallback(
    (sentence: string) => {
      const text = sentence.trim()
      if (!text) return
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = language
      const voice = pickVoice(language)
      if (voice) utterance.voice = voice
      utterance.rate = 1.05
      queueRef.current++
      setPhase('speaking')
      setSpoken((current) => `${current} ${text}`.trim())
      const done = () => {
        queueRef.current = Math.max(0, queueRef.current - 1)
      }
      utterance.onend = done
      utterance.onerror = done
      window.speechSynthesis.speak(utterance)
    },
    [language],
  )

  // Speak the latest answer as it streams in.
  const answer = [...messages].reverse().find((message) => message.role === 'assistant')
  useEffect(() => {
    if (!open || !answer || (phase !== 'thinking' && phase !== 'speaking')) return
    if (answerIdRef.current === null && answer.status === 'streaming') answerIdRef.current = answer.id
    if (answerIdRef.current === null) return
    const text = toSpeakable(answer.status === 'error' ? (answer.error ?? 'Sorry, something went wrong.') : answer.content)
    const fresh = pendingRest.current + text.slice(spokenUpTo.current)
    spokenUpTo.current = text.length
    const finished = answer.status !== 'streaming'
    const { sentences, rest } = finished ? { sentences: fresh.trim() ? [fresh] : [], rest: '' } : takeSentences(fresh)
    pendingRest.current = rest
    sentences.forEach(speak)
  }, [open, answer, phase, speak])

  // When the answer is complete and everything has been said, listen for the next question.
  useEffect(() => {
    if (!open || phase !== 'speaking' || isStreaming) return
    const timer = window.setInterval(() => {
      if (queueRef.current === 0 && !window.speechSynthesis.speaking && !window.speechSynthesis.pending) {
        window.clearInterval(timer)
        listen()
      }
    }, 250)
    return () => window.clearInterval(timer)
  }, [open, phase, isStreaming, listen])

  // An answer with nothing to say (e.g. stopped) should not leave us waiting.
  useEffect(() => {
    if (open && phase === 'thinking' && !isStreaming && answerIdRef.current !== null && queueRef.current === 0) listen()
  }, [open, phase, isStreaming, listen])

  useEffect(() => {
    activeRef.current = open
    if (open) {
      window.speechSynthesis.getVoices() // warms up the voice list (loaded asynchronously)
      listen()
    } else {
      stopListening()
      window.speechSynthesis?.cancel()
      queueRef.current = 0
      setPhase('idle')
    }
    // Start/stop only when the overlay opens or closes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(
    () => () => {
      activeRef.current = false
      recognitionRef.current?.abort()
      if (typeof window !== 'undefined') window.speechSynthesis?.cancel()
    },
    [],
  )

  function onOrb() {
    if (phase === 'listening') {
      recognitionRef.current?.stop() // ends the utterance now; what was heard is sent
      return
    }
    if (phase === 'speaking' || phase === 'thinking') {
      // Interrupt: stop talking (and generating) and listen right away.
      window.speechSynthesis.cancel()
      queueRef.current = 0
      if (isStreaming) onStop()
    }
    listen()
  }

  if (!open || typeof document === 'undefined') return null
  const label = { idle: 'Tap to speak', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking — tap to interrupt' }[phase]

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Voice chat"
      className="fixed inset-0 z-[80] flex animate-fade-in flex-col items-center justify-between bg-background/95 px-6 py-8 backdrop-blur-xl"
    >
      <div className="flex w-full max-w-xl items-center justify-between">
        <select
          aria-label="Voice language"
          value={lang}
          onChange={(event) => setLang(event.target.value)}
          className="rounded-lg border border-border/70 bg-card px-2 py-1 text-xs text-muted-foreground"
        >
          {LANGUAGES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-label="Close voice chat"
          onClick={onClose}
          className="flex size-9 items-center justify-center rounded-full border border-border/70 text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="flex flex-col items-center gap-8">
        <button
          type="button"
          onClick={onOrb}
          aria-label={label}
          className={cn(
            'relative flex size-40 items-center justify-center rounded-full bg-brand-gradient text-white shadow-2xl transition-transform active:scale-95',
            phase === 'listening' && 'animate-pulse',
          )}
        >
          {phase === 'listening' && <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-primary/30" />}
          {phase === 'thinking' ? (
            <Loader2 className="size-12 animate-spin" />
          ) : phase === 'speaking' ? (
            <Volume2 className="size-12" />
          ) : phase === 'listening' ? (
            <Mic className="size-12" />
          ) : (
            <MicOff className="size-12 opacity-80" />
          )}
        </button>
        <p className="text-sm font-medium text-muted-foreground" aria-live="polite">
          {label}
        </p>
        {error && <p className="max-w-sm text-center text-xs text-destructive">{error}</p>}
      </div>

      <div className="w-full max-w-xl space-y-3 text-center">
        {heard && (
          <p className="text-sm">
            <span className="text-muted-foreground">You: </span>
            {heard}
          </p>
        )}
        {spoken && <p className="line-clamp-4 text-sm text-foreground/80">{spoken}</p>}
        <div className="flex justify-center gap-2 pt-2">
          {(phase === 'speaking' || phase === 'thinking') && (
            <button
              type="button"
              onClick={onOrb}
              className="flex items-center gap-1.5 rounded-full border border-border/70 px-4 py-2 text-xs text-muted-foreground hover:text-foreground"
            >
              <Square className="size-3 fill-current" /> Stop
            </button>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">Answers still come from your sources, and appear in the chat with their citations.</p>
      </div>
    </div>,
    document.body,
  )
}
