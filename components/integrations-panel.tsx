'use client'

import { AlertCircle, Check, Copy, Loader2, MessageSquareShare, Plus, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import useSWR from 'swr'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { useCollections } from '@/hooks/use-api'
import { apiJson, errorMessage } from '@/lib/api-client'
import type { IntegrationProvider, IntegrationSummary } from '@/lib/contracts'
import { timeAgo } from '@/lib/format'

const PROVIDERS: Record<IntegrationProvider, { label: string; steps: string[] }> = {
  slack: {
    label: 'Slack',
    steps: [
      'Create a Slack app (api.slack.com/apps) and add the bot scopes app_mentions:read, chat:write and im:history.',
      'Install it to your Slack workspace and copy the Bot User OAuth Token (xoxb-…) and the Signing Secret.',
      'After connecting here, paste the endpoint below as the Event Subscriptions Request URL and subscribe to app_mention and message.im.',
    ],
  },
  teams: {
    label: 'Microsoft Teams',
    steps: [
      'Create an Azure Bot resource (single tenant is the default) and a client secret for its Microsoft App ID.',
      'After connecting here, set the endpoint below as the bot’s Messaging endpoint and enable the Microsoft Teams channel.',
      'Add the bot to Teams (Developer Portal app package), then @mention it in a channel or chat with it directly.',
    ],
  },
}

function CopyEndpoint({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center gap-1.5">
      <input
        readOnly
        value={value}
        aria-label="Endpoint URL"
        onFocus={(event) => event.target.select()}
        className="h-7 min-w-0 flex-1 rounded-md border border-border/60 bg-background px-2 font-mono text-[10px]"
      />
      <button
        type="button"
        aria-label="Copy endpoint"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
          } catch {
            // clipboard unavailable — the field is selectable
          }
        }}
        className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/60 text-muted-foreground hover:text-foreground"
      >
        {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  )
}

