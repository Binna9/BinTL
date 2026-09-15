import type { NavigateFunction } from "react-router-dom";

let navigateRef: NavigateFunction | null = null;

export function registerAppNavigate(navigate: NavigateFunction): void {
  navigateRef = navigate;
}

export function unregisterAppNavigate(): void {
  navigateRef = null;
}

/** SPA navigation; falls back to a hard redirect outside React Router. */
export function appNavigate(to: string, options?: { replace?: boolean }): void {
  if (navigateRef) {
    navigateRef(to, options);
    return;
  }
  if (options?.replace) location.replace(to);
  else location.assign(to);
}

export function redirectToLogin(): void {
  if (location.pathname === "/login") return;
  appNavigate("/login", { replace: true });
}

/** Full-bleed canvas only — not chip editors under `/workspace/:id/chips/:id/{extract|...}`. */
export function isWorkspaceCanvasPath(pathname: string): boolean {
  if (pathname === "/workspace") return true;
  if (pathname.startsWith("/workspace/runs")) return false;
  return /^\/workspace\/[^/]+(?:\/chips\/[^/]+)?$/.test(pathname);
}

export function workspaceCanvasId(pathname: string): string | null {
  if (pathname === "/workspace" || !isWorkspaceCanvasPath(pathname)) return null;
  return pathname.match(/^\/workspace\/([^/]+)/)?.[1] ?? null;
}
