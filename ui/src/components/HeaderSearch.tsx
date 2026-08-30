import { FormEvent, useState } from "react";
import { ScanSearch, Search, X } from "lucide-react";
import { useLanguage } from "@/i18n/LanguageProvider";

export function HeaderSearch() {
  const { messages } = useLanguage();
  const [query, setQuery] = useState("");

  function onSubmit(event: FormEvent) {
    event.preventDefault();
  }

  return (
    <div className="header-search">
      <span className="header-bloom" aria-hidden="true">
        <ScanSearch className="size-[1.05rem] text-accent" strokeWidth={1.75} />
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
