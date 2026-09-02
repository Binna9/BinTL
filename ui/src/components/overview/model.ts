import { bucketActivity, fileName, successRate } from "@/lib/overview";
import type { ExtractRecord } from "@/types/extract";
import type { EtlJob } from "@/types/job";
import type { DashboardModel, FeedItem } from "./types";

function countStatus(rows: { status: string }[], status: string) {
  return rows.filter((row) => row.status === status).length;
}

export function toFeed(extracts: ExtractRecord[], jobs: EtlJob[]): FeedItem[] {
  return [
    ...extracts.map((row) => ({
      id: row.id,
      kind: "extract" as const,
      title: row.table_name || row.filename || row.id.slice(0, 8),
      status: row.status,
      at: row.created_at,
      to: "/extracts",
      error: row.error_message,
    })),
    ...jobs.map((row) => ({
      id: row.id,
      kind: "transform" as const,
      title: fileName(row.source_path) || row.id.slice(0, 8),
      status: row.status,
      at: row.created_at,
      to: `/jobs/${row.id}`,
      error: row.error_message,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));
}

export function buildDashboardModel(input: {
  systemHealth: DashboardModel["systemHealth"];
  recentJobs: EtlJob[];
  recentExtracts: ExtractRecord[];
  workspaceCount: number;
  activeChipCount: number;
  datasetCount: number;
  connectionCount: number;
}): DashboardModel {
  const work = [...input.recentJobs, ...input.recentExtracts];
  const running = countStatus(work, "running");
  const queued = countStatus(work, "queued");
  const succeeded = countStatus(work, "succeeded");
  const failed = countStatus(work, "failed");
  const active = running + queued;
  const feed = toFeed(input.recentExtracts, input.recentJobs);
  return {
    ...input,
    running,
    queued,
    succeeded,
    failed,
    active,
    bar: active ? Math.round((running / active) * 100) : 0,
    days: bucketActivity(input.recentExtracts, input.recentJobs),
    feed,
    attention: feed.filter((item) => item.status === "failed").slice(0, 5),
    extractRate: successRate(input.recentExtracts),
    transformRate: successRate(input.recentJobs),
    funnelMax: Math.max(input.recentExtracts.length, input.recentJobs.length, 1),
  };
}
