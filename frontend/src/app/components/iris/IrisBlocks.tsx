import { Fragment, useState, type ReactNode } from 'react';
import type { Answer, Block, Evidence, SourceType } from '../../types/irisV2';
import { NOTICE_TITLES } from './irisCopy';
import { formatTime } from './irisFormat';
import { IrisEvidencePeek, IrisLink } from './IrisEvidencePeek';
import { NOTICE_ROUTES, ROUTE_PATHS } from './irisRoutes';

const SOURCE_BADGE: Record<SourceType, string | null> = {
  product_guide: 'Product guide',
  account_record: 'Your records',
  system_notice: null,
};

const ANSWER_SOURCE: Record<Answer['source'], string> = {
  offline_stub: 'Prepared answer from your records (no AI)',
  deterministic_records: 'Straight from your records',
  meta: 'Iris',
  model_planned: 'Iris chose what to show (AI); figures come straight from your records',
};

/** Contract narration.provenanceLabel. */
export const EXPLANATION_LABEL = 'Iris explanation';

export function SourceBadge({ sourceType }: { sourceType: SourceType }) {
  const label = SOURCE_BADGE[sourceType];
  if (!label) return null;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        sourceType === 'product_guide' ? 'bg-mist-tint text-mist-text' : 'bg-lichen-tint text-lichen-pill'
      }`}
    >
      {label}
    </span>
  );
}

function Sources({
  refs,
  evidence,
  historicalLabel,
}: {
  refs: string[];
  evidence: Map<string, Evidence>;
  historicalLabel: string | null;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const items = refs.map((ref) => evidence.get(ref)).filter((e): e is Evidence => Boolean(e));
  if (!items.length) return null;
  return (
    <div className="mt-2">
      <div className="flex flex-wrap gap-1.5">
        {items.map((e) => (
          <button
            key={e.ref}
            type="button"
            aria-expanded={open === e.ref}
            onClick={() => setOpen(open === e.ref ? null : e.ref)}
            className="inline-flex max-w-full items-center rounded-full border border-hairline bg-chip px-2.5 py-0.5 text-xs text-ink hover:bg-accent"
          >
            <span className="text-left [overflow-wrap:anywhere]">Source: {e.label}</span>
          </button>
        ))}
      </div>
      {open && evidence.get(open) ? (
        <IrisEvidencePeek key={open} evidence={evidence.get(open)!} historicalLabel={historicalLabel} />
      ) : null}
    </div>
  );
}

/**
 * A table too wide for a narrow sheet or large text scrolls inside a named,
 * focusable region instead of clipping a value or widening the page.
 */
export function TableRegion({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      data-testid={testId}
      className="mt-1 min-w-0 max-w-full overflow-x-auto rounded-lg border border-hairline outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring forced-colors:focus-visible:outline-[Highlight]"
    >
      {children}
    </div>
  );
}

/** Each row's own sources; the one opened shows in a full-width row under it. */
function RowSources({
  rowKey,
  refs,
  evidence,
  open,
  setOpen,
}: {
  rowKey: number;
  refs: string[];
  evidence: Map<string, Evidence>;
  open: { row: number; ref: string } | null;
  setOpen: (next: { row: number; ref: string } | null) => void;
}) {
  const items = refs.map((ref) => evidence.get(ref)).filter((e): e is Evidence => Boolean(e));
  if (!items.length) return <span className="text-meta">—</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((e) => {
        const isOpen = open?.row === rowKey && open.ref === e.ref;
        return (
          <button
            key={e.ref}
            type="button"
            aria-expanded={isOpen}
            onClick={() => setOpen(isOpen ? null : { row: rowKey, ref: e.ref })}
            className="inline-flex max-w-full items-center rounded-full border border-hairline bg-chip px-2.5 py-0.5 text-left text-xs text-ink hover:bg-accent"
          >
            <span className="[overflow-wrap:anywhere]">Source: {e.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function PeekRow({
  rowKey,
  columns,
  evidence,
  open,
  historicalLabel,
}: {
  rowKey: number;
  columns: number;
  evidence: Map<string, Evidence>;
  open: { row: number; ref: string } | null;
  historicalLabel: string | null;
}) {
  if (open?.row !== rowKey || !evidence.get(open.ref)) return null;
  return (
    <tr>
      <td colSpan={columns} className="px-3 pb-2">
        <IrisEvidencePeek key={open.ref} evidence={evidence.get(open.ref)!} historicalLabel={historicalLabel} />
      </td>
    </tr>
  );
}

const CELL = 'px-3 py-1.5 align-top';
// Column floors, set on the header cells. Without them a long Event or Value
// column squeezes the others until a name or a source pill breaks one letter
// per line; with them a narrow panel scrolls the table inside its region.
const COL = {
  item: 'min-w-[7rem]',
  value: 'min-w-[8rem]',
  when: 'min-w-[6.5rem]',
  who: 'min-w-[6rem]',
  event: 'min-w-[12rem]',
  source: 'min-w-[9rem]',
} as const;

function FactsTable({
  block,
  evidence,
  historicalLabel,
  grouped = false,
}: {
  block: Extract<Block, { kind: 'facts' }>;
  evidence: Map<string, Evidence>;
  historicalLabel: string | null;
  grouped?: boolean;
}) {
  const [open, setOpen] = useState<{ row: number; ref: string } | null>(null);
  return (
    <div>
      {!grouped && <SourceBadge sourceType={block.sourceType} />}
      <TableRegion label={block.title || 'Details from your records'} testId="iris-facts">
        <table className="w-full min-w-[24rem] text-left text-sm">
          <caption className={block.title ? 'px-3 pt-2 text-left font-medium' : 'sr-only'}>{block.title || 'Details from your records'}</caption>
          <thead>
            <tr className="text-xs text-meta">
              <th scope="col" className={`${CELL} ${COL.item} font-normal`}>Type</th>
              <th scope="col" className={`${CELL} ${COL.value} font-normal`}>Value</th>
              <th scope="col" className={`${CELL} ${COL.source} font-normal`}>Source</th>
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, i) => (
              <Fragment key={i}>
                <tr className="border-t border-hairline">
                  <th scope="row" className={`${CELL} font-normal text-meta [overflow-wrap:anywhere]`}>{row.label}</th>
                  <td className={`${CELL} [overflow-wrap:anywhere]`}>{row.value}</td>
                  <td className={CELL}>
                    <RowSources rowKey={i} refs={row.evidenceRefs} evidence={evidence} open={open} setOpen={setOpen} />
                  </td>
                </tr>
                <PeekRow rowKey={i} columns={3} evidence={evidence} open={open} historicalLabel={historicalLabel} />
              </Fragment>
            ))}
          </tbody>
        </table>
      </TableRegion>
    </div>
  );
}

function TimelineTable({
  block,
  evidence,
  historicalLabel,
  grouped = false,
}: {
  block: Extract<Block, { kind: 'timeline' }>;
  evidence: Map<string, Evidence>;
  historicalLabel: string | null;
  grouped?: boolean;
}) {
  const [open, setOpen] = useState<{ row: number; ref: string } | null>(null);
  return (
    <div>
      {!grouped && <SourceBadge sourceType={block.sourceType} />}
      <TableRegion label="Recorded events" testId="iris-timeline">
        <table className="w-full min-w-[33.5rem] text-left text-sm">
          <caption className="sr-only">Recorded events, in their recorded order</caption>
          <thead>
            <tr className="text-xs text-meta">
              <th scope="col" className={`${CELL} ${COL.when} font-normal`}>When</th>
              <th scope="col" className={`${CELL} ${COL.who} font-normal`}>Who</th>
              <th scope="col" className={`${CELL} ${COL.event} font-normal`}>Event</th>
              <th scope="col" className={`${CELL} ${COL.source} font-normal`}>Source</th>
            </tr>
          </thead>
          <tbody>
            {block.events.map((event, i) => (
              <Fragment key={i}>
                <tr className="border-t border-hairline">
                  <td className={`${CELL} text-meta`}>{event.at ? <time dateTime={event.at}>{formatTime(event.at)}</time> : 'Time not recorded'}</td>
                  <td className={`${CELL} [overflow-wrap:anywhere]`}>{event.actorLabel || 'Unknown'}</td>
                  <th scope="row" className={`${CELL} font-normal`}>
                    <span className="font-medium">{event.title}</span>
                    {event.text ? <span className="mt-0.5 block [overflow-wrap:anywhere]">{event.text}</span> : null}
                  </th>
                  <td className={CELL}>
                    <RowSources rowKey={i} refs={event.evidenceRefs} evidence={evidence} open={open} setOpen={setOpen} />
                  </td>
                </tr>
                <PeekRow rowKey={i} columns={4} evidence={evidence} open={open} historicalLabel={historicalLabel} />
              </Fragment>
            ))}
          </tbody>
        </table>
      </TableRegion>
    </div>
  );
}

function BlockView({
  block,
  evidence,
  historicalLabel,
  onChoose,
  grouped = false,
}: {
  block: Block;
  evidence: Map<string, Evidence>;
  historicalLabel: string | null;
  onChoose: ((value: string) => void) | null;
  grouped?: boolean;
}) {
  switch (block.kind) {
    case 'explanation':
      // The model's only prose: plain text, set apart from the record tables
      // by a rule and its own label rather than a card, so it never reads as a
      // record or a receipt. Whether Confirm shows is decided by the preview
      // alone, never by anything this text says.
      return (
        <div className="border-l-2 border-control-border pl-3" data-testid="iris-explanation">
          <p className="text-xs font-medium text-meta">{EXPLANATION_LABEL}</p>
          <p className="mt-0.5 whitespace-pre-line [overflow-wrap:anywhere]">{block.text}</p>
          <Sources refs={block.evidenceRefs} evidence={evidence} historicalLabel={historicalLabel} />
        </div>
      );
    case 'paragraph':
      return (
        <div>
          {!grouped && <SourceBadge sourceType={block.sourceType} />}
          <p className="mt-1 whitespace-pre-line [overflow-wrap:anywhere]">{block.text}</p>
          <Sources refs={block.evidenceRefs} evidence={evidence} historicalLabel={historicalLabel} />
        </div>
      );
    case 'facts':
      return <FactsTable block={block} evidence={evidence} historicalLabel={historicalLabel} grouped={grouped} />;
    case 'cost_table': {
      const refs = [...block.rows, ...block.footerRows].flatMap((r) => r.cells.flatMap((c) => c.evidenceRefs));
      return (
        <div>
          {!grouped && <SourceBadge sourceType={block.sourceType} />}
          <TableRegion label={block.caption} testId="iris-cost-table">
            <table className="w-full min-w-[16rem] text-left text-sm">
              <caption className="px-3 pt-2 text-left font-medium">{block.caption}</caption>
              <thead>
                <tr className="text-xs text-meta">
                  <th scope="col" className={`px-3 py-1.5 ${COL.item} font-normal`}>
                    <span className="sr-only">Item</span>
                  </th>
                  {block.columns.map((c, i) => (
                    <th key={i} scope="col" className="px-3 py-1.5 text-right font-normal">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, i) => (
                  <tr key={i} className="border-t border-hairline">
                    <th scope="row" className="px-3 py-1.5 font-normal">
                      {row.label}
                    </th>
                    {row.cells.map((cell, j) => (
                      <td key={j} className="whitespace-nowrap px-3 py-1.5 text-right font-mono tabular-nums">
                        {cell.text}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              {block.footerRows.length ? (
                <tfoot>
                  {block.footerRows.map((row, i) => (
                    <tr key={i} className="border-t border-hairline font-medium">
                      <th scope="row" className="px-3 py-1.5">
                        {row.label}
                      </th>
                      {row.cells.map((cell, j) => (
                        <td key={j} className="whitespace-nowrap px-3 py-1.5 text-right font-mono tabular-nums" colSpan={j === row.cells.length - 1 ? block.columns.length - row.cells.length + 1 : 1}>
                          {cell.text}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tfoot>
              ) : null}
            </table>
          </TableRegion>
          <Sources refs={[...new Set(refs)]} evidence={evidence} historicalLabel={historicalLabel} />
        </div>
      );
    }
    case 'timeline':
      return <TimelineTable block={block} evidence={evidence} historicalLabel={historicalLabel} grouped={grouped} />;
    case 'notice': {
      const route = NOTICE_ROUTES[block.code];
      const href = route ? ROUTE_PATHS[route] : null;
      return (
        <div role="note" className="rounded-lg border border-hairline bg-well p-3" data-notice={block.code}>
          <p className="font-medium">{NOTICE_TITLES[block.code]}</p>
          <p className="mt-0.5 [overflow-wrap:anywhere]">{block.text}</p>
          {href ? (
            <IrisLink href={href} className="mt-1 inline-block">
              {route === 'policy' ? 'View Policy' : 'Open Requests'}
            </IrisLink>
          ) : null}
          <Sources refs={block.evidenceRefs} evidence={evidence} historicalLabel={historicalLabel} />
        </div>
      );
    }
    case 'clarification':
      return (
        <div className="rounded-lg border border-hairline bg-well p-3">
          <p className="font-medium">{block.question}</p>
          {block.choices.length ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {block.choices.map((choice, i) => (
                <button
                  key={i}
                  type="button"
                  disabled={!onChoose}
                  onClick={() => onChoose?.(choice.value)}
                  className="rounded-md border border-control-border bg-surface px-3 py-1 text-sm text-ink hover:bg-accent disabled:opacity-50"
                >
                  {choice.label}
                </button>
              ))}
            </div>
          ) : (
            <p className="mt-1 text-xs text-meta">Reply in the message box below.</p>
          )}
        </div>
      );
    default:
      return (
        <div role="note" className="rounded-lg border border-hairline bg-well p-3 text-meta">
          This part of the answer cannot be shown.
        </div>
      );
  }
}

/** Closed block/evidence metadata and canonical server captions, never prose parsing. */
function recordRefs(block: Block): string[] {
  switch (block.kind) {
    case 'facts': return block.rows.flatMap((row) => row.evidenceRefs);
    case 'timeline': return block.events.flatMap((event) => event.evidenceRefs);
    case 'cost_table': return [...block.rows, ...block.footerRows].flatMap((row) => row.cells.flatMap((cell) => cell.evidenceRefs));
    default: return 'evidenceRefs' in block ? block.evidenceRefs : [];
  }
}

function recordSection(block: Block, evidence: Map<string, Evidence>): string {
  if (block.kind === 'timeline') return 'Events';
  if (block.kind === 'cost_table') return 'Costs';
  if (block.kind === 'facts') {
    // These are backend-owned captions on typed FactsBlock, not model narration.
    const canonical: Record<string, string> = {
      'Visit changes': 'Visits',
      'Recorded decisions and policy evidence': 'Decisions',
      'Your current setting': 'Policy',
    };
    if (block.title && Object.hasOwn(canonical, block.title)) return canonical[block.title];
  }
  const kinds = recordRefs(block).map((ref) => evidence.get(ref)?.kind);
  if (kinds.length && kinds.every((kind) => kind === 'scheduling_event')) return 'Visits';
  if (kinds.length && kinds.every((kind) => kind === 'decision' || kind === 'checkpoint')) return 'Decisions';
  if (kinds.length && kinds.every((kind) => kind === 'policy_revision' || kind === 'policy_change')) return 'Policy';
  return 'Other records';
}

function RecordsGroup({ blocks, evidence, historicalLabel, onChoose }: {
  blocks: Block[]; evidence: Map<string, Evidence>; historicalLabel: string | null;
  onChoose: ((value: string) => void) | null;
}) {
  const sections = new Map<string, Block[]>();
  for (const block of blocks) {
    const section = recordSection(block, evidence);
    sections.set(section, [...(sections.get(section) ?? []), block]);
  }
  const refs = blocks.flatMap(recordRefs).map((ref) => evidence.get(ref)).filter((e): e is Evidence => Boolean(e));
  const request = refs.some((e) => e.requestId !== null);
  const account = refs.some((e) => e.kind === 'policy_revision' || e.kind === 'policy_change');
  const title = request ? (account ? 'Request and account records' : 'Request records') :
    sections.size === 1 && sections.has('Policy') ? 'Account Policy records' : 'Records';
  return (
    <section aria-label={title} className="min-w-0 space-y-3" data-testid="iris-records-group">
      <div>
        <h3 className="font-medium text-ink">{title}</h3>
        <SourceBadge sourceType="account_record" />
      </div>
      {[...sections].map(([section, items]) => (
        <section key={section} aria-label={section} className="min-w-0 space-y-2">
          <h4 className="text-sm font-medium text-ink">{section}</h4>
          {items.map((block) => <BlockView key={block.id} block={block} evidence={evidence} historicalLabel={historicalLabel} onChoose={onChoose} grouped />)}
        </section>
      ))}
    </section>
  );
}

/** Renders only server Blocks; no model text is ever turned into markup. */
export function IrisAnswer({
  answer,
  historicalLabel,
  onChoose,
}: {
  answer: Answer;
  historicalLabel: string | null;
  onChoose: ((value: string) => void) | null;
}) {
  const evidence = new Map(answer.evidence.map((e) => [e.ref, e]));
  const records = answer.blocks.filter((block) => block.kind !== 'explanation' && block.sourceType === 'account_record');
  const firstRecord = records[0]?.id;
  return (
    <div className="min-w-0 space-y-3">
      {answer.blocks.map((block) => records.includes(block) ? (
        block.id === firstRecord ? <RecordsGroup key={block.id} blocks={records} evidence={evidence} historicalLabel={historicalLabel} onChoose={onChoose} /> : null
      ) : <BlockView key={block.id} block={block} evidence={evidence} historicalLabel={historicalLabel} onChoose={onChoose} />)}
      <p className="text-xs text-meta">
        {ANSWER_SOURCE[answer.source]}
        {answer.coverage === 'partial' ? ' · Partial: some records were not included' : ''}
        {answer.coverage === 'unknown' ? ' · Coverage unknown' : ''}
      </p>
    </div>
  );
}
