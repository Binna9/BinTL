import { Link } from "react-router-dom";
import { cn } from "@/lib/cn";

function DatabaseGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <ellipse cx="12" cy="5.4" rx="7.2" ry="2.5" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M4.8 5.4v4.1c0 1.38 3.22 2.5 7.2 2.5s7.2-1.12 7.2-2.5V5.4"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="M4.8 12.1v4.1c0 1.38 3.22 2.5 7.2 2.5s7.2-1.12 7.2-2.5v-4.1"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="M4.8 16.6v2.1c0 1.38 3.22 2.5 7.2 2.5s7.2-1.12 7.2-2.5v-2.1"
        stroke="currentColor"
        strokeWidth="1.7"
      />
    </svg>
  );
}

export function BrandMark({
  to,
  compact = false,
}: {
  to?: string;
  compact?: boolean;
}) {
  const inner = (
    <>
      <span className={cn("brand-mark-icon", compact ? "size-9" : "size-11")}>
        <DatabaseGlyph />
      </span>
      <span className="leading-tight">
        <span className={cn("brand-mark-word", compact ? "text-[1.15rem]" : "text-[1.45rem]")}>
          BinTL
        </span>
        {compact ? null : (
          <span className="brand-mark-sub">Data workspace</span>
        )}
      </span>
    </>
  );

  const className = "brand-mark flex items-center gap-3 no-underline";
  if (to) {
    return (
      <Link to={to} className={className}>
        {inner}
      </Link>
    );
  }
  return <div className={className}>{inner}</div>;
}
