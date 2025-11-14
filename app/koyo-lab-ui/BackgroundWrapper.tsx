"use client";

import { KoyoMode } from "./hooks/useKoyoMode";

const BG_BY_MODE: Record<KoyoMode, string> = {
  before: "/images/koyo/bg/koyo_before.png",
  stay: "/images/koyo/bg/koyo_stay.png",
  after: "/images/koyo/bg/koyo_after.png",
};

export default function BackgroundWrapper({ mode }: { mode: KoyoMode }) {
  const bg = BG_BY_MODE[mode];

  return (
    <div
      className="fixed inset-0 -z-10 bg-cover bg-center bg-no-repeat"
      style={{ backgroundImage: `url(${bg})` }}
    >
      <div className="absolute inset-0 bg-black/40" />
    </div>
  );
}

