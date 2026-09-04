import type { CombineSpec } from "@/types/transform";

/** In-editor recipe sections (one transform = one recipe). */
export type TransformEditorSection = "combine" | "clean" | "aggregate";

export const TRANSFORM_SECTIONS: TransformEditorSection[] = [
  "combine",
  "clean",
  "aggregate",
];

export function parseTransformSection(
  value: string | null | undefined,
): TransformEditorSection {
  if (value === "combine" || value === "aggregate" || value === "clean") return value;
  return "clean";
}

/** Canonical editor URL: `/transform` or `/transform/:id`, optional `?section=`. */
export function transformEditorPath(
  transformId?: string,
  searchOrParams?: string | URLSearchParams,
  section?: TransformEditorSection,
): string {
  const base = transformId ? `/transform/${transformId}` : "/transform";
  const params =
    typeof searchOrParams === "string"
      ? new URLSearchParams(searchOrParams)
      : searchOrParams
        ? new URLSearchParams(searchOrParams)
        : new URLSearchParams();
  if (section && section !== "clean") {
    params.set("section", section);
  } else if (section === "clean") {
    params.delete("section");
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/**
 * Redirect helper for legacy `/transform/{clean|combine|aggregate}(/:id)` URLs.
 * Returns the canonical path including query (merges existing search).
 */
export function legacyTransformRedirectTarget(
  pathname: string,
  search: string,
): string | null {
  const match = pathname.match(
    /^\/transform\/(clean|combine|aggregate)(?:\/([^/]+))?\/?$/,
  );
  if (!match) return null;
  const mode = match[1] as TransformEditorSection;
  const id = match[2];
  return transformEditorPath(id, search, mode);
}

export type CombineDraft = {
  mode: CombineSpec["mode"];
  rightDatasetId?: string;
  unionDatasetIds: string[];
  joinKeys: string[];
  joinHow: "left" | "inner";
};

export function emptyCombineDraft(): CombineDraft {
  return { mode: "join", unionDatasetIds: [], joinKeys: [], joinHow: "left" };
}

export function combineDraftFromSpec(combine?: CombineSpec | null): CombineDraft | null {
  if (!combine) return null;
  if (combine.mode === "join") {
    return {
      mode: "join",
      rightDatasetId: combine.right_dataset_id,
      unionDatasetIds: [],
      joinKeys: combine.on ?? [],
      joinHow: combine.how ?? "left",
    };
  }
  return {
    mode: "union",
    unionDatasetIds: combine.union_dataset_ids ?? [],
    joinKeys: [],
    joinHow: "left",
  };
}

export function combineDraftToSpec(draft: CombineDraft | null): CombineSpec | undefined {
  if (!draft) return undefined;
  if (draft.mode === "join") {
    if (!draft.rightDatasetId || draft.joinKeys.length === 0) return undefined;
    return {
      mode: "join",
      right_dataset_id: draft.rightDatasetId,
      on: draft.joinKeys,
      how: draft.joinHow,
    };
  }
  if (draft.unionDatasetIds.length === 0) return undefined;
  return { mode: "union", union_dataset_ids: draft.unionDatasetIds };
}

export function canPreviewCombine(draft: CombineDraft | null, datasetId?: string): boolean {
  if (!datasetId || !draft) return false;
  return Boolean(combineDraftToSpec(draft));
}
