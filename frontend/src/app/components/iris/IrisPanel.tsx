import { ChevronLeft, ChevronRight, MessageSquareText, X } from 'lucide-react';
import { HackathonBadge } from '../judge/JudgeBadges';
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { failureCopy, ERROR_COPY } from './irisCopy';
import { MAX_MESSAGE_CHARS, type IrisState } from './irisController';
import { shouldSubmit } from './irisFormat';
import { DOCK, dragResize, keyResize } from './irisDock';
import { IrisLink } from './IrisEvidencePeek';
import { useIris } from './IrisProvider';
import { IrisPolicyCard } from './IrisPolicyCard';
import { ROUTE_PATHS } from './irisRoutes';
import { IrisTranscript } from './IrisTranscript';
import { useTranscriptFollow } from './irisScroll';

function ContextChip({ state }: { state: IrisState }) {
  const { status, origin } = state.context;
  let text: string;
  if (status === 'resolved' && origin) text = origin.contextLabel;
  else if (status === 'unavailable') text = 'No request Iris can read here';
  else if (status === 'failed') text = 'Could not check this page';
  else text = 'Checking access…';
  return (
    <p className="text-xs text-meta [overflow-wrap:anywhere]" data-testid="iris-context">
      Asking about: <span className="rounded-full bg-chip box-decoration-clone px-2 py-0.5 font-medium text-ink">{text}</span>
    </p>
  );
}

