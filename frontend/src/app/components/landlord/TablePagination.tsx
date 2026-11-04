import { ChevronLeft, ChevronRight } from 'lucide-react';
import { pageNumbers } from '../../lib/paginate';
import { cn } from '../ui/utils';

/**
 * "Showing 1–10 of 42" on the left, page buttons on the right — the footer
 * every paged landlord table shares. Renders nothing for a single page, so a
 * short list doesn't carry a control that does nothing.
 */
export default function TablePagination({
  page,
  totalPages,
  total,
  from,
  to,
  noun = 'results',
  onPageChange,
  className,
  testId,
  presentation = false,
}: {
  page: number;
  totalPages: number;
  total: number;
  from: number;
  to: number;
  noun?: string;
  onPageChange: (page: number) => void;
  className?: string;
  testId?: string;
  /** Wallet-only opt-in; route and page handlers remain with the caller. */
  presentation?: boolean;
}) {
  if (totalPages <= 1) return null;

  const button = cn(
    'inline-flex h-8 min-w-8 items-center justify-center rounded-lg border px-2 text-sm font-medium transition disabled:pointer-events-none disabled:opacity-40 in-[.lichen-d3]:rounded-md in-[.lichen-d3]:font-mono in-[.lichen-d3]:motion-reduce:transition-none',
    presentation && 'h-auto min-h-8 max-w-full rounded-md font-mono focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none'
  );

  return (
    <nav
      aria-label="Pagination"
      data-testid={testId}
      className={cn('flex flex-col items-center justify-between gap-3 sm:flex-row', className)}
    >
      <span className="text-xs text-slate-500 in-[.lichen-d3]:text-meta in-[.lichen-wallet]:text-meta">
        Showing {from}–{to} of {total} {noun}
      </span>
      <ul className={cn("flex items-center gap-1", presentation && "max-w-full flex-wrap justify-center")}>
        <li>
          <button
            type="button"
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
            className={cn(button, "border-slate-200 bg-white text-slate-600 hover:bg-slate-50 in-[.lichen-wallet]:border-border in-[.lichen-wallet]:bg-card in-[.lichen-wallet]:text-meta in-[.lichen-wallet]:hover:bg-well in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card in-[.lichen-d3]:text-meta in-[.lichen-d3]:hover:bg-well")}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        </li>
        {pageNumbers(page, totalPages).map((n, index) =>
          n === '…' ? (
            <li key={`gap-${index}`} className="px-1 text-sm text-slate-400 in-[.lichen-d3]:text-meta" aria-hidden>
              …
            </li>
          ) : (
            <li key={n}>
              <button
                type="button"
                aria-label={`Page ${n}`}
                aria-current={n === page ? 'page' : undefined}
                onClick={() => onPageChange(n)}
                className={cn(
                  button,
                  n === page
                    ? 'border-[#137fec]/30 bg-[#137fec]/10 text-[#137fec] in-[.lichen-wallet]:border-transparent in-[.lichen-wallet]:bg-primary in-[.lichen-wallet]:text-primary-foreground in-[.lichen-d3]:border-transparent in-[.lichen-d3]:bg-primary in-[.lichen-d3]:text-primary-foreground'
                    : "border-transparent text-slate-600 hover:bg-slate-100 in-[.lichen-wallet]:text-meta in-[.lichen-wallet]:hover:bg-chip in-[.lichen-d3]:text-meta in-[.lichen-d3]:hover:bg-chip"
                )}
              >
                {n}
              </button>
            </li>
          )
        )}
        <li>
          <button
            type="button"
            aria-label="Next page"
            disabled={page >= totalPages}
            onClick={() => onPageChange(page + 1)}
            className={cn(button, "border-slate-200 bg-white text-slate-600 hover:bg-slate-50 in-[.lichen-wallet]:border-border in-[.lichen-wallet]:bg-card in-[.lichen-wallet]:text-meta in-[.lichen-wallet]:hover:bg-well in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card in-[.lichen-d3]:text-meta in-[.lichen-d3]:hover:bg-well")}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </li>
      </ul>
    </nav>
  );
}
