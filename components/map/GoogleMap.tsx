"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { loadGoogleMaps } from "./MapLoader";
import type { Spot, OriginInfo, RouteInfo } from "@/store/spots";
import { useSpotStore } from "@/store/spots";
import { getPrefBoundary, type PrefectureKey } from "@/store/prefBoundaries";
import { getDefaultEntryPoint } from "@/app/api/koyo/before/_constants/prefEntryPoints";
import type { RouteLegInfo, RoutePoint, KoyoMode, WaypointInfo } from "@/types/route";
import { KOYO_COORDINATES } from "@/constants/koyo";
import RouteList from "./RouteList";

// モード判定関数
function detectMode(
  origin: OriginInfo | undefined,
  destination: { lat: number; lng: number } | undefined,
  koyoOrigin: { lat: number; lng: number } | undefined
): KoyoMode {
  const KOYO_LAT = KOYO_COORDINATES.lat;
  const KOYO_LNG = KOYO_COORDINATES.lng;

  // ■ Before（Pre-Checkin）
  // type が設定されている場合（県境モードや入力モード）は Before
  if (origin && origin.type !== null) {
    return "before";
  }

  // ■ After（帰宅）
  // destination が古窯ではない場合
  if (destination && koyoOrigin) {
    const isDestinationKoyo =
      Math.abs(destination.lat - KOYO_LAT) < 0.0001 &&
      Math.abs(destination.lng - KOYO_LNG) < 0.0001;

    if (!isDestinationKoyo) {
      return "after";
    }
  }

  // ■ Stay（宿泊中）
  return "stay";
}

// ラベル割り当て関数
function assignLabel(
  routePoints: RoutePoint[],
  mode: KoyoMode
): RoutePoint[] {
  return routePoints.map((p, index) => {
    // --- origin ---
    if (p.pointType === "origin") {
      // Stayモードでoriginとdestinationが同じ位置の場合は「S / G」
      if (mode === "stay") {
        const isDestinationSame = routePoints.some(
          (dp) =>
            dp.pointType === "destination" &&
            Math.abs(dp.location.lat - p.location.lat) < 0.0001 &&
            Math.abs(dp.location.lng - p.location.lng) < 0.0001
        );
        if (isDestinationSame) {
          return { ...p, label: "S / G" };
        }
      }
      return { ...p, label: "S" };
    }

    // --- destination ---
    if (p.pointType === "destination") {
      // Stayモードでoriginとdestinationが同じ位置の場合は、originで既に「S / G」を設定済み
      // この場合はdestinationのマーカーは描画しない（後で処理）
      if (mode === "stay") {
        const isOriginSame = routePoints.some(
          (op) =>
            op.pointType === "origin" &&
            Math.abs(op.location.lat - p.location.lat) < 0.0001 &&
            Math.abs(op.location.lng - p.location.lng) < 0.0001
        );
        if (isOriginSame) {
          // destinationは描画しない（originで「S / G」として表示済み）
          return { ...p, label: "" };
        }
      }
      return { ...p, label: "G" };
    }

    // --- waypoints ---
    // originの次から1番、2番、3番...と振る
    const wpIndex = index; // index=1が最初のwaypointなので、そのまま使用
    return { ...p, label: String(wpIndex) };
  });
}

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
  destination?: OriginInfo; // Afterモード用のdestination情報
  routeInfo?: { origin: { lat: number; lng: number }; waypoints: WaypointInfo[]; destination: { lat: number; lng: number } } | null; // ルート情報（APIから取得）
  onRouteWarningChange?: (warning: string | null) => void; // ルート取得失敗時の警告メッセージを親に通知
  showRouteList?: boolean; // RouteList の表示状態（親から制御）
  onShowRouteListChange?: (show: boolean) => void; // RouteList の表示状態を変更する関数
  onSpotDoubleClick?: (spotId: string) => void; // スポットの2回タップ検出時に呼び出されるコールバック
}

