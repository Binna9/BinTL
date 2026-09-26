import { useCallback, useRef, useState } from "react";
import { readLastFileWorkspace, writeLastFileWorkspace } from "@/features/workspace/fileWorkspaceTree";

export function useWorkspacePick() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const pending = useRef<((id: string | null) => void) | null>(null);

  const settle = useCallback((id: string | null) => {
    if (id) writeLastFileWorkspace(id);
    setOpen(false);
    pending.current?.(id);
    pending.current = null;
  }, []);

  const pick = useCallback((preset?: string) => {
    pending.current?.(null);
    setValue(preset?.trim() || readLastFileWorkspace());
    setOpen(true);
    return new Promise<string | null>((resolve) => {
      pending.current = resolve;
    });
  }, []);

  return {
    pick,
    dialogProps: {
      open,
      value,
      onChange: setValue,
      onClose: () => settle(null),
      onConfirm: () => {
        if (value) settle(value);
      },
    },
  };
}
