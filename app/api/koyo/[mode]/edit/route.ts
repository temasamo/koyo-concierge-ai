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
} {
  const normalized = userMessage.toLowerCase();
  
  const relaxKeywords = ["ゆっくり", "のんびり", "ゆったり", "余裕", "時間", "急がない"];
  const foodKeywords = ["食べる", "ご飯", "ランチ", "食事", "レストラン", "お店", "食事処"];
  const cafeKeywords = ["カフェ", "休憩", "コーヒー", "ティー", "一休み"];
  const shorterKeywords = ["短く", "近く", "少なく", "減らす", "削除"];
  
  return {
    wantsRelax: relaxKeywords.some(kw => normalized.includes(kw)),
    wantsFood: foodKeywords.some(kw => normalized.includes(kw)),
    wantsCafe: cafeKeywords.some(kw => normalized.includes(kw)),
    wantsShorter: shorterKeywords.some(kw => normalized.includes(kw)),
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
 * Google Places APIでスポットを検索
 */
async function searchPlaces(
  location: { lat: number; lng: number },
  type: "restaurant" | "cafe"
): Promise<GooglePlace | null> {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.warn("[koyo-edit] Google Maps API key not found");
    return null;
  }

  try {
    const url = new URL("https://maps.googleapis.com/maps/api/place/nearbysearch/json");
    url.searchParams.set("location", `${location.lat},${location.lng}`);
    url.searchParams.set("radius", "800"); // 800m
    url.searchParams.set("type", type);
    url.searchParams.set("key", apiKey);

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

    // 最初の1件を返す（maxResults = 5だが、1件のみ採用）
    return data.results[0];
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
  { params }: { params: { mode: string } }
) {
  try {
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
    
    // Google Places API呼び出し（条件: wantsFood/wantsCafe && bCallCount < 1）
    let placeAdded = false;
    let finalSpots = [...routePlan.spots];
    let updatedBCallCount = routePlan.bCallCount;
    
    if ((intent.wantsFood || intent.wantsCafe) && routePlan.bCallCount < 1) {
      const placeType = intent.wantsFood ? "restaurant" : "cafe";
      const place = await searchPlaces(routePlan.origin, placeType);
      
      if (place) {
        const placeSpot = convertPlaceToSpot(place);
        // originの直後に挿入
        finalSpots = [placeSpot, ...finalSpots];
        updatedBCallCount = routePlan.bCallCount + 1;
        placeAdded = true;
        console.log("[koyo-edit] Added place from Google Places API:", place.name);
      } else {
        console.log("[koyo-edit] No place found from Google Places API");
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

