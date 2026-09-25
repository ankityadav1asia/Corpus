'use client'

import { useCallback, useEffect, useState } from 'react'

/** Below this width the sidebar is an overlay drawer instead of a panel. */
export const isNarrowScreen = () => window.matchMedia('(max-width: 1023px)').matches

/** Whether the chat history panel is shown on desktop (small screens always start closed). */
const HISTORY_PANEL_KEY = 'corpus:history-panel'

function readPreference(): boolean {
  try {
    return window.localStorage.getItem(HISTORY_PANEL_KEY) !== 'closed'
  } catch {
    return true
  }
}

function savePreference(open: boolean) {
  try {
    window.localStorage.setItem(HISTORY_PANEL_KEY, open ? 'open' : 'closed')
  } catch {
    // storage unavailable: the choice lasts for this page only
  }
}

/**
 * The sidebar's history panel. On desktop, showing or hiding it is remembered; on phones the whole
 * sidebar is a drawer that starts closed and closes again after navigating.
 */
export function useHistoryPanel() {
  const [open, setOpen] = useState(true)

  useEffect(() => {
    setOpen(!isNarrowScreen() && readPreference())
  }, [])

  const change = useCallback((next: boolean) => {
    setOpen(next)
    if (!isNarrowScreen()) savePreference(next)
  }, [])

  const closeOnMobile = useCallback(() => {
    if (isNarrowScreen()) setOpen(false)
  }, [])

  return { open, change, closeOnMobile }
}
