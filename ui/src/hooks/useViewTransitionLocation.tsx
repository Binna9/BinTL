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
    withViewTransition(() => {
      setRenderLocation(location);
    });
  }, [location, renderLocation.key]);

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
