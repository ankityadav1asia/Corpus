'use client'

import { useEffect, useRef, useState } from 'react'

export interface Hotkey {
  /** e.g. 'mod+k', 'mod+/', 'alt+1', 'shift+?'. `mod` is ⌘ on macOS and Ctrl elsewhere. */
  combo: string
  handler: (event: KeyboardEvent) => void
  /** Also fire while typing in an input / textarea (default: only for combos with mod). */
  inInputs?: boolean
}

export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
}

/** "⌘" on Apple devices, "Ctrl" elsewhere — decided after mount so server and client HTML match. */
export function useModKeyLabel(): string {
  const [label, setLabel] = useState('Ctrl')
  useEffect(() => setLabel(isMac() ? '⌘' : 'Ctrl'), [])
  return label
}

function matches(event: KeyboardEvent, combo: string): boolean {
  const parts = combo.toLowerCase().split('+')
  const key = parts.pop()
  const mod = parts.includes('mod')
  const wantsCtrl = parts.includes('ctrl') || (mod && !isMac())
  const wantsMeta = parts.includes('meta') || (mod && isMac())
  const wantsAlt = parts.includes('alt')
  const wantsShift = parts.includes('shift')
  if (event.ctrlKey !== wantsCtrl || event.metaKey !== wantsMeta || event.altKey !== wantsAlt) return false
  // Shifted symbols (like "?") already imply Shift; only check it for letters and digits.
  if (key && /^[a-z0-9]$/.test(key) && event.shiftKey !== wantsShift) return false
  const pressed = event.key.toLowerCase()
  // Alt+digit produces other characters on some layouts, so digits are matched by physical key.
  if (key && /^[0-9]$/.test(key)) return event.code === `Digit${key}` || pressed === key
  return pressed === key
}

function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element) return false
  return element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)
}

/** Global keyboard shortcuts; handlers always see the latest props. */
export function useHotkeys(hotkeys: Hotkey[]) {
  const ref = useRef(hotkeys)
  useEffect(() => {
    ref.current = hotkeys
  })

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      for (const hotkey of ref.current) {
        if (!matches(event, hotkey.combo)) continue
        const withModifier = /(mod|ctrl|meta|alt)\+/.test(hotkey.combo)
        if (isTyping(event.target) && !(hotkey.inInputs ?? withModifier)) continue
        event.preventDefault()
        hotkey.handler(event)
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
