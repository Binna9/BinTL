import {
  AppWindow,
  Cable,
  DatabaseZap,
  FileSpreadsheet,
  FolderTree,
  Puzzle,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { SearchEntityType } from "@/types/search";

export type SearchEntityMeta = {
  icon: LucideIcon;
  tone: string;
};

export const SEARCH_ENTITY_META: Record<SearchEntityType, SearchEntityMeta> = {
  workspace: { icon: AppWindow, tone: "search-tone-blue" },
  workspace_folder: { icon: FolderTree, tone: "search-tone-violet" },
  chip: { icon: Puzzle, tone: "search-tone-purple" },
  dataset: { icon: FileSpreadsheet, tone: "search-tone-emerald" },
  connection: { icon: Cable, tone: "search-tone-amber" },
  extract: { icon: DatabaseZap, tone: "search-tone-cyan" },
  transform: { icon: Workflow, tone: "search-tone-indigo" },
};

export const SEARCH_GROUP_ORDER: SearchEntityType[] = [
  "workspace",
  "workspace_folder",
  "chip",
  "dataset",
  "extract",
  "transform",
  "connection",
];
