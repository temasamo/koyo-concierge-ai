// app/api/koyo/_utils/places.ts
// Google Places API関連の共通ユーティリティ

import type { StopIntent, StopType } from "@/types/route";
import { detectStopIntent as detectStopIntentFromUtils } from "./detectStopIntent";

// Google Places APIの型定義
type GooglePlace = {
  place_id: string;
  name: string;
  geometry: {
    location: {
      lat: number;
      lng: number;
    };
  };
  types: string[];
  rating?: number;
  user_ratings_total?: number;
  distance?: number;
};

type GooglePlacesResponse = {
  results: GooglePlace[];
  status: string;
};

/**
 * ランチ系発話を検出（後方互換性のため残す）
 */
export function detectLunchIntent(message: string): boolean {
  const keywords = [
    "ランチ",
    "昼食",
    "お昼",
    "昼ごはん",
    "昼飯",
    "食べたい",
    "米沢牛",
  ];
  return keywords.some((k) => message.includes(k));
}

/**
 * 途中立ち寄り意図を検出（StopIntent生成）- 汎用版へのエクスポート
 * detectStopIntent.tsから再エクスポート（後方互換性のため）
 */
export { detectStopIntentFromUtils as detectStopIntent };

/**
 * 食事系の途中立ち寄り意図を検出（StopIntent生成）- 後方互換性のため残す
 * @deprecated detectStopIntentを使用してください
 */
export function detectMealStopIntent(message: string): StopIntent | null {
  const normalized = message.toLowerCase();
  
  // 明示キーワード
  const explicitKeywords = [
    "ランチ",
    "昼食",
    "お昼",
    "昼ごはん",
    "昼飯",
    "食べたい",
    "ご飯",
    "食事",
  ];
  
  // 食要求キーワード（抽出対象）
  const foodRequestKeywords = [
    { keyword: "米沢牛", patterns: ["米沢牛", "よねざわぎゅう"] },
    { keyword: "山形牛", patterns: ["山形牛", "やまがたぎゅう"] },
    { keyword: "芋煮", patterns: ["芋煮", "いも煮", "いもに", "imoni"] },
    { keyword: "そば", patterns: ["そば", "蕎麦"] },
    { keyword: "ラーメン", patterns: ["ラーメン", "らーめん"] },
    { keyword: "冷やしラーメン", patterns: ["冷やしラーメン", "冷やしらーめん", "ひやしらーめん"] },
  ];
  
  // 明示キーワードの検出
  const hasExplicitIntent = explicitKeywords.some((k) => normalized.includes(k));
  
  // 食要求キーワードの抽出
  let extractedKeyword: string | undefined;
  for (const { keyword, patterns } of foodRequestKeywords) {
    if (patterns.some((p) => normalized.includes(p))) {
      extractedKeyword = keyword;
      break; // 最初にマッチしたものを採用
    }
  }
  
  // 明示または食要求があればStopIntentを生成
  if (hasExplicitIntent || extractedKeyword) {
    return {
      type: "meal",
      keyword: extractedKeyword,
      fallbackKeyword: "ランチ",
      placeType: "restaurant",
      radius: 2000,
      // insertAfterSpotIndexは呼び出し側で決定
    };
  }
  
  return null;
}

/**
 * 2点間の距離を計算（ハーバーサイン公式）
 */
function calculateDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371000; // 地球の半径（メートル）
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Google Places APIのtypeマッピング
 */
const PLACE_TYPE_MAP: Record<StopType, string> = {
  lunch: "restaurant",
  meal: "restaurant",     // 互換
  cafe: "cafe",
  rest: "park",
  onsen: "establishment", // spaは国・地域差が大きいためestablishmentを使用
  shop: "store",
  shopping: "store",      // 互換
  sightseeing: "tourist_attraction",
};

/**
 * Google Places APIでスポットを検索（汎用版）
 * - nearbySearchを使用
 * - keywordはStopIntentから取得（優先順位: foodCategory → keyword → fallbackKeyword）
 * - radiusはStopIntentから取得（デフォルト2000m）
 * - typeはStopIntentから取得（StopTypeに基づいて動的決定）
 * - 評価4.0以上、距離が近い順で1件選定
 */
