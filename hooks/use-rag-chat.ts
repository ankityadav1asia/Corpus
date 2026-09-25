'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { apiFetch, apiJson, errorMessage } from '@/lib/api-client'
import { INSUFFICIENT_CONTEXT_MESSAGE, type ChatMode } from '@/lib/constants'
import type { ChatMessage, Citation, ConversationDetail, EvaluationScores, RetrievalStep } from '@/lib/contracts'
import { decodeEvents, type ChatStage } from '@/lib/stream-protocol'

export interface UiMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  citations: Citation[]
  steps: RetrievalStep[]
  status: 'streaming' | 'done' | 'error'
  error?: string
  /** True once the server has stored it (only persisted messages can be branched from). */
  persisted: boolean
  /** Pipeline progress while the answer is being prepared. */
  stage?: ChatStage
  statusText?: string
  /** Background quality scores (arrive a few seconds after the answer). */
  evaluation?: EvaluationScores | null
  /** The reader's own rating. */
  feedback?: ChatMessage['feedback']
  /** Suggested next questions (fetched after the answer, never delaying it). */
  followups?: string[] | null
}

interface Options {
  onConversationCreated?: (conversationId: string) => void
  onSettled?: () => void
}

let localIds = 0
const localId = (prefix: string) => `local-${prefix}-${Date.now()}-${localIds++}`

/** Evaluation runs as a background job; look for its scores a few times, then give up quietly. */
const EVALUATION_POLL_DELAYS_MS = [4_000, 8_000, 15_000, 30_000, 60_000]

/**
 * Chat state machine over the NDJSON protocol. The server owns history; the client only sends
 * the new question plus the conversation id. Token deltas are batched per animation frame.
 */