function Composer({ state }: { state: IrisState }) {
  const iris = useIris()!;
  const { controller } = iris;
  // A draft typed in another context (the panel was closed while the page
  // changed) is discarded here, and the notice below says so.
  const carried = iris.draft && iris.draft.epoch === state.draftEpoch ? iris.draft.current : '';
  const dropped = Boolean(iris.draft && iris.draft.epoch !== state.draftEpoch && iris.draft.current.trim());
  const [draft, setDraftState] = useState(carried);
  const [cleared, setCleared] = useState(dropped);
  const epoch = useRef(state.draftEpoch);
  const setDraft = (value: string) => {
    if (iris.draft) {
      iris.draft.current = value;
      iris.draft.epoch = epoch.current;
    }
    setDraftState(value);
  };
  useEffect(() => {
    // Forget the discarded text once, so it is not reported again.
    if (dropped && iris.draft) {
      iris.draft.current = '';
      iris.draft.epoch = epoch.current;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // Moving to another context clears an unsent message, and says so.
  useEffect(() => {
    if (state.draftEpoch === epoch.current) return;
    epoch.current = state.draftEpoch;
    if (draftRef.current.trim()) {
      setDraft('');
      setCleared(true);
    }
  }, [state.draftEpoch]);

  const canSend = controller.canSend();
  const submit = async () => {
    const text = draft.trim();
    if (!text || !canSend) return;
    setCleared(false);
    if (await controller.send(text)) setDraft('');
  };

  return (
    <form
      className="min-w-0 border-t border-hairline p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {cleared ? (
        <p className="mb-2 text-xs text-meta" role="status">
          Your unsent message was cleared because you moved to another page.
        </p>
      ) : null}
      <label htmlFor="iris-message" className="sr-only">
        Message Iris
      </label>
      <textarea
        id="iris-message"
        data-iris-composer
        rows={3}
        maxLength={MAX_MESSAGE_CHARS}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (shouldSubmit({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode })) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder="Ask about this request or your policy"
        aria-describedby="iris-message-hint"
        className="block w-full resize-none rounded-md border border-control-border bg-surface px-3 py-2 text-base text-ink placeholder:text-meta sm:text-sm"
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p id="iris-message-hint" className="min-w-0 text-xs text-meta [overflow-wrap:anywhere]">
          Enter to send · Shift+Enter for a new line · {draft.length}/{MAX_MESSAGE_CHARS}
        </p>
        <button
          type="submit"
          disabled={!canSend || !draft.trim()}
          className="rounded-md bg-lichen px-3 py-1.5 text-sm font-medium text-on-lichen hover:opacity-90 disabled:opacity-50"
          data-testid="iris-send"
        >
          Send
        </button>
      </div>
    </form>
  );
}

function PanelBody({ state }: { state: IrisState }) {
  const iris = useIris()!;
  const { controller } = iris;
  const shownPreviews = new Set(
    state.segments.flatMap((s) => s.items.map((i) => i.view?.preview?.id).filter(Boolean) as string[])
  );
  // Submitted confirmations whose card is no longer in the transcript
  // (expired or trimmed) stay visible here until signed out.
  const orphaned = state.pendingConfirms.filter((p) => !shownPreviews.has(p.previewId) && (p.view || p.phase !== 'settled'));
  const needsNew = state.phase === 'expired' || Boolean(state.limit);
  const empty = state.segments.every((s) => s.items.length === 0);
  // New answers stay in view while the person reads the latest message.
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const lastItem = state.segments.flatMap((s) => s.items).at(-1);
  const { away, unseen, jump } = useTranscriptFollow(
    scrollRef,
    contentRef,
    lastItem ? {
      key: lastItem.key,
      signature: `${lastItem.phase}:${lastItem.view?.status ?? ''}:${lastItem.view?.preview?.id ?? ''}:${JSON.stringify(lastItem.view?.answer?.blocks ?? null)}`,
      records: lastItem.view?.answer?.blocks.some((block) => block.kind !== 'explanation' && block.sourceType === 'account_record') ?? false,
    } : null
  );
  const jumpToBottom = () => {
    jump();
    // The button goes away, so the composer takes the focus it held.
    document.getElementById('iris-message')?.focus();
  };

  return (
    <>
      <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-3" data-testid="iris-scroll">
        <div ref={contentRef} className="min-w-0">
        {orphaned.length ? (
          <div className="mb-4 space-y-3" aria-label="Policy changes you confirmed">
            {orphaned.map((p) =>
              p.view ? (
                <IrisPolicyCard key={p.previewId} preview={p.view} inertReason={null} />
              ) : (
                <p key={p.previewId} className="rounded-lg bg-well p-3 text-sm" role="status">
                  Checking whether your confirmed policy change was applied. Iris will not send it again.
                </p>
              )
            )}
          </div>
        ) : null}
        {state.phase === 'expired' ? (
          <p className="mb-3 rounded-lg bg-well p-3 text-sm" role="status">
            {ERROR_COPY.conversation_expired}
          </p>
        ) : null}
        {state.failure && !state.limit ? (
          <p className="mb-3 rounded-lg bg-alert-tint p-3 text-sm text-alert-text" role="status">
            {failureCopy(state.failure)}
          </p>
        ) : null}
        {state.limit ? (
          <p className="mb-3 rounded-lg bg-well p-3 text-sm" role="status">
            {ERROR_COPY[state.limit]}
          </p>
        ) : null}
        {state.context.status === 'unavailable' ? (
          <div className="mb-3 rounded-lg bg-well p-3 text-sm" role="status">
            <p>Iris cannot read this request for your account. Open one of your requests to ask about it.</p>
            <IrisLink href={ROUTE_PATHS.requests!} className="mt-1 inline-block">
              Open Requests
            </IrisLink>
          </div>
        ) : null}
        {state.context.status === 'failed' ? (
          <div className="mb-3 rounded-lg bg-well p-3 text-sm" role="status">
            <p>{failureCopy(state.context.failure) || 'Iris could not check this page.'}</p>
            <button type="button" onClick={() => void controller.resolveContext()} className="mt-1 rounded-md font-medium text-lichen-text underline">
              Try again
            </button>
          </div>
        ) : null}
        {empty && state.context.status === 'resolved' && state.context.origin?.contextKind === 'account' ? (
          <div className="mb-3 text-sm text-meta">
            <p>Ask about your policy here, for example what a setting does or whether it is on for you.</p>
            <p className="mt-1">
              To ask about a request, open it from Requests. Selecting a request changes what new answers are about; this conversation stays.
            </p>
            <IrisLink href={ROUTE_PATHS.requests!} className="mt-1 inline-block">
              Open Requests
            </IrisLink>
          </div>
        ) : null}
        <IrisTranscript state={state} />
        </div>
        {/* Offered whenever the person is scrolled away from the latest message,
            new reply or not; "New response" beside it only says one arrived. */}
        {away ? (
          <div className="pointer-events-none sticky bottom-0 flex items-center justify-center gap-2 pt-2">
            {unseen ? (
              <span className="pointer-events-auto rounded-full bg-lichen-tint px-2 py-0.5 text-xs font-medium text-lichen-pill" data-testid="iris-new-response">
                New response
              </span>
            ) : null}
            <button
              type="button"
              onClick={jumpToBottom}
              data-testid="iris-jump-bottom"
              className="pointer-events-auto rounded-full border border-lichen-icon bg-surface px-3 py-1.5 text-xs font-medium text-ink outline-none hover:bg-hairline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring forced-colors:focus-visible:outline-[Highlight]"
            >
              Jump to bottom
            </button>
          </div>
        ) : null}
      </div>
      {needsNew ? (
        <div className="border-t border-hairline p-3">
          <button
            type="button"
            onClick={() => void controller.newConversation()}
            className="w-full rounded-md bg-lichen px-3 py-2 text-sm font-medium text-on-lichen hover:opacity-90"
          >
            {/* At the profile cap there is no conversation here to replace, so
                this only asks again; it cannot free a slot. */}
            {state.limit === 'conversation_limit' ? 'Try again' : 'Start a new conversation'}
          </button>
        </div>
      ) : (
        <Composer state={state} />
      )}
    </>
  );
}

/** Focus after closing: the visible launcher, or the new page's heading after Open Requests. */
function restoreFocus(target: 'launcher' | 'heading') {
  if (target === 'heading') {
    // The destination page is lazy; wait for its heading to mount.
    let tries = 0;
    const focusHeading = () => {
      const heading = document.querySelector<HTMLElement>('main h1, main h2');
      if (heading) {
        if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
        heading.focus();
      } else if (tries++ < 20) window.setTimeout(focusHeading, 50);
    };
    window.setTimeout(focusHeading, 0);
    return;
  }
  // The visible launcher: desktop and phone each mount their own.
  document.querySelector<HTMLElement>('[data-iris-launcher]')?.focus();
}

const focusComposer = () => document.querySelector<HTMLElement>('[data-iris-composer]')?.focus();

const DESCRIPTION =
  "Answers come from your Artrelo records and Artrelo's product guides. Iris can prepare a policy change; only you can confirm it.";

function HeaderActions({ docked }: { docked: boolean }) {
  const iris = useIris()!;
  const { state, controller, dock, setPanelWidth, closePanel } = iris;
  const target = 'inline-flex size-6 items-center justify-center rounded-md text-ink hover:bg-accent disabled:opacity-40';
  return (
    // Wraps onto its own row (and within it) rather than squeezing the title
    // when the panel is narrow or the text is large.
    <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1">
      {state.segments.some((s) => s.items.length) ? (
        <button type="button" onClick={() => void controller.newConversation()} className="rounded-md px-2 py-1 text-xs text-ink hover:bg-accent">
          New conversation
        </button>
      ) : null}
      {docked ? (
        <>
          {/* Single-pointer alternative to dragging the divider (WCAG 2.5.7). */}
          <button
            type="button"
            aria-label="Make Ask Iris wider"
            disabled={dock.width >= dock.max}
            onClick={() => setPanelWidth(Math.min(dock.max, dock.width + DOCK.bigStep))}
            className={target}
          >
            <ChevronLeft className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            aria-label="Make Ask Iris narrower"
            disabled={dock.width <= dock.min}
            onClick={() => setPanelWidth(Math.max(dock.min, dock.width - DOCK.bigStep))}
            className={target}
          >
            <ChevronRight className="size-4" aria-hidden />
          </button>
          <button type="button" aria-label="Close Iris" onClick={closePanel} className={target}>
            <X className="size-4" aria-hidden />
          </button>
        </>
      ) : (
        <Dialog.Close className="rounded-md p-1.5 text-ink hover:bg-accent" aria-label="Close Iris">
          <X className="size-4" aria-hidden />
        </Dialog.Close>
      )}
    </div>
  );
}

/** The vertical divider on the docked panel's left edge: drag it, or use the arrow keys. */
function DockDivider() {
  const iris = useIris()!;
  const { dock, setPanelWidth } = iris;
  const drag = useRef<{ id: number; startX: number; startWidth: number } | null>(null);

  const end = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const active = drag.current;
    if (!active || active.id !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    // A cancelled drag (the system took the pointer) puts the width back.
    if (cancelled) setPanelWidth(active.startWidth);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize Ask Iris"
      aria-valuemin={dock.min}
      aria-valuemax={dock.max}
      aria-valuenow={dock.width}
      aria-valuetext={`${dock.width} pixels wide`}
      tabIndex={0}
      data-testid="iris-dock-divider"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, startX: event.clientX, startWidth: dock.width };
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        if (!active || active.id !== event.pointerId) return;
        setPanelWidth(dragResize(active.startWidth, active.startX, event.clientX, dock.min, dock.max));
      }}
      onPointerUp={(event) => end(event, false)}
      onPointerCancel={(event) => end(event, true)}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
      onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
        const next = keyResize(dock.width, event.key, event.shiftKey, dock.min, dock.max);
        if (next === null) return;
        event.preventDefault();
        setPanelWidth(next);
      }}
      className="group flex w-2 shrink-0 cursor-col-resize touch-none justify-center bg-background outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring forced-colors:focus-visible:outline-[Highlight]"
    >
      <span className="h-full w-px bg-hairline group-hover:bg-meta group-focus-visible:bg-ring forced-colors:bg-[CanvasText]" aria-hidden />
    </div>
  );
}

