import { useState } from 'react';
import { Loader2, MessageSquarePlus } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { FeedbackAPI } from '../api/client';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { Textarea } from './ui/textarea';

/**
 * "Send feedback", in the landlord and tenant sidebars. Beta metrics show what
 * people do; this is how they tell us why. The page they were on goes with it,
 * so "this is confusing" arrives with the "this".
 */
export default function FeedbackButton({ variant = 'row' }: { variant?: 'row' | 'outline' }) {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const send = async () => {
    if (message.trim().length < 3) {
      toast.error('Tell us a little more first.');
      return;
    }
    setBusy(true);
    try {
      await FeedbackAPI.send({ message: message.trim(), page: location.pathname });
      toast.success('Thanks — we read every message.');
      setMessage('');
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not send that. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {variant === 'row' ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          data-testid="feedback-btn"
          // lichen: matches the landlord shell's nav rows; the tenant sidebar is
          // not a Lichen scope and keeps the slate row.
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 lichen:rounded-md lichen:py-2 lichen:text-nav lichen:hover:bg-hairline/60 lichen:hover:text-ink"
        >
          <MessageSquarePlus className="h-4 w-4" aria-hidden />
          Send feedback
        </button>
      ) : (
        <Button
          variant="outline"
          onClick={() => setOpen(true)}
          data-testid="feedback-btn"
          className="w-full justify-start gap-2"
        >
          <MessageSquarePlus className="h-4 w-4" />
          Send feedback
        </Button>
      )}

      <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Send feedback</DialogTitle>
            <DialogDescription>
              Something confusing, broken, or missing? Tell us. It goes straight to the Artrelo team, and
              we&rsquo;ll reply by email.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            maxLength={4000}
            // The shared Textarea sizes to its content (field-sizing-content),
            // which ignores `rows`; give it room to write, then scroll.
            className="min-h-32 max-h-72 overflow-y-auto"
            placeholder="What happened, and what did you expect?"
            data-testid="feedback-message"
          />
          <Button
            onClick={() => void send()}
            disabled={busy}
            className="w-full gap-2 bg-[#137fec] hover:bg-[#137fec]/90"
            data-testid="feedback-send"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Send
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
