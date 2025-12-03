"use client";

import { useEffect, useRef, useState } from "react";
import { useSpotStore } from "@/store/spots";
import L from "leaflet";

// Leafletのデフォルトアイコンの問題を修正
if (typeof window !== "undefined") {
  delete (L.Icon.Default.prototype as any)._getIconUrl;
  L.Icon.Default.mergeOptions({
    iconRetinaUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png",
    iconUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png",
    shadowUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png",
  });
}

export default function MapWithSpots() {
  const mapRef = useRef<L.Map | null>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const markersRef = useRef<L.Marker[]>([]);
  const spots = useSpotStore((s) => s.spots);
  const [isMounted, setIsMounted] = useState(false);
  const [isMapReady, setIsMapReady] = useState(false);

  // クライアント側でのみマウント
  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    // マップの初期化（クライアント側でのみ実行）
    if (!isMounted || !mapContainerRef.current || mapRef.current) return;

    try {
      console.log("[MapWithSpots] Initializing map...");
      const map = L.map(mapContainerRef.current, {
        zoomControl: true,
      }).setView([38.146, 140.272], 10); // 古窯付近

      // OpenStreetMapタイルレイヤーを追加
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
      }).addTo(map);

      // マップのサイズを再計算（初期化後に必要）
      setTimeout(() => {
        map.invalidateSize();
        mapRef.current = map;
        setIsMapReady(true);
        console.log("[MapWithSpots] Map initialized and ready");
      }, 100);
    } catch (error) {
      console.error("Map initialization error:", error);
    }

    // クリーンアップ関数
    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
        setIsMapReady(false);
      }
    };
  }, [isMounted]);

  useEffect(() => {
    // スポットが変更されたときにマーカーを更新
    if (!isMapReady || !mapRef.current) {
      console.log("[MapWithSpots] Map not ready yet, spots:", spots.length);
      return;
    }

    console.log("[MapWithSpots] spots:", spots);

    // 既存のマーカーを削除
    markersRef.current.forEach((marker) => {
      marker.remove();
    });
    markersRef.current = [];

    // 新しいマーカーを追加
    if (spots.length > 0) {
      console.log("[MapWithSpots] Adding markers for", spots.length, "spots");
      const bounds = L.latLngBounds([]);

      spots.forEach((spot, index) => {
        // lat/lngがnullの場合はスキップ
        if (spot.lat == null || spot.lng == null) {
          console.warn(`[MapWithSpots] Skipping spot "${spot.name}" - missing coordinates`);
          return;
        }

        console.log(`[MapWithSpots] Adding marker ${index + 1}:`, spot.name, "at", spot.lat, spot.lng);
        
        try {
          const marker = L.marker([spot.lat, spot.lng])
            .addTo(mapRef.current!)
            .bindPopup(
              `<div>
                <h3 class="font-bold text-sm mb-1">${spot.name}</h3>
                ${spot.description ? `<p class="text-xs text-gray-600 mb-1">${spot.description}</p>` : ""}
                ${spot.category ? `<span class="text-xs text-blue-600">${spot.category}</span>` : ""}
              </div>`
            );

          markersRef.current.push(marker);
          bounds.extend([spot.lat, spot.lng]);
        } catch (error) {
          console.error(`[MapWithSpots] Error adding marker for ${spot.name}:`, error);
        }
      });

      // すべてのマーカーが表示されるように地図を調整
      if (markersRef.current.length > 1) {
        mapRef.current.fitBounds(bounds, { padding: [50, 50] });
      } else if (markersRef.current.length === 1) {
        const firstSpot = spots.find(s => s.lat != null && s.lng != null);
        if (firstSpot && firstSpot.lat != null && firstSpot.lng != null) {
          mapRef.current.setView([firstSpot.lat, firstSpot.lng], 13);
        }
      }
      
      console.log("[MapWithSpots] Markers added:", markersRef.current.length);
    } else {
      console.log("[MapWithSpots] No spots to display");
    }
  }, [spots, isMapReady]);

  if (!isMounted) {
    return <div className="w-full h-full bg-gray-100 flex items-center justify-center">地図を読み込み中...</div>;
  }

  return <div ref={mapContainerRef} className="w-full h-full min-h-[400px]" style={{ height: "100%" }} />;
}

