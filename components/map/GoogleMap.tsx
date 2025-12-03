"use client";
import { useEffect, useRef, useState } from "react";
import { loadGoogleMaps } from "./MapLoader";
import type { Spot } from "@/store/spots";

interface GoogleMapProps {
  center: { lat: number; lng: number };
  markers: Spot[];
}

export default function GoogleMap({ center, markers }: GoogleMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const infoWindowsRef = useRef<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [googleMapsLibs, setGoogleMapsLibs] = useState<{
    Map: any;
    Marker: any;
    InfoWindow: any;
  } | null>(null);

  // マップの初期化（一度だけ実行）
  useEffect(() => {
    let isMounted = true;
    let retryCount = 0;
    const maxRetries = 10;

    async function init() {
      // mapRef.currentが利用可能になるまで待つ
      if (!mapRef.current) {
        retryCount++;
        if (retryCount > maxRetries) {
          console.error("[GoogleMap] Failed to get mapRef.current after", maxRetries, "retries");
          setIsLoading(false);
          return;
        }
        console.log("[GoogleMap] Waiting for mapRef.current... (attempt", retryCount, ")");
        // 少し待ってから再試行
        setTimeout(() => {
          if (isMounted) {
            init();
          }
        }, 100);
        return;
      }

      try {
        console.log("[GoogleMap] mapRef.current found, loading Google Maps API...");
        const libs = await loadGoogleMaps();
        console.log("[GoogleMap] Google Maps API loaded:", libs);

        if (!isMounted || !mapRef.current) {
          console.log("[GoogleMap] Component unmounted or mapRef is null after loading");
          return;
        }

        console.log("[GoogleMap] Creating map instance...");
        const map = new libs.Map(mapRef.current, {
          center,
          zoom: 12,
        });

        mapInstanceRef.current = map;
        setGoogleMapsLibs(libs);
        setIsLoading(false);
        console.log("[GoogleMap] Map initialized successfully");
      } catch (error) {
        console.error("[GoogleMap] Google Maps initialization error:", error);
        setIsLoading(false);
      }
    }
    
    // DOMが確実にマウントされた後に初期化
    const timer = setTimeout(() => {
      init();
    }, 100);

    // クリーンアップ
    return () => {
      isMounted = false;
      clearTimeout(timer);
      // マーカーを削除
      markersRef.current.forEach((marker) => {
        marker.setMap(null);
      });
      markersRef.current = [];
      infoWindowsRef.current.forEach((iw) => iw.close());
      infoWindowsRef.current = [];
      if (mapInstanceRef.current) {
        mapInstanceRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // 一度だけ実行

  // マップの中心を更新
  useEffect(() => {
    if (mapInstanceRef.current && !isLoading) {
      mapInstanceRef.current.setCenter(center);
    }
  }, [center, isLoading]);

  // マーカーの更新
  useEffect(() => {
    if (!mapInstanceRef.current || isLoading || !googleMapsLibs) {
      console.log("[GoogleMap] Skipping marker update:", {
        hasMap: !!mapInstanceRef.current,
        isLoading,
        hasLibs: !!googleMapsLibs,
      });
      return;
    }

    console.log("[GoogleMap] Updating markers:", markers.length);
    const map = mapInstanceRef.current;
    const { Marker, InfoWindow } = googleMapsLibs;
    
    // 早期リターンで関数を終了（依存配列のサイズを一定に保つ）
    if (!Marker || !InfoWindow) {
      return;
    }

    // 既存のマーカーと情報ウィンドウを完全に削除（毎回クリア→再生成方式）
    markersRef.current.forEach((marker) => {
      marker.setMap(null);
    });
    infoWindowsRef.current.forEach((infoWindow) => {
      infoWindow.close();
    });
    markersRef.current = [];
    infoWindowsRef.current = [];

    // 新しいマーカーを追加（Supabaseデータのみを使用）
    if (markers.length > 0) {
      // LatLngBoundsを取得（google.mapsから）
      const google = (window as any).google;
      if (!google || !google.maps) {
        console.error("[GoogleMap] Google Maps API is not loaded");
        return;
      }
      const bounds = new google.maps.LatLngBounds();
      const newMarkers: any[] = [];
      let skippedCount = 0;

      markers.forEach((spot, index) => {
        // Supabaseのlat/lngのみを使用（必須チェック）
        if (spot.lat == null || spot.lng == null) {
          console.warn(`[GoogleMap] Skipping spot "${spot.name}" (index ${index}) - missing coordinates`);
          skippedCount++;
          return;
        }

        // マーカーを作成（Supabaseの座標のみ使用）
        const marker = new Marker({
          position: { lat: spot.lat, lng: spot.lng },
          map,
          title: spot.name,
        });

        // InfoWindowの内容をSupabaseデータのみで構築
        const infoContent = `
          <div style="padding: 8px; min-width: 200px;">
            <h3 style="font-weight: bold; font-size: 14px; margin-bottom: 4px;">${spot.name || "スポット名不明"}</h3>
            ${spot.category ? `<p style="font-size: 12px; color: #2563eb; margin-bottom: 4px;">カテゴリ: ${spot.category}</p>` : ""}
            ${spot.city ? `<p style="font-size: 11px; color: #666; margin-bottom: 2px;">場所: ${spot.city}</p>` : ""}
            ${spot.drive_minutes != null ? `<p style="font-size: 11px; color: #666; margin-bottom: 2px;">車で約${spot.drive_minutes}分</p>` : spot.drive_time ? `<p style="font-size: 11px; color: #666; margin-bottom: 2px;">${spot.drive_time}</p>` : ""}
            ${spot.stay_time ? `<p style="font-size: 11px; color: #666; margin-bottom: 2px;">滞在時間: ${spot.stay_time}</p>` : ""}
            ${spot.season ? `<p style="font-size: 11px; color: #666;">シーズン: ${spot.season}</p>` : ""}
          </div>
        `;

        const infoWindow = new InfoWindow({
          content: infoContent,
        });

        marker.addListener("click", () => {
          // 他の情報ウィンドウを閉じる
          infoWindowsRef.current.forEach((iw) => iw.close());
          infoWindow.open(map, marker);
        });

        newMarkers.push(marker);
        infoWindowsRef.current.push(infoWindow);
      });

      // マーカー参照を更新
      markersRef.current = newMarkers;

      // デバッグログ：表示されたマーカー数を確認
      console.log(`[GoogleMap] Created ${newMarkers.length} markers (${skippedCount} skipped due to missing coordinates)`);
      
      if (newMarkers.length === 0) {
        console.error("[GoogleMap] No valid markers created! All spots had missing coordinates.");
        // マーカーがない場合は中心を設定
        map.setCenter(center);
        map.setZoom(12);
        return;
      }

      // bounds計算をマーカーのgetPosition()で行う（現行のマーカーのみ）
      newMarkers.forEach((marker) => {
        const position = marker.getPosition();
        if (position) {
          bounds.extend(position);
        }
      });

      // すべてのマーカーが表示されるように地図を調整
      if (newMarkers.length > 1) {
        map.fitBounds(bounds, { top: 50, right: 50, bottom: 50, left: 50 });
        console.log(`[GoogleMap] Adjusted map bounds to fit ${newMarkers.length} markers`);
      } else if (newMarkers.length === 1) {
        const position = newMarkers[0].getPosition();
        if (position) {
          map.setCenter(position);
          map.setZoom(13);
          console.log(`[GoogleMap] Centered map on single marker: ${markers[0].name}`);
        }
      }
    } else {
      // マーカーがない場合は中心を設定
      console.log("[GoogleMap] No markers to display, centering on default location");
      map.setCenter(center);
      map.setZoom(12);
    }
  }, [markers, isLoading, googleMapsLibs, center]); // すべての依存関係を明示

  return (
    <div className="w-full h-full relative" style={{ minHeight: '400px' }}>
      {/* mapRefは常にレンダリングされるようにする */}
      <div 
        ref={mapRef} 
        className="w-full h-full" 
        style={{ minHeight: '400px' }}
      />
      {isLoading && (
        <div className="absolute inset-0 bg-gray-100 flex items-center justify-center z-10">
          <div className="text-gray-600">地図を読み込み中...</div>
        </div>
      )}
      {!isLoading && markers.length === 0 && (
        <div className="absolute inset-0 bg-gray-50 flex items-center justify-center z-10 pointer-events-none">
          <div className="text-gray-500 text-sm">スポットがありません</div>
        </div>
      )}
    </div>
  );
}
