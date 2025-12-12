"use client";

import React from "react";
import type { RouteLegInfo } from "@/types/route";

type Props = {
  routeLegs: RouteLegInfo[];
  visible: boolean;
  onClose: () => void;
  hasWarning?: boolean;
  warningMessage?: string;
};

export default function RouteList({
  routeLegs,
  visible,
  onClose,
  hasWarning = false,
  warningMessage,
}: Props) {
  if (!visible) return null;

  // 番号を表示用ラベルに変換（S → ① → ② → ... → G）
  const getDisplayLabel = (leg: RouteLegInfo, index: number, total: number): string => {
    // 最初のleg（index 0）は出発地なので「S」
    if (index === 0) {
      return "S";
    }
    // 最後のlegは到着地なので「G」
    if (index === total - 1) {
      return "G";
    }
    // 中間のlegは①②③...
    const numbers = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];
    const waypointIndex = index - 1; // 出発地を除いたインデックス（0から始まる）
    if (waypointIndex >= 0 && waypointIndex < numbers.length) {
      return numbers[waypointIndex];
    }
    // 10以上の場合も数字で表示
    return `${waypointIndex + 1}`;
  };

  return (
    <div
      className="fixed bottom-0 left-0 right-0 bg-white shadow-xl p-4 border-t border-gray-200 z-50 rounded-t-2xl"
      style={{ maxHeight: "50%", overflowY: "auto" }}
    >
      <div className="flex justify-between items-center mb-3">
        <h2 className="text-lg font-semibold text-gray-900">📍 本日のルート</h2>
        <button
          onClick={onClose}
          className="text-gray-500 text-xl hover:text-gray-700 transition-colors"
          aria-label="閉じる"
        >
          ×
        </button>
      </div>

      {hasWarning && warningMessage && (
        <div className="mb-3 p-3 bg-yellow-100 text-yellow-800 text-sm rounded-md border border-yellow-300">
          <div className="flex items-start">
            <span className="mr-2">⚠️</span>
            <span>{warningMessage}</span>
          </div>
        </div>
      )}

      {routeLegs.length === 0 ? (
        <p className="text-gray-600 text-sm">ルートが見つかりません。</p>
      ) : (
        <div className="space-y-3">
          {routeLegs.map((leg) => (
            <div
              key={leg.index}
              className="flex gap-3 border-t border-gray-100 pt-3 first:border-t-0 first:pt-0"
            >
              {/* 番号バッジ */}
              <div className="mt-1 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-indigo-600 text-xs font-bold text-white">
                {getDisplayLabel(leg, leg.index, routeLegs.length)}
              </div>

              {/* 本文 */}
              <div className="flex-1 text-xs">
                <div className="font-semibold text-gray-900">
                  {leg.index === 0 ? `出発：${leg.fromName}` : leg.toName}
                </div>

                {/* カテゴリ・市区町村 */}
                {(leg.category || leg.city) && (
                  <div className="mt-0.5 text-[11px] text-gray-500">
                    {leg.category && <span>{leg.category}</span>}
                    {leg.category && leg.city && <span> / </span>}
                    {leg.city && <span>{leg.city}</span>}
                  </div>
                )}

                {/* 距離・所要時間 */}
                {(leg.distanceText || leg.durationText) && (
                  <div className="mt-1 text-[11px] text-gray-600">
                    {leg.distanceText && (
                      <>
                        距離：{leg.distanceText}
                        {leg.durationText && " / "}
                      </>
                    )}
                    {leg.durationText && <>所要時間：{leg.durationText}</>}
                  </div>
                )}

                {/* 滞在時間（スポットに紐づく場合のみ） */}
                {leg.stayTimeText && (
                  <div className="mt-0.5 text-[11px] text-gray-600">
                    滞在時間：{leg.stayTimeText}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