export function useRagChat(options: Options = {}) {
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)

  const conversationRef = useRef<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const optionsRef = useRef(options)
  // Bumped on reset/load so late evaluation polls never touch a different conversation.
  const generationRef = useRef(0)
  const pollTimerRef = useRef<number | null>(null)
  useEffect(() => {
    optionsRef.current = options
  })

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current)
    pollTimerRef.current = null
  }, [])

  useEffect(() => stopPolling, [stopPolling])

  // Follow-up suggestions are requested once per answer, after it has been delivered.
  const followupsRequested = useRef(new Set<string>())

  const patch = useCallback((id: string, change: (message: UiMessage) => UiMessage) => {
    setMessages((current) => current.map((message) => (message.id === id ? change(message) : message)))
  }, [])

  const requestFollowups = useCallback(
    async (messageId: string) => {
      if (followupsRequested.current.has(messageId)) return
      followupsRequested.current.add(messageId)
      const generation = generationRef.current
      try {
        const { followups } = await apiJson<{ followups: string[] }>(`/api/messages/${messageId}/followups`, { method: 'POST' })
        if (generation === generationRef.current) patch(messageId, (message) => ({ ...message, followups }))
      } catch {
        // Suggestions are optional.
      }
    },
    [patch],
  )

  const pollEvaluation = useCallback(
    (forConversation: string, messageId: string) => {
      stopPolling()
      const generation = generationRef.current
      let attempt = 0
      const tick = async () => {
        if (generation !== generationRef.current) return
        try {
          const detail = await apiJson<ConversationDetail>(`/api/conversations/${forConversation}`)
          const evaluation = detail.messages.find((message) => message.id === messageId)?.evaluation
          if (generation !== generationRef.current) return
          if (evaluation) return patch(messageId, (message) => ({ ...message, evaluation }))
        } catch {
          return
        }
        if (attempt < EVALUATION_POLL_DELAYS_MS.length) pollTimerRef.current = window.setTimeout(tick, EVALUATION_POLL_DELAYS_MS[attempt++])
      }
      pollTimerRef.current = window.setTimeout(tick, EVALUATION_POLL_DELAYS_MS[attempt++])
    },
    [patch, stopPolling],
  )

  const send = useCallback(
    async (text: string, request: { collectionId: string | null; mode: ChatMode }) => {
      const question = text.trim()
      if (!question || abortRef.current) return

      const userId = localId('user')
      let assistantId = localId('assistant')
      setMessages((current) => [
        ...current,
        { id: userId, role: 'user', content: question, citations: [], steps: [], status: 'done', persisted: false },
        { id: assistantId, role: 'assistant', content: '', citations: [], steps: [], status: 'streaming', persisted: false, statusText: 'Starting…' },
      ])

      const controller = new AbortController()
      abortRef.current = controller
      setIsStreaming(true)

      let pending = ''
      let frame: number | null = null
      let answered = ''
      const flush = () => {
        frame = null
        if (!pending) return
        const chunk = pending
        pending = ''
        patch(assistantId, (message) => ({ ...message, content: message.content + chunk }))
      }

      try {
        const res = await apiFetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: question,
            conversationId: conversationRef.current,
            collectionId: request.collectionId,
            mode: request.mode,
          }),
          signal: controller.signal,
        })
        if (!res.body) throw new Error('The server returned an empty response.')

        for await (const event of decodeEvents(res.body)) {
          switch (event.type) {
            case 'start':
              conversationRef.current = event.conversationId
              setConversationId(event.conversationId)
              patch(userId, (message) => ({ ...message, id: event.userMessageId, persisted: true }))
              if (event.createdConversation) optionsRef.current.onConversationCreated?.(event.conversationId)
              break
            case 'status':
              patch(assistantId, (message) => ({ ...message, stage: event.stage, statusText: event.message }))
              break
            case 'sources':
              patch(assistantId, (message) => ({ ...message, citations: event.citations, steps: event.steps }))
              break
            case 'delta':
              answered += event.text
              pending += event.text
              frame ??= requestAnimationFrame(flush)
              break
            case 'done': {
              flush()
              const savedId = event.assistantMessageId
              patch(assistantId, (message) => ({ ...message, id: savedId, status: 'done', persisted: true, statusText: undefined }))
              assistantId = savedId
              if (conversationRef.current && answered.trim() !== INSUFFICIENT_CONTEXT_MESSAGE) {
                void requestFollowups(savedId)
                pollEvaluation(conversationRef.current, savedId)
              }
              break
            }
            case 'error':
              flush()
              patch(assistantId, (message) => ({ ...message, status: 'error', error: event.message, statusText: undefined }))
              break
          }
        }
        flush()
        patch(assistantId, (message) =>
          message.status === 'streaming'
            ? message.content
              ? { ...message, status: 'done', statusText: undefined }
              : { ...message, status: 'error', error: 'The connection closed before an answer arrived.', statusText: undefined }
            : message,
        )
      } catch (error) {
        if (frame !== null) cancelAnimationFrame(frame)
        flush()
        if (controller.signal.aborted) {
          patch(assistantId, (message) => ({ ...message, status: 'done', content: message.content || '_Stopped._', statusText: undefined }))
        } else {
          patch(assistantId, (message) => ({ ...message, status: 'error', error: errorMessage(error), statusText: undefined }))
        }
      } finally {
        abortRef.current = null
        setIsStreaming(false)
        optionsRef.current.onSettled?.()
      }
    },
    [patch, pollEvaluation, requestFollowups],
  )

  const stop = useCallback(() => abortRef.current?.abort(), [])

  const load = useCallback(
    (id: string, loaded: ChatMessage[]) => {
      abortRef.current?.abort()
      stopPolling()
      generationRef.current++
      conversationRef.current = id
      setConversationId(id)
      setMessages(loaded.map((message) => ({ ...message, status: 'done', persisted: true })))
      // Older answers may not have suggestions yet: ask for the latest one's.
      const last = [...loaded].reverse().find((message) => message.role === 'assistant')
      if (last && !last.followups && last.citations.length > 0 && last.content.trim() !== INSUFFICIENT_CONTEXT_MESSAGE) void requestFollowups(last.id)
    },
    [stopPolling, requestFollowups],
  )

  const reset = useCallback(() => {
    abortRef.current?.abort()
    stopPolling()
    generationRef.current++
    conversationRef.current = null
    setConversationId(null)
    setMessages([])
  }, [stopPolling])

  /** Reflects a rating saved on the server. */
  const setFeedback = useCallback((messageId: string, feedback: ChatMessage['feedback']) => patch(messageId, (message) => ({ ...message, feedback })), [patch])

  return { conversationId, messages, isStreaming, send, stop, load, reset, setFeedback }
}
