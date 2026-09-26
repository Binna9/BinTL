import { NODE_H, NODE_W, type CanvasNode } from "@/features/workspace/workspaceCanvasModel";

const KEY = "bintl.chip-clipboard";

export type ChipClipboard = {
  sourceWorkspaceId: string;
  chipIds: string[];
  bbox: { x: number; y: number; w: number; h: number };
};

export function chipSelectionBbox(
  chipIds: string[],
  positions: Record<string, CanvasNode>,
  sizeOf: (id: string, node: CanvasNode) => { w: number; h: number } = () => ({ w: NODE_W, h: NODE_H }),
): ChipClipboard["bbox"] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let found = false;
  for (const id of chipIds) {
    const point = positions[id];
    if (!point) continue;
    found = true;
    const size = sizeOf(id, point);
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x + size.w);
    maxY = Math.max(maxY, point.y + size.h);
  }
  if (!found) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function readChipClipboard(): ChipClipboard | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as ChipClipboard;
    if (!value?.sourceWorkspaceId || !Array.isArray(value.chipIds) || value.chipIds.length === 0) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function writeChipClipboard(value: ChipClipboard) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // ponytail: private-mode storage can throw; in-memory paste still works this session
  }
}

let memoryClipboard: ChipClipboard | null = null;

export function rememberChipClipboard(value: ChipClipboard) {
  memoryClipboard = value;
  writeChipClipboard(value);
}

export function currentChipClipboard(): ChipClipboard | null {
  return memoryClipboard ?? readChipClipboard();
}
