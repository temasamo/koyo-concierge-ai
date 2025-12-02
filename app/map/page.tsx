"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useSpotStore } from "@/store/spots";

// LeafletのCSSをインポート
import "leaflet/dist/leaflet.css";

// MapWithSpotsを動的インポート（SSRを無効化）
const MapWithSpots = dynamic(() => import("@/components/MapWithSpots"), {
  ssr: false,
});

export default function MapPage() {
  const router = useRouter();
  const spots = useSpotStore((s) => s.spots);

  // デバッグログ
  console.log("[MapPage] Current spots:", spots);

  return (
    <div className="relative w-full h-screen flex flex-col">
      {/* ヘッダー */}
      <div className="bg-white shadow-sm p-4 flex items-center justify-between z-10">
        <h1 className="text-xl font-bold text-gray-900">観光スポットマップ</h1>
        <button
          onClick={() => router.back()}
          className="px-4 py-2 rounded-lg bg-gray-200 text-gray-700 hover:bg-gray-300 transition-colors"
        >
          戻る
        </button>
      </div>

      {/* マップ */}
      <div className="flex-1 relative" style={{ minHeight: 0 }}>
        {spots.length === 0 ? (
          <div className="w-full h-full flex items-center justify-center bg-gray-100">
            <div className="text-center">
              <p className="text-gray-600 mb-2">スポットがありません</p>
              <p className="text-sm text-gray-500">チャットでスポット提案をリクエストしてください</p>
            </div>
          </div>
        ) : (
          <MapWithSpots />
        )}
      </div>
    </div>
  );
}

