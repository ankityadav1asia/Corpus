/**
 * A cited answer set as a record: the question, the answer with its markers, and the passages it
 * came from with what the system measured about each. Used on the public pages to show what Corpus
 * does; the values are labelled as an example and are not a claim about any real document.
 */
const PASSAGES = [
  {
    index: 1,
    source: 'returns-policy.pdf',
    where: 'page 3',
    relevance: '0.91',
    text: 'Items may be returned within 30 days of delivery when unused and in their original packaging.',
  },
  { index: 2, source: 'support-handbook.md', where: 'section 4.2', relevance: '0.74', text: 'Late returns are refused unless a support lead approves an exception in the ticket.' },
]

export function AnswerRecord() {
  return (
    <figure className="m-0 overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <span className="text-[13px] font-medium text-foreground">Support handbook</span>
        <span className="text-xs text-muted-foreground">Example notebook</span>
      </div>
      <div className="border-b border-border px-5 py-4">
        <p className="text-[13px] text-muted-foreground">Question</p>
        <p className="mt-1 text-[15px] text-foreground">Can a customer return an order after 45 days?</p>
      </div>
      <div className="border-b border-border px-5 py-4">
        <p className="text-[13px] text-muted-foreground">Answer</p>
        <p className="mt-1 text-[15px] leading-relaxed text-ink-2">
          Not by default. Returns are accepted within 30 days of delivery <span className="measured text-cool">[1]</span>. A later return needs an exception approved by a support
          lead <span className="measured text-cool">[2]</span>.
        </p>
      </div>
      <ol className="m-0 list-none divide-y divide-border bg-paper-3 p-0">
        {PASSAGES.map((passage) => (
          <li key={passage.index} className="grid grid-cols-[2rem_minmax(0,1fr)_auto] gap-x-3 px-5 py-3">
            <span className="measured text-sm text-cool">[{passage.index}]</span>
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-medium text-foreground">
                {passage.source}, {passage.where}
              </span>
              <span className="mt-0.5 block text-[13px] leading-relaxed text-muted-foreground">{passage.text}</span>
            </span>
            <span className="measured text-sm text-ink-2" title="Re-ranker relevance (0 to 1)">
              {passage.relevance}
            </span>
          </li>
        ))}
      </ol>
      <figcaption className="border-t border-border px-5 py-2.5 text-xs text-muted-foreground">
        Every line of an answer points at the passage it came from, with its re-ranker relevance.
      </figcaption>
    </figure>
  )
}
