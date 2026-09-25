'use client'

import { Loader2, Save, SlidersHorizontal } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import { useBusyAction } from '@/hooks/use-busy-action'
import { apiJson } from '@/lib/api-client'
import type { WorkspaceSettings } from '@/lib/contracts'

import { GroupHeading, NumberField, Row, Section } from './layout'

function inRange(settings: WorkspaceSettings): boolean {
  const { retrieval: r, guardrail: g, evaluation: e } = settings
  const within = (value: number, min: number, max: number) => Number.isFinite(value) && value >= min && value <= max
  return (
    within(r.candidatePool, 5, 50) &&
    within(r.topK, 1, 10) &&
    r.topK <= r.candidatePool &&
    within(r.multiQueryCount, 3, 5) &&
    within(g.minRelevance, 0, 1) &&
    within(g.minSimilarity, 0, 1) &&
    within(e.sampleRate, 0, 1)
  )
}

type Update = <G extends keyof WorkspaceSettings>(group: G, change: Partial<WorkspaceSettings[G]>) => void

function RetrievalFields({ settings, readOnly, update }: { settings: WorkspaceSettings; readOnly: boolean; update: Update }) {
  const { retrieval } = settings
  return (
    <>
      <GroupHeading first>Re-ranking</GroupHeading>
      <Row label="Re-rank passages" hint="Score the fused candidates against the question and keep the best">
        <Switch label="Re-rank passages" checked={retrieval.rerank} disabled={readOnly} onChange={(rerank) => update('retrieval', { rerank })} />
      </Row>
      <Row label="Candidates (top N)" hint="Passages retrieved by hybrid search, 5–50">
        <NumberField label="Candidates" value={retrieval.candidatePool} min={5} max={50} disabled={readOnly} onChange={(candidatePool) => update('retrieval', { candidatePool })} />
      </Row>
      <Row label="Passages sent to the model (top K)" hint="1–10">
        <NumberField label="Top K" value={retrieval.topK} min={1} max={10} disabled={readOnly} onChange={(topK) => update('retrieval', { topK })} />
      </Row>

      <GroupHeading>Deep mode query expansion</GroupHeading>
      <Row label="Query variations" hint="Multi-query rewrites, 3–5">
        <NumberField
          label="Query variations"
          value={retrieval.multiQueryCount}
          min={3}
          max={5}
          disabled={readOnly}
          onChange={(multiQueryCount) => update('retrieval', { multiQueryCount })}
        />
      </Row>
      <Row label="Step-back question" hint="Also search a broader question about the concept">
        <Switch label="Step-back question" checked={retrieval.stepBack} disabled={readOnly} onChange={(stepBack) => update('retrieval', { stepBack })} />
      </Row>
      <Row label="Hypothetical answer (HyDE)" hint="Search with an embedded draft answer">
        <Switch label="HyDE" checked={retrieval.hyde} disabled={readOnly} onChange={(hyde) => update('retrieval', { hyde })} />
      </Row>
    </>
  )
}

function GuardrailFields({ settings, readOnly, update }: { settings: WorkspaceSettings; readOnly: boolean; update: Update }) {
  const { guardrail } = settings
  const thresholdsOff = readOnly || !guardrail.enabled
  return (
    <>
      <GroupHeading>Source guardrail</GroupHeading>
      <Row label="Withhold weakly supported answers" hint="Replies “Insufficient context in knowledge base.” instead">
        <Switch label="Source guardrail" checked={guardrail.enabled} disabled={readOnly} onChange={(enabled) => update('guardrail', { enabled })} />
      </Row>
      <Row label="Minimum re-ranker relevance" hint="0–1, used when re-ranking succeeded">
        <NumberField
          label="Minimum relevance"
          value={guardrail.minRelevance}
          min={0}
          max={1}
          step={0.05}
          disabled={thresholdsOff}
          onChange={(minRelevance) => update('guardrail', { minRelevance })}
        />
      </Row>
      <Row label="Minimum similarity" hint="0–1, fallback when no re-ranker score exists">
        <NumberField
          label="Minimum similarity"
          value={guardrail.minSimilarity}
          min={0}
          max={1}
          step={0.05}
          disabled={thresholdsOff}
          onChange={(minSimilarity) => update('guardrail', { minSimilarity })}
        />
      </Row>
    </>
  )
}

function EvaluationFields({ settings, readOnly, update }: { settings: WorkspaceSettings; readOnly: boolean; update: Update }) {
  const { evaluation } = settings
  return (
    <>
      <GroupHeading>Evaluation</GroupHeading>
      <Row label="Score answers in the background" hint="Faithfulness, answer relevance, context precision">
        <Switch label="Background evaluation" checked={evaluation.enabled} disabled={readOnly} onChange={(enabled) => update('evaluation', { enabled })} />
      </Row>
      <Row label="Share of answers scored (%)" hint="Each score costs one model call">
        <NumberField
          label="Evaluation sample rate"
          value={Math.round(evaluation.sampleRate * 100)}
          min={0}
          max={100}
          step={5}
          disabled={readOnly || !evaluation.enabled}
          onChange={(percent) => update('evaluation', { sampleRate: percent / 100 })}
        />
      </Row>
    </>
  )
}

/** Retrieval, guardrail and evaluation settings: admins edit and save them, others can read them. */
export function RetrievalSection({ workspaceId, saved, isAdmin, onSaved }: { workspaceId: string; saved: WorkspaceSettings; isAdmin: boolean; onSaved: () => Promise<unknown> }) {
  const { toast } = useToast()
  const { busy, run } = useBusyAction()
  const [settings, setSettings] = useState(saved)

  useEffect(() => {
    setSettings(saved)
  }, [saved])

  const update: Update = (group, change) => setSettings((current) => ({ ...current, [group]: { ...current[group], ...change } }))

  const save = () =>
    void run('settings', async () => {
      await apiJson(`/api/workspaces/${workspaceId}`, { method: 'PATCH', json: { settings } })
      await onSaved()
      toast({ description: 'Settings saved. They apply to the next question.' })
    })

  const readOnly = !isAdmin
  const dirty = JSON.stringify(settings) !== JSON.stringify(saved)
  const valid = inRange(settings)
  return (
    <Section
      title="Retrieval & answer quality"
      icon={<SlidersHorizontal className="size-4 text-primary" />}
      description={readOnly ? 'Only workspace admins can change these settings.' : 'Applies to every question asked in this workspace.'}
    >
      <div className="space-y-3">
        <RetrievalFields settings={settings} readOnly={readOnly} update={update} />
        <GuardrailFields settings={settings} readOnly={readOnly} update={update} />
        <EvaluationFields settings={settings} readOnly={readOnly} update={update} />
      </div>
      {isAdmin && (
        <div className="flex items-center justify-end gap-2 pt-2">
          {dirty && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setSettings(saved)}>
              Discard
            </Button>
          )}
          <Button type="button" size="sm" onClick={save} disabled={!dirty || !valid || busy === 'settings'}>
            {busy === 'settings' ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <Save className="mr-2 size-3.5" />}
            Save settings
          </Button>
        </div>
      )}
      {isAdmin && !valid && <p className="text-right text-[11px] text-destructive">Some values are out of range (top K cannot exceed the candidate count).</p>}
    </Section>
  )
}
