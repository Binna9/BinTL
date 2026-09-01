import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { withViewTransition } from "@/lib/viewTransition";

type SetOptions = { instant?: boolean };

/**
 * Like useState, but user-driven updates cross-fade via the View Transitions API.
 * Use `instant: true` when resetting on dialog open or after save.
 */
export function useViewTransitionState<S>(
  initial: S,
): [S, (next: SetStateAction<S>, options?: SetOptions) => void] {
  const [value, setValue] = useState(initial);
  const [rendered, setRendered] = useState(initial);
  const isInitial = useRef(true);
  const skipTransition = useRef(false);

  const set = useCallback((next: SetStateAction<S>, options?: SetOptions) => {
    if (options?.instant) skipTransition.current = true;
    setValue(next);
  }, []);

  useEffect(() => {
    if (isInitial.current) {
      isInitial.current = false;
      return;
    }
    if (Object.is(value, rendered)) return;
    if (skipTransition.current) {
      skipTransition.current = false;
      setRendered(value);
      return;
    }
    withViewTransition(() => setRendered(value));
  }, [value, rendered]);

  return [rendered, set];
}

/** Imperatively cross-fade to the next value without the hook. */
export function transitionSetState<S>(setRendered: Dispatch<SetStateAction<S>>, next: S): void {
  withViewTransition(() => setRendered(next));
}
