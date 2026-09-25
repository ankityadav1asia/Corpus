import type { ConnectorProvider } from '@/lib/contracts'
import { createGitHubConnector } from '@/server/connectors/github'
import { createGoogleDriveConnector, type GoogleClient } from '@/server/connectors/google-drive'
import { createNotionConnector } from '@/server/connectors/notion'
import type { Connector } from '@/server/connectors/types'
import { createWebsiteConnector } from '@/server/connectors/website'

export interface ConnectorRegistry {
  /** null when the provider is not available on this server (e.g. no Google OAuth client). */
  get(provider: ConnectorProvider): Connector | null
  /** Why a provider is unavailable, for the UI. */
  unavailableReason(provider: ConnectorProvider): string | null
}

export function createConnectorRegistry(options: { google: GoogleClient | null }): ConnectorRegistry {
  const connectors: Partial<Record<ConnectorProvider, Connector>> = {
    notion: createNotionConnector(),
    github: createGitHubConnector(),
    website: createWebsiteConnector(),
    ...(options.google ? { google_drive: createGoogleDriveConnector(options.google) } : {}),
  }
  return {
    get: (provider) => connectors[provider] ?? null,
    unavailableReason: (provider) =>
      connectors[provider] ? null : provider === 'google_drive' ? 'Google Drive needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server.' : 'Not available on this server.',
  }
}

/** For tests and alternative wiring: a registry over given connectors. */
export function registryOf(connectors: Partial<Record<ConnectorProvider, Connector>>): ConnectorRegistry {
  return { get: (provider) => connectors[provider] ?? null, unavailableReason: (provider) => (connectors[provider] ? null : 'Not available on this server.') }
}
