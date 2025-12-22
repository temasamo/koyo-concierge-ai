// app/api/koyo/[mode]/edit/route.ts
import { NextRequest, NextResponse } from "next/server";
import type { RoutePlan, StopIntent } from "@/types/route";
import type { Spot } from "@/store/spots";
import { detectMealStopIntent, detectStopIntent, searchMealPlaces, convertPlaceToSpot } from "../../_utils/places";

// Google Places APIの型定義（_utils/places.tsから型を参照するため残す）
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

// searchMealPlaces と convertPlaceToSpot は _utils/places.ts から使用

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
    const updatedConstraints: RoutePlan["constraints"] = {
      ...routePlan.constraints,
      pace: intent.wantsRelax ? "relax" : "normal",
    };
    
    // Google Places API呼び出し（条件: meal intent && bCallCount === 0）
    let placeAdded = false;
    let finalSpots = [...routePlan.spots];
    let updatedBCallCount = routePlan.bCallCount;
    
    const stopIntent = detectStopIntent(userMessage);
    if (stopIntent && routePlan.bCallCount === 0) {
      // 挿入位置の決定
      let baseSpotIndex: number;
      if (stopIntent.insertAfterSpotIndex !== undefined) {
        baseSpotIndex = stopIntent.insertAfterSpotIndex;
      } else {
        // デフォルト: spotsが2つ以上あるならindex=1、1つしかないならindex=0
        baseSpotIndex = routePlan.spots.length >= 2 ? 1 : 0;
      }
      
      if (routePlan.spots.length > 0 && baseSpotIndex < routePlan.spots.length) {
        const baseSpot = routePlan.spots[baseSpotIndex];
        
        if (baseSpot.lat != null && baseSpot.lng != null) {
          const baseLocation = { lat: baseSpot.lat, lng: baseSpot.lng };
          console.log("[koyo-edit] Base location for meal search:", baseLocation, "from spot index:", baseSpotIndex, "keyword:", stopIntent.foodCategory || stopIntent.keyword || stopIntent.fallbackKeyword);
          
          const place = await searchMealPlaces(baseLocation, stopIntent);
          
          if (place) {
            const placeSpotData = convertPlaceToSpot(place);
            // RoutePlan["spots"][0]の型に合わせて変換
            const placeSpot: RoutePlan["spots"][0] = {
              ...placeSpotData,
              city: null,
              season: null,
              drive_time: null,
              walk_time: null,
              stay_time: null,
              url: null,
              tags: null,
              drive_minutes: null,
            };
            // spots配列の該当位置の直後に挿入
            const insertIndex = baseSpotIndex + 1;
            finalSpots.splice(insertIndex, 0, placeSpot);
            updatedBCallCount = routePlan.bCallCount + 1;
            placeAdded = true;
            console.log("[koyo-edit] Added meal place at index:", insertIndex, "name:", place.name, "foodCategory:", stopIntent.foodCategory);
          } else {
            console.log("[koyo-edit] No meal place found from Google Places API");
          }
        } else {
          console.warn("[koyo-edit] Base spot has no coordinates");
        }
      } else {
        console.warn("[koyo-edit] No spots in routePlan or invalid baseSpotIndex");
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
    
    // Places API結果はreplyに追記しない（フェーズ1: AIは店名を知らない）
    
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

