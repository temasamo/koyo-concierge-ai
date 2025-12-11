"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { loadGoogleMaps } from "./MapLoader";
import type { Spot, OriginInfo } from "@/store/spots";
import { getPrefBoundary, type PrefectureKey } from "@/store/prefBoundaries";
import { getDefaultEntryPoint } from "@/app/api/koyo/before/_constants/prefEntryPoints";
import RouteList from "./RouteList";

function buildKoyoInfoWindowContent() {
  return `
    <div style="
      padding: 14px;
      border-radius: 12px;
      font-family: 'Noto Sans JP', sans-serif;
      color: #333;
      background: #fff;
      width: 260px;
    ">
      <img
        src="/origin/koyo-main.jpg"
        style="width: 100%; border-radius: 10px; margin-bottom: 10px;"
      />

      <div style="font-size: 16px; font-weight: 700; margin-bottom: 4px;">
        ◆ 古窯（Koyo）
      </div>

      <div style="font-size: 13px; margin-bottom: 10px; color: #666;">
        上山温泉の老舗旅館<br>旅のスタート地点です。
      </div>

      <div style="border-top: 1px solid #eee; margin: 8px 0;"></div>

      <div style="font-size: 13px; line-height: 1.7;">
        ・チェックイン：15時<br>
        ・チェックアウト：10時<br>
        ・住所：山形県上山市葉山5-45
      </div>

      <div style="margin-top: 10px; font-size: 12px; color: #999;">
        本日も素敵な旅をお楽しみください。
      </div>
    </div>
  `;
}

interface GoogleMapProps {
  center: { lat: number; lng: number };
  markers: Spot[];
  spots?: Spot[]; // Directions API用（plan.spotsを渡す）
  showRoute?: boolean; // ルート表示の有効/無効（デフォルト: false）
  koyoOrigin?: { lat: number; lng: number }; // 古窯の座標（固定origin用）
  origin?: OriginInfo; // Pre-Checkinモード用のorigin情報
  onRouteWarningChange?: (warning: string | null) => void; // ルート取得失敗時の警告メッセージを親に通知
  showRouteList?: boolean; // RouteList の表示状態（親から制御）
  onShowRouteListChange?: (show: boolean) => void; // RouteList の表示状態を変更する関数
}

