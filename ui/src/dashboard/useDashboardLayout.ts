import { useCallback, useEffect, useState } from "react";
import {
  cloneDefaultLayout,
  hideWidget,
  loadSessionLayouts,
  moveItem,
  resetWidgetSize,
  resizeItem,
  saveSessionLayouts,
  showWidget,
  wipeLegacyLayouts,
} from "./layout";
import type { WidgetId } from "./types";

export function useDashboardLayout() {
  const [items, setItems] = useState(() => {
    wipeLegacyLayouts();
    return loadSessionLayouts();
  });

  useEffect(() => {
    saveSessionLayouts(items);
  }, [items]);

  const hide = useCallback((id: WidgetId) => {
    setItems((prev) => hideWidget(prev, id));
  }, []);

  const show = useCallback((id: WidgetId) => {
    setItems((prev) => showWidget(prev, id));
  }, []);

  const reset = useCallback(() => {
    setItems(cloneDefaultLayout());
  }, []);

  const move = useCallback((id: WidgetId, x: number, y: number) => {
    setItems((prev) => moveItem(prev, id, x, y));
  }, []);

  const resize = useCallback((id: WidgetId, w: number, h: number) => {
    setItems((prev) => resizeItem(prev, id, w, h));
  }, []);

  const resetSize = useCallback((id: WidgetId) => {
    setItems((prev) => resetWidgetSize(prev, id));
  }, []);

  return {
    items,
    hidden: items.filter((item) => !item.visible),
    hide,
    show,
    reset,
    move,
    resize,
    resetSize,
  };
}
