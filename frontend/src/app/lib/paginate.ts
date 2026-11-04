/**
 * Client-side paging for lists the landlord pages already hold in full
 * (tenants, invite codes, vendors). The wallet pages on the server instead,
 * because its journal only grows — see getLedger.
 */

export type Page<T> = {
  rows: T[];
  /** 1-based, clamped into range — a filter that shrinks the list never strands you on an empty page. */
  page: number;
  totalPages: number;
  total: number;
  /** 1-based index of the first row shown, 0 when there are none. */
  from: number;
  to: number;
};

export function paginate<T>(items: T[], page: number, pageSize: number): Page<T> {
  const size = Math.max(1, Math.floor(pageSize));
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
  const start = (current - 1) * size;
  const rows = items.slice(start, start + size);
  return {
    rows,
    page: current,
    totalPages,
    total,
    from: total ? start + 1 : 0,
    to: start + rows.length,
  };
}

/**
 * The page buttons to draw: always the first and last, a window around the
 * current page, and `'…'` where a run is skipped. Seven slots at most, so the
 * control keeps its width as the list grows.
 */
export function pageNumbers(page: number, totalPages: number): Array<number | '…'> {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const window = new Set([1, totalPages, page - 1, page, page + 1]);
  if (page <= 3) [2, 3, 4].forEach((n) => window.add(n));
  if (page >= totalPages - 2) [totalPages - 3, totalPages - 2, totalPages - 1].forEach((n) => window.add(n));
  const sorted = [...window].filter((n) => n >= 1 && n <= totalPages).sort((a, b) => a - b);
  const out: Array<number | '…'> = [];
  sorted.forEach((n, i) => {
    if (i > 0 && n - sorted[i - 1] > 1) out.push('…');
    out.push(n);
  });
  return out;
}
