import { ArrowUpRight } from "lucide-react";
import { motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useLanguage } from "@/i18n/LanguageProvider";
import { fmtWhen } from "@/lib/format";
import { cn } from "@/lib/cn";
import { SEARCH_ENTITY_META, SEARCH_GROUP_ORDER } from "@/lib/searchEntityMeta";
import { searchApi } from "@/services/searchApi";
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

function SearchSummaryIcons({ groups }: { groups: SearchGroup[] }) {
  return (
    <div className="search-page-summary" aria-label={groups.map((g) => `${g.label} ${g.items.length}`).join(", ")}>
      {groups.map((group) => (
        <span key={group.type} className={`search-page-summary-chip ${SEARCH_ENTITY_META[group.type].tone}`}>
          <SearchTypeIcon type={group.type} size="sm" className="search-page-summary-chip-icon" />
          <span className="search-page-summary-chip-count">{group.items.length}</span>
        </span>
      ))}
    </div>
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
        <span className={`search-page-card-icon ${meta.tone}`} aria-hidden="true">
          <meta.icon className="size-[1.05rem]" />
        </span>
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
  const [params] = useSearchParams();
  const query = params.get("q") ?? "";
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const browsing = !query.trim();

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

  const groups = useMemo<SearchGroup[]>(() => {
    const map = new Map<SearchEntityType, SearchHit[]>();
    for (const hit of hits) {
      const bucket = map.get(hit.entity_type) ?? [];
      bucket.push(hit);
      map.set(hit.entity_type, bucket);
    }
    return SEARCH_GROUP_ORDER.filter((type) => map.has(type)).map((type) => ({
      type,
      label: messages.search.types[type],
      items: map.get(type) ?? [],
    }));
  }, [hits, messages.search.types]);

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

        <section
          className={cn(
            "scroll-pane search-page-results",
            !loading && !error && hits.length === 0 && browsing && "search-page-results-empty",
          )}
          aria-live="polite"
        >
          {loading ? (
            <p className="search-page-empty">{messages.common.loading}</p>
          ) : error ? (
            <p className="search-page-empty text-danger">{error}</p>
          ) : hits.length === 0 ? (
            browsing ? (
              <SearchBrowseEmpty message={messages.search.browseEmpty} />
            ) : (
              <p className="search-page-empty">{messages.search.noResults(query.trim())}</p>
            )
          ) : (
            <>
              <div className="search-page-results-head">
                <p className="search-page-results-label">{messages.search.resultsFor(query.trim())}</p>
                <SearchSummaryIcons groups={groups} />
              </div>
              <div className="search-page-groups">
                {groups.map((group) => (
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
        </section>
      </div>
    </div>
  );
}