/**
 * Wide screens: a non-modal panel docked beside the page, which reflows into
 * the space the shell reserves. No backdrop, focus trap or scroll lock; the
 * page stays usable. Escape closes it only from inside the panel.
 */
function DockedPanel() {
  const iris = useIris()!;
  const { state, closePanel, takeCloseFocus, dock } = iris;
  const wasOpen = useRef(false);

  useEffect(() => {
    if (state.open && !wasOpen.current) focusComposer();
    if (!state.open && wasOpen.current) restoreFocus(takeCloseFocus());
    wasOpen.current = state.open;
  }, [state.open, takeCloseFocus]);

  if (!state.open) return null;
  return (
    <aside
      aria-labelledby="iris-docked-title"
      aria-describedby="iris-docked-description"
      data-testid="iris-panel"
      data-iris-mode="docked"
      style={{ width: dock.width + DOCK.divider }}
      className="lichen lichen-light fixed inset-y-0 right-0 z-40 flex bg-background font-sans text-ink"
      onKeyDown={(event) => {
        // Only an Escape nothing inside the panel already handled, and not
        // one meant for a popup inside it.
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        const from = event.target as HTMLElement;
        if (from.closest('[role="menu"], [role="listbox"], [role="dialog"]')) return;
        event.preventDefault();
        closePanel();
      }}
    >
      <DockDivider />
      <div className="flex min-w-0 flex-1 flex-col border-l border-hairline">
        <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 border-b border-hairline px-4 py-3">
          <div className="min-w-0 flex-1 basis-32 space-y-1">
            <h2 id="iris-docked-title" className="flex flex-wrap items-center gap-2 text-base font-semibold text-ink">
              <span>Ask Iris</span>
              <HackathonBadge />
            </h2>
            <p id="iris-docked-description" className="text-xs text-meta">
              {DESCRIPTION}
            </p>
            <ContextChip state={state} />
          </div>
          <HeaderActions docked />
        </header>
        <PanelBody state={state} />
      </div>
    </aside>
  );
}

