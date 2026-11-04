import type { IrisState, Segment, TurnItem } from './irisController';
import { IrisAnswer } from './IrisBlocks';
import { ERROR_COPY, STOPPED_COPY, failureCopy } from './irisCopy';
import { useIris } from './IrisProvider';
import { IrisPolicyCard } from './IrisPolicyCard';

function Turn({ item, segment, current }: { item: TurnItem; segment: Segment; current: boolean }) {
  const iris = useIris();
  if (!iris) return null;
  const { controller } = iris;
  const view = item.view;
  const historicalLabel = current ? null : segment.origin.contextLabel;
  const busy = item.phase === 'sending' || item.phase === 'active';
  const lastActivity = view?.activities.length ? view.activities[view.activities.length - 1] : null;
  const canChoose = current && controller.canSend();

  return (
    // Who said what is a visible word, not only colour or alignment: the person's
    // message is a right-aligned chip, Iris's reply a framed card on the left.
    <li className="space-y-3" data-testid="iris-turn">
      <div className="ml-8 rounded-lg border border-control-border bg-chip px-3 py-2 text-sm text-ink" data-testid="iris-you">
        <p className="text-xs font-medium text-meta">You</p>
        <p className="mt-0.5 whitespace-pre-line [overflow-wrap:anywhere]">{item.text}</p>
      </div>
      <div className="mr-4 rounded-lg border border-hairline bg-surface p-3 text-sm text-ink" data-testid="iris-reply">
        <p className="mb-2 text-xs font-medium text-meta">Iris</p>
        {busy ? (
          <div className="flex items-center gap-3" role="status">
            <span className="inline-block size-2 rounded-full bg-lichen motion-safe:animate-pulse" aria-hidden />
            <span className="text-meta">{lastActivity?.label || (item.phase === 'sending' ? 'Sending…' : 'Reading your records…')}</span>
            <button
              type="button"
              onClick={() => controller.stop(item.key)}
              className="rounded-md border border-control-border bg-surface px-2 py-0.5 text-xs text-ink hover:bg-accent"
            >
              Stop
            </button>
          </div>
        ) : null}
        {item.phase === 'stopped' ? <p className="text-meta">{STOPPED_COPY[item.stoppedBy ?? 'person']}</p> : null}
        {item.phase === 'failed' ? (
          <div className="text-alert-text">
            <p>{failureCopy(item.failure)}</p>
            {current && !item.turnId && (item.failure?.kind === 'transport' || item.failure?.kind === 'unexpected') ? (
              <button type="button" onClick={() => void controller.retry(item.key)} className="mt-1 rounded-md font-medium text-lichen-text underline">
                Try again
              </button>
            ) : null}
          </div>
        ) : null}
        {item.phase === 'done' && view ? (
          <div className="space-y-3">
            {view.status === 'cancelled' ? <p className="text-meta">{STOPPED_COPY.person}</p> : null}
            {view.status === 'interrupted' && !view.error ? <p className="text-alert-text">{ERROR_COPY.turn_interrupted}</p> : null}
            {view.error ? <p className="text-alert-text">{ERROR_COPY[view.error.code]}</p> : null}
            {view.answer ? (
              <IrisAnswer
                answer={view.answer}
                historicalLabel={historicalLabel}
                onChoose={canChoose ? (value) => void controller.send(value) : null}
              />
            ) : null}
            {view.preview ? (
              <IrisPolicyCard
                preview={view.preview}
                inertReason={current ? null : 'This preview belongs to an earlier page and is no longer active. No change was applied.'}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Every segment stays visible, in order, under the label the server gave it
 * when it began. Answers from earlier segments are history, not current facts:
 * their previews are inert and their sources are re-read on demand.
 */
export function IrisTranscript({ state }: { state: IrisState }) {
  const currentKey = state.context.status === 'resolved' ? state.context.origin?.segmentId : null;
  return (
    <div role="log" aria-live="polite" aria-relevant="additions" aria-label="Iris conversation" className="space-y-4">
      {state.trimmed ? (
        <p className="rounded-lg bg-well px-3 py-2 text-xs text-meta">Earlier messages were removed to keep this conversation within its limit.</p>
      ) : null}
      {state.segments.map((segment, index) => {
        const current = segment.key === currentKey && segment.generation === state.generation;
        return (
          <section key={`${segment.key}:${segment.generation}`} aria-label={`About ${segment.origin.contextLabel}`} data-testid="iris-segment">
            <div className="flex items-center gap-2 text-xs text-ink" data-testid="iris-divider">
              <span className="h-px min-w-4 flex-1 bg-lichen" aria-hidden />
              <span className="min-w-0 text-center [overflow-wrap:anywhere]">
                {index === 0 ? 'Asking about' : 'Now asking about'}: <span className="font-medium text-ink">{segment.origin.contextLabel}</span>
              </span>
              <span className="h-px min-w-4 flex-1 bg-lichen" aria-hidden />
            </div>
            <ul className="mt-3 space-y-4">
              {segment.items.map((item) => (
                <Turn key={item.key} item={item} segment={segment} current={current} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
