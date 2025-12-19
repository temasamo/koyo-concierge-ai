// app/api/koyo/[mode]/edit/route.ts
import { NextRequest, NextResponse } from "next/server";
import type { RoutePlan } from "@/types/route";
import type { Spot } from "@/store/spots";

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
  // 距離計算用（nearbySearchでは返されないが、計算で使用）
  distance?: number;
};

type GooglePlacesResponse = {
  results: GooglePlace[];
  status: string;
};

type EditRequestBody = {
  routePlan: RoutePlan;
  userMessage: string;
};

/**
 * Intent推定（簡易キーワードベース）
 */
function estimateIntent(userMessage: string): {
  wantsRelax?: boolean;
  wantsFood?: boolean;
  wantsCafe?: boolean;
  wantsShorter?: boolean;
  wantsLunch?: boolean;
} {
  const normalized = userMessage.toLowerCase();
  
  const relaxKeywords = ["ゆっくり", "のんびり", "ゆったり", "余裕", "時間", "急がない"];
  const foodKeywords = ["食べる", "ご飯", "食事", "レストラン", "お店", "食事処"];
  const cafeKeywords = ["カフェ", "休憩", "コーヒー", "ティー", "一休み"];
  const shorterKeywords = ["短く", "近く", "少なく", "減らす", "削除"];
  
  // wantsLunch判定（wantsFoodも含む）
  const wantsLunch = 
    foodKeywords.some(kw => normalized.includes(kw)) ||
    normalized.includes("ランチ") ||
    normalized.includes("昼") ||
    normalized.includes("昼ごはん") ||
    normalized.includes("食べたい");
  
  return {
    wantsRelax: relaxKeywords.some(kw => normalized.includes(kw)),
    wantsFood: foodKeywords.some(kw => normalized.includes(kw)),
    wantsCafe: cafeKeywords.some(kw => normalized.includes(kw)),
    wantsShorter: shorterKeywords.some(kw => normalized.includes(kw)),
    wantsLunch,
  };
}

/**
 * スポット再編成ロジック
 * - 移動距離が長いものを削除（drive_minutes > 25）
 * - 屋外長時間スポットを後ろへ（tags.includes("outdoor") && stayMinutes >= 60）
 * - 最低1件は必ず残す
 */
function reorganizeSpots(
  spots: RoutePlan["spots"],
  intent: ReturnType<typeof estimateIntent>
): RoutePlan["spots"] {
  if (spots.length <= 1) {
    // 最低1件は必ず残す
    return spots;
  }
  
  let result = [...spots];
  
  // 移動距離が長いものを削除（wantsShorter または drive_minutes > 25）
  if (intent.wantsShorter || result.some(s => (s.drive_minutes ?? 0) > 25)) {
    result = result.filter(s => (s.drive_minutes ?? 0) <= 25);
    // 削除後に空になった場合は元に戻す
    if (result.length === 0) {
      result = [...spots];
    }
  }
  
  // 最低1件は必ず残す
  if (result.length <= 1) {
    return result;
  }
  
  // 屋外長時間スポットを後ろへ
  const outdoorLongSpots = result.filter(
    s => s.tags?.includes("outdoor") && (s.stayMinutes ?? 0) >= 60
  );
  const otherSpots = result.filter(
    s => !(s.tags?.includes("outdoor") && (s.stayMinutes ?? 0) >= 60)
  );
  
  result = [...otherSpots, ...outdoorLongSpots];
  
  return result;
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
 * Google Places APIでスポットを検索（ランチ用）
 * - nearbySearchを使用
 * - keyword="ランチ 米沢牛"
 * - radius=2000m
 * - 評価4.0以上、距離が近い順で1件選定
 */
async function searchLunchPlaces(
  baseLocation: { lat: number; lng: number }
): Promise<GooglePlace | null> {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.warn("[koyo-edit] Google Maps API key not found");
    return null;
  }

  try {
    const url = new URL("https://maps.googleapis.com/maps/api/place/nearbysearch/json");
    url.searchParams.set("location", `${baseLocation.lat},${baseLocation.lng}`);
    url.searchParams.set("radius", "2000"); // 2000m固定
    url.searchParams.set("keyword", "ランチ 米沢牛");
    url.searchParams.set("type", "restaurant");
    url.searchParams.set("key", apiKey);

    console.log("[koyo-edit] Searching lunch places near:", baseLocation);

    const response = await fetch(url.toString());
    if (!response.ok) {
      console.error("[koyo-edit] Google Places API error:", response.status);
      return null;
    }

    const data = (await response.json()) as GooglePlacesResponse;
    if (data.status !== "OK" || !data.results || data.results.length === 0) {
      console.warn("[koyo-edit] No places found:", data.status);
      return null;
    }

    console.log("[koyo-edit] Found places:", data.results.length);

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
      console.warn("[koyo-edit] No places with rating >= 4.0");
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
    console.log("[koyo-edit] Selected place:", {
      name: selectedPlace.name,
      rating: selectedPlace.rating,
      distance: selectedPlace.distance,
    });

    return selectedPlace;
  } catch (error) {
    console.error("[koyo-edit] Google Places API error:", error);
    return null;
  }
}

/**
 * Google PlaceをRoutePlanのSpot形式に変換
 */
function convertPlaceToSpot(place: GooglePlace): RoutePlan["spots"][0] {
  return {
    id: `places_${place.place_id}`,
    name: place.name,
    lat: place.geometry.location.lat,
    lng: place.geometry.location.lng,
    category: place.types[0] || null,
    city: null,
    season: null,
    drive_time: null,
    walk_time: null,
    stay_time: null,
    url: null,
    tags: null,
    drive_minutes: null,
    stayMinutes: null,
    source: "places", // Places API由来であることを明示
    placeId: place.place_id,
    isFromPlaces: true,
  };
}

