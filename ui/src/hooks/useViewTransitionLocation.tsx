import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation, type Location } from "react-router-dom";
import { withViewTransition } from "@/lib/viewTransition";

const RenderLocationContext = createContext<Location | null>(null);

/** Same workspace canvas: `/workspace/:id` ↔ `/workspace/:id/chips/:chipId`. */
function workspaceCanvasId(pathname: string): string | null {
  if (pathname.startsWith("/workspace/runs")) return null;
  const match = pathname.match(/^\/workspace\/([^/]+)(?:\/chips\/[^/]+)?$/);
  return match?.[1] ?? null;
}

export function ViewTransitionLocationProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [renderLocation, setRenderLocation] = useState(location);
  const isInitial = useRef(true);

  useEffect(() => {
    if (isInitial.current) {
      isInitial.current = false;
      return;
    }
    if (location.key === renderLocation.key) return;
    const fromId = workspaceCanvasId(renderLocation.pathname);
    const toId = workspaceCanvasId(location.pathname);
    // Empty-canvas clicks / chip-detail close stay on the same canvas — skip the global flash.
    if (fromId && toId && fromId === toId) {
      setRenderLocation(location);
      return;
    }
    withViewTransition(() => {
      setRenderLocation(location);
    });
  }, [location, renderLocation.key, renderLocation.pathname]);

  return (
    <RenderLocationContext.Provider value={renderLocation}>{children}</RenderLocationContext.Provider>
  );
}

/** Deferred route location — updates inside a view transition (same feel as theme/locale). */
export function useRenderLocation(): Location {
  const renderLocation = useContext(RenderLocationContext);
  const location = useLocation();
  return renderLocation ?? location;
}
