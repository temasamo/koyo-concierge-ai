// store/mode.ts
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type KoyoMode = "before" | "stay" | "after";

type ModeStore = {
  mode: KoyoMode;
  setMode: (mode: KoyoMode) => void;
};

export const useModeStore = create<ModeStore>()(
  persist(
    (set) => ({
      mode: "before",
      setMode: (mode) => set({ mode }),
    }),
    {
      name: "koyo-mode-storage", // localStorage key
    }
  )
);