/**
 * おもてなし発話を生成
 */
function generateHospitalityMessage(
  intent: ReturnType<typeof estimateIntent>,
  spotsChanged: boolean,
  spotsReorganized: boolean,
  placeAdded: boolean
): string {
  // ランチ系発話でPlaces APIが発動した場合の固定メッセージ
  if (placeAdded && intent.wantsLunch) {
    return "途中でランチをご希望とのことでしたので、\nルートの途中に立ち寄りやすいお店を1か所だけ追加しました。";
  }
  
  if (!spotsChanged && !spotsReorganized && !placeAdded) {
    return "ルートを確認いたしました。";
  }
  
  const messages: string[] = [];
  
  if (placeAdded) {
    messages.push("無理のない距離で立ち寄れる場所を");
    messages.push("1か所だけ追加しました。");
  } else if (intent.wantsRelax) {
    messages.push("無理のない距離で立ち寄れる場所を");
    messages.push(spotsReorganized ? "1か所だけ追加しました。" : "調整いたしました。");
  } else if (intent.wantsShorter) {
    messages.push("より近い場所を中心に");
    messages.push("調整いたしました。");
  } else {
    messages.push("無理のない距離で立ち寄れる場所を");
    messages.push(spotsReorganized ? "1か所だけ追加しました。" : "調整いたしました。");
  }
  
  return messages.join("");
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ mode: string }> }
) {
  try {
    const { mode } = await params;
    const body = (await req.json()) as EditRequestBody;
    const { routePlan, userMessage } = body;
    
    if (!routePlan || !userMessage) {
      return NextResponse.json(
        { error: "routePlan と userMessage が必要です。" },
        { status: 400 }
      );
    }
    
    // Intent推定
    const intent = estimateIntent(userMessage);
    console.log("[koyo-edit] Intent:", intent);
    
    // constraints更新
    const updatedConstraints = {
      ...routePlan.constraints,
      pace: intent.wantsRelax ? "relax" : "normal",
    };
    
    // Google Places API呼び出し（条件: wantsLunch && bCallCount === 0）
    let placeAdded = false;
    let finalSpots = [...routePlan.spots];
    let updatedBCallCount = routePlan.bCallCount;
    
    if (intent.wantsLunch && routePlan.bCallCount === 0) {
      // waypointsの中間地点を基準に検索
      if (routePlan.spots.length > 0) {
        const baseSpotIndex = Math.floor(routePlan.spots.length / 2);
        const baseSpot = routePlan.spots[baseSpotIndex];
        
        if (baseSpot.lat != null && baseSpot.lng != null) {
          const baseLocation = { lat: baseSpot.lat, lng: baseSpot.lng };
          console.log("[koyo-edit] Base location for lunch search:", baseLocation, "from spot index:", baseSpotIndex);
          
          const place = await searchLunchPlaces(baseLocation);
          
          if (place) {
            const placeSpot = convertPlaceToSpot(place);
            // spots配列の中間に挿入
            const insertIndex = Math.floor(finalSpots.length / 2);
            finalSpots.splice(insertIndex, 0, placeSpot);
            updatedBCallCount = routePlan.bCallCount + 1;
            placeAdded = true;
            console.log("[koyo-edit] Added lunch place at index:", insertIndex, "name:", place.name);
          } else {
            console.log("[koyo-edit] No lunch place found from Google Places API");
          }
        } else {
          console.warn("[koyo-edit] Base spot has no coordinates");
        }
      } else {
        console.warn("[koyo-edit] No spots in routePlan, cannot determine base location");
      }
    }
    
    // スポット再編成（Places APIで追加した場合は再編成をスキップ）
    const originalSpotsCount = routePlan.spots.length;
    const reorganizedSpots = placeAdded ? finalSpots : reorganizeSpots(finalSpots, intent);
    const spotsChanged = reorganizedSpots.length !== originalSpotsCount;
    const spotsReorganized = !placeAdded && JSON.stringify(reorganizedSpots) !== JSON.stringify(finalSpots);
    
    console.log("[koyo-edit] Spots reorganized:", {
      original: originalSpotsCount,
      after: reorganizedSpots.length,
      changed: spotsChanged || spotsReorganized,
      placeAdded,
    });
    
    // 更新されたRoutePlan
    const updatedRoutePlan: RoutePlan = {
      ...routePlan,
      constraints: updatedConstraints,
      spots: reorganizedSpots,
      bCallCount: updatedBCallCount,
    };
    
    // おもてなし発話生成
    const hospitalityMessage = generateHospitalityMessage(intent, spotsChanged, spotsReorganized, placeAdded);
    
    // routeInfoを再構築
    const routeInfo = {
      origin: routePlan.origin,
      waypoints: reorganizedSpots
        .filter((s) => s.lat != null && s.lng != null)
        .map((s) => ({ lat: s.lat!, lng: s.lng! })),
      destination: routePlan.destination,
    };
    
    return NextResponse.json({
      reply: hospitalityMessage,
      routePlan: updatedRoutePlan,
      spots: reorganizedSpots as Spot[],
      routeInfo,
    });
  } catch (error: any) {
    console.error("[koyo-edit] error:", error);
    return NextResponse.json(
      {
        error: "ルート編集中にエラーが発生しました。",
        detail: error?.message ?? String(error),
        reply: "申し訳ございません。エラーが発生しました。",
      },
      { status: 500 }
    );
  }
}