export async function searchPlaces(
  baseLocation: { lat: number; lng: number },
  stopIntent: StopIntent
): Promise<GooglePlace | null> {
  // サーバー側では専用のAPIキーを使用
  const apiKey = process.env.GOOGLE_PLACES_API_SERVER_KEY || process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.warn("[koyo-places] Google Places API key not found");
    return null;
  }
  
  console.log("[koyo-places] Using API key:", apiKey.substring(0, 10) + "...");

  // keyword決定: 優先順位は foodCategory → keyword → fallbackKeyword
  const keyword =
    stopIntent.foodCategory ??
    stopIntent.keyword ??
    stopIntent.fallbackKeyword;
  const radius = stopIntent.radius || 2000;
  // placeTypeはStopTypeから動的に決定（stopIntent.placeTypeがあれば優先）
  const placeType = stopIntent.placeType || PLACE_TYPE_MAP[stopIntent.type] || "establishment";

  try {
    const url = new URL("https://maps.googleapis.com/maps/api/place/nearbysearch/json");
    url.searchParams.set("location", `${baseLocation.lat},${baseLocation.lng}`);
    url.searchParams.set("radius", String(radius));
    url.searchParams.set("keyword", keyword);
    url.searchParams.set("type", placeType);
    url.searchParams.set("key", apiKey);

    console.log("[koyo-places] Searching places near:", baseLocation, "type:", stopIntent.type, "keyword:", keyword);

    const response = await fetch(url.toString());
    if (!response.ok) {
      console.error("[koyo-places] Google Places API error:", response.status);
      return null;
    }

    const data = (await response.json()) as GooglePlacesResponse;
    if (data.status !== "OK" || !data.results || data.results.length === 0) {
      console.warn("[koyo-places] No places found:", data.status);
      return null;
    }

    console.log("[koyo-places] Found places:", data.results.length);

    // 距離を計算して追加
    const placesWithDistance = data.results.map((place) => ({
      ...place,
      distance: calculateDistance(
        baseLocation.lat,
        baseLocation.lng,
        place.geometry.location.lat,
        place.geometry.location.lng
      ),
    }));

    // 評価4.0以上でフィルタ（ただし0件ならフォールバックで評価条件を外す）
    let candidates = placesWithDistance.filter((p) => (p.rating ?? 0) >= 4.0);

    if (candidates.length === 0) {
      // 県境/郊外などで「4.0以上が0件」になりやすく、結果が空になると直行ルートしか返せなくなる。
      // UX優先で「距離が近い順」のフォールバックを行う（評価が無い/低い場所も候補として採用）。
      console.warn("[koyo-places] No places with rating >= 4.0; falling back to nearest result without rating filter");
      candidates = placesWithDistance;
    }

    // ソート
    // - 通常: 評価が高い順、同等なら距離が近い順
    // - フォールバック: ratingがundefinedなこともあるので距離優先に寄せる（rating差がつかない）
    candidates.sort((a, b) => {
      const ar = a.rating ?? 0;
      const br = b.rating ?? 0;
      if (br !== ar) return br - ar;
      return (a.distance ?? Infinity) - (b.distance ?? Infinity);
    });

    const selectedPlace = candidates[0];
    console.log("[koyo-places] Selected place:", {
      name: selectedPlace.name,
      rating: selectedPlace.rating,
      distance: selectedPlace.distance,
    });

    return selectedPlace;
  } catch (error) {
    console.error("[koyo-places] Google Places API error:", error);
    return null;
  }
}

/**
 * Google Places APIで食事スポットを検索（後方互換性のため残す）
 * @deprecated searchPlacesを使用してください
 */
export async function searchMealPlaces(
  baseLocation: { lat: number; lng: number },
  stopIntent: StopIntent
): Promise<GooglePlace | null> {
  return searchPlaces(baseLocation, stopIntent);
}

/**
 * Google Places APIでランチスポットを検索（後方互換性のため残す）
 * @deprecated searchPlacesを使用してください
 */
export async function searchLunchPlaces(
  baseLocation: { lat: number; lng: number }
): Promise<GooglePlace | null> {
  const defaultStopIntent: StopIntent = {
    type: "meal",
    fallbackKeyword: "ランチ",
    placeType: "restaurant",
    radius: 2000,
  };
  return searchPlaces(baseLocation, defaultStopIntent);
}

/**
 * Google PlaceをSpot形式に変換
 */
export function convertPlaceToSpot(place: GooglePlace): {
  id: string;
  name: string;
  lat: number;
  lng: number;
  category: string;
  source: "places";
  stayMinutes: number;
  placeId: string;
  isFromPlaces: boolean;
} {
  return {
    id: `places_${place.place_id}`,
    name: place.name,
    lat: place.geometry.location.lat,
    lng: place.geometry.location.lng,
    category: "食べる",
    source: "places",
    stayMinutes: 60, // 固定60分
    placeId: place.place_id,
    isFromPlaces: true,
  };
}

/**
 * StopIntentに基づいてPlaces APIを呼び出し、spots配列に統合（汎用版）
 * フェーズ1.5: AIは店名を知らない。ルートにstopを挿入する責務のみ。
 * @param spots 既存のspots配列（空でもOK）
 * @param stopIntent StopIntent（nullの場合は何もしない）
 * @param origin 出発地座標（spotsが空の場合に使用、オプショナル）
 * @param destination 目的地座標（spotsが空の場合に使用、オプショナル）
 * @param options オプション
 * @param options.minRequiredCount 最小必要件数（デフォルト: 3）
 * @param options.forceCallPlaces 強制的にPlaces APIを呼ぶか（デフォルト: false）
 * @param options.reason ログ用の理由（オプショナル）
 * @returns { spots: 統合後のspots配列, placesApiFailed: Places APIが失敗したか, placesAdded: Places APIでスポットが追加されたか }
 */
