"use client";

import { useModeStore, type KoyoMode } from "@/store/mode";

export type { KoyoMode };

export function useKoyoMode() {
  const mode = useModeStore((state) => state.mode);
  const setMode = useModeStore((state) => state.setMode);
  return { mode, setMode };
}