export default function GoogleMap({
  center,
  markers,
  spots,
  showRoute = false,
  koyoOrigin,
  origin,
  destination,
  routeInfo,
  onRouteWarningChange,
  showRouteList: showRouteListProp,
  onShowRouteListChange,
  onSpotDoubleClick,
}: GoogleMapProps) {
  const { routeLegs, setRouteLegs, routeReady, routeVersion } = useSpotStore();
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const infoWindowsRef = useRef<any[]>([]);
  const optionalMarkersRef = useRef<any[]>([]); // Phase2-1: 候補ピン（optionalSpots）専用
  const optionalInfoWindowsRef = useRef<any[]>([]); // Phase2-1: 候補ピンのInfoWindow専用
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
  const [routePoints, setRoutePoints] = useState<RoutePoint[]>([]);
  
  // 2回タップ検出用の状態管理
  const lastClickedSpotIdRef = useRef<string | null>(null);
  const lastClickTimeRef = useRef<number>(0);
  const DOUBLE_CLICK_THRESHOLD = 500; // 500ms以内の2回タップを検出
  
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
    if (routeLegs.length > 0 && onShowRouteListChange && !hasAutoShownRef.current) {
      console.log("[GoogleMap] Auto-showing route list, routeLegs.length:", routeLegs.length);
      onShowRouteListChange(true);
      hasAutoShownRef.current = true;
    }
    // routeLegs が空になったらリセット
    if (routeLegs.length === 0) {
      hasAutoShownRef.current = false;
    }
  }, [routeLegs.length, onShowRouteListChange]);

  // Phase2-2.5: validateRouteState関数（pure関数化）
  const validateRouteState = useCallback((
    routeInfo: RouteInfo | null | undefined,
    validSpots: Array<Spot & { lat: number; lng: number }>,
    routePlanSpots: Array<{ id: string }> | undefined
  ): { ok: true } | { ok: false; missingSpotIds: string[] } => {
    // waypointsが空（直行ルート）の場合は常にOK
    if (!routeInfo?.waypoints || routeInfo.waypoints.length === 0) {
      return { ok: true };
    }

    // routeInfoがない場合はNG
    if (!routeInfo) {
      return { ok: false, missingSpotIds: [] };
    }

    const validSpotIds = new Set(validSpots.map(s => s.id));
    // routePlan.spots もチェック対象に追加
    const planSpotIds = routePlanSpots?.map(s => s.id) || [];
    planSpotIds.forEach(id => validSpotIds.add(id));
    
    const missingSpotIds: string[] = [];
    
    for (const waypoint of routeInfo.waypoints) {
      if (waypoint.spotId && !validSpotIds.has(waypoint.spotId)) {
        missingSpotIds.push(waypoint.spotId);
      }
    }
    
    if (missingSpotIds.length > 0) {
      return { ok: false, missingSpotIds };
    }
    
    return { ok: true };
  }, []);

  // Directions APIでルートを描画する関数
  const drawRoute = useCallback((routeSpots: Spot[]) => {
    // Phase2-2.5: drawRoute実行時に1回だけstateを読み取る
    const currentState = useSpotStore.getState();
    const currentRouteInfo = currentState.routeInfo;
    const currentRoutePlan = currentState.routePlan;
    const currentRouteReady = currentState.routeReady;
    
    const detectedMode = detectMode(origin, currentRouteInfo?.destination, koyoOrigin);
    
    // null安全性チェック：有効な座標を持つスポットのみをフィルタリング（候補ピン用/後方互換用）
    const validSpots = (routeSpots || []).filter(
      (s) => s.lat != null && s.lng != null
    ) as Array<Spot & { lat: number; lng: number }>;
    
    console.log("[drawRoute]", {
      mode: detectedMode,
      showRoute,
      routeReady: currentRouteReady,
      routeVersion: currentState.routeVersion,
      hasDirectionsService: !!directionsServiceRef.current,
      hasDirectionsRenderer: !!directionsRendererRef.current,
      hasRouteInfo: !!currentRouteInfo,
      hasRouteInfoOrigin: !!currentRouteInfo?.origin,
      hasRouteInfoDestination: !!currentRouteInfo?.destination,
      planSpotIds: currentRoutePlan?.spots?.slice(0, 10).map(s => s.id) || [],
      planSpotIdsCount: currentRoutePlan?.spots?.length || 0,
      storeSpotIds: routeSpots?.slice(0, 10).map(s => s.id) || [],
      storeSpotIdsCount: routeSpots?.length || 0,
      validSpotIds: validSpots?.slice(0, 10).map(s => s.id) || [],
      validSpotIdsCount: validSpots?.length || 0,
      waypointSpotIds: currentRouteInfo?.waypoints?.map(w => w.spotId) || [],
      waypointSpotIdsCount: currentRouteInfo?.waypoints?.length || 0,
    });
    
    if (!showRoute) return;
    if (!directionsServiceRef.current || !directionsRendererRef.current) {
      console.warn("[GoogleMap] Directions API not initialized");
      return;
    }

    // Phase2-2.5: routeReady/routeInfoのガード
    if (!currentRouteReady || !currentRouteInfo) {
      console.log("[GoogleMap] drawRoute skipped: route not ready or routeInfo missing", {
        routeReady: currentRouteReady,
        hasRouteInfo: !!currentRouteInfo,
        routeVersion: currentState.routeVersion,
      });
      return;
    }

    // routeInfo がない場合は描画材料が不足（Phase2-1: 直行ルートは routeInfo 前提）
    if (!currentRouteInfo.origin || !currentRouteInfo.destination) {
      console.log("[GoogleMap] drawRoute skipped: no routeInfo.origin/destination", {
        hasOrigin: !!currentRouteInfo.origin,
        hasDestination: !!currentRouteInfo.destination,
        routeVersion: currentState.routeVersion,
      });
      return;
    }

    // Phase2-2.5: validateRouteStateでガード
    const validation = validateRouteState(currentRouteInfo, validSpots, currentRoutePlan?.spots);
    if (!validation.ok) {
      console.log("[GoogleMap] route mismatch: waypoints=" + currentRouteInfo.waypoints.length + 
        ", spots=" + validSpots.length + 
        ", planSpots=" + (currentRoutePlan?.spots?.length || 0) + 
        ", missingSpotIds=[" + validation.missingSpotIds.join(", ") + "]", {
        waypointSpotIds: currentRouteInfo.waypoints.map(w => w.spotId).filter(Boolean),
        validSpotIds: validSpots.map(s => s.id),
        planSpotIds: currentRoutePlan?.spots?.map(s => s.id) || [],
        routeVersion: currentState.routeVersion,
      });
      return;
    }

    // Phase2-1: waypoints決定を冒頭で一本化（最優先はrouteInfo.waypoints）
    // - 配列が存在するなら（空配列でも）必ず採用
    // - undefined/null のときだけ validSpots から生成（後方互換）
    const hasWaypointsArray = Array.isArray(currentRouteInfo.waypoints);
    console.log("[GoogleMap] Phase2-1 waypoint resolution (fact-check):", {
      hasWaypointsArray,
      routeInfoWaypoints: currentRouteInfo.waypoints,
      validSpotsCount: validSpots.length,
    });
    const resolvedRouteWaypoints: Array<{
      name?: string;
      location: { lat: number; lng: number };
      stopover: true;
      category?: string | null;
      city?: string | null;
      spotId?: string;
    }> = hasWaypointsArray
      ? (currentRouteInfo.waypoints || []).map((wp) => {
          // spotIdでspotを検索（AfterではspotId必須）
          let spot: Spot | null = null;
          if (wp.spotId) {
            spot = validSpots.find((s) => s.id === wp.spotId) ?? null;
            // routePlan.spots も検索対象に追加
            if (!spot && currentRoutePlan?.spots) {
              const planSpot = currentRoutePlan.spots.find((s) => s.id === wp.spotId);
              if (planSpot && planSpot.lat != null && planSpot.lng != null) {
                spot = {
                  ...planSpot,
                  stayMinutes: planSpot.stayMinutes ?? undefined,
                } as Spot & { lat: number; lng: number };
              }
            }
          }
          return {
            name: spot?.name || "",
            location: { lat: wp.lat, lng: wp.lng },
            stopover: true as const,
            category: spot?.category ?? null,
            city: spot?.city ?? null,
            spotId: wp.spotId, // spotIdを保持
          };
        })
      : validSpots.map((s) => ({
          name: s.name,
          location: { lat: s.lat!, lng: s.lng! },
          stopover: true as const,
          category: s.category ?? null,
          city: s.city ?? null,
          spotId: s.id, // spotIdを保持
        }));
    console.log("[GoogleMap] Phase2-1 resolvedRouteWaypoints (fact-check):", {
      count: resolvedRouteWaypoints.length,
      coords: resolvedRouteWaypoints.map((w) => w.location),
    });

    // ルート重複判定キー（routeInfoベースで安定化）
    const currentRouteKey = [
      `o:${currentRouteInfo.origin.lat},${currentRouteInfo.origin.lng}`,
      `d:${currentRouteInfo.destination.lat},${currentRouteInfo.destination.lng}`,
      `w:${resolvedRouteWaypoints.map((w) => `${w.location.lat},${w.location.lng}`).join("|")}`,
    ].join(";");
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
    // Phase2-1: 分岐内で再生成しない（冒頭で確定済み）
    const routeWaypoints = resolvedRouteWaypoints;

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
    
    console.log("[GoogleMap] Origin check:", {
      hasPrefBoundary,
      hasFixedOrigin,
      hasCurrentOrigin,
      originType: origin?.type,
      originPref: origin?.pref,
      origin,
      routeInfoOrigin: currentRouteInfo.origin,
    });
    
    // routeInfo.originが存在し、originが設定されていない場合、routeInfo.originを優先する
    // Beforeモードで県境が設定されている場合、routeInfo.originに正しい座標が含まれている
    if (currentRouteInfo.origin && !hasPrefBoundary && !hasFixedOrigin && !hasCurrentOrigin) {
      console.log("[GoogleMap] Using routeInfo.origin as routeOrigin (origin not set)");
      routeOrigin = currentRouteInfo.origin;
      routeDestination = currentRouteInfo.destination || koyoOrigin || center;
      console.log("[GoogleMap] Using routeInfo for route:", {
        origin: routeOrigin,
        destination: routeDestination,
        waypointsCount: routeWaypoints.length,
      });
    } else if (hasPrefBoundary) {
      // 県境 → AIスポット → 古窯
      const prefBoundary = getPrefBoundary(origin!.pref as PrefectureKey);
      routeOrigin = prefBoundary;
      routeDestination = koyoOrigin || center;
      console.log(
        "[GoogleMap] Pre-Checkin (pref-boundary): origin -> spots -> Koyo",
        routeOrigin,
        "=>",
        routeDestination
      );
      console.log("[GoogleMap] routeOrigin (pref-boundary):", routeOrigin);
      console.log("[GoogleMap] origin info:", origin);
    } else if (hasFixedOrigin || hasCurrentOrigin) {
      // A〜E / 現在地 → AIスポット → 古窯
      routeOrigin = {
        lat: origin!.lat as number,
        lng: origin!.lng as number,
      };
      routeDestination = koyoOrigin || center;
      console.log(
        "[GoogleMap] Pre-Checkin (fixed/current): origin -> spots -> Koyo",
        routeOrigin,
        "=>",
        routeDestination
      );
    } else if (koyoOrigin) {
      // 通常モード（Stay/After/通常Before）
      routeOrigin = koyoOrigin;
      // routeInfo が存在する場合は destination を使用、なければ古窯固定
      if (currentRouteInfo.destination) {
        routeDestination = currentRouteInfo.destination;
        console.log(
          "[GoogleMap] Using routeInfo.destination:",
          routeDestination
        );
      } else {
        routeDestination = koyoOrigin; // デフォルト：古窯固定
      }
      console.log(
        "[GoogleMap] Normal mode: Koyo -> spots ->",
        routeDestination === koyoOrigin ? "Koyo" : "Destination",
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
      // spotIdでspotを取得（一貫性のため）
      let spot: Spot | null = null;
      if (wp.spotId) {
        spot = validSpots.find((s) => s.id === wp.spotId) ?? null;
      }
      return {
        index,
        spotId: spot?.id || wp.spotId || "unknown",
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

    // destination の名前を取得する関数
    const getDestinationName = () => {
      // 1. destination プロパティの name を最優先でチェック
      if (destination && destination.name) {
        return `到着：${destination.name}`;
      }
      
      // 2. routeInfo が存在し、destination が古窯と異なる場合
      const currentState = useSpotStore.getState();
      const currentRouteInfoForDest = currentState.routeInfo;
      if (currentRouteInfoForDest && currentRouteInfoForDest.destination) {
        const dest = currentRouteInfoForDest.destination;
        const koyoLat = koyoOrigin?.lat || center.lat;
        const koyoLng = koyoOrigin?.lng || center.lng;
        
        // 古窯の座標と一致するかチェック（小数点以下6桁で比較）
        const isKoyo = 
          Math.abs(dest.lat - koyoLat) < 0.000001 &&
          Math.abs(dest.lng - koyoLng) < 0.000001;
        
        if (isKoyo) {
          return "到着：日本の宿 古窯";
        }
        
        // 県境の座標と一致するかチェック
        const prefBoundaries = [
          { pref: "miyagi" as PrefectureKey, name: "宮城県境" },
          { pref: "fukushima" as PrefectureKey, name: "福島県境" },
          { pref: "akita" as PrefectureKey, name: "秋田県境" },
          { pref: "niigata" as PrefectureKey, name: "新潟県境" },
        ];
        
        for (const { pref, name } of prefBoundaries) {
          const boundary = getPrefBoundary(pref);
          if (
            Math.abs(dest.lat - boundary.lat) < 0.000001 &&
            Math.abs(dest.lng - boundary.lng) < 0.000001
          ) {
            return `到着：${name}`;
          }
        }
        
        // 固定地点（A〜E）の座標と一致するかチェック
        const fixedPoints = [
          { name: "山形駅", lat: 38.248662864893596, lng: 140.327528420525 },
          { name: "山形空港", lat: 38.4125, lng: 140.3711 },
          { name: "かみのやま温泉駅", lat: 38.15233921920549, lng: 140.27857922264496 },
          { name: "山形蔵王IC", lat: 38.24564526672003, lng: 140.38118390915645 },
          { name: "かみのやま温泉IC", lat: 38.12676684858146, lng: 140.2560067803147 },
        ];
        
        for (const point of fixedPoints) {
          if (
            Math.abs(dest.lat - point.lat) < 0.000001 &&
            Math.abs(dest.lng - point.lng) < 0.000001
          ) {
            return `到着：${point.name}`;
    }
        }
        
        // 一致しない場合は座標を表示
        return `到着：目的地`;
      }
      
      // routeInfo が存在しない場合は古窯固定
      return "到着：日本の宿 古窯";
    };

    // routeLegs を生成する関数
    const buildRouteLegs = (legs: any[] | null): RouteLegInfo[] => {
      const originName = getOriginName();
      const destinationName = getDestinationName();
      
      // spot解決ヘルパー関数（spotId参照で統一）
      // 注意: setRouteInfo と setRoutePlan の更新タイミングのずれを考慮し、routePlan.spots も検索対象に追加
      const resolveSpotByWaypoint = (wp: WaypointInfo | undefined, routePlan: typeof currentRoutePlan): Spot | null => {
        if (!wp?.spotId) return null;
        // まず validSpots から検索
        let spot = validSpots.find((s) => s.id === wp.spotId) ?? null;
        // 見つからない場合は routePlan.spots から検索（setRoutePlan の更新タイミングを考慮）
        if (!spot && routePlan?.spots) {
          const planSpot = routePlan.spots.find((s) => s.id === wp.spotId);
          // lat/lngがnullでない場合のみ有効なspotとして扱う
          if (planSpot && planSpot.lat != null && planSpot.lng != null) {
            // RoutePlan.spotsの型をSpot型に変換（stayMinutesのnullをundefinedに変換）
            spot = {
              ...planSpot,
              stayMinutes: planSpot.stayMinutes ?? undefined,
            } as Spot & { lat: number; lng: number };
          }
        }
        return spot;
      };
      
      // デバッグ: routeInfo.waypointsとvalidSpotsの内容を確認
      console.log("[GoogleMap] buildRouteLegs: routeInfo.waypoints", currentRouteInfo.waypoints?.map(wp => ({
        spotId: wp.spotId,
        lat: wp.lat,
        lng: wp.lng,
      })));
      console.log("[GoogleMap] buildRouteLegs: validSpots", validSpots.map(s => ({
        id: s.id,
        name: s.name,
        lat: s.lat,
        lng: s.lng,
      })));

      // legs がない場合（ZERO_RESULTS など）は、routeInfo.waypointsのspotId優先でspot解決
      if (!legs || legs.length === 0) {
        const routeLegs: RouteLegInfo[] = [];
        
        // waypointsが空（直行ルート）の場合: origin → destination
        if (!currentRouteInfo.waypoints || currentRouteInfo.waypoints.length === 0) {
          // 最初に出発地を追加
          const firstFromName = originName.replace("出発：", "");
          routeLegs.push({
            index: 0,
            fromName: firstFromName,
            toName: firstFromName, // 表示用にtoNameにも同じ値を設定
            distanceText: "",
            durationText: "",
            stayTimeText: null,
            spotId: null,
            category: null,
            city: null,
          });
          
          // origin → destination
          routeLegs.push({
            index: 1,
            fromName: originName.replace("出発：", ""),
            toName: destinationName.replace("到着：", ""),
            distanceText: "",
            durationText: "",
            stayTimeText: null,
            spotId: null,
            category: null,
            city: null,
          });
          
          return routeLegs;
        }
        
        // waypointsがある場合: waypoints順で origin→wp..→destination を生成
        // 最初に出発地を追加
        const firstFromName = originName.replace("出発：", "");
        routeLegs.push({
          index: 0,
          fromName: firstFromName,
          toName: firstFromName, // 表示用にtoNameにも同じ値を設定
          distanceText: "",
          durationText: "",
          stayTimeText: null,
          spotId: null,
          category: null,
          city: null,
        });
        
        // 最初の leg: origin → 最初のwaypoint
        if (currentRouteInfo.waypoints.length > 0) {
          const firstWaypoint = currentRouteInfo.waypoints[0];
          const firstSpot = resolveSpotByWaypoint(firstWaypoint, currentRoutePlan);
          routeLegs.push({
            index: 1,
            fromName: originName.replace("出発：", ""),
            toName: firstSpot?.name ?? firstWaypoint.spotId ?? `立ち寄りスポット1`,
            distanceText: "",
            durationText: "",
            stayTimeText: firstSpot?.stay_time || null,
            spotId: firstSpot?.id ?? firstWaypoint.spotId ?? null,
            category: firstSpot?.category ?? null,
            city: firstSpot?.city ?? null,
          });
        }

        // 中間の legs: waypoint間
        for (let i = 1; i < currentRouteInfo.waypoints.length; i++) {
          const prevWaypoint = currentRouteInfo.waypoints[i - 1];
          const currentWaypoint = currentRouteInfo.waypoints[i];
          const prevSpot = resolveSpotByWaypoint(prevWaypoint, currentRoutePlan);
          const currentSpot = resolveSpotByWaypoint(currentWaypoint, currentRoutePlan);
          routeLegs.push({
            index: i + 1,
            fromName: prevSpot?.name ?? prevWaypoint.spotId ?? `立ち寄りスポット${i}`,
            toName: currentSpot?.name ?? currentWaypoint.spotId ?? `立ち寄りスポット${i + 1}`,
            distanceText: "",
            durationText: "",
            stayTimeText: currentSpot?.stay_time || null,
            spotId: currentSpot?.id ?? currentWaypoint.spotId ?? null,
            category: currentSpot?.category ?? null,
            city: currentSpot?.city ?? null,
          });
        }

        // 最後の leg: 最後のwaypoint → destination
        if (currentRouteInfo.waypoints.length > 0) {
          const lastWaypoint = currentRouteInfo.waypoints[currentRouteInfo.waypoints.length - 1];
          const lastSpot = resolveSpotByWaypoint(lastWaypoint, currentRoutePlan);
          routeLegs.push({
            index: currentRouteInfo.waypoints.length + 1,
            fromName: lastSpot?.name ?? lastWaypoint.spotId ?? `立ち寄りスポット${currentRouteInfo.waypoints.length}`,
            toName: destinationName.replace("到着：", ""),
            distanceText: "",
            durationText: "",
            stayTimeText: null,
            spotId: null,
            category: null,
            city: null,
          });
        }

        return routeLegs;
      }

      // legs がある場合（Directions API 成功時）
      // legs の構造:
      // - legs[0]: origin → waypoint[0] (validSpots[0] に対応)
      // - legs[1]: waypoint[0] → waypoint[1] (validSpots[1] に対応)
      // - ...
      // - legs[waypoints.length]: waypoint[waypoints.length-1] → destination
      const routeLegs: RouteLegInfo[] = [];
      
      // 最初に出発地を追加（最初のlegのfromName）
      if (legs.length > 0) {
        const firstLeg = legs[0];
        const firstFromName = originName.replace("出発：", "");
        routeLegs.push({
          index: 0,
          fromName: firstFromName,
          toName: firstFromName, // 表示用にtoNameにも同じ値を設定
          distanceText: "",
          durationText: "",
          stayTimeText: null,
          spotId: null,
          category: null,
          city: null,
        });
      }
      
      // 各legを処理して、スポットごとに1つのRouteLegInfoを作成
      // routeInfo.waypoints の順番に完全追従（spotIdで検索）
      legs.forEach((leg, index) => {
        // routeInfo.waypoints の順番に従ってspotを取得
        let spot: Spot | null = null;
        if (index < currentRouteInfo.waypoints.length) {
          const waypoint = currentRouteInfo.waypoints[index];
          // spotIdでspotを検索（AfterではspotId必須）
          spot = resolveSpotByWaypoint(waypoint, currentRoutePlan);
          if (!spot && waypoint.spotId) {
            console.log("[GoogleMap] route mismatch: spotId not found in buildRouteLegs", {
              waypointIndex: index,
              spotId: waypoint.spotId,
              waypointCoords: { lat: waypoint.lat, lng: waypoint.lng },
              validSpotsIds: validSpots.map(s => s.id),
              planSpotIds: currentRoutePlan?.spots?.map(s => s.id) || [],
            });
            // 保険として座標近傍検索（After正常系では使わない）
            spot = validSpots.find((s) => 
              Math.abs(s.lat! - waypoint.lat) < 0.000001 &&
              Math.abs(s.lng! - waypoint.lng) < 0.000001
            ) ?? null;
          }
        }

        // fromName生成（spotId参照に統一）
        let fromName: string;
        if (index === 0) {
          fromName = originName.replace("出発：", "");
        } else if (index > 0 && index <= currentRouteInfo.waypoints.length) {
          // 前のwaypointのspotIdでspotを取得
          const prevWaypoint = currentRouteInfo.waypoints[index - 1];
          const prevSpot = resolveSpotByWaypoint(prevWaypoint, currentRoutePlan);
          fromName = prevSpot?.name ?? originName.replace("出発：", "");
        } else {
          fromName = originName.replace("出発：", "");
        }

        // 最後の leg の to は到着地名、それ以外はスポット名
        const isLastLeg = index === legs.length - 1;
        // ③ 見つからなければ leg.end_address / 座標表示
        const toName = isLastLeg
          ? destinationName.replace("到着：", "")
          : spot?.name ??
            leg.end_address ??
            `立ち寄りスポット${index + 1}`;

        // ルート表の表示用インデックス（出発地がindex 0なので、+1する）
        // 最初のleg（origin → spot[0]）は index 1
        // 中間のlegs（spot[i-1] → spot[i]）は index i+1
        // 最後のleg（spot[last] → destination）は index validSpots.length+1
        const displayIndex = isLastLeg ? currentRouteInfo.waypoints.length + 1 : index + 1;

        routeLegs.push({
          index: displayIndex,
          fromName,
          toName,
          distanceText: leg.distance?.text ?? "",
          durationText: leg.duration?.text ?? "",
          stayTimeText: spot?.stay_time || null,
          spotId: spot?.id ?? null,
          category: spot?.category ?? null,
          city: spot?.city ?? null,
        });
      });

      return routeLegs;
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

    // routePoints を生成（Directions API呼び出し前に生成）
    const mode = detectMode(origin, routeDestination, koyoOrigin);
    console.log("[GoogleMap] Generating routePoints - mode:", mode, "routeOrigin:", routeOrigin);
    const generatedRoutePoints: RoutePoint[] = [
      {
        location: routeOrigin,
        pointType: "origin",
        label: "", // assignLabelで設定
        name: getOriginName().replace("出発：", ""),
      },
      ...routeWaypoints.map((wp) => {
        // spotIdでspotを取得
        let spot: Spot | null = null;
        if (wp.spotId) {
          spot = validSpots.find((s) => s.id === wp.spotId) ?? null;
        }
        return {
          location: wp.location,
          pointType: "waypoint" as const,
          label: "", // assignLabelで設定
          name: spot?.name || wp.name || `スポット`,
          spotId: spot?.id || wp.spotId || null,
          category: spot?.category || wp.category || null,
          city: spot?.city || wp.city || null,
        };
      }),
      {
        location: routeDestination,
        pointType: "destination",
        label: "", // assignLabelで設定
        name: getDestinationName().replace("到着：", ""),
      },
    ];
    
    // ラベルを割り当て
    const labeledRoutePoints = assignLabel(generatedRoutePoints, mode);
    console.log("[GoogleMap] Generated routePoints:", labeledRoutePoints.length, "points");
    console.log("[GoogleMap] Mode:", mode);
    console.log("[GoogleMap] routePoints details:", JSON.stringify(labeledRoutePoints.map(p => ({
      pointType: p.pointType,
      label: p.label,
      name: p.name,
      location: p.location
    })), null, 2));
    setRoutePoints(labeledRoutePoints);

    directionsServiceRef.current.route(request, (result: any, status: any) => {

        if (status === google.maps.DirectionsStatus.OK && result) {
          directionsRendererRef.current.setDirections(result);
          lastRouteSpotsRef.current = currentRouteKey;
        setRouteWarning(null);
        
        // routeLegs を生成してストアに保存
        const route = result.routes[0];
        const legs = route?.legs || [];
        const routeLegs = buildRouteLegs(legs);
        console.log("[GoogleMap] Generated routeLegs:", routeLegs.length, "legs");
        console.log("[GoogleMap] routeLegs details:", JSON.stringify(routeLegs, null, 2));
        console.log("[GoogleMap] validSpots:", validSpots.map(s => ({ id: s.id, name: s.name })));
        setRouteLegs(routeLegs);
        
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
        
        // ZERO_RESULTS 時も routeLegs を生成（距離・時間は空欄）
        const routeLegs = buildRouteLegs(null);
        console.log("[GoogleMap] Generated routeLegs for ZERO_RESULTS:", routeLegs.length, "legs");
        setRouteLegs(routeLegs);
        
        // routePoints は既に生成済み（Directions API呼び出し前に生成）
        
        // ZERO_RESULTS 時も RouteList を表示（useEffect で自動表示される）
        logFailure();
        return;
      }

      // その他のエラー
      setRouteWarning("ルートを取得できませんでした。Google マップで代替ルートをご確認ください。");
      directionsRendererRef.current?.setDirections({ routes: [] as any });
      
      // エラー時も routeLegs を生成（距離・時間は空欄）
      const routeLegs = buildRouteLegs(null);
      console.log("[GoogleMap] Generated routeLegs for error:", routeLegs.length, "legs");
      setRouteLegs(routeLegs);
      
      // routePoints は既に生成済み（Directions API呼び出し前に生成）
      
      // エラー時も RouteList を表示（useEffect で自動表示される）
      logFailure();
    });
  }, [showRoute, koyoOrigin, origin, center, validateRouteState]);

  // マップの中心を更新
  useEffect(() => {
    if (mapInstanceRef.current && !isLoading) {
      mapInstanceRef.current.setCenter(center);
    }
  }, [center, isLoading]);

  // Phase2-2.5: Directions APIでルートを描画（routeVersion/routeReady基準に変更）
  // routeVersion/routeReadyが更新されたら、drawRoute内部でrouteReady/routeInfo/validateをガード
  useEffect(() => {
    if (!isLoading && showRoute && koyoOrigin) {
      // drawRoute実行時に1回だけstateを読み取る
      const currentState = useSpotStore.getState();
      console.log("[GoogleMap] useEffect triggered, calling drawRoute:", {
        routeVersion: currentState.routeVersion,
        routeReady: currentState.routeReady,
        hasRouteInfo: !!currentState.routeInfo,
        routeInfoWaypoints: currentState.routeInfo?.waypoints?.length || 0,
        spotsCount: currentState.spots?.length || 0,
        showRoute,
        isLoading,
      });
      drawRoute(currentState.spots || []);
    } else {
      console.log("[GoogleMap] useEffect skipped:", {
        isLoading,
        showRoute,
        koyoOrigin: !!koyoOrigin,
      });
    }
  }, [routeVersion, routeReady, showRoute, isLoading, drawRoute, koyoOrigin]);

  // マーカーの更新（routePointsベース）
  useEffect(() => {
    if (!mapInstanceRef.current || isLoading || !googleMapsLibs) {
      console.log("[GoogleMap] Skipping marker update:", {
        hasMap: !!mapInstanceRef.current,
        isLoading,
        hasLibs: !!googleMapsLibs,
      });
      return;
    }

    // routePointsが空の場合は何もしない
    if (routePoints.length === 0) {
      console.log("[GoogleMap] No routePoints to display");
      return;
    }

    console.log("[GoogleMap] Updating markers from routePoints:", routePoints.length);
    const map = mapInstanceRef.current;
    const { Marker, InfoWindow } = googleMapsLibs;
    
    // 早期リターンで関数を終了（依存配列のサイズを一定に保つ）
    if (!Marker || !InfoWindow) {
      return;
    }

    // --- Marker Reset ---
    // 新しいroutePointsがセットされたとき、古いマーカーを必ず全て削除
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

    // routePointsからマーカーを生成
    routePoints.forEach((point) => {
      // labelが空の場合は描画しない（StayモードでS/Gが同じ位置の場合、destinationは描画しない）
      if (!point.label || point.label === "") {
        return;
      }

      // マーカーを作成（ラベル付き）
      const marker = new Marker({
        position: point.location,
        map,
        title: point.name || point.label,
        label: {
          text: point.label,
          color: "#ffffff",
          fontSize: "14px",
          fontWeight: "bold",
        },
      });

      // InfoWindowの生成
      let infoWindow: any = null;
      let infoWindowContent = "";

      // 古窯の場合（originまたはdestinationが古窯）
      const isKoyo = 
        Math.abs(point.location.lat - KOYO_COORDINATES.lat) < 0.0001 &&
        Math.abs(point.location.lng - KOYO_COORDINATES.lng) < 0.0001;

      if (isKoyo) {
        infoWindowContent = buildKoyoInfoWindowContent();
        infoWindow = new InfoWindow({
          content: infoWindowContent,
        });
      } else if (point.spotId) {
        // スポットの場合（waypoint）
        // スポット情報を取得（markers配列とroutePlan.spotsの両方を検索）
        // 注意: setRouteInfo と setRoutePlan の更新タイミングのずれを考慮し、routePlan.spots も検索対象に追加
        let spot = markers.find((s) => s.id === point.spotId);
        // 見つからない場合は routePlan.spots から検索（setRoutePlan の更新タイミングを考慮）
        if (!spot) {
          const currentRoutePlan = useSpotStore.getState().routePlan;
          const planSpot = currentRoutePlan?.spots?.find((s) => s.id === point.spotId);
          if (planSpot) {
            // RoutePlan.spotsの型をSpot型に変換（stayMinutesのnullをundefinedに変換）
            spot = {
              ...planSpot,
              stayMinutes: planSpot.stayMinutes ?? undefined,
            } as Spot;
          }
        }
        if (spot) {
        const imageUrl = (spot as any).photoUrl || spot.imageUrl || "/noimage.png";
          infoWindowContent = `
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
            ${spot.description ? `<p style="margin:4px 0 0; font-size:12px; color:#666; line-height:1.5;">${spot.description}</p>` : ""}
          </div>
        `;
          infoWindow = new InfoWindow({
            content: infoWindowContent,
        });
        } else {
          // スポットが見つからない場合の警告ログ
          console.warn("[GoogleMap] InfoWindow: spot not found for spotId:", point.spotId, {
            markerIds: markers.map(s => s.id),
            planSpotIds: useSpotStore.getState().routePlan?.spots?.map(s => s.id) || [],
          });
        }
      }

      // クリックイベントを追加
      if (infoWindow) {
        marker.addListener("click", () => {
          // 他の情報ウィンドウを閉じる
          infoWindowsRef.current.forEach((iw) => iw.close());
          infoWindow.open({
            map: mapInstanceRef.current,
            anchor: marker,
          });
          
          // 2回タップ検出
          if (point.spotId && onSpotDoubleClick) {
            const now = Date.now();
            const timeSinceLastClick = now - lastClickTimeRef.current;
            
            if (
              lastClickedSpotIdRef.current === point.spotId &&
              timeSinceLastClick < DOUBLE_CLICK_THRESHOLD
            ) {
              // 2回タップ検出
              console.log("[GoogleMap] Double click detected for spot:", point.spotId);
              onSpotDoubleClick(point.spotId);
              // リセット
              lastClickedSpotIdRef.current = null;
              lastClickTimeRef.current = 0;
            } else {
              // 1回目のタップ
              lastClickedSpotIdRef.current = point.spotId;
              lastClickTimeRef.current = now;
            }
          }
        });
        infoWindowsRef.current.push(infoWindow);
      }

      newMarkers.push(marker);
      bounds.extend(point.location);
      });

    // マーカー参照を更新
      markersRef.current = newMarkers;

      // デバッグログ：表示されたマーカー数を確認
    console.log(`[GoogleMap] Created ${newMarkers.length} markers from routePoints (${skippedCount} skipped)`);
      
      if (newMarkers.length === 0) {
      console.warn("[GoogleMap] No valid markers created from routePoints");
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

    // マーカー数で挙動を分岐
      const totalMarkerCount = newMarkers.length;
      if (totalMarkerCount === 1) {
      // マーカーが1つのみ → zoom: 14
        mapInstanceRef.current.setCenter(bounds.getCenter());
        mapInstanceRef.current.setZoom(14);
      console.log("[Map] マーカー1つのためズーム固定で表示");
      } else if (totalMarkerCount > 1) {
      // 複数マーカー → bounds.fit()
        mapInstanceRef.current.fitBounds(bounds, 80);
      console.log("[Map] 複数マーカーのため bounds.fit で調整");
      }
  }, [routePoints, isLoading, googleMapsLibs, center, markers]); // routePointsが更新されたら再描画

  // Phase2-1: 候補ピン（optionalSpots）を別描画（spots更新時に全削除→再描画）
  useEffect(() => {
    if (!mapInstanceRef.current || isLoading || !googleMapsLibs) {
      return;
    }

    const { Marker, InfoWindow } = googleMapsLibs;
    if (!Marker || !InfoWindow) {
      return;
    }

    const map = mapInstanceRef.current;
    const google = (window as any).google;
    if (!google || !google.maps) {
      return;
    }

    // 既存の候補ピンを全削除
    optionalMarkersRef.current.forEach((m) => m.setMap(null));
    optionalMarkersRef.current = [];
    optionalInfoWindowsRef.current.forEach((iw) => iw.close());
    optionalInfoWindowsRef.current = [];

    // spots（optionalSpots）が空の場合は何もしない
    if (!spots || spots.length === 0) {
      console.log("[GoogleMap] Phase2-1: No optional spots to display");
      return;
    }

    console.log("[GoogleMap] Phase2-1: Creating optional markers from spots:", spots.length);

    // 候補ピンを生成（①②…のラベルを付ける）
    spots.forEach((spot, index) => {
      if (spot.lat == null || spot.lng == null) {
        console.warn(`[GoogleMap] Phase2-1: Skipping optional spot "${spot.name}" - missing coordinates`);
        return;
      }

      // 丸数字のラベルを生成（①②③…）
      const circleNumbers = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];
      const label = index < circleNumbers.length ? circleNumbers[index] : String(index + 1);

      const marker = new Marker({
        position: { lat: spot.lat, lng: spot.lng },
        map,
        title: spot.name || `候補${index + 1}`,
        label: {
          text: label,
          color: "#ffffff",
          fontSize: "14px",
          fontWeight: "bold",
        },
        icon: {
          // 候補ピンは少し小さめのサイズで表示（オプション）
          url: "http://maps.google.com/mapfiles/ms/icons/blue-dot.png",
          scaledSize: new google.maps.Size(32, 32),
        },
      });

      // InfoWindowの生成（既存のスポット情報表示を再利用）
      const imageUrl = (spot as any).photoUrl || spot.imageUrl || "/noimage.png";
      const infoWindowContent = `
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
        content: infoWindowContent,
      });

      // クリックイベントを追加
      marker.addListener("click", () => {
        // 他のInfoWindowを閉じる（routePoints由来のものも含む）
        infoWindowsRef.current.forEach((iw) => iw.close());
        optionalInfoWindowsRef.current.forEach((iw) => iw.close());
        infoWindow.open({
          map: mapInstanceRef.current,
          anchor: marker,
        });
      });

      optionalMarkersRef.current.push(marker);
      optionalInfoWindowsRef.current.push(infoWindow);
    });

    console.log(`[GoogleMap] Phase2-1: Created ${optionalMarkersRef.current.length} optional markers`);
  }, [spots, isLoading, googleMapsLibs, center]); // spots更新時に再描画

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
      {/* 直行ルート（routeInfoあり・waypoints空）でも spots が 0 のことがあるため、
          markers.length===0 だけで空状態を出すと、ルート線/地図がオーバーレイに隠れる。
          routeInfoがある（= ルート表示の材料がある）場合は空状態を出さない。 */}
      {!isLoading && markers.length === 0 && !routeInfo && routePoints.length === 0 && (
        <div className="absolute inset-0 bg-gray-50 flex items-center justify-center z-10 pointer-events-none">
          <div className="text-gray-500 text-sm">スポットがありません</div>
        </div>
      )}
      <RouteList
        routeLegs={routeLegs}
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
