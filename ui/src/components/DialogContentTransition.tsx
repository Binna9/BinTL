import { ReactNode, useEffect, useRef, useState } from "react";
import { withViewTransition } from "@/lib/viewTransition";

type Snapshot = { key: unknown; node: ReactNode };

/**
 * Defers child updates through the same root cross-fade used for theme/locale/route changes.
 * Pass a stable `contentKey` when switching tabs, panels, or wizard steps inside a dialog.
 */
export function DialogContentTransition({
  contentKey,
  resetWhen,
  className,
  children,
}: {
  contentKey?: string | number | null;
  resetWhen?: unknown;
  className?: string;
  children: ReactNode;
}) {
  const [rendered, setRendered] = useState<Snapshot>(() => ({
    key: contentKey,
    node: children,
  }));
  const isInitial = useRef(true);
  const skipTransition = useRef(false);
  const prevResetWhen = useRef(resetWhen);

  useEffect(() => {
    if (resetWhen !== prevResetWhen.current) {
      prevResetWhen.current = resetWhen;
      skipTransition.current = true;
      isInitial.current = true;
    }
  }, [resetWhen]);

  useEffect(() => {
    if (contentKey === undefined) return;

    if (isInitial.current) {
      isInitial.current = false;
      setRendered({ key: contentKey, node: children });
      return;
    }

    if (contentKey === rendered.key) {
      setRendered((prev) =>
        prev.key === contentKey ? { key: contentKey, node: children } : prev,
      );
      return;
    }

    const nextNode = children;
    if (skipTransition.current) {
      skipTransition.current = false;
      setRendered({ key: contentKey, node: nextNode });
      return;
    }

    withViewTransition(() => {
      setRendered({ key: contentKey, node: nextNode });
    });
  }, [contentKey, children, rendered.key]);

  if (contentKey === undefined) {
    return className ? <div className={className}>{children}</div> : children;
  }

  const body = rendered.node;
  return className ? <div className={className}>{body}</div> : body;
}
