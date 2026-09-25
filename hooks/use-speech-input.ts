'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

interface RecognitionAlternative {
  transcript: string
}
interface RecognitionResult {
  isFinal: boolean
  0: RecognitionAlternative
}
interface RecognitionEvent {
  resultIndex: number
  results: ArrayLike<RecognitionResult>
}
export interface Recognition {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: RecognitionEvent) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}
export type RecognitionConstructor = new () => Recognition

export function getRecognition(): RecognitionConstructor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/**
 * Dictation. Only *final* results are handed to `onFinalText` (once each); in-progress words are
 * exposed separately as `interim`. The old version appended every interim result, duplicating text.
 */
export function useSpeechInput(onFinalText: (text: string) => void) {
  const [supported, setSupported] = useState(false)
  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState('')
  const recognitionRef = useRef<Recognition | null>(null)
  const callbackRef = useRef(onFinalText)

  useEffect(() => {
    callbackRef.current = onFinalText
  })
  useEffect(() => {
    setSupported(getRecognition() !== null)
    return () => recognitionRef.current?.abort()
  }, [])

  const start = useCallback(() => {
    const Recognition = getRecognition()
    if (!Recognition || recognitionRef.current) return
    const recognition = new Recognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = navigator.language || 'en-US'
    recognition.onresult = (event) => {
      let pending = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]!
        if (result.isFinal) {
          const text = result[0].transcript.trim()
          if (text) callbackRef.current(text)
        } else {
          pending += result[0].transcript
        }
      }
      setInterim(pending)
    }
    const finish = () => {
      recognitionRef.current = null
      setListening(false)
      setInterim('')
    }
    recognition.onend = finish
    recognition.onerror = finish
    recognitionRef.current = recognition
    recognition.start()
    setListening(true)
  }, [])

  const stop = useCallback(() => recognitionRef.current?.stop(), [])

  return { supported, listening, interim, start, stop }
}
