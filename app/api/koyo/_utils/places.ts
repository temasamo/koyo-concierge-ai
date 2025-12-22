// app/api/koyo/_utils/places.ts
// Google Places API関連の共通ユーティリティ

import type { StopIntent, StopType } from "@/types/route";

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
 * 途中立ち寄り意図を検出（StopIntent生成）- 将来の正統後継
 * フェーズ1では lunch (meal) のみ対応
 * - 明示: "ランチ", "昼食", "お昼", "昼ごはん", "昼飯", "食べたい", "ご飯", "食事"
 * - 食要求: "米沢牛", "山形牛", "芋煮", "いも煮", "そば", "ラーメン", "冷やしラーメン"
 */
export function detectStopIntent(message: string): StopIntent | null {
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
  const FOOD_KEYWORDS = [
    { foodCategory: "ラーメン", patterns: ["ラーメン", "らーめん"] },
    { foodCategory: "そば", patterns: ["そば", "蕎麦"] },
    { foodCategory: "芋煮", patterns: ["芋煮", "いも煮", "いもに", "imoni"] },
    { foodCategory: "米沢牛", patterns: ["米沢牛", "よねざわぎゅう"] },
    { foodCategory: "山形牛", patterns: ["山形牛", "やまがたぎゅう"] },
    { foodCategory: "冷やしラーメン", patterns: ["冷やしラーメン", "冷やしらーめん", "ひやしらーめん"] },
  ];
  
  // 明示キーワードの検出
  const hasExplicitIntent = explicitKeywords.some((k) => normalized.includes(k));
  
  // 食要求キーワードの抽出
  let extractedFoodCategory: string | undefined;
  for (const { foodCategory, patterns } of FOOD_KEYWORDS) {
    if (patterns.some((p) => normalized.includes(p))) {
      extractedFoodCategory = foodCategory;
      break; // 最初にマッチしたものを採用
    }
  }
  
  // 明示または食要求があればStopIntentを生成
  if (hasExplicitIntent || extractedFoodCategory) {
    return {
      type: "meal",
      foodCategory: extractedFoodCategory,
      fallbackKeyword: "ランチ",
      placeType: "restaurant",
      radius: 2000,
      // preferenceTagsはフェーズ1では未使用
      // insertAfterSpotIndexは呼び出し側で決定
    };
  }
  
  return null;
}

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
 * Google Places APIで食事スポットを検索（動的keyword対応）
 * - nearbySearchを使用
 * - keywordはStopIntentから取得（動的）
 * - radiusはStopIntentから取得（デフォルト2000m）
 * - typeはStopIntentから取得（デフォルト"restaurant"）
 * - 評価4.0以上、距離が近い順で1件選定
 */
export async function searchMealPlaces(
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
  const placeType = stopIntent.placeType || "restaurant";

  try {
    const url = new URL("https://maps.googleapis.com/maps/api/place/nearbysearch/json");
    url.searchParams.set("location", `${baseLocation.lat},${baseLocation.lng}`);
    url.searchParams.set("radius", String(radius));
    url.searchParams.set("keyword", keyword);
    url.searchParams.set("type", placeType);
    url.searchParams.set("key", apiKey);

    console.log("[koyo-places] Searching meal places near:", baseLocation, "keyword:", keyword);

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

    // 評価4.0以上でフィルタ
    const candidates = placesWithDistance.filter((p) => (p.rating ?? 0) >= 4.0);

    if (candidates.length === 0) {
      console.warn("[koyo-places] No places with rating >= 4.0");
      return null;
    }

    // 評価が高い順、同等なら距離が近い順でソート
    candidates.sort((a, b) => {
      if (b.rating !== a.rating) {
        return (b.rating ?? 0) - (a.rating ?? 0);
      }
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
 * Google Places APIでランチスポットを検索（後方互換性のため残す）
 * @deprecated searchMealPlacesを使用してください
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
  return searchMealPlaces(baseLocation, defaultStopIntent);
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
 * ランチ系発話を検出してPlaces APIを呼び出し、spots配列に統合
 * フェーズ1: AIは店名を知らない。ルートにstopを挿入する責務のみ。
 * @param spots 既存のspots配列
 * @param userMessage ユーザーメッセージ
 * @returns { spots: 統合後のspots配列, placesApiFailed: Places APIが失敗したか }
 */
export async function integrateLunchPlace(
  spots: any[],
  userMessage: string
): Promise<{ spots: any[]; placesApiFailed: boolean }> {
  if (!spots || spots.length === 0) {
    return { spots, placesApiFailed: false };
  }

  const stopIntent = detectStopIntent(userMessage);
  let placesApiFailed = false;

  if (stopIntent) {
    // 挿入位置の決定
    let baseSpotIndex: number;
    if (stopIntent.insertAfterSpotIndex !== undefined) {
      baseSpotIndex = stopIntent.insertAfterSpotIndex;
    } else {
      // デフォルト: spotsが2つ以上あるならindex=1、1つしかないならindex=0
      baseSpotIndex = spots.length >= 2 ? 1 : 0;
    }
    
    const baseSpot = spots[baseSpotIndex];
    
    if (baseSpot.lat != null && baseSpot.lng != null) {
      const baseLocation = { lat: baseSpot.lat, lng: baseSpot.lng };
      console.log("[koyo-places] Meal intent detected, searching places near:", baseLocation, "from spot index:", baseSpotIndex, "keyword:", stopIntent.keyword || stopIntent.fallbackKeyword);

      const place = await searchMealPlaces(baseLocation, stopIntent);

      if (place) {
        const lunchSpot = convertPlaceToSpot(place);
        // spots配列の該当位置の直後に挿入
        const insertIndex = baseSpotIndex + 1;
        spots.splice(insertIndex, 0, lunchSpot);
        console.log("[koyo-places] Added meal place at index:", insertIndex, "name:", place.name, "foodCategory:", stopIntent.foodCategory);
      } else {
        placesApiFailed = true;
        console.log("[koyo-places] No meal place found from Google Places API");
      }
    } else {
      placesApiFailed = true;
      console.warn("[koyo-places] Base spot has no coordinates");
    }
  }

  // DBスポットにsourceフィールドを追加
  spots.forEach((spot) => {
    if (!spot.source) {
      spot.source = "db";
    }
  });

  return { spots, placesApiFailed };
}

