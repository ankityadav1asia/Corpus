export const THEME_STORAGE_KEY = 'corpus-theme'

export type ThemePreference = 'light' | 'dark' | 'system'

/**
 * Inlined in <head> (static string, no user input) so the page never flashes the wrong theme.
 * No stored choice (or 'system') follows the operating system.
 */
export const THEME_BOOTSTRAP_SCRIPT = `try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');var l=t==='light'||(t!=='dark'&&window.matchMedia('(prefers-color-scheme: light)').matches);var d=document.documentElement;d.classList.toggle('light',l);d.classList.toggle('dark',!l)}catch(e){}`
