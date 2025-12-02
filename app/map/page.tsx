"use client";

import { useRouter } from "next/navigation";
import GoogleMap from "@/components/map/GoogleMap";
import { useSpotStore } from "@/store/spots";

export default function MapPage() {
  const router = useRouter();
  const spots = useSpotStore((state) => state.spots);

  // 古窯（上山温泉）の公式座標
  const center = { lat: 38.1530, lng: 140.2794 };

  return (
    <div className="w-full h-screen flex flex-col">
      {/* ヘッダー */}
      <div className="bg-white shadow-sm px-4 py-3 flex items-center">
        <button
          onClick={() => router.push("/")}
          className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
        >
          ← 戻る
        </button>
      </div>

      {/* マップ */}
      <div className="flex-1 min-h-0">
        <GoogleMap center={center} markers={spots} />
      </div>
    </div>
  );
}
