"use client";

import { useRouter } from "next/navigation";
import GoogleMap from "@/components/map/GoogleMap";
import { useSpotStore } from "@/store/spots";

export default function MapPage() {
  const router = useRouter();
  const spots = useSpotStore((state) => state.spots);
  const origin = useSpotStore((state) => state.origin);

  // 古窯（上山温泉）の公式座標
  const center = { lat: 38.14828716772903, lng: 140.261163693796 };

  // デバッグ用
  console.log("[MapPage] Spots:", spots);
  console.log("[MapPage] Spots count:", spots.length);
  console.log("[MapPage] Origin:", origin);

  return (
    <div className="w-full h-screen flex flex-col overflow-hidden">
      {/* ヘッダー */}
      <div className="bg-white shadow-sm px-4 py-3 flex items-center flex-shrink-0">
        <button
          onClick={() => router.push("/")}
          className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
        >
          ← 戻る
        </button>
        {spots.length > 0 && (
          <span className="ml-4 text-sm text-gray-600">
            {spots.length}件のスポットを表示中
          </span>
        )}
      </div>

      {/* マップ */}
      <div className="flex-1 relative min-h-0">
        <GoogleMap 
          center={center} 
          markers={spots} 
          spots={spots}
          showRoute={true}
          koyoOrigin={center}
          origin={origin}
        />
      </div>
    </div>
  );
}
