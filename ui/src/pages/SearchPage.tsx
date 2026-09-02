import { ArrowUpRight, Clock3, ListFilter, Search } from "lucide-react";
import { motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useLanguage } from "@/i18n/LanguageProvider";
import { fmtWhen } from "@/lib/format";
import { cn } from "@/lib/cn";
import { SEARCH_ENTITY_META, SEARCH_GROUP_ORDER } from "@/lib/searchEntityMeta";
import { searchApi } from "@/services/search/searchApi";
import type { SearchEntityType, SearchHit } from "@/types/search";

const listVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.05, delayChildren: 0.04 },
  },
};

const cardVariants = {
  hidden: { opacity: 0, y: 10 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { type: "spring" as const, stiffness: 320, damping: 28 },
  },
};

type SearchGroup = {
  type: SearchEntityType;
  label: string;
  items: SearchHit[];
};

function highlightText(text: string, query: string) {
  const needle = query.trim();
  if (!needle) return text;
  const lower = text.toLowerCase();
  const index = lower.indexOf(needle.toLowerCase());
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark className="search-page-mark">{text.slice(index, index + needle.length)}</mark>
      {text.slice(index + needle.length)}
    </>
  );
}

function SearchTypeIcon({
  type,
  className = "",
  size = "md",
}: {
  type: SearchEntityType;
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  const meta = SEARCH_ENTITY_META[type];
  const Icon = meta.icon;
  return (
    <span className={`search-page-type-icon search-page-type-icon-${size} ${meta.tone} ${className}`}>
      <Icon aria-hidden="true" />
    </span>
  );
}

function SearchTypeFilter({
  groups,
  title,
  highlightResults,
  hiddenTypes,
  onToggle,
}: {
  groups: SearchGroup[];
  title: string;
  highlightResults: boolean;
  hiddenTypes: Set<SearchEntityType>;
  onToggle: (type: SearchEntityType) => void;
}) {
  return (
    <aside className="search-page-filter" aria-label={title}>
      <h2 className="search-page-filter-title">
        <ListFilter className="search-page-filter-title-icon" aria-hidden="true" />
        {title}
      </h2>
      <ul className="search-page-filter-list">
        {groups.map((group) => {
          const count = group.items.length;
          const canToggle = highlightResults && count > 0;
          const active = canToggle && !hiddenTypes.has(group.type);
          return (
            <li key={group.type}>
              <button
                type="button"
                disabled={!canToggle}
                onClick={() => onToggle(group.type)}
                className={cn(
                  "search-page-filter-item",
                  active && "is-active",
                  count === 0 && "is-empty",
                  canToggle && "is-clickable",
                )}
              >
                <SearchTypeIcon type={group.type} size="sm" className="search-page-filter-icon" />
                <span className="search-page-filter-label">{group.label}</span>
                <span className={`search-page-filter-count ${SEARCH_ENTITY_META[group.type].tone}`}>
                  {count}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

function SearchRecentPanel({
  items,
  currentQuery,
  title,
  emptyMessage,
  onPick,
}: {
  items: string[];
  currentQuery: string;
  title: string;
  emptyMessage: string;
  onPick: (query: string) => void;
}) {
  const trimmedCurrent = currentQuery.trim().toLowerCase();

  return (
    <aside className="search-page-filter search-page-recent" aria-label={title}>
      <h2 className="search-page-filter-title">
        <Clock3 className="search-page-filter-title-icon" aria-hidden="true" />
        {title}
      </h2>
      {items.length === 0 ? (
        <p className="search-page-recent-empty">{emptyMessage}</p>
      ) : (
        <ul className="search-page-filter-list">
          {items.map((term) => {
            const active = term.toLowerCase() === trimmedCurrent && trimmedCurrent.length > 0;
            return (
              <li key={term}>
                <button
                  type="button"
                  onClick={() => onPick(term)}
                  className={cn(
                    "search-page-filter-item is-clickable",
                    active && "is-active",
                  )}
                >
                  <span className="search-page-recent-icon" aria-hidden="true">
                    <Search />
                  </span>
                  <span className="search-page-filter-label">{term}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

function SearchSectionHead({ type, label, count }: { type: SearchEntityType; label: string; count: number }) {
  return (
    <div className="search-page-section-head">
      <SearchTypeIcon type={type} size="lg" />
      <div className="min-w-0 flex-1">
        <h2 className="search-page-section-title">{label}</h2>
      </div>
      <span className={`search-page-section-count ${SEARCH_ENTITY_META[type].tone}`}>{count}</span>
    </div>
  );
}

function SearchBrowseEmptyIcon() {
  return (
    <svg className="search-page-empty-icon" viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="18" className="search-page-empty-icon-face" />
      <ellipse cx="14" cy="17" rx="1.6" ry="2.2" className="search-page-empty-icon-eye" />
      <ellipse cx="26" cy="17" rx="1.6" ry="2.2" className="search-page-empty-icon-eye" />
      <path
        d="M13 27.5c2.2 2.4 11.8 2.4 14 0"
        className="search-page-empty-icon-mouth"
        fill="none"
        strokeLinecap="round"
      />
      <path d="M28.5 19.5c0 3.8 1.6 6.8 3.2 8.6 0.5 0.6 0.1 1.6-0.7 1.6h-3.4c-0.9 0-1.4-1-0.9-1.7 1.2-1.6 1.8-3.6 1.8-6.1z" className="search-page-empty-icon-tear" />
    </svg>
  );
}

function SearchBrowseEmpty({ message }: { message: string }) {
  return (
    <div className="search-page-empty-state">
      <SearchBrowseEmptyIcon />
      <p>{message}</p>
    </div>
  );
}

function SearchResultCard({
  item,
  query,
  layout = "row",
}: {
  item: SearchHit;
  query: string;
  layout?: "row" | "tile";
}) {
  const meta = SEARCH_ENTITY_META[item.entity_type];
  const preview = item.preview?.trim() || item.subtitle;

  return (
    <motion.li variants={cardVariants} className="min-w-0">
      <Link
        to={item.route}
        className={layout === "tile" ? "search-page-card search-page-card-tile" : "search-page-card search-page-card-row"}
        data-tone={meta.tone}
      >
        <span className="search-page-card-accent" aria-hidden="true" />
        <span className="search-page-card-body">
          <span className="search-page-card-top">
            <span className="search-page-card-title">{highlightText(item.title, query)}</span>
            <span className="search-page-card-time">{fmtWhen(item.updated_at)}</span>
          </span>
          <span className="search-page-card-subtitle">{item.subtitle}</span>
          {preview ? <span className="search-page-card-preview">{preview}</span> : null}
        </span>
        <ArrowUpRight className="search-page-card-arrow" aria-hidden="true" />
      </Link>
    </motion.li>
  );
}

export function SearchPage() {
  const { messages } = useLanguage();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const query = params.get("q") ?? "";
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [hiddenTypes, setHiddenTypes] = useState<Set<SearchEntityType>>(() => new Set());
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const browsing = !query.trim();
  const highlightTypes = Boolean(query.trim()) && hits.length > 0;

  useEffect(() => {
    setHiddenTypes(new Set());
  }, [query, hits]);

  useEffect(() => {
    void searchApi
      .listRecent()
      .then((response) => setRecentSearches(response.items))
      .catch(() => setRecentSearches([]));
  }, []);

  useEffect(() => {
    const needle = query.trim();
    if (!needle) return;
    void searchApi
      .recordRecent(needle)
      .then((response) => setRecentSearches(response.items))
      .catch(() => {});
  }, [query]);
  useEffect(() => {
    const needle = query.trim();
    if (!needle) {
      setHits([]);
      setLoading(false);
      setError("");
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(
      () => {
        setLoading(true);
        setError("");
        void searchApi
          .search(needle, 24)
          .then((response) => {
            if (!cancelled) setHits(response.items);
          })
          .catch((err: unknown) => {
            if (!cancelled) {
              setHits([]);
              setError(err instanceof Error ? err.message : messages.search.error);
            }
          })
          .finally(() => {
            if (!cancelled) setLoading(false);
          });
      },
      220,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [messages.search.error, query]);

  const filterGroups = useMemo<SearchGroup[]>(
    () =>
      SEARCH_GROUP_ORDER.map((type) => ({
        type,
        label: messages.search.types[type],
        items: hits.filter((hit) => hit.entity_type === type),
      })),
    [hits, messages.search.types],
  );

  const groups = useMemo<SearchGroup[]>(
    () => filterGroups.filter((group) => group.items.length > 0),
    [filterGroups],
  );

  const visibleGroups = useMemo(
    () => groups.filter((group) => !hiddenTypes.has(group.type)),
    [groups, hiddenTypes],
  );

  function toggleType(type: SearchEntityType) {
    if (!highlightTypes) return;
    setHiddenTypes((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  function pickRecentSearch(term: string) {
    navigate(`/search?q=${encodeURIComponent(term)}`);
  }

  return (
    <div className="search-page">
      <div className="search-page-bg" aria-hidden="true">
        <div className="search-page-ink search-page-ink-a" />
        <div className="search-page-ink search-page-ink-b" />
        <div className="search-page-ink search-page-ink-c" />
      </div>

      <div className="search-page-inner">
        <motion.header
          className="search-page-hero"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        >
          <h1 className="search-page-title">{messages.search.title}</h1>
          <p className="search-page-hint">{messages.search.hint}</p>
        </motion.header>

        <div className="search-page-body">
          <div className="search-page-stage">
            {!error ? (
              <SearchTypeFilter
                groups={filterGroups}
                highlightResults={highlightTypes}
                hiddenTypes={hiddenTypes}
                onToggle={toggleType}
                title={messages.search.filterTitle}
              />
            ) : null}

            <section
            className={cn(
              "search-page-results search-page-results-with-filter",
              !loading && !error && hits.length === 0 && browsing && "search-page-results-empty",
              !loading && !error && query.trim() && hits.length === 0 && "search-page-results-empty",
              !loading && !error && hits.length > 0 && visibleGroups.length === 0 && "search-page-results-empty",
            )}
            aria-live="polite"
          >
            {loading || error || hits.length === 0 ? (
              <div
                className={cn(
                  "scroll-pane search-page-results-scroll",
                  !loading && !error && hits.length === 0 && "search-page-results-scroll-empty",
                )}
              >
                {loading ? (
                  <p className="search-page-empty">{messages.common.loading}</p>
                ) : error ? (
                  <p className="search-page-empty text-danger">{error}</p>
                ) : browsing ? (
                  <SearchBrowseEmpty message={messages.search.browseEmpty} />
                ) : (
                  <p className="search-page-empty">{messages.search.noResults(query.trim())}</p>
                )}
              </div>
            ) : (
              <div
                className={cn(
                  "scroll-pane search-page-results-scroll",
                  visibleGroups.length === 0 && "search-page-results-scroll-empty",
                )}
              >
                {visibleGroups.length === 0 ? (
                  <p className="search-page-empty">{messages.search.filterEmpty}</p>
                ) : (
                  <>
                    <div className="search-page-results-head">
                      <p className="search-page-results-label">{messages.search.resultsFor(query.trim())}</p>
                    </div>
                    <div className="search-page-groups">
                      {visibleGroups.map((group) => (
                        <section key={group.type} className="search-page-group">
                          <SearchSectionHead type={group.type} label={group.label} count={group.items.length} />
                          <motion.ul
                            className="search-page-card-stack"
                            initial="hidden"
                            animate="visible"
                            variants={listVariants}
                          >
                            {group.items.map((item) => (
                              <SearchResultCard
                                key={`${item.entity_type}:${item.entity_id}`}
                                item={item}
                                query={query}
                              />
                            ))}
                          </motion.ul>
                        </section>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </section>

            {!error ? (
              <SearchRecentPanel
                items={recentSearches}
                currentQuery={query}
                title={messages.search.recentTitle}
                emptyMessage={messages.search.recentEmpty}
                onPick={pickRecentSearch}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