/** Slack and Microsoft Teams bots that answer questions from this workspace (admins). */
export function IntegrationsPanel({ workspaceId }: { workspaceId: string }) {
  const { toast } = useToast()
  const collections = useCollections()
  const list = useSWR(`/api/workspaces/${workspaceId}/integrations`, (path: string) => apiJson<{ integrations: IntegrationSummary[] }>(path, { workspaceId: null }))
  const [adding, setAdding] = useState<IntegrationProvider | null>(null)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ name: '', collectionId: '', botToken: '', signingSecret: '', appId: '', appPassword: '', tenantId: '' })
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm((current) => ({ ...current, [key]: event.target.value }))

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!adding) return
    setBusy(true)
    const common = { provider: adding, name: form.name.trim() || PROVIDERS[adding].label, collectionId: form.collectionId || null }
    const body =
      adding === 'slack'
        ? { ...common, botToken: form.botToken.trim(), signingSecret: form.signingSecret.trim() }
        : { ...common, appId: form.appId.trim(), appPassword: form.appPassword.trim(), tenantId: form.tenantId.trim() || null }
    try {
      await apiJson<{ integration: IntegrationSummary }>(`/api/workspaces/${workspaceId}/integrations`, { method: 'POST', json: body, workspaceId: null })
      toast({ title: `${PROVIDERS[adding].label} connected`, description: 'Now paste the endpoint into the app settings (shown below).' })
      setAdding(null)
      setForm({ name: '', collectionId: '', botToken: '', signingSecret: '', appId: '', appPassword: '', tenantId: '' })
      await list.mutate()
    } catch (error) {
      toast({ variant: 'destructive', description: errorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  async function remove(integration: IntegrationSummary) {
    if (!window.confirm(`Disconnect “${integration.name}”? The bot will stop answering.`)) return
    try {
      await apiJson(`/api/workspaces/${workspaceId}/integrations/${integration.id}`, { method: 'DELETE', workspaceId: null })
      await list.mutate()
    } catch (error) {
      toast({ variant: 'destructive', description: errorMessage(error) })
    }
  }

  const notebooks = collections.data?.collections ?? []
  const integrations = list.data?.integrations ?? []
  return (
    <div className="space-y-3">
      {list.isLoading ? (
        <Loader2 className="size-4 animate-spin text-primary" />
      ) : (
        integrations.map((integration) => (
          <div key={integration.id} className="space-y-2 rounded-xl border border-border/60 bg-secondary/20 p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-semibold">
                  {integration.name} <span className="font-normal text-muted-foreground">· {PROVIDERS[integration.provider].label}</span>
                </p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {integration.account ?? 'Unknown account'} · answers from{' '}
                  {integration.allNotebooks ? 'all notebooks' : (notebooks.find((notebook) => notebook.id === integration.collectionId)?.name ?? 'a deleted notebook')}
                  {integration.lastUsedAt ? ` · last answered ${timeAgo(integration.lastUsedAt)}` : ' · not used yet'}
                </p>
              </div>
              <button
                type="button"
                aria-label={`Disconnect ${integration.name}`}
                onClick={() => void remove(integration)}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
            {integration.status === 'error' && integration.lastError && (
              <p className="flex items-start gap-1.5 text-[11px] text-destructive">
                <AlertCircle className="mt-0.5 size-3 shrink-0" /> {integration.lastError}
              </p>
            )}
            <div>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {integration.provider === 'slack' ? 'Request URL (Event Subscriptions)' : 'Messaging endpoint'}
              </p>
              <CopyEndpoint value={integration.endpoint} />
            </div>
          </div>
        ))
      )}

      {adding ? (
        <form onSubmit={submit} className="space-y-2.5 rounded-xl border border-primary/30 bg-primary/5 p-3">
          <p className="text-xs font-semibold">Connect {PROVIDERS[adding].label}</p>
          <ol className="list-decimal space-y-1 pl-4 text-[11px] text-muted-foreground">
            {PROVIDERS[adding].steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="integration-name">Name</Label>
              <Input id="integration-name" value={form.name} onChange={set('name')} placeholder={`${PROVIDERS[adding].label} bot`} maxLength={80} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="integration-notebook">Answers from</Label>
              <Select id="integration-notebook" value={form.collectionId} onChange={set('collectionId')}>
                <option value="">All notebooks</option>
                {notebooks.map((notebook) => (
                  <option key={notebook.id} value={notebook.id}>
                    {notebook.name}
                  </option>
                ))}
              </Select>
            </div>
            {adding === 'slack' ? (
              <>
                <div className="space-y-1">
                  <Label htmlFor="slack-token">Bot token</Label>
                  <Input id="slack-token" type="password" autoComplete="off" value={form.botToken} onChange={set('botToken')} placeholder="xoxb-…" required />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="slack-secret">Signing secret</Label>
                  <Input id="slack-secret" type="password" autoComplete="off" value={form.signingSecret} onChange={set('signingSecret')} required />
                </div>
              </>
            ) : (
              <>
                <div className="space-y-1">
                  <Label htmlFor="teams-app">Microsoft App ID</Label>
                  <Input id="teams-app" value={form.appId} onChange={set('appId')} placeholder="00000000-0000-…" required />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="teams-secret">Client secret</Label>
                  <Input id="teams-secret" type="password" autoComplete="off" value={form.appPassword} onChange={set('appPassword')} required />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor="teams-tenant">Tenant ID (single-tenant bots)</Label>
                  <Input id="teams-tenant" value={form.tenantId} onChange={set('tenantId')} placeholder="Leave empty for a multi-tenant bot" />
                </div>
              </>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">Anyone who can message the bot gets answers from the chosen notebooks. Secrets are encrypted and never shown again.</p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(null)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              {busy && <Loader2 className="mr-2 size-3.5 animate-spin" />}
              Check and connect
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          {(Object.keys(PROVIDERS) as IntegrationProvider[]).map((provider) => (
            <Button key={provider} type="button" variant="outline" size="sm" className="text-xs" onClick={() => setAdding(provider)}>
              <Plus className="mr-1.5 size-3.5" />
              {PROVIDERS[provider].label}
            </Button>
          ))}
          {integrations.length === 0 && (
            <p className="flex w-full items-center gap-1.5 text-[11px] text-muted-foreground">
              <MessageSquareShare className="size-3.5" /> Let your team ask questions from Slack or Teams.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
