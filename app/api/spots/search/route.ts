// app/api/spots/search/route.ts

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Supabaseクライアントの初期化（環境変数チェック付き）
function getSupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error(
      "Supabase environment variables are not set. Please set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local"
    );
  }

  return createClient(supabaseUrl, supabaseServiceRoleKey);
}

type Mode = "before" | "stay" | "after";
type SeasonHint = "spring" | "summer" | "autumn" | "winter";
type TimeOfDay = "morning" | "afternoon" | "evening";
type BehaviorIntent = "near" | "normal" | "far" | "full_day";
type Interest = "nature" | "history" | "food" | "activity" | "festival";

type SpotSearchRequest = {
  mode?: Mode;
  visitDate?: string;
  seasonHint?: SeasonHint;
  stayNights?: number;
  timeOfDay?: TimeOfDay;
  behaviorIntent?: BehaviorIntent;
  interests?: Interest[];
  maxSpots?: number;
};

type SpotRow = {
  id: string;
  name: string;
  category: string | null;
  city: string | null;
  season: string | null;
  drive_time: string | null;
  walk_time: string | null;
  stay_time: string | null;
  lat: number | null;
  lng: number | null;
  url: string | null;
  tags: string | null;
};

type SpotWithScore = SpotRow & {
  score: number;
  drive_minutes: number | null;
};

// -----------------------------
// ユーティリティ関数
// -----------------------------

function parseDriveTimeToMinutes(drive_time: string | null): number | null {
  if (!drive_time) return null;
  // "車50分" / "車 60 分" などから数値だけ抜く
  const match = drive_time.match(/(\d+)/);
  if (!match) return null;
  return Number(match[1]);
}

function getSeasonFromDate(dateStr?: string): string | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  const month = d.getMonth() + 1; // 1-12
  if (month >= 3 && month <= 5) return "春";
  if (month >= 6 && month <= 8) return "夏";
  if (month >= 9 && month <= 11) return "秋";
  return "冬"; // 12,1,2
}

function normalizeSeasonHint(hint?: SeasonHint): string | null {
  if (!hint) return null;
  switch (hint) {
    case "spring":
      return "春";
    case "summer":
      return "夏";
    case "autumn":
      return "秋";
    case "winter":
      return "冬";
    default:
      return null;
  }
}

function isSeasonMatch(spotSeason: string | null, targetSeason: string | null): boolean {
  if (!targetSeason) return true; // フィルタなし
  if (!spotSeason) return true;   // season 未設定は一旦許可

  if (spotSeason.includes("通年") || spotSeason.includes("春〜冬")) return true;

  // 例: "春〜秋" に対して "春" / "夏" / "秋" はOK
  if (spotSeason.includes(targetSeason)) return true;

  // イベント系（"夏（8月5〜7日）" など）は、とりあえず季節だけでマッチさせる
  if (spotSeason.includes("春") && targetSeason === "春") return true;
  if (spotSeason.includes("夏") && targetSeason === "夏") return true;
  if (spotSeason.includes("秋") && targetSeason === "秋") return true;
  if (spotSeason.includes("冬") && targetSeason === "冬") return true;

  return false;
}

function getBaseDistanceMinutes(intent: BehaviorIntent): number {
  switch (intent) {
    case "near":
      return 30;
    case "normal":
      return 50;
    case "far":
      return 90;
    case "full_day":
      return 120;
    default:
      return 50;
  }
}

function getDistanceAllowanceMinutes(params: {
  mode: Mode;
  behaviorIntent: BehaviorIntent;
  stayNights: number;
  targetSeason: string | null;
  timeOfDay: TimeOfDay;
}): number {
  const { mode, behaviorIntent, stayNights, targetSeason, timeOfDay } = params;

  let base = getBaseDistanceMinutes(behaviorIntent);

  // mode 補正
  if (mode === "before") {
    base += 10;
  } else if (mode === "stay") {
    if (stayNights <= 1) base -= 10;
    if (stayNights >= 3) base += 20;
  } else if (mode === "after") {
    // 現状は補正なし
  }

  // 季節補正（冬はやや控えめ）
  if (targetSeason === "冬") {
    base -= 10;
  }

  // 時刻補正（夕方は近場のみ）
  if (timeOfDay === "evening") {
    base -= 10;
  }

  // 下限・上限を設定
  if (base < 20) base = 20;
  if (base > 120) base = 120;

  return base;
}

