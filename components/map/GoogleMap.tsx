"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { loadGoogleMaps } from "./MapLoader";
import type { Spot } from "@/store/spots";

interface GoogleMapProps {
  center: { lat: number; lng: number };
  markers: Spot[];
  spots?: Spot[]; // Directions API用（plan.spotsを渡す）
  showRoute?: boolean; // ルート表示の有効/無効（デフォルト: false）
  koyoOrigin?: { lat: number; lng: number }; // 古窯の座標（固定origin用）
}

export default function GoogleMap({ center, markers, spots, showRoute = false, koyoOrigin }: GoogleMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const infoWindowsRef = useRef<any[]>([]);
  const directionsServiceRef = useRef<any>(null);
  const directionsRendererRef = useRef<any>(null);
  const lastRouteSpotsRef = useRef<string>(""); // 最後に描画したルートのスポットIDを記録（重複リクエスト防止）
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
          gestureHandling: "greedy",
          streetViewControl: false,
        });

        mapInstanceRef.current = map;
        
        // Directions APIの初期化（google.mapsから直接取得）
        const google = (window as any).google;
        if (google && google.maps && google.maps.DirectionsService && google.maps.DirectionsRenderer) {
          directionsServiceRef.current = new google.maps.DirectionsService();
          directionsRendererRef.current = new google.maps.DirectionsRenderer({
            suppressMarkers: true, // 純正マーカーとInfoWindowを無効化（既存のマーカー描画ロジックを使用）
            preserveViewport: true, // ビューポートを保持
          });
          directionsRendererRef.current.setMap(map);
          console.log("[GoogleMap] Directions API initialized (suppressMarkers: true)");
        } else {
          console.warn("[GoogleMap] Directions API not available - make sure Directions API is enabled in Google Cloud Console");
        }
        
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
      // Directions APIのクリーンアップ
      if (directionsRendererRef.current) {
        directionsRendererRef.current.setMap(null);
        directionsRendererRef.current = null;
      }
      if (directionsServiceRef.current) {
        directionsServiceRef.current = null;
      }
      if (mapInstanceRef.current) {
        mapInstanceRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // 一度だけ実行

  // Directions APIでルートを描画する関数
  const drawRoute = useCallback((routeSpots: Spot[]) => {
    if (!showRoute || !routeSpots || routeSpots.length === 0) {
      return;
    }
    if (!directionsServiceRef.current || !directionsRendererRef.current) {
      console.warn("[GoogleMap] Directions API not initialized");
      return;
    }
    if (!koyoOrigin) {
      console.warn("[GoogleMap] Koyo origin not provided");
      return;
    }

    // null安全性チェック：有効な座標を持つスポットのみをフィルタリング
    const validSpots = routeSpots.filter(
      (s) => s.lat != null && s.lng != null
    ) as Array<Spot & { lat: number; lng: number }>;

    if (validSpots.length === 0) {
      console.warn("[GoogleMap] No valid spots for route");
      return;
    }

    // 同一ルートの重複リクエスト防止：スポットIDのシーケンスを比較
    const currentRouteKey = validSpots.map((s) => s.id).join(",");
    if (lastRouteSpotsRef.current === currentRouteKey) {
      console.log("[GoogleMap] Same route already drawn, skipping");
      return;
    }

    // originは常に古窯の座標に固定
    const origin = koyoOrigin;
    
    // destinationはAI spotsの最後のスポット
    const destination = {
      lat: validSpots[validSpots.length - 1].lat,
      lng: validSpots[validSpots.length - 1].lng,
    };

    // waypointsはAI spotsの最初以外すべて（最後も含む）
    const waypoints =
      validSpots.length > 1
        ? validSpots.slice(0, -1).map((s) => ({
            location: { lat: s.lat, lng: s.lng },
            stopover: true,
          }))
        : [];

    const google = (window as any).google;
    if (!google || !google.maps) {
      console.error("[GoogleMap] Google Maps API is not loaded");
      return;
    }

    // デバッグ情報を出力
    console.log("[GoogleMap] Drawing route from Koyo (origin) to", validSpots.length, "AI spots");
    console.log("[GoogleMap] Origin: 古窯 (固定)", origin);
    console.log("[GoogleMap] Destination:", validSpots[validSpots.length - 1].name, destination);
    if (waypoints.length > 0) {
      console.log("[GoogleMap] Waypoints:", waypoints.map((w, i) => `${validSpots[i].name} (${w.location.lat}, ${w.location.lng})`));
    }
    directionsServiceRef.current.route(
      {
        origin,
        destination,
        waypoints: waypoints.length > 0 ? waypoints : undefined,
        travelMode: google.maps.TravelMode.DRIVING,
      },
      (result: any, status: any) => {
        if (status === google.maps.DirectionsStatus.OK && result) {
          directionsRendererRef.current.setDirections(result);
          lastRouteSpotsRef.current = currentRouteKey;
          console.log("[GoogleMap] Route drawn successfully");
        } else {
          console.error("[GoogleMap] Directions API error:", status);
          if (status === google.maps.DirectionsStatus.REQUEST_DENIED) {
            console.error(
              "[GoogleMap] REQUEST_DENIED - 可能性のある原因:\n" +
              "1. APIキーのHTTPリファラー制限が設定されている\n" +
              "   → Google Cloud ConsoleでAPIキーの制限を確認し、\n" +
              "     localhost:3001/* または http://localhost:3001/* を許可してください\n" +
              "2. Directions APIが有効になっていない\n" +
              "   → Google Cloud ConsoleでDirections APIが有効か確認してください\n" +
              "3. 請求情報が設定されていない\n" +
              "   → Google Cloud Consoleで請求情報を設定してください"
            );
          } else if (status === google.maps.DirectionsStatus.ZERO_RESULTS) {
            console.error(
              "[GoogleMap] ZERO_RESULTS - ルートが見つかりませんでした\n" +
              "可能性のある原因:\n" +
              "1. 座標データが正しくない\n" +
              "2. 出発地と目的地が離れすぎている、または到達不可能\n" +
              "3. 経由地の順序が不適切\n" +
              `出発地: ${validSpots[0].name} (${origin.lat}, ${origin.lng})\n` +
              `目的地: ${validSpots[validSpots.length - 1].name} (${destination.lat}, ${destination.lng})\n` +
              `経由地数: ${waypoints.length}`
            );
          }
        }
      }
    );
  }, [showRoute, koyoOrigin]);

  // マップの中心を更新
  useEffect(() => {
    if (mapInstanceRef.current && !isLoading) {
      mapInstanceRef.current.setCenter(center);
    }
  }, [center, isLoading]);

  // Directions APIでルートを描画（spotsが変更されたとき）
  useEffect(() => {
    if (!isLoading && showRoute && spots && spots.length >= 1 && koyoOrigin) {
      drawRoute(spots);
    }
  }, [spots, showRoute, isLoading, drawRoute, koyoOrigin]);

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

    // LatLngBoundsを取得（google.mapsから）
    const google = (window as any).google;
    if (!google || !google.maps) {
      console.error("[GoogleMap] Google Maps API is not loaded");
      return;
    }
    const bounds = new google.maps.LatLngBounds();
    const newMarkers: any[] = [];
    let skippedCount = 0;

    // まず古窯のマーカーを追加（固定）
    if (koyoOrigin) {
      const koyoMarker = new Marker({
        position: koyoOrigin,
        map,
        title: "古窯",
        icon: {
          url: "http://maps.google.com/mapfiles/ms/icons/red-dot.png", // 赤いマーカーで区別
        },
      });

      // 古窯のInfoWindow（固定データ）
      const koyoHtml = `
        <div style="
          max-width: 220px;
          padding: 8px;
          font-family: sans-serif;
        ">
          <h3 style="margin:0 0 6px; font-size:14px; font-weight:bold;">
            古窯
          </h3>
          <p style="margin:0 0 4px; font-size:12px; color:#666;">上山温泉の旅館</p>
          <p style="margin:0 0 4px; font-size:12px; color:#666;">出発地点</p>
        </div>
      `;

      const koyoInfoWindow = new InfoWindow({
        content: koyoHtml,
      });

      koyoMarker.addListener("click", () => {
        infoWindowsRef.current.forEach((iw) => iw.close());
        koyoInfoWindow.open({
          map: mapInstanceRef.current,
          anchor: koyoMarker,
        });
      });

      newMarkers.push(koyoMarker);
      infoWindowsRef.current.push(koyoInfoWindow);
      bounds.extend(koyoOrigin);
      console.log("[GoogleMap] Added Koyo marker (origin)");
    }

    // AIスポットのマーカーを追加
    if (markers.length > 0) {
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
        bounds.extend({ lat: spot.lat, lng: spot.lng });
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

      // mapRef.current が存在してから実行
      if (!mapInstanceRef.current) {
        console.error("[GoogleMap] mapInstanceRef.current is null");
        return;
      }

      // マーカー数で挙動を分岐（古窯マーカーを含む）
      const totalMarkerCount = newMarkers.length;
      if (totalMarkerCount === 1) {
        // 古窯のみ → zoom: 14 あたり（自然）
        mapInstanceRef.current.setCenter(bounds.getCenter());
        mapInstanceRef.current.setZoom(14);
        console.log("[Map] 古窯のみのためズーム固定で表示");
      } else if (totalMarkerCount > 1) {
        // 古窯 + AIスポット → bounds.fit()
        mapInstanceRef.current.fitBounds(bounds, 80);
        console.log("[Map] 古窯 + AIスポットのため bounds.fit で調整");
      }
    } else {
      // AIスポットがない場合でも、古窯マーカーがあれば表示
      if (koyoOrigin && newMarkers.length > 0) {
        mapInstanceRef.current.setCenter(koyoOrigin);
        mapInstanceRef.current.setZoom(14);
        console.log("[GoogleMap] Only Koyo marker displayed");
      } else {
        // マーカーがない場合は中心を設定
        console.log("[GoogleMap] No markers to display, centering on default location");
        map.setCenter(center);
        map.setZoom(12);
      }
    }
  }, [markers, isLoading, googleMapsLibs, center, koyoOrigin]); // すべての依存関係を明示

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
