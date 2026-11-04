import { useEffect, useState } from 'react';
import { Loader2, Scale, Send } from 'lucide-react';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Textarea } from '../ui/textarea';
import { TenantDialogContent } from './TenantDialogs';
import { TENANT_FIELD } from './tenantPresentation';

export interface AppealRequestTarget {
  requestId: string;
  issueTitle: string;
  summary?: string;
  rejectionReason?: string;
}

const eyebrow = 'text-xs font-semibold uppercase tracking-normal';

type AppealNoteControl =
  | { note: string; onNoteChange: (note: string) => void }
  | { note?: undefined; onNoteChange?: undefined };

export function AppealRequestDialog({
  target,
  busy,
  onClose,
  onConfirm,
  note: controlledNote,
  onNoteChange,
}: {
  target: AppealRequestTarget | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: (note: string) => Promise<void>;
} & AppealNoteControl) {
  const [localNote, setLocalNote] = useState('');

  useEffect(() => {
    setLocalNote('');
  }, [target?.requestId]);

  // A parent that can temporarily unmount this dialog owns the draft/reset.
  // Callers without this pair retain the existing target-local note lifecycle.
  const note = controlledNote === undefined ? localNote : controlledNote;
  const changeNote = (value: string) => {
    if (controlledNote === undefined) setLocalNote(value);
    else onNoteChange?.(value);
  };
  const normalizedNote = note.trim();

  return (
    <Dialog open={Boolean(target)} onOpenChange={(open) => !open && !busy && onClose()}>
      <TenantDialogContent className="lichen lichen-light font-sans text-ink block w-full min-w-0 max-w-[calc(100%-2rem)] sm:max-w-[min(32rem,calc(100%-2rem))] max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto overscroll-contain p-0">
        <div className="h-1 w-full shrink-0 bg-chip" />
        <DialogHeader className="px-4 pt-4">
          <div className="flex min-w-0 flex-col items-start gap-3 text-left sm:flex-row">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-chip text-chip-icon">
              <Scale className="h-5 w-5" />
            </div>
            <div className="min-w-0 w-full flex-1 [overflow-wrap:anywhere] sm:pe-8">
              <DialogTitle className="text-ink">Appeal this rejection</DialogTitle>
              <DialogDescription className="mt-1 text-meta">
                Tell your property manager why this request should be reconsidered.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="min-w-0 px-4 py-5">
          <div className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
            <div className="min-w-0 max-w-full rounded-lg border border-hairline bg-well px-4 py-3">
              <div className={`${eyebrow} text-meta`}>Request</div>
              <div className="mt-1 min-w-0 text-sm font-medium leading-relaxed text-ink">
                {target?.summary || target?.issueTitle}
              </div>
            </div>

            {target?.rejectionReason ? (
              <div className="min-w-0 max-w-full rounded-lg border border-alert-line bg-alert-tint px-4 py-3">
                <div className={`${eyebrow} text-alert-text`}>Reason for rejection</div>
                <div className="mt-1 min-w-0 text-sm leading-relaxed text-ink">{target.rejectionReason}</div>
              </div>
            ) : null}

            <div className="min-w-0">
              <label htmlFor="appeal-note" className="text-sm font-semibold text-ink">
                Your appeal
              </label>
              <p className="mt-1 text-xs text-meta">
                Required. Add any new details or context the manager may have missed. You get one appeal per
                request, so make it count.
              </p>
              <Textarea
                id="appeal-note"
                data-testid="appeal-note"
                value={note}
                onChange={(event) => changeNote(event.target.value)}
                maxLength={1000}
                rows={5}
                className={`mt-3 min-w-0 max-w-full field-sizing-fixed text-base md:text-base border-control-border bg-input-background text-ink placeholder:text-meta focus-visible:border-control-border ${TENANT_FIELD}`}
                placeholder="Explain why this request should be reconsidered..."
                disabled={busy}
              />
              <div className="mt-1 text-right text-xs text-meta">{note.length}/1000</div>
            </div>
          </div>
        </div>

        <DialogFooter className="min-w-0 w-full gap-2 border-t border-hairline bg-well px-4 py-4 sm:flex-wrap">
          <Button variant="outline" className="min-w-0 max-w-full w-full sm:w-auto h-auto min-h-9 whitespace-normal [overflow-wrap:anywhere] flex-wrap border-control-border bg-card lichen:bg-card text-ink" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            data-testid="confirm-appeal"
            className="min-w-0 max-w-full w-full sm:w-auto h-auto min-h-9 whitespace-normal [overflow-wrap:anywhere] flex-wrap gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90"
            disabled={busy || !normalizedNote}
            onClick={() => onConfirm(normalizedNote)}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Submit Appeal
          </Button>
        </DialogFooter>
      </TenantDialogContent>
    </Dialog>
  );
}
