// app/api/koyo/_utils/places.ts
// Google Places API関連の共通ユーティリティ

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
 * ランチ系発話を検出
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
 * Google Places APIでランチスポットを検索
 * - nearbySearchを使用
 * - keyword="ランチ"
 * - radius=2000m
 * - type=restaurant
 * - 評価4.0以上、距離が近い順で1件選定
 */
export async function searchLunchPlaces(
  baseLocation: { lat: number; lng: number }
): Promise<GooglePlace | null> {
  // サーバー側では専用のAPIキーを使用
  const apiKey = process.env.GOOGLE_PLACES_API_SERVER_KEY || process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.warn("[koyo-places] Google Places API key not found");
    return null;
  }
  
  console.log("[koyo-places] Using API key:", apiKey.substring(0, 10) + "...");

  try {
    const url = new URL("https://maps.googleapis.com/maps/api/place/nearbysearch/json");
    url.searchParams.set("location", `${baseLocation.lat},${baseLocation.lng}`);
    url.searchParams.set("radius", "2000"); // 2000m固定
    url.searchParams.set("keyword", "ランチ");
    url.searchParams.set("type", "restaurant");
    url.searchParams.set("key", apiKey);

    console.log("[koyo-places] Searching lunch places near:", baseLocation);

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

