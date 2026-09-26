import { useEffect, useMemo, useState } from "react";

export const PAGE_SIZES = [20, 50, 100, 200, 1000] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export const DEFAULT_PAGE_SIZE: PageSize = 20;

export function isPageSize(value: number): value is PageSize {
  return (PAGE_SIZES as readonly number[]).includes(value);
}

export function paginate<T>(items: readonly T[], page: number, pageSize: number) {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize) || 1);
  const safePage = Math.min(Math.max(1, page), pageCount);
  const start = total === 0 ? 0 : (safePage - 1) * pageSize;
  const end = Math.min(start + pageSize, total);
  return {
    page: safePage,
    pageCount,
    pageSize,
    total,
    start,
    end,
    items: items.slice(start, end),
  };
}

export function usePagination<T>(items: readonly T[], resetKey = "", initialPageSize: number = DEFAULT_PAGE_SIZE) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(initialPageSize);

  useEffect(() => {
    setPage(1);
  }, [resetKey]);

  const result = useMemo(
    () => paginate(items, page, pageSize),
    [items, page, pageSize],
  );

  useEffect(() => {
    if (result.page !== page) setPage(result.page);
  }, [page, result.page]);

  function setPageSize(next: number) {
    setPageSizeState(next);
    setPage(1);
  }

  return { ...result, setPage, setPageSize };
}

if (import.meta.env.DEV) {
  const rows = [1, 2, 3, 4, 5];
  const first = paginate(rows, 1, 2);
  console.assert(first.items.join(",") === "1,2" && first.page === 1 && first.pageCount === 3, "pagination: first page");
  console.assert(paginate(rows, 99, 2).items.join(",") === "5" && paginate(rows, 99, 2).page === 3, "pagination: clamp past last");
  console.assert(paginate([], 3, 20).page === 1 && paginate([], 3, 20).end === 0, "pagination: empty stays on page 1");
  console.assert(paginate([1, 2, 3, 4, 5, 6, 7, 8, 9], 1, 8).items.length === 8 && paginate([1, 2, 3, 4, 5, 6, 7, 8, 9], 2, 8).items.join(",") === "9", "pagination: page size 8");
}
