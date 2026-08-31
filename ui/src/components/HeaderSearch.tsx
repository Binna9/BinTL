import { FormEvent, useEffect, useId, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useRenderLocation } from "@/hooks/useViewTransitionLocation";
import { useLanguage } from "@/i18n/LanguageProvider";
import { searchApi } from "@/services/searchApi";
import type { SearchHit } from "@/types/search";

const PREVIEW_LIMIT = 8;

function highlightText(text: string, query: string) {
  const needle = query.trim();
  if (!needle) return text;
  const lower = text.toLowerCase();
  const index = lower.indexOf(needle.toLowerCase());
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark className="header-search-preview-mark">{text.slice(index, index + needle.length)}</mark>
      {text.slice(index + needle.length)}
    </>
  );
}

export function HeaderSearch() {
  const { messages } = useLanguage();
  const navigate = useNavigate();
  const location = useRenderLocation();
  const listId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const onSearchPage = location.pathname === "/search";
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const trimmed = query.trim();
  const showPreview = focused && trimmed.length > 0;

  useEffect(() => {
    if (!onSearchPage) {
      setQuery("");
      return;
    }
    const params = new URLSearchParams(location.search);
    setQuery(params.get("q") ?? "");
  }, [location.search, onSearchPage]);

  useEffect(() => {
    if (!showPreview) {
      setHits([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      void searchApi
        .search(trimmed, PREVIEW_LIMIT)
        .then((response) => {
          if (!cancelled) setHits(response.items);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 220);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [showPreview, trimmed]);

  useEffect(() => {
    if (!showPreview) return;
    function onPointerDown(event: PointerEvent) {
      if (!formRef.current?.contains(event.target as Node)) {
        setFocused(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [showPreview]);

  function goSearch(next: string) {
    const nextTrimmed = next.trim();
    setFocused(false);
    navigate(nextTrimmed ? `/search?q=${encodeURIComponent(nextTrimmed)}` : "/search");
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    goSearch(query);
  }

  function pickHit(route: string) {
    setFocused(false);
    navigate(route);
  }

  return (
    <div className={onSearchPage ? "header-search header-search-active" : "header-search"}>
      <span className="header-search-brand" aria-hidden="true">
        {messages.nav.searchBar}
      </span>
      <form
        ref={formRef}
        className="header-search-form group"
        onSubmit={onSubmit}
        role="search"
      >
        <div className="header-search-shell">
          <Search className="header-search-icon" strokeWidth={2} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onFocus={() => setFocused(true)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setFocused(false);
            }}
            placeholder={messages.nav.searchPlaceholder}
            aria-label={messages.nav.search}
            aria-expanded={showPreview}
            aria-controls={showPreview ? listId : undefined}
            aria-autocomplete="list"
            autoComplete="off"
          />
          {query ? (
            <button
              type="button"
              className="header-search-clear"
              onClick={() => {
                setQuery("");
                setFocused(false);
              }}
              aria-label={messages.common.close}
            >
              <X className="size-4" strokeWidth={2} />
            </button>
          ) : null}
        </div>

        {showPreview ? (
          <div
            id={listId}
            className="header-search-preview"
            role="listbox"
            aria-label={messages.nav.search}
            onMouseDown={(event) => event.preventDefault()}
          >
            <div className="scroll-pane header-search-preview-body">
              {loading ? (
                <p className="header-search-preview-empty">{messages.common.loading}</p>
              ) : hits.length === 0 ? (
                <p className="header-search-preview-empty">{messages.search.noResults(trimmed)}</p>
              ) : (
                <ul className="header-search-preview-list">
                  {hits.map((item) => (
                    <li key={`${item.entity_type}:${item.entity_id}`}>
                      <button
                        type="button"
                        className="header-search-preview-item"
                        role="option"
                        onClick={() => pickHit(item.route)}
                      >
                        <span className="header-search-preview-type">
                          {messages.search.types[item.entity_type]}
                        </span>
                        <span className="header-search-preview-title">
                          {highlightText(item.title, trimmed)}
                        </span>
                        <span className="header-search-preview-subtitle">{item.subtitle}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <button
              type="button"
              className="header-search-preview-footer"
              onClick={() => goSearch(query)}
            >
              {messages.search.viewAllResults(trimmed)}
            </button>
          </div>
        ) : null}
      </form>
    </div>
  );
}
