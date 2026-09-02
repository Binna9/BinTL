import { httpRequest } from "@/services/httpClient";
import type { RecentSearchesResponse, SearchResponse } from "@/types/search";

export const searchApi = {
  search: (query = "", limit = 24) => {
    const params = new URLSearchParams({
      q: query.trim(),
      limit: String(limit),
    });
    return httpRequest<SearchResponse>(`/api/search?${params.toString()}`, { silent: true });
  },
  listRecent: () =>
    httpRequest<RecentSearchesResponse>("/api/search/recent", { silent: true }),
  recordRecent: (query: string) =>
    httpRequest<RecentSearchesResponse>("/api/search/recent", {
      method: "POST",
      body: JSON.stringify({ query: query.trim() }),
      silent: true,
    }),
};