function categoryMatchesInterests(category: string | null, interests: Interest[] | undefined): boolean {
  if (!interests || interests.length === 0) return true; // フィルタなし
  if (!category) return false;

  const c = category;

  for (const interest of interests) {
    if (interest === "nature" && c.includes("自然")) return true;
    if (interest === "history" && (c.includes("歴史") || c === "歴史")) return true;
    if (interest === "food" && c === "食べる") return true;
    if (interest === "activity" && (c.includes("遊ぶ") || c === "遊ぶ")) return true;
    if (interest === "festival" && c === "祭り") return true;
  }

  return false;
}

function getCityPriority(city: string | null): number {
  if (!city) return 0;
  if (city.includes("上山")) return 2;      // 上山 / 上山周辺 最優先
  if (city.includes("山形市") || city.includes("山形")) return 1;
  return 0;
}

function computeSpotScore(params: {
  spot: SpotRow;
  driveMinutes: number | null;
  mode: Mode;
  interests?: Interest[];
  targetSeason: string | null;
}): number {
  const { spot, driveMinutes, mode, interests, targetSeason } = params;
  let score = 0;

  // 上山優先
  score += getCityPriority(spot.city) * 20;

  // 季節マッチ
  if (isSeasonMatch(spot.season, targetSeason)) {
    score += 15;
  }

  // カテゴリマッチ
  if (categoryMatchesInterests(spot.category, interests)) {
    score += 15;
  }

  // 距離（短いほど有利）
  if (driveMinutes != null) {
    score -= driveMinutes / 3; // ゆるやかに減点
  }

  // stay モードで遠すぎるスポットは微減点（フィルタで落としてない範囲でも）
  if (mode === "stay" && driveMinutes != null && driveMinutes > 60) {
    score -= 10;
  }

  return score;
}

// -----------------------------
// メインハンドラ
// -----------------------------

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as SpotSearchRequest;

    const mode: Mode = body.mode ?? "stay";
    const stayNights = body.stayNights ?? 1;
    const timeOfDay: TimeOfDay = body.timeOfDay ?? "afternoon";
    const behaviorIntent: BehaviorIntent = body.behaviorIntent ?? "normal";
    const interests = body.interests;
    const maxSpots = body.maxSpots ?? 5;

    // 季節判定
    const seasonFromDate = getSeasonFromDate(body.visitDate);
    const seasonFromHint = normalizeSeasonHint(body.seasonHint);
    const targetSeason = seasonFromDate ?? seasonFromHint ?? null;

    const distanceAllowance = getDistanceAllowanceMinutes({
      mode,
      behaviorIntent,
      stayNights,
      targetSeason,
      timeOfDay,
    });

    // Supabase クライアントを取得
    const supabase = getSupabaseClient();

    // Supabase から 33スポット全件取得
    const { data, error } = await supabase
      .from("spot_master")
      .select<"*", SpotRow>("*");

    if (error) {
      console.error("[spot_search] Supabase error:", error);
      return NextResponse.json(
        { error: "Failed to fetch spots from database." },
        { status: 500 }
      );
    }

    if (!data) {
      return NextResponse.json({ spots: [] }, { status: 200 });
    }

    // フィルタ＆スコアリング
    const scored: SpotWithScore[] = data
      .map((spot) => {
        const driveMinutes = parseDriveTimeToMinutes(spot.drive_time);
        return {
          ...spot,
          score: 0,
          drive_minutes: driveMinutes,
        };
      })
      .filter((spot) => {
        // 季節フィルタ
        if (!isSeasonMatch(spot.season, targetSeason)) return false;

        // カテゴリフィルタ
        if (!categoryMatchesInterests(spot.category, interests)) return false;

        // 距離フィルタ
        if (spot.drive_minutes != null) {
          if (spot.drive_minutes > distanceAllowance) return false;
        }
        // drive_minutes が null の場合は（徒歩スポット等）、とりあえず許可
        return true;
      })
      .map((spot) => {
        const score = computeSpotScore({
          spot,
          driveMinutes: spot.drive_minutes,
          mode,
          interests,
          targetSeason,
        });
        return { ...spot, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, maxSpots);

    const response = {
      spots: scored,
    };

    return NextResponse.json(response, { status: 200 });
  } catch (e) {
    console.error("[spot_search] Unexpected error:", e);
    return NextResponse.json(
      { error: "Unexpected error in /api/spots/search" },
      { status: 500 }
    );
  }
}