export default function GoogleMap({
  center,
  markers,
  spots,
  showRoute = false,
  koyoOrigin,
  origin,
  onRouteWarningChange,
  showRouteList: showRouteListProp,
  onShowRouteListChange,
}: GoogleMapProps) {
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
  const [routeWarning, setRouteWarning] = useState<string | null>(null);
  const [routeListData, setRouteListData] = useState<
    Array<{
      name: string;
      location: { lat: number; lng: number };
      category?: string | null;
      city?: string | null;
    }>
  >([]);
  
  // 親から制御される場合は prop を使用、そうでない場合は内部 state を使用
  const showRouteList = showRouteListProp !== undefined ? showRouteListProp : false;

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

  // 警告メッセージを親へ伝搬
  useEffect(() => {
    onRouteWarningChange?.(routeWarning);
  }, [routeWarning, onRouteWarningChange]);

  // ルート描画成功時に RouteList を自動表示（初回のみ）
  const hasAutoShownRef = useRef(false);
  useEffect(() => {
    if (routeListData.length > 0 && onShowRouteListChange && !hasAutoShownRef.current) {
      console.log("[GoogleMap] Auto-showing route list, routeListData.length:", routeListData.length);
      onShowRouteListChange(true);
      hasAutoShownRef.current = true;
    }
    // routeListData が空になったらリセット
    if (routeListData.length === 0) {
      hasAutoShownRef.current = false;
    }
  }, [routeListData.length, onShowRouteListChange]);

  // Directions APIでルートを描画する関数
  const drawRoute = useCallback((routeSpots: Spot[]) => {
    if (!showRoute || !routeSpots || routeSpots.length === 0) {
      return;
    }
    if (!directionsServiceRef.current || !directionsRendererRef.current) {
      console.warn("[GoogleMap] Directions API not initialized");
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

    const currentRouteKey = validSpots.map((s) => s.id).join(",");
    if (lastRouteSpotsRef.current === currentRouteKey) {
      console.log("[GoogleMap] Same route already drawn, skipping");
      return;
    }

    const google = (window as any).google;
    if (!google || !google.maps) {
      console.error("[GoogleMap] Google Maps API is not loaded");
      return;
    }

    let routeOrigin: { lat: number; lng: number };
    let routeDestination: { lat: number; lng: number };
    let routeWaypoints: any[] = [];

    const hasPrefBoundary =
      origin && origin.type === "pref-boundary" && origin.pref;
    const hasFixedOrigin =
      origin &&
      origin.type === "fixed" &&
      origin.lat != null &&
      origin.lng != null;
    const hasCurrentOrigin =
      origin &&
      origin.type === "current" &&
      origin.lat != null &&
      origin.lng != null;

    if (hasPrefBoundary) {
      // 県境 → AIスポット → 古窯
      const prefBoundary = getPrefBoundary(origin!.pref as PrefectureKey);
      routeOrigin = prefBoundary;
      routeDestination = koyoOrigin || center;
      routeWaypoints = validSpots.map((s) => ({
        name: s.name,
        location: { lat: s.lat, lng: s.lng },
        stopover: true,
        category: s.category,
        city: s.city,
      }));
      console.log(
        "[GoogleMap] Pre-Checkin (pref-boundary): origin -> spots -> Koyo",
        routeOrigin,
        "=>",
        routeDestination
      );
    } else if (hasFixedOrigin || hasCurrentOrigin) {
      // A〜E / 現在地 → AIスポット → 古窯
      routeOrigin = {
        lat: origin!.lat as number,
        lng: origin!.lng as number,
      };
      routeDestination = koyoOrigin || center;
      routeWaypoints = validSpots.map((s) => ({
        name: s.name,
        location: { lat: s.lat, lng: s.lng },
        stopover: true,
        category: s.category,
        city: s.city,
      }));
      console.log(
        "[GoogleMap] Pre-Checkin (fixed/current): origin -> spots -> Koyo",
        routeOrigin,
        "=>",
        routeDestination
      );
    } else if (koyoOrigin) {
      // 通常モード（Stay/After/通常Before）：古窯 → スポット → 古窯
      routeOrigin = koyoOrigin;
      routeDestination = koyoOrigin; // Phase 1仕様：常に古窯をdestinationに
      routeWaypoints = validSpots.map((s) => ({
        name: s.name,
        location: { lat: s.lat, lng: s.lng },
        stopover: true,
        category: s.category,
        city: s.city,
      }));
      console.log(
        "[GoogleMap] Normal mode: Koyo -> spots -> Koyo",
        routeOrigin,
        "=>",
        routeDestination,
        "waypoints:",
        routeWaypoints.length
      );
    } else {
      console.warn("[GoogleMap] No origin provided");
      return;
    }
    // 座標の妥当性チェック
    const isValidCoordinate = (coord: { lat: number; lng: number }) => {
      return (
        typeof coord.lat === "number" &&
        typeof coord.lng === "number" &&
        !isNaN(coord.lat) &&
        !isNaN(coord.lng) &&
        coord.lat >= -90 &&
        coord.lat <= 90 &&
        coord.lng >= -180 &&
        coord.lng <= 180
      );
    };

    if (!isValidCoordinate(routeOrigin)) {
      console.error("[GoogleMap] Invalid origin coordinates:", routeOrigin);
      return;
    }

    if (!isValidCoordinate(routeDestination)) {
      console.error("[GoogleMap] Invalid destination coordinates:", routeDestination);
      return;
    }

    // waypointsの座標を検証
    const invalidWaypoints = routeWaypoints.filter(
      (wp) => !isValidCoordinate(wp.location)
    );
    if (invalidWaypoints.length > 0) {
      console.error("[GoogleMap] Invalid waypoint coordinates:", invalidWaypoints);
      return;
    }

    // waypointsが空でoriginとdestinationが同じ場合はルートを描画しない
    if (
      routeWaypoints.length === 0 &&
      routeOrigin.lat === routeDestination.lat &&
      routeOrigin.lng === routeDestination.lng
    ) {
      console.warn(
        "[GoogleMap] Cannot draw route: origin and destination are the same with no waypoints"
      );
      return;
    }

    // 蔵王お釜のIDをチェック（デバッグ用）
    const zawaoOkamaId = "b916a6f4-7225-42df-800a-a48f5f030da0";
    const containsZawaoOkama = validSpots.some((s) => s.id === zawaoOkamaId);
    
    // waypointsの詳細検証（各座標の型と値を確認）
    const waypointDetails = routeWaypoints.map((wp, index) => {
      const spot = validSpots[index];
      return {
        index,
        spotId: spot?.id || "unknown",
        spotName: spot?.name || "unknown",
        location: wp.location,
        latType: typeof wp.location.lat,
        lngType: typeof wp.location.lng,
        latIsNaN: isNaN(wp.location.lat),
        lngIsNaN: isNaN(wp.location.lng),
        latValue: wp.location.lat,
        lngValue: wp.location.lng,
        isZawaoOkama: spot?.id === zawaoOkamaId,
      };
    });

    // 事前に警告をクリア
    setRouteWarning(null);

    console.log("[GoogleMap] Requesting route (DRIVING):", {
      origin: routeOrigin,
      destination: routeDestination,
      waypointsCount: routeWaypoints.length,
      waypoints: routeWaypoints.map((wp) => wp.location),
      containsZawaoOkama,
      waypointDetails,
    });

    // origin 名を取得する関数
    const getOriginName = (): string => {
      if (hasPrefBoundary && origin?.pref) {
        const entryPoint = getDefaultEntryPoint(origin.pref as PrefectureKey);
        return `出発：${entryPoint.name}`;
      } else if (hasFixedOrigin || hasCurrentOrigin) {
        return origin?.name ? `出発：${origin.name}` : "出発：出発地点";
      } else {
        return "出発：日本の宿 古窯";
      }
    };

    // routeOrder を生成する関数
    const buildRouteOrder = () => {
      const originName = getOriginName();
      const destinationName = "到着：日本の宿 古窯";

      const routeOrder = [
        {
          name: originName,
          location: routeOrigin,
        },
        ...routeWaypoints.map((wp) => ({
          name: wp.name || "スポット",
          location: wp.location,
          category: wp.category,
          city: wp.city,
        })),
        {
          name: destinationName,
          location: routeDestination,
        },
      ];

      return routeOrder;
    };

    // DirectionsServiceに渡すrequestオブジェクト（DRIVING固定）
    // Directions API は { location, stopover } のみを受け取るため、name, category, city を除外
    const directionsWaypoints = routeWaypoints.length > 0
      ? routeWaypoints.map((wp) => ({
          location: wp.location,
          stopover: wp.stopover,
        }))
      : undefined;

    const request = {
      origin: routeOrigin,
      destination: routeDestination,
      waypoints: directionsWaypoints,
      travelMode: google.maps.TravelMode.DRIVING,
    };

    directionsServiceRef.current.route(request, (result: any, status: any) => {
      // routeOrder を生成（成功・失敗問わず表示するため）
      const routeOrder = buildRouteOrder();
      console.log("[GoogleMap] Setting routeListData, routeOrder.length:", routeOrder.length);
      setRouteListData(routeOrder);

      if (status === google.maps.DirectionsStatus.OK && result) {
        directionsRendererRef.current.setDirections(result);
        lastRouteSpotsRef.current = currentRouteKey;
        setRouteWarning(null);
        // ルート描画成功時は useEffect で自動表示されるため、ここでは何もしない
        console.log("[GoogleMap] Route drawn successfully (DRIVING)");
        return;
      }

      const logFailure = () => {
        console.error("[GoogleMap] Directions API error:", status);
        console.error("[GoogleMap] Full request object:", JSON.stringify(request, null, 2));
        console.error("[GoogleMap] Request details:", {
          origin: {
            lat: request.origin.lat,
            lng: request.origin.lng,
            latType: typeof request.origin.lat,
            lngType: typeof request.origin.lng,
            latIsNaN: isNaN(request.origin.lat),
            lngIsNaN: isNaN(request.origin.lng),
          },
          destination: {
            lat: request.destination.lat,
            lng: request.destination.lng,
            latType: typeof request.destination.lat,
            lngType: typeof request.destination.lng,
            latIsNaN: isNaN(request.destination.lat),
            lngIsNaN: isNaN(request.destination.lng),
          },
          waypointsCount: request.waypoints?.length || 0,
          waypoints: request.waypoints?.map((wp, idx) => ({
            index: idx,
            location: wp.location,
            latType: typeof wp.location.lat,
            lngType: typeof wp.location.lng,
            latIsNaN: isNaN(wp.location.lat),
            lngIsNaN: isNaN(wp.location.lng),
            latValue: wp.location.lat,
            lngValue: wp.location.lng,
            stopover: wp.stopover,
          })),
          travelMode: request.travelMode,
          containsZawaoOkama,
          waypointDetails,
        });
      };

      if (status === google.maps.DirectionsStatus.ZERO_RESULTS) {
        const warning =
          "🚧 このルートには冬季閉鎖区間が含まれている可能性があります。正確なルートは Google マップでご確認ください。";
        setRouteWarning(warning);
        directionsRendererRef.current?.setDirections({ routes: [] as any });
        // ZERO_RESULTS 時も RouteList を表示（useEffect で自動表示される）
        logFailure();
        return;
      }

      // その他のエラー
      setRouteWarning("ルートを取得できませんでした。Google マップで代替ルートをご確認ください。");
      directionsRendererRef.current?.setDirections({ routes: [] as any });
      // エラー時も RouteList を表示（useEffect で自動表示される）
      logFailure();
    });
  }, [showRoute, koyoOrigin, origin, center]);

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

  // originが更新されたらルートを再描画
  useEffect(() => {
    if (!isLoading && showRoute && spots && spots.length >= 1) {
      drawRoute(spots);
    }
  }, [origin, isLoading, showRoute, spots, drawRoute]);

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
      const koyoHtml = buildKoyoInfoWindowContent();

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
      <RouteList
        route={routeListData}
        visible={showRouteList}
        onClose={() => {
          if (onShowRouteListChange) {
            onShowRouteListChange(false);
          }
        }}
        hasWarning={!!routeWarning}
        warningMessage={routeWarning || undefined}
      />
    </div>
  );
}
