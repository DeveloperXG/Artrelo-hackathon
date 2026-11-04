import { TENANT_FIELD, useTenantPresentation } from '../tenant/tenantPresentation';
import { MessageSquare, Send } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import type { RequestComment } from './requestDetailTypes';
import { DetailCard } from './detailUi';
import { D3_FIELD } from './d3Presentation';

export default function RequestMessagesPanel({
  comments,
  comment,
  onCommentChange,
  onSubmit,
  sending,
  isLandlord,
}: {
  comments: RequestComment[];
  comment: string;
  onCommentChange: (value: string) => void;
  onSubmit: () => void;
  sending: boolean;
  isLandlord: boolean;
}) {
  const tenantPresentation = useTenantPresentation();
  return (
    <DetailCard
      icon={MessageSquare}
      title="Messages"
      description="Shared thread between tenant, landlord, and vendor."
      className="in-[.lichen-d3]:[overflow-wrap:anywhere] in-[.lichen-d5]:[overflow-wrap:anywhere]"
      id="request-detail-tab-messages"
      role={tenantPresentation ? 'region' : 'tabpanel'}
      aria-labelledby={tenantPresentation ? undefined : 'request-detail-tab-button-messages'}
      aria-label={tenantPresentation ? 'Messages' : undefined}
    >
      {comments.length > 0 ? (
        <div className="mb-4 space-y-3" data-testid="detail-comments">
          {comments.map((item, index) => (
            <div
              key={`${item.at}-${index}`}
              className="rounded-xl border border-slate-300 bg-slate-50/70 p-4 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-control-border in-[.lichen-d3]:bg-well in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:border-control-border in-[.lichen-d5]:bg-well"
            >
              <div className="mb-1 text-xs text-slate-500 in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta">
                <b className="capitalize text-slate-700 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink">{item.authorRole}</b> ·{' '}
                {new Date(item.at).toLocaleString()}
              </div>
              <p className="text-sm leading-7 text-slate-700 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink">{item.body}</p>
            </div>
          ))}
        </div>
      ) : (
        <div className="mb-4 rounded-xl border border-dashed border-slate-300 bg-slate-50/60 px-4 py-8 text-center text-sm text-slate-400 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-control-border in-[.lichen-d3]:bg-well in-[.lichen-d3]:text-meta in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:border-control-border in-[.lichen-d5]:bg-well in-[.lichen-d5]:text-meta">
          No comments yet. Start the conversation below.
        </div>
      )}

      <div className="flex gap-2">
        <Input
          data-testid="detail-comment-input"
          aria-label={tenantPresentation ? `Add a comment as ${isLandlord ? 'landlord' : 'tenant'}` : undefined}
          className={`h-10 min-w-0 bg-white in-[.lichen-d3]:bg-card in-[.lichen-d5]:bg-card ${D3_FIELD} ${TENANT_FIELD}`}
          value={comment}
          onChange={(event) => onCommentChange(event.target.value)}
          placeholder={`Add a comment as ${isLandlord ? 'landlord' : 'tenant'}...`}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onSubmit();
          }}
        />
        <Button
          data-testid="detail-comment-send"
          onClick={onSubmit}
          disabled={sending || !comment.trim()}
          aria-label={sending ? 'Sending comment' : 'Send comment'}
          className="h-10 shrink-0 bg-[#137fec] hover:bg-[#137fec]/90 in-[.lichen-d3]:bg-primary in-[.lichen-d3]:hover:bg-primary/90 in-[.lichen-d3]:text-primary-foreground in-[.lichen-d5]:bg-primary in-[.lichen-d5]:hover:bg-primary/90 in-[.lichen-d5]:text-primary-foreground"
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </DetailCard>
  );
}
