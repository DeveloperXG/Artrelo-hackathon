import { describe, expect, it } from 'vitest';
import { pageNumbers, paginate } from './paginate';

describe('paginate', () => {
  const items = Array.from({ length: 23 }, (_, i) => i + 1);

  it('slices the requested page', () => {
    const page = paginate(items, 2, 10);
    expect(page.rows).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(page).toMatchObject({ page: 2, totalPages: 3, total: 23, from: 11, to: 20 });
  });

  it('returns a short last page', () => {
    expect(paginate(items, 3, 10)).toMatchObject({ rows: [21, 22, 23], from: 21, to: 23 });
  });

  it('clamps a page past the end, e.g. after a search shrinks the list', () => {
    expect(paginate(items, 9, 10).page).toBe(3);
    expect(paginate(items, 0, 10).page).toBe(1);
  });

  it('reports an empty list as one empty page', () => {
    expect(paginate([], 1, 10)).toEqual({ rows: [], page: 1, totalPages: 1, total: 0, from: 0, to: 0 });
  });
});

describe('pageNumbers', () => {
  it('lists every page when there are few', () => {
    expect(pageNumbers(2, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it('elides the far side near the start', () => {
    expect(pageNumbers(1, 20)).toEqual([1, 2, 3, 4, '…', 20]);
  });

  it('elides both sides in the middle', () => {
    expect(pageNumbers(10, 20)).toEqual([1, '…', 9, 10, 11, '…', 20]);
  });

  it('elides the near side at the end', () => {
    expect(pageNumbers(20, 20)).toEqual([1, '…', 17, 18, 19, 20]);
  });
});
