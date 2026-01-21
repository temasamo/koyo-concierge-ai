// app/api/debug/spot-master-stats/route.ts
// 一時的なデバッグ用エンドポイント: spot_masterの実データを確認

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

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

// 型定義（spot_masterの行）
type SpotMasterRow = {
  id: string;
  name: string;
  category: string | null;
  tags: string | null;
  [key: string]: any;
};

export async function GET(req: NextRequest) {
  try {
    const supabase = getSupabaseClient();

    // 1. categoryの実値集計
    const { data: categoryStats, error: categoryError } = await supabase
      .from("spot_master")
      .select("category");

    if (categoryError) {
      console.error("[debug/spot-master-stats] Category error:", categoryError);
    }

    const categoryCounts: Record<string, number> = {};
    if (categoryStats) {
      categoryStats.forEach((row: { category: string | null }) => {
        const cat = row.category || "null";
        categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
      });
    }

    // 2. tagsのnull状況確認
    const { data: tagsData, error: tagsError } = await supabase
      .from("spot_master")
      .select("id, name, tags");

    if (tagsError) {
      console.error("[debug/spot-master-stats] Tags error:", tagsError);
    }

    // NOTE: tagsData is a partial select (id, name, tags) so don't type it as SpotMasterRow (which requires category)
    const nonNullTagsCount = tagsData?.filter((row) => row.tags != null).length || 0;
    const tagsSamples = tagsData
      ?.filter((row) => row.tags != null)
      .slice(0, 10)
      .map((row) => ({
        id: row.id,
        name: row.name,
        tags: row.tags,
        tagsLength: row.tags ? String(row.tags).length : 0,
      })) || [];

    // 3. 全カラム一覧
    const { data: sampleRow } = await supabase
      .from("spot_master")
      .select("*")
      .limit(1)
      .single();

    return NextResponse.json({
      categoryCounts: Object.entries(categoryCounts)
        .sort(([, a], [, b]) => b - a)
        .map(([category, count]) => ({ category, count })),
      tagsStats: {
        total: tagsData?.length || 0,
        nonNullCount: nonNullTagsCount,
        nullCount: (tagsData?.length || 0) - nonNullTagsCount,
        samples: tagsSamples,
      },
      sampleRow: sampleRow ? Object.keys(sampleRow) : [],
    });
  } catch (error) {
    console.error("[debug/spot-master-stats] Error:", error);
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}

