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

    // --- Marker Reset ---
    // Task 1: 新しいスポットがセットされたとき、古いマーカーを必ず全て削除
    if (markersRef.current.length > 0) {
      markersRef.current.forEach((m) => m.setMap(null));
      markersRef.current = [];
      console.log("[Map] 古いマーカーを全て削除しました");
    }
    infoWindowsRef.current.forEach((infoWindow) => {
      infoWindow.close();
    });
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

        // Task 3: InfoWindowのスタイル安定化
        // 画像URLを取得（photoUrlまたはimageUrlの両方に対応）
        const imageUrl = (spot as any).photoUrl || spot.imageUrl || "/noimage.png";
        
        const html = `
          <div style="
            max-width: 220px;
            padding: 8px;
            font-family: sans-serif;
          ">
            <h3 style="margin:0 0 6px; font-size:14px; font-weight:bold;">
              ${spot.name || "スポット名不明"}
            </h3>

            <img 
              src="${imageUrl}"
              style="width:100%; border-radius:6px; margin-bottom:6px;"
              onerror="this.src='/noimage.png'"
            />

            ${spot.category ? `<p style="margin:0 0 4px; font-size:12px; color:#2563eb;">カテゴリ: ${spot.category}</p>` : ""}
            ${spot.city ? `<p style="margin:0 0 4px; font-size:12px; color:#666;">場所: ${spot.city}</p>` : ""}
            ${spot.drive_minutes != null ? `<p style="margin:0 0 4px; font-size:12px; color:#666;">車で約${spot.drive_minutes}分</p>` : spot.drive_time ? `<p style="margin:0 0 4px; font-size:12px; color:#666;">${spot.drive_time}</p>` : ""}
            ${spot.stay_time ? `<p style="margin:0 0 4px; font-size:12px; color:#666;">滞在時間: ${spot.stay_time}</p>` : ""}
            ${spot.season ? `<p style="margin:0; font-size:12px; color:#666;">シーズン: ${spot.season}</p>` : ""}
          </div>
        `;

        const infoWindow = new InfoWindow({
          content: html,
        });

        marker.addListener("click", () => {
          // 他の情報ウィンドウを閉じる
          infoWindowsRef.current.forEach((iw) => iw.close());
          infoWindow.open({
            map: mapInstanceRef.current,
            anchor: marker,
          });
        });

        newMarkers.push(marker);
        infoWindowsRef.current.push(infoWindow);
      });

      // マーカー参照を更新（Task 1: 新しいマーカーを作る際は markersRef.current.push）
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

      // Task 2: bounds.fit()が正しく効くように調整
      // 座標のあるスポットのみ bounds.extend()
      const validSpots = markers.filter((s) => s.lat && s.lng);
      validSpots.forEach((s) => {
        bounds.extend({ lat: s.lat!, lng: s.lng! });
      });

      // mapRef.current が存在してから実行
      if (!mapInstanceRef.current) {
        console.error("[GoogleMap] mapInstanceRef.current is null");
        return;
      }

      // マーカー数で挙動を分岐
      if (validSpots.length === 1) {
        // 1スポット → zoom: 14 あたり（自然）
        mapInstanceRef.current.setCenter(bounds.getCenter());
        mapInstanceRef.current.setZoom(14);
        console.log("[Map] 単スポットのためズーム固定で表示");
      } else if (validSpots.length > 1) {
        // 2スポット以上 → bounds.fit()
        mapInstanceRef.current.fitBounds(bounds, 80);
        console.log("[Map] 複数スポットのため bounds.fit で調整");
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
