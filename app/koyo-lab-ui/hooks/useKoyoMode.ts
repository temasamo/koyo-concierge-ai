"use client";

import { useState } from "react";

export type KoyoMode = "before" | "stay" | "after";

export function useKoyoMode() {
  const [mode, setMode] = useState<KoyoMode>("before");
  return { mode, setMode };
}

