import type { ConversationSummary } from '@/lib/contracts'

export interface HistoryGroup {
  label: string
  items: ConversationSummary[]
}

const DAY = 24 * 3600 * 1000
const MONTH = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric' })

function startOfDay(time: number): number {
  const date = new Date(time)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * Sidebar history, grouped like most chat apps: Pinned, Today, Yesterday, Previous 7 days,
 * Previous 30 days, then one group per month. Keeps the given order inside each group
 * (the API returns the most recent first) and drops empty groups.
 */
export function groupConversations(conversations: readonly ConversationSummary[], now = Date.now()): HistoryGroup[] {
  const today = startOfDay(now)
  const buckets = new Map<string, ConversationSummary[]>()
  const add = (label: string, item: ConversationSummary) => {
    const list = buckets.get(label)
    if (list) list.push(item)
    else buckets.set(label, [item])
  }

  const fixed = ['Pinned', 'Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days']
  for (const label of fixed) buckets.set(label, [])

  for (const conversation of conversations) {
    if (conversation.pinned) {
      add('Pinned', conversation)
      continue
    }
    const time = new Date(conversation.updatedAt).getTime()
    if (!Number.isFinite(time) || time >= today) add('Today', conversation)
    else if (time >= today - DAY) add('Yesterday', conversation)
    else if (time >= today - 7 * DAY) add('Previous 7 days', conversation)
    else if (time >= today - 30 * DAY) add('Previous 30 days', conversation)
    else add(MONTH.format(time), conversation)
  }

  return [...buckets].filter(([, items]) => items.length > 0).map(([label, items]) => ({ label, items }))
}
