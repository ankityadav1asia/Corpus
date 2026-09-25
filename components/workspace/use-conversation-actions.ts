'use client'

import { useCallback } from 'react'

import { useToast } from '@/components/ui/use-toast'
import { useErrorToast } from '@/hooks/use-error-toast'
import type { UiMessage, useRagChat } from '@/hooks/use-rag-chat'
import { apiJson } from '@/lib/api-client'
import type { ChatMessage, Collection, ConversationDetail } from '@/lib/contracts'
import { downloadText } from '@/lib/download'

type RagChat = ReturnType<typeof useRagChat>

function toMarkdown(messages: UiMessage[]) {
  return messages
    .map((message) => {
      const sources = message.citations.map((c) => `[${c.index}] ${c.title} — ${c.source}`).join('\n')
      return `### ${message.role === 'user' ? 'You' : 'Assistant'}\n\n${message.content}${sources ? `\n\nSources:\n${sources}` : ''}`
    })
    .join('\n\n---\n\n')
}

/** Everything done to conversations: open, rename, pin, delete, branch, rate answers, export. */
export function useConversationActions(deps: {
  chat: RagChat
  refreshConversations: () => Promise<unknown>
  collections: readonly Collection[]
  /** A conversation was opened: select its notebook (or all) and show the chat. */
  onOpened: (notebookId: string | null) => void
}) {
  const { chat, refreshConversations, collections, onOpened } = deps
  const { toast } = useToast()
  const fail = useErrorToast()

  const open = useCallback(
    async (id: string) => {
      try {
        const detail = await apiJson<ConversationDetail>(`/api/conversations/${id}`)
        chat.load(id, detail.messages)
        const notebook = detail.conversation.collectionId
        onOpened(notebook && collections.some((c) => c.id === notebook) ? notebook : null)
      } catch (error) {
        fail(error)
      }
    },
    [chat, collections, fail, onOpened],
  )

  async function remove(id: string) {
    if (!window.confirm('Delete this conversation?')) return
    try {
      await apiJson(`/api/conversations/${id}`, { method: 'DELETE' })
      if (chat.conversationId === id) chat.reset()
      await refreshConversations()
    } catch (error) {
      fail(error)
    }
  }

  async function rename(id: string, title: string): Promise<boolean> {
    try {
      await apiJson(`/api/conversations/${id}`, { method: 'PATCH', json: { title } })
      await refreshConversations()
      return true
    } catch (error) {
      fail(error)
      return false
    }
  }

  async function pin(id: string, pinned: boolean) {
    try {
      await apiJson(`/api/conversations/${id}`, { method: 'PATCH', json: { pinned } })
      await refreshConversations()
    } catch (error) {
      fail(error)
    }
  }

  async function branch(messageId: string) {
    if (!chat.conversationId) return
    try {
      const { conversationId } = await apiJson<{ conversationId: string }>(`/api/conversations/${chat.conversationId}/branch`, { method: 'POST', json: { messageId } })
      await refreshConversations()
      await open(conversationId)
      toast({ description: 'Branched into a new conversation.' })
    } catch (error) {
      fail(error)
    }
  }

  async function rate(messageId: string, rating: 1 | -1 | 0, comment?: string) {
    try {
      const { feedback } = await apiJson<{ feedback: ChatMessage['feedback'] }>(`/api/messages/${messageId}/feedback`, {
        method: 'PUT',
        json: { rating, comment: comment || undefined },
      })
      chat.setFeedback(messageId, feedback)
      if (rating !== 0 && comment) toast({ description: 'Thanks — your feedback helps improve the answers.' })
    } catch (error) {
      fail(error)
    }
  }

  function exportChat(format: 'markdown' | 'json') {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    if (format === 'json') {
      const data = chat.messages.map(({ role, content, citations, steps, evaluation }) => ({ role, content, citations, steps, evaluation }))
      downloadText(`conversation-${stamp}.json`, 'application/json', JSON.stringify(data, null, 2))
    } else {
      downloadText(`conversation-${stamp}.md`, 'text/markdown', toMarkdown(chat.messages))
    }
  }

  return { open, remove, rename, pin, branch, rate, exportChat }
}
