import { httpRequest } from "@/services/httpClient";
import type { SearchResponse } from "@/types/search";

export const searchApi = {
  search: (query = "", limit = 24) => {
    const params = new URLSearchParams({
      q: query.trim(),
      limit: String(limit),
    });
    return httpRequest<SearchResponse>(`/api/search?${params.toString()}`, { silent: true });
  },
};
