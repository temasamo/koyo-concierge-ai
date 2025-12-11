"use client";

import React from "react";

type RouteItem = {
  name: string;
  location: { lat: number; lng: number };
  category?: string | null;
  city?: string | null;
};

type Props = {
  route: RouteItem[];
  visible: boolean;
  onClose: () => void;
  hasWarning?: boolean;
  warningMessage?: string;
};

export default function RouteList({
  route,
  visible,
  onClose,
  hasWarning = false,
  warningMessage,
}: Props) {
  if (!visible) return null;

  return (
    <div
      className="fixed bottom-0 left-0 right-0 bg-white shadow-xl p-4 border-t border-gray-200 z-50 rounded-t-2xl"
      style={{ maxHeight: "50%", overflowY: "auto" }}
    >
      <div className="flex justify-between items-center mb-3">
        <h2 className="text-lg font-semibold">📍 本日のルート</h2>
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

      {route.length === 0 ? (
        <p className="text-gray-600 text-sm">ルートが見つかりません。</p>
      ) : (
        <ul className="space-y-2">
          {route.map((r, idx) => (
            <li
              key={idx}
              className="p-3 bg-gray-50 rounded-lg border border-gray-200 hover:bg-gray-100 transition-colors"
            >
              <div className="flex items-start">
                <span className="font-bold text-blue-600 mr-2 min-w-[24px]">
                  {idx + 1}.
                </span>
                <div className="flex-1">
                  <div className="font-medium text-gray-900">{r.name}</div>
                  {(r.category || r.city) && (
                    <div className="text-xs text-gray-500 mt-1">
                      {r.category && <span>{r.category}</span>}
                      {r.category && r.city && <span> / </span>}
                      {r.city && <span>{r.city}</span>}
                    </div>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

