import { useCallback, useRef, useState } from "react";
import {
  readLastFileFolder,
  readLastFileWorkspace,
  writeLastFileFolder,
  writeLastFileWorkspace,
} from "@/features/workspace/fileWorkspaceTree";

export type PickTarget = "workspace" | "folder";

export function useWorkspacePick() {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<PickTarget>("workspace");
  const [value, setValue] = useState("");
  const pending = useRef<((id: string | null) => void) | null>(null);

  const settle = useCallback((id: string | null, picked: PickTarget) => {
    if (id) {
      if (picked === "folder") writeLastFileFolder(id);
      else writeLastFileWorkspace(id);
    }
    setOpen(false);
    pending.current?.(id);
    pending.current = null;
  }, []);

  const openPick = useCallback((picked: PickTarget, preset?: string) => {
    pending.current?.(null);
    setTarget(picked);
    const remembered = picked === "folder" ? readLastFileFolder() : readLastFileWorkspace();
    setValue(preset?.trim() || remembered);
    setOpen(true);
    return new Promise<string | null>((resolve) => {
      pending.current = resolve;
    });
  }, []);

  const pick = useCallback((preset?: string) => openPick("workspace", preset), [openPick]);
  const pickFolder = useCallback((preset?: string) => openPick("folder", preset), [openPick]);

  return {
    pick,
    pickFolder,
    dialogProps: {
      open,
      target,
      value,
      onChange: setValue,
      onClose: () => settle(null, target),
      onConfirm: () => {
        if (value) settle(value, target);
      },
    },
  };
}
