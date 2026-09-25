/**
 * API contract shared by route handlers (runtime validation) and the UI (types), one file per area.
 * Client components should use `import type` from '@/lib/contracts' so zod stays out of the bundle.
 */
export * from './auth'
export * from './chat'
export * from './common'
export * from './connectors'
export * from './documents'
export * from './integrations'
export * from './notifications'
export * from './quality'
export * from './shares'
export * from './studio'
export * from './workspaces'
