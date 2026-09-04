import { ReactNode, useEffect, useRef, useState } from "react";
import { withViewTransition } from "@/lib/viewTransition";

/**
 * Cross-fades when `contentKey` changes (tabs / wizard steps).
 * Same-key child updates render live so controlled inputs (IME) stay in sync.
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
  const [activeKey, setActiveKey] = useState(contentKey);
  const exitNodeRef = useRef<ReactNode>(children);
  const isInitial = useRef(true);
  const skipTransition = useRef(false);
  const prevResetWhen = useRef(resetWhen);
  const childrenRef = useRef(children);
  childrenRef.current = children;

  // Keep the exit snapshot current only while the panel identity is stable.
  // Do not drive live paint through state — that lag breaks Korean/Japanese IME.
  if (contentKey === activeKey) {
    exitNodeRef.current = children;
  }

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
      setActiveKey(contentKey);
      exitNodeRef.current = childrenRef.current;
      return;
    }

    if (contentKey === activeKey) return;

    const apply = () => {
      setActiveKey(contentKey);
      exitNodeRef.current = childrenRef.current;
    };

    if (skipTransition.current) {
      skipTransition.current = false;
      apply();
      return;
    }

    withViewTransition(apply);
  }, [contentKey, activeKey]);

  if (contentKey === undefined) {
    return className ? <div className={className}>{children}</div> : children;
  }

  const body = contentKey === activeKey ? children : exitNodeRef.current;
  return className ? <div className={className}>{body}</div> : body;
}
