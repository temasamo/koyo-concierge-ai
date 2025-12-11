"use client";

import { useRouter } from "next/navigation";
import { useState, useMemo } from "react";
import GoogleMap from "@/components/map/GoogleMap";
import { useSpotStore } from "@/store/spots";
import { KOYO_COORDINATES } from "@/constants/koyo";
import { buildGoogleMapsUrl } from "@/utils/googleMaps";

export default function MapPage() {
  const router = useRouter();
  const spots = useSpotStore((state) => state.spots);
  const origin = useSpotStore((state) => state.origin);
  const routeInfo = useSpotStore((state) => state.routeInfo);
  const [routeWarning, setRouteWarning] = useState<string | null>(null);
  const [showRouteListFn, setShowRouteListFn] = useState<(() => void) | null>(null);

  // 古窯（上山温泉）の公式座標
  const center = KOYO_COORDINATES;

  const destinationForLink = useMemo(() => {
    return routeInfo?.destination ?? center;
  }, [routeInfo, center]);

  // デバッグ用
  console.log("[MapPage] Spots:", spots);
  console.log("[MapPage] Spots count:", spots.length);
  console.log("[MapPage] Origin:", origin);
  console.log("[MapPage] RouteInfo:", routeInfo);

  const handleOpenGoogleMaps = () => {
    if (!routeInfo) {
      console.warn("[MapPage] routeInfo is not available");
      return;
    }

    // デバッグ: 座標情報をログ出力
    console.log("[MapPage] Opening Google Maps with routeInfo:", {
      origin: routeInfo.origin,
      destination: routeInfo.destination,
      waypointsCount: routeInfo.waypoints.length,
      waypoints: routeInfo.waypoints,
    });

    const url = buildGoogleMapsUrl(
      routeInfo.origin,
      routeInfo.waypoints,
      routeInfo.destination
    );
    
    console.log("[MapPage] Generated Google Maps URL:", url);
    window.open(url, "_blank");
  };

  return (
    <div className="w-full h-screen flex flex-col overflow-hidden">
      {/* ヘッダー */}
      <div className="bg-white shadow-sm px-4 py-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center">
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
        <div className="flex items-center gap-2">
          {showRouteListFn && (
            <button
              onClick={showRouteListFn}
              className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors flex items-center gap-2"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-5 w-5"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z"
                  clipRule="evenodd"
                />
              </svg>
              ルート一覧
            </button>
          )}
          {routeInfo && (
            <button
              onClick={handleOpenGoogleMaps}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-2"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-5 w-5"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z"
                  clipRule="evenodd"
                />
              </svg>
              Googleマップで開く
            </button>
          )}
        </div>
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
          onRouteWarningChange={setRouteWarning}
          onRouteListToggle={setShowRouteListFn}
        />
      </div>

      {routeWarning && (
        <div className="px-4 py-3 bg-yellow-100 text-yellow-800 text-sm flex flex-col gap-2 shadow-inner">
          <div>{routeWarning}</div>
        </div>
      )}
    </div>
  );
}
