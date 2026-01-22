// app/api/koyo/_utils/searchSpotsFromDB.ts
// DBからstopIntentに基づいてスポット候補を検索する関数

import { createClient } from "@supabase/supabase-js";
import type { StopIntent } from "@/types/route";
import type { Spot } from "@/store/spots";

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

/**
 * DBからstopIntentに基づいてスポット候補を検索
 * 実データ前提: tagsは全null、categoryは「食べる」「自然」「遊ぶ」「歴史」「祭り」「自然・遊ぶ」「自然・歴史」
 * 
 * @param params 検索パラメータ
 * @returns DB候補スポット配列
 */
export async function searchSpotsFromDB(params: {
  stopIntent: StopIntent;
  origin?: { lat: number; lng: number };
  destination?: { lat: number; lng: number };
  limit?: number;
  foodKeyword?: string | null; // lunchで料理ジャンルキーワードがある場合
}): Promise<{
  spots: Spot[];
  dbCount: number; // 検索前の全件数（categoryのみ）
  dbMatchCount: number; // 検索後の件数（keyword絞り込み後、lunchの場合）
}> {
  const { stopIntent, limit = 10, foodKeyword } = params;
  const supabase = getSupabaseClient();
  
  let query = supabase.from("spot_master").select("*", { count: "exact" });
  let dbCount = 0;
  let dbMatchCount = 0;
  
  // stopIntent.typeごとの条件分岐（実データ前提）
  let whereCondition = "";
  switch (stopIntent.type) {
    case "lunch": {
      // base: categoryに「食べる」を含むもの
      query = query.ilike("category", "%食べる%");
      whereCondition = `category ilike '%食べる%'`;
      
      // 料理ジャンルキーワードがある場合: nameで部分一致
      if (foodKeyword) {
        query = query.ilike("name", `%${foodKeyword}%`);
        whereCondition += ` AND name ilike '%${foodKeyword}%'`;
      }
      
      // 全件数を取得（categoryのみ）
      const { count } = await supabase
        .from("spot_master")
        .select("*", { count: "exact", head: true })
        .ilike("category", "%食べる%");
      dbCount = count || 0;
      
      break;
    }
    
    case "cafe": {
      // categoryに「食べる」を含むもの（＋ nameに「喫茶」「カフェ」等が含まれるものを優先）
      query = query.ilike("category", "%食べる%");
      whereCondition = `category ilike '%食べる%'`;
      
      const { count } = await supabase
        .from("spot_master")
        .select("*", { count: "exact", head: true })
        .ilike("category", "%食べる%");
      dbCount = count || 0;
      
      break;
    }
    
    case "rest": {
      // categoryに「自然」または「遊ぶ」を含むもの（自然・遊ぶ等も部分一致で拾う）
      query = query.or("category.ilike.%自然%,category.ilike.%遊ぶ%");
      whereCondition = `category ilike '%自然%' OR category ilike '%遊ぶ%'`;
      
      const { count } = await supabase
        .from("spot_master")
        .select("*", { count: "exact", head: true })
        .or("category.ilike.%自然%,category.ilike.%遊ぶ%");
      dbCount = count || 0;
      
      break;
    }
    
    case "onsen": {
      // DBに温泉カテゴリは存在しない前提（基本0件想定）
      query = query.or("category.ilike.%温泉%,name.ilike.%温泉%");
      whereCondition = `category ilike '%温泉%' OR name ilike '%温泉%'`;
      
      const { count } = await supabase
        .from("spot_master")
        .select("*", { count: "exact", head: true })
        .or("category.ilike.%温泉%,name.ilike.%温泉%");
      dbCount = count || 0;
      
      break;
    }
    
    case "shop": {
      // DBに観光/お土産カテゴリは存在しない前提（基本0件想定）
      query = query.or("category.ilike.%観光%,category.ilike.%お土産%,name.ilike.%お土産%,name.ilike.%売店%");
      whereCondition = `category ilike '%観光%' OR category ilike '%お土産%' OR name ilike '%お土産%' OR name ilike '%売店%'`;
      
      const { count } = await supabase
        .from("spot_master")
        .select("*", { count: "exact", head: true })
        .or("category.ilike.%観光%,category.ilike.%お土産%,name.ilike.%お土産%,name.ilike.%売店%");
      dbCount = count || 0;
      
      break;
    }

    case "sightseeing": {
      // sightseeing: subTypeに応じて category の部分一致で検索
      // DBに複合カテゴリ（自然・遊ぶ/自然・歴史）があるため部分一致でOK
      const subType = stopIntent.subType ?? null;
      if (subType === "history") {
        query = query.ilike("category", "%歴史%");
        whereCondition = `category ilike '%歴史%'`;
        const { count } = await supabase
          .from("spot_master")
          .select("*", { count: "exact", head: true })
          .ilike("category", "%歴史%");
        dbCount = count || 0;
      } else if (subType === "nature") {
        query = query.ilike("category", "%自然%");
        whereCondition = `category ilike '%自然%'`;
        const { count } = await supabase
          .from("spot_master")
          .select("*", { count: "exact", head: true })
          .ilike("category", "%自然%");
        dbCount = count || 0;
      } else if (subType === "play") {
        query = query.ilike("category", "%遊ぶ%");
        whereCondition = `category ilike '%遊ぶ%'`;
        const { count } = await supabase
          .from("spot_master")
          .select("*", { count: "exact", head: true })
          .ilike("category", "%遊ぶ%");
        dbCount = count || 0;
      } else if (subType === "festival") {
        query = query.ilike("category", "%祭り%");
        whereCondition = `category ilike '%祭り%'`;
        const { count } = await supabase
          .from("spot_master")
          .select("*", { count: "exact", head: true })
          .ilike("category", "%祭り%");
        dbCount = count || 0;
      } else {
        // subTypeなし: 歴史/自然/遊ぶ/祭り を OR で検索
        query = query.or(
          "category.ilike.%歴史%,category.ilike.%自然%,category.ilike.%遊ぶ%,category.ilike.%祭り%"
        );
        whereCondition = `category ilike '%歴史%' OR category ilike '%自然%' OR category ilike '%遊ぶ%' OR category ilike '%祭り%'`;
        const { count } = await supabase
          .from("spot_master")
          .select("*", { count: "exact", head: true })
          .or("category.ilike.%歴史%,category.ilike.%自然%,category.ilike.%遊ぶ%,category.ilike.%祭り%");
        dbCount = count || 0;
      }

      break;
    }
    
    default: {
      // デフォルト: 全件取得（後方互換性）
      whereCondition = "全件";
      const { count } = await supabase
        .from("spot_master")
        .select("*", { count: "exact", head: true });
      dbCount = count || 0;
      break;
    }
  }
  
  // DB検索ログ出力
  console.log("[searchSpotsFromDB] DB search:", {
    stopIntentType: stopIntent.type,
    subType: stopIntent.subType || null,
    whereCondition,
    dbCount,
  });
  
  const { data, error } = await query
    .order("name")
    .limit(limit);
  
  if (error) {
    console.error("[searchSpotsFromDB] Supabase error:", error);
    return { spots: [], dbCount, dbMatchCount: 0 };
  }
  
  const spots = (data || []).map((spot) => ({
    id: spot.id,
    name: spot.name,
    lat: spot.lat,
    lng: spot.lng,
    category: spot.category,
    city: spot.city,
    season: spot.season,
    drive_time: spot.drive_time,
    walk_time: spot.walk_time,
    stay_time: spot.stay_time,
    url: spot.url,
    tags: spot.tags,
    drive_minutes: spot.drive_time
      ? parseInt(spot.drive_time.match(/\d+/)?.[0] || "0")
      : null,
    source: "db" as const,
  }));
  
  // 件数（lunchのkeyword絞り込み後、sightseeing含め共通）
  dbMatchCount = spots.length;
  
  return { spots, dbCount, dbMatchCount };
}