export async function integratePlaces(
  spots: any[],
  stopIntent: StopIntent | null,
  origin?: { lat: number; lng: number },
  destination?: { lat: number; lng: number },
  options?: {
    minRequiredCount?: number;
    forceCallPlaces?: boolean;
    reason?: string | null;
  }
): Promise<{ spots: any[]; placesApiFailed: boolean; placesAdded: boolean }> {
  const minRequiredCount = options?.minRequiredCount ?? 3;
  const forceCallPlaces = options?.forceCallPlaces ?? false;
  const reason = options?.reason ?? null;
  
  // spotsが空でもstopIntentがあればPlaces APIを呼ぶ（DBスポットがなくてもPlacesで補完）
  const baseSpots = spots || [];

  if (!stopIntent) {
    // DBスポットにsourceフィールドを追加
    baseSpots.forEach((spot) => {
      if (!spot.source) {
        spot.source = "db";
      }
    });
    return { spots: baseSpots, placesApiFailed: false, placesAdded: false };
  }

  // ゲート: forceCallPlacesがfalseでspots.length >= minRequiredCountの場合はPlaces APIを呼ばない
  if (!forceCallPlaces && baseSpots.length >= minRequiredCount) {
    console.log("[koyo-places] Skipping Places API: spots.length >= minRequiredCount", {
      spotsCount: baseSpots.length,
      minRequiredCount,
      reason: reason || "sufficient_db_candidates",
    });
    // DBスポットにsourceフィールドを追加
    baseSpots.forEach((spot) => {
      if (!spot.source) {
        spot.source = "db";
      }
    });
    return { spots: baseSpots, placesApiFailed: false, placesAdded: false };
  }

  let placesApiFailed = false;
  let placesAdded = false;
  let baseLocation: { lat: number; lng: number } | null = null;

  // baseLocationの決定
  if (baseSpots.length > 0) {
    // spotsがある場合：挿入位置の決定
    let baseSpotIndex: number;
    if (stopIntent.insertAfterSpotIndex !== undefined) {
      baseSpotIndex = stopIntent.insertAfterSpotIndex;
    } else {
      // デフォルト: spotsが2つ以上あるなら中間位置、1つしかないならindex=0
      baseSpotIndex = baseSpots.length >= 2 ? Math.floor(baseSpots.length / 2) : 0;
    }
    
    const baseSpot = baseSpots[baseSpotIndex];
    
    if (baseSpot.lat != null && baseSpot.lng != null) {
      baseLocation = { lat: baseSpot.lat, lng: baseSpot.lng };
    }
  } else if (origin && destination) {
    // spotsが空の場合：originとdestinationの中間地点を使用
    baseLocation = {
      lat: (origin.lat + destination.lat) / 2,
      lng: (origin.lng + destination.lng) / 2,
    };
    console.log("[koyo-places] Spots is empty, using midpoint between origin and destination:", baseLocation);
  } else if (origin) {
    // destinationがない場合はoriginを使用
    baseLocation = origin;
    console.log("[koyo-places] Spots is empty, using origin as baseLocation:", baseLocation);
  }

  if (baseLocation) {
    const keyword = stopIntent.foodCategory ?? stopIntent.keyword ?? stopIntent.fallbackKeyword;
    console.log("[koyo-places] Stop intent detected:", stopIntent.type, "searching places near:", baseLocation, "keyword:", keyword, "forceCallPlaces:", forceCallPlaces, "reason:", reason);

    const place = await searchPlaces(baseLocation, stopIntent);

    if (place) {
      const newSpot = convertPlaceToSpot(place);
      // spots配列の先頭に挿入（spotsが空の場合は先頭、そうでない場合はbaseSpotIndex + 1）
      const insertIndex = baseSpots.length > 0 && baseSpots.length >= 2 
        ? Math.floor(baseSpots.length / 2) + 1 
        : baseSpots.length > 0 
          ? 1 
          : 0;
      baseSpots.splice(insertIndex, 0, newSpot);
      placesAdded = true;
      console.log("[koyo-places] Added place at index:", insertIndex, "name:", place.name, "type:", stopIntent.type, "foodCategory:", stopIntent.foodCategory);
    } else {
      placesApiFailed = true;
      console.log("[koyo-places] No place found from Google Places API for type:", stopIntent.type);
    }
  } else {
    placesApiFailed = true;
    console.warn("[koyo-places] Cannot determine baseLocation: spots is empty and origin/destination not provided");
  }

  // DBスポットにsourceフィールドを追加
  baseSpots.forEach((spot) => {
    if (!spot.source) {
      spot.source = "db";
    }
  });

  return { spots: baseSpots, placesApiFailed, placesAdded };
}

/**
 * ランチ系発話を検出してPlaces APIを呼び出し、spots配列に統合（後方互換性のため残す）
 * @deprecated integratePlacesを使用してください
 */
export async function integrateLunchPlace(
  spots: any[],
  userMessage: string
): Promise<{ spots: any[]; placesApiFailed: boolean }> {
  const stopIntent = detectStopIntentFromUtils(userMessage);
  return integratePlaces(spots, stopIntent);
}

