import type { CombineSpec } from "@/types/transform";

export type TransformEditorMode = "clean" | "combine" | "aggregate" | "reshape";

export function editorModeFromPath(pathname: string): TransformEditorMode {
  if (pathname.includes("/transform/combine")) return "combine";
  if (pathname.includes("/transform/aggregate")) return "aggregate";
  if (pathname.includes("/transform/reshape")) return "reshape";
  return "clean";
}

export function transformEditorPath(
  mode: TransformEditorMode,
  transformId?: string,
  search = "",
): string {
  const segment = mode === "clean" ? "clean" : mode;
  const base = transformId ? `/transform/${segment}/${transformId}` : `/transform/${segment}`;
  return search ? `${base}?${search}` : base;
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
