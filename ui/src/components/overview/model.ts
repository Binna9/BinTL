import { successRate } from "@/lib/overview";
import type { ChipKind, ChipRun, WorkspaceExecution } from "@/types/chip";
import type { AssetCounts, DashboardModel, FeedItem, OpsStats } from "./types";

export type ChipRunRow = ChipRun & { chipName: string };

function runAt(run: { started_at?: string | null; finished_at?: string | null; created_at: string }) {
  return run.finished_at || run.started_at || run.created_at;
}

function countStatus(rows: { status: string }[], status: string) {
  return rows.filter((row) => row.status === status).length;
}

function opsFrom(rows: { status: string }[]): OpsStats {
  const running = countStatus(rows, "running");
  const queued = countStatus(rows, "queued");
  const succeeded = countStatus(rows, "succeeded");
  const failed = countStatus(rows, "failed");
  const active = running + queued;
  return { running, queued, succeeded, failed, active, bar: active ? Math.round((running / active) * 100) : 0 };
}

function ofKind(runs: ChipRunRow[], kind: ChipKind) {
  return runs.filter((run) => run.kind === kind);
}

export function toFeed(runs: ChipRunRow[]): FeedItem[] {
  return runs
    .map((run) => ({
      id: run.id,
      kind: run.kind,
      title: run.chipName,
      status: run.status,
      at: runAt(run),
      to: `/workspace/${run.workspace_id}/chips/${run.chip_id}`,
      error: run.error_message ?? null,
    }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

export function buildDashboardModel(input: {
  systemHealth: DashboardModel["systemHealth"];
  chipRuns: ChipRunRow[];
  workspaceRuns: WorkspaceExecution[];
  mineAssets: AssetCounts;
  sharedAssets: AssetCounts;
}): DashboardModel {
  const extracts = ofKind(input.chipRuns, "extract");
  const transforms = ofKind(input.chipRuns, "transform");
  const loads = ofKind(input.chipRuns, "load");
  const sqls = ofKind(input.chipRuns, "sql");
  const validations = ofKind(input.chipRuns, "validation");
  const serves = ofKind(input.chipRuns, "serve");
  const feed = toFeed(input.chipRuns);
  return {
    systemHealth: input.systemHealth,
    mineAssets: input.mineAssets,
    sharedAssets: input.sharedAssets,
    chipOps: opsFrom(input.chipRuns),
    workspaceOps: opsFrom(input.workspaceRuns),
    trendRuns: input.chipRuns.map((run) => ({ kind: run.kind, created_at: run.created_at })),
    feed,
    attention: feed.filter((item) => item.status === "failed").slice(0, 5),
    extractCount: extracts.length,
    transformCount: transforms.length,
    loadCount: loads.length,
    sqlCount: sqls.length,
    validationCount: validations.length,
    serveCount: serves.length,
    extractRate: successRate(extracts),
    transformRate: successRate(transforms),
    loadRate: successRate(loads),
    sqlRate: successRate(sqls),
    validationRate: successRate(validations),
    serveRate: successRate(serves),
  };
}

if (import.meta.env.DEV) {
  const built = buildDashboardModel({
    systemHealth: { ok: true, version: "0" },
    chipRuns: [
      {
        execution_id: "exec-1",
        execution_source: "workspace",
        id: "run-1",
        chip_id: "chip-1",
        workspace_id: "ws-1",
        kind: "load",
        status: "succeeded",
        config_snapshot: {},
        created_at: "2026-09-13T01:00:00Z",
        chipName: "주문 적재",
      },
    ],
    workspaceRuns: [{ id: "exec-1", workspace_id: "ws-1", status: "running", created_at: "2026-09-13T01:00:00Z" }],
    mineAssets: { workspaces: 1, chips: 1, datasets: 0, connections: 0 },
    sharedAssets: { workspaces: 0, chips: 0, datasets: 0, connections: 1 },
  });
  if (built.loadCount !== 1 || built.extractCount !== 0) {
    throw new Error("overview model: load runs must count as load, not zero");
  }
  if (built.chipOps.succeeded !== 1 || built.workspaceOps.running !== 1 || built.chipOps.running !== 0) {
    throw new Error("overview model: chip and workspace ops must stay separate");
  }
  if (built.mineAssets.connections !== 0 || built.sharedAssets.connections !== 1) {
    throw new Error("overview model: shared assets are connections only");
  }
}
