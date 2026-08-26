import { FormEvent, useId, useState } from "react";
import { Search, X } from "lucide-react";
import { useLanguage } from "@/i18n/LanguageProvider";

function DataMark() {
  const id = useId().replace(/:/g, "");
  const disc = `${id}-disc`;
  const side = `${id}-side`;
  const lid = `${id}-lid`;

  function layer(cy: number) {
    return (
      <g key={cy}>
        <path d={`M7 ${cy} v4.15 a9 3.05 0 0 0 18 0 V${cy}`} fill={`url(#${side})`} />
        <ellipse cx="16" cy={cy} rx="9" ry="3.05" fill={`url(#${lid})`} />
        <ellipse cx="13.1" cy={cy - 0.55} rx="3.4" ry="1.05" fill="#fff" opacity="0.38" />
      </g>
    );
  }

  return (
    <svg viewBox="0 0 32 32" className="size-9" aria-hidden="true">
      <defs>
        <radialGradient id={disc} cx="38%" cy="28%">
          <stop offset="0%" stopColor="#26262b" />
          <stop offset="100%" stopColor="#070708" />
        </radialGradient>
        <linearGradient id={side} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#5a3d90" />
          <stop offset="38%" stopColor="#b59ae8" />
          <stop offset="100%" stopColor="#4a2f78" />
        </linearGradient>
        <radialGradient id={lid} cx="32%" cy="35%">
          <stop offset="0%" stopColor="#f6f0ff" />
          <stop offset="42%" stopColor="#cbb6f2" />
          <stop offset="100%" stopColor="#7a58b6" />
        </radialGradient>
      </defs>
      <circle cx="16" cy="16" r="16" fill={`url(#${disc})`} />
      {layer(19.6)}
      {layer(14.35)}
      {layer(9.1)}
    </svg>
  );
}

export function HeaderSearch() {
  const { messages } = useLanguage();
  const [query, setQuery] = useState("");

  function onSubmit(event: FormEvent) {
    event.preventDefault();
  }

  return (
    <div className="header-search">
      <span className="header-bloom">
        <DataMark />
      </span>
      <form className="header-search-form group" onSubmit={onSubmit}>
        <div className="header-search-shell">
          <Search className="header-search-icon" strokeWidth={2} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={messages.nav.searchPlaceholder}
            aria-label={messages.nav.search}
          />
          {query ? (
            <button
              type="button"
              className="header-search-clear"
              onClick={() => setQuery("")}
              aria-label={messages.common.close}
            >
              <X className="size-4" strokeWidth={2} />
            </button>
          ) : null}
        </div>
      </form>
    </div>
  );
}
