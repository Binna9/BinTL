import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import { isPageSize, PAGE_SIZES, type PageSize } from "@/lib/pagination";

export function PaginationBar({
  page,
  pageCount,
  pageSize,
  total,
  start,
  end,
  onPageChange,
  onPageSizeChange,
  disabled = false,
  className,
}: {
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  start: number;
  end: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: PageSize) => void;
  disabled?: boolean;
  className?: string;
}) {
  const { messages } = useLanguage();
  const from = total === 0 ? 0 : start + 1;

  return (
    <div
      className={cn(
        "flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border bg-surface px-3 py-1.5",
        className,
      )}
    >
      <div className="flex items-center gap-2 text-xs text-text-secondary">
        {onPageSizeChange ? (
          <>
            <span className="sr-only">{messages.common.rowsPerPage}</span>
            <Select
              className="h-8 !w-[4.75rem] technical"
              value={String(pageSize)}
              disabled={disabled}
              options={PAGE_SIZES.map((size) => ({ value: String(size), label: String(size) }))}
              onChange={(value) => {
                const next = Number(value);
                if (isPageSize(next)) onPageSizeChange(next);
              }}
            />
          </>
        ) : null}
        <span className="tabular-nums">{messages.common.pageRange(from, end, total)}</span>
      </div>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="quiet"
          className="!px-2"
          disabled={disabled || page <= 1}
          aria-label={messages.common.prevPage}
          title={messages.common.prevPage}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
        </Button>
        <span className="min-w-[3.5rem] text-center text-xs tabular-nums text-text-secondary">
          {messages.common.pageOf(page, pageCount)}
        </span>
        <Button
          type="button"
          variant="quiet"
          className="!px-2"
          disabled={disabled || page >= pageCount}
          aria-label={messages.common.nextPage}
          title={messages.common.nextPage}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRight className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