/**
 * Narrower screens: the modal Sheet in its own Lichen light scope, portaled
 * outside the page so legacy pages keep their theme. Right side on a tablet,
 * full screen on a phone.
 */
function SheetPanel() {
  const iris = useIris()!;
  const { state, closePanel, openPanel, takeCloseFocus } = iris;
  return (
    <Dialog.Root open={state.open} onOpenChange={(open) => (open ? openPanel() : closePanel())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:fade-in-0" />
        <Dialog.Content
          className="lichen lichen-light fixed inset-y-0 right-0 z-50 flex h-full w-full flex-col border-l border-hairline bg-background font-sans text-ink shadow-lg sm:max-w-md lg:max-w-lg motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:slide-in-from-right"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            focusComposer();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreFocus(takeCloseFocus());
          }}
          data-testid="iris-panel"
          data-iris-mode="sheet"
        >
          <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 border-b border-hairline px-4 py-3">
            <div className="min-w-0 flex-1 basis-32 space-y-1">
              <Dialog.Title className="flex flex-wrap items-center gap-2 text-base font-semibold text-ink">
                <span>Ask Iris</span>
                <HackathonBadge />
              </Dialog.Title>
              <Dialog.Description className="text-xs text-meta">{DESCRIPTION}</Dialog.Description>
              <ContextChip state={state} />
            </div>
            <HeaderActions docked={false} />
          </header>
          <PanelBody state={state} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The one Iris panel. Docked beside the page when the page keeps at least
 * DOCK.minPage of usable width; otherwise the modal sheet. Both read the same
 * controller, so switching keeps the conversation, previews and draft.
 */
export function IrisPanel() {
  const iris = useIris();
  if (!iris) return null;
  return iris.dock.docked ? <DockedPanel /> : <SheetPanel />;
}

/**
 * "Ask Iris". Exactly one is mounted per breakpoint, like the bell. On a
 * legacy page `ownScope` gives it its own Lichen light scope, so it looks the
 * same everywhere without flipping the page's theme.
 */
export function IrisLauncher({ placement, ownScope = false }: { placement: 'desktop' | 'phone'; ownScope?: boolean }) {
  const iris = useIris();
  if (!iris) return null;
  const button = (
    <button
      type="button"
      data-iris-launcher
      data-testid={`iris-launcher-${placement}`}
      aria-haspopup="dialog"
      aria-expanded={iris.state.open}
      onClick={iris.openPanel}
      className={`inline-flex items-center gap-1.5 rounded-md bg-lichen font-medium text-on-lichen hover:opacity-90 ${
        placement === 'phone' ? 'px-2.5 py-1.5 text-sm' : 'px-3 py-1.5 text-sm'
      }`}
    >
      <MessageSquareText className="size-4" aria-hidden />
      Ask Iris
    </button>
  );
  return ownScope ? (
    <span className="lichen lichen-light contents" data-iris-scope>
      {button}
    </span>
  ) : (
    button
  );
}
