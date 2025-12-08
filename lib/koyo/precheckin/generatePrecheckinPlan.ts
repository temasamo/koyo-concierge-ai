/**
 * Pre-Checkin Plan Generation
 * 出発地から古窯までの観光プランを生成する
 */

import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import type { Origin } from "./origins";
import { matchSpot } from "@/app/api/koyo/_utils/matchSpot";

// OpenAIクライアントを取得する関数
function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable is not set");
  }
  return new OpenAI({ apiKey });
}

// Supabaseクライアントを取得する関数
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
 * Supabaseからスポット一覧を取得して、AIプロンプト用のテキストにフォーマット
 */
async function getSpotListForPrompt(): Promise<string> {
  try {
    const supabase = getSupabaseClient();
    const { data: spots, error } = await supabase
      .from("spot_master")
      .select("*")
      .order("name");

    if (error) {
      console.error("[precheckin] Supabase error:", error);
      return "【注意】スポット一覧の取得に失敗しました。";
    }

    if (!spots || spots.length === 0) {
      return "【注意】スポット一覧が空です。";
    }

    // スポット一覧をフォーマット
    const spotListText = spots
      .map(
        (s, idx) =>
          `[${idx + 1}] ${s.name}（カテゴリ: ${s.category || "未設定"}, 地域: ${
            s.city || "未設定"
          }, 季節: ${s.season || "未設定"}, 所要時間: ${s.drive_time || "未設定"}, lat:${s.lat || "未設定"}, lng:${
            s.lng || "未設定"
          }）`
      )
      .join("\n");

    return spotListText;
  } catch (error) {
    console.error("[precheckin] Error fetching spots:", error);
    return "【注意】スポット一覧の取得中にエラーが発生しました。";
  }
}

/**
 * Pre-Checkin用のシステムプロンプトを生成
 */
async function buildPrecheckinSystemPrompt(origin: Origin, userMessage: string): Promise<string> {
  const spotListText = await getSpotListForPrompt();

  return `
あなたは「古窯 旅館コンシェルAI（チェックイン前）」です。
お客様が古窯に到着する前の観光プランを、出発地から古窯までのルートに沿ってご提案する若女将AIとしてふるまいます。

【重要】あなたの返答は必ずJSON形式で返してください。テキストのみの返答は絶対に禁止です。

【人格】
- 48歳前後の落ち着いた若女将。
- 温かく丁寧だが硬くない接客。
- 出発地から古窯までの道中を楽しめる観光プランを提案する。
- 山形県内の観光地・移動時間・季節の情報に詳しい。

【出発地情報】
- 出発地: ${origin.name}
- 出発地座標: lat: ${origin.lat}, lng: ${origin.lng}

【目的地情報】
- 目的地: 古窯（上山温泉の旅館）
- 目的地座標: lat: 38.14828716772903, lng: 140.261163693796

【行動指針】
1. 出発地から古窯までのルート上または近くにある観光スポットを提案する。
2. 必ず Supabase に登録されたスポットのみを使用する。
3. スポット名は Supabase の登録名をそのまま使う。
4. スポットが不確定な場合は推測しない（空の spots を返す）。
5. プラン数は 1〜3 個。
6. plan[0] を「主プラン」とする。
7. 移動時間を考慮した現実的なプランを提案する。

【観光スポット一覧（Supabaseから自動取得）】
${spotListText}

--------------------------------------------------
【重要制限（厳守）】
- 山形県外のスポットは提案禁止
- Supabase に存在しないスポット名は絶対に出してはいけません
- 地名・市名（例：蔵王温泉、天童市、上山市など）をスポットとして出すのは禁止です
- 架空スポットの生成は厳禁
- スポット名は必ず Supabase の登録名を正確に使用すること

--------------------------------------------------
【季節ルール】
冬（12〜3月）は以下の注意文を含める：
「雪道が多いため、お車の場合は通常より余裕を持ったご計画がおすすめです。」

--------------------------------------------------
【出力形式（最重要）】
**必ず以下のJSON形式で返してください。テキストのみの返答は禁止です。**

{
  "reply": "若女将の丁寧な文章（必ず提案するスポット名を含めてください）",
  "plan": [
    {
      "title": "プランタイトル",
      "spots": [
        { "name": "スポット名（Supabaseの登録名）", "id": "SupabaseのID" }
      ],
      "description": "プランの説明"
    }
  ]
}

**必須条件：**
- 必ずJSON形式で返す（テキストのみは不可）
- reply と plan の両方を含める
- **【最重要】replyには必ず提案するスポット名を自然な文章で含めること**
  - reply内でスポット名を言及する場合、必ず plan[0].spots[].name の正確な名称を使用すること
  - plan[0].spots に含まれるすべてのスポット名を reply に含めること
  - **replyで説明する順番も plan[0].spots の順番と完全に一致させてください**
  - スポット名を列挙するだけではなく、自然な文章に組み込むこと
- スポットの id は Supabase の id をそのまま使用すること
- スポット名は Supabase の登録名を正確に使用すること（推測や略称は禁止）
- JSON の前後に説明文やコードブロックは付けない
- スポットが0件の場合は plan を空配列にする
`;
}

/**
 * plan[0].spotsからスポットを抽出し、Supabaseとマッチングする関数
 */
async function extractAndMatchSpots(planArray: any[]): Promise<any[] | undefined> {
  try {
    if (!planArray || planArray.length === 0) {
      return undefined;
    }

    const firstPlan = planArray[0];
    if (!firstPlan || !firstPlan.spots || !Array.isArray(firstPlan.spots) || firstPlan.spots.length === 0) {
      return undefined;
    }

    const aiSpots = firstPlan.spots;

    // Supabaseから全スポットを取得
    const supabase = getSupabaseClient();
    const { data: supabaseSpots } = await supabase
      .from("spot_master")
      .select("*");

    if (!supabaseSpots || supabaseSpots.length === 0) {
      console.warn("[precheckin] No Supabase spots found");
      return undefined;
    }

    // AIが返したスポットをSupabase形式に変換
    const matchedSpots: any[] = [];
    const usedSpotIds = new Set<string>();

    for (const aiSpot of aiSpots) {
      let matched: any = null;

      // 1. IDでマッチングを試す（最優先）
      if (aiSpot.id) {
        matched = supabaseSpots.find(
          (s) => !usedSpotIds.has(s.id) && s.id === aiSpot.id
        );
      }

      // 2. IDでマッチしない場合は、nameで正規化マッチング
      if (!matched && aiSpot.name) {
        matched = matchSpot(aiSpot.name, supabaseSpots, usedSpotIds);
      }

      if (matched) {
        // Supabase形式の完全なデータを使用
        matchedSpots.push({
          id: matched.id,
          name: matched.name,
          lat: matched.lat,
          lng: matched.lng,
          category: matched.category,
          city: matched.city,
          season: matched.season,
          drive_time: matched.drive_time,
          walk_time: matched.walk_time,
          stay_time: matched.stay_time,
          url: matched.url,
          tags: matched.tags,
          drive_minutes: matched.drive_time
            ? parseInt(matched.drive_time.match(/\d+/)?.[0] || "0")
            : null,
        });
        usedSpotIds.add(matched.id);
        console.log(`[precheckin] Matched spot: "${aiSpot.name || aiSpot.id}" -> "${matched.name}" (Supabase ID: ${matched.id})`);
      } else {
        console.warn(`[precheckin] No match found for: "${aiSpot.name || aiSpot.id}"`);
      }
    }

    return matchedSpots.length > 0 ? matchedSpots : undefined;
  } catch (error) {
    console.error("[precheckin] Spot matching error:", error);
    return undefined;
  }
}

/**
 * Pre-Checkinプランを生成する
 */
export async function generatePrecheckinPlan({
  origin,
  userMessage,
}: {
  origin: Origin;
  userMessage: string;
}): Promise<{
  reply: string;
  plan: any[];
  spots?: any[];
  origin?: Origin;
  mode?: string;
}> {
  try {
    const openai = getOpenAIClient();
    const systemPrompt = await buildPrecheckinSystemPrompt(origin, userMessage);

    const completion = await openai.chat.completions.create({
      model: process.env.KOYO_BEFORE_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0.7,
      response_format: { type: "json_object" },
    });

    const reply = completion.choices[0]?.message?.content ?? "";

    // JSONをパース
    let planData: any;
    try {
      planData = JSON.parse(reply);
    } catch (error) {
      console.error("[precheckin] Failed to parse AI response:", error);
      throw new Error("AIの応答の解析に失敗しました");
    }

    // plan配列を抽出
    const planArray = planData.plan || [];

    // plan[0].spotsからスポットを抽出し、Supabaseとマッチング
    let matchedSpots: any[] | undefined;
    let finalPlan: any[] | undefined;

    if (planArray && planArray.length > 0) {
      matchedSpots = await extractAndMatchSpots(planArray);

      // plan配列を構築（plan[0].spotsをマッチング済みスポットに置き換え）
      if (matchedSpots && matchedSpots.length > 0) {
        finalPlan = planArray.map((plan: any, index: number) => {
          if (index === 0) {
            // plan[0]のspotsをマッチング済みスポットに置き換え
            return {
              ...plan,
              spots: matchedSpots!.map((spot) => ({
                name: spot.name,
                id: spot.id,
              })),
            };
          }
          return plan;
        });
      } else {
        // スポットが0件の場合はplanを返さない
        finalPlan = undefined;
      }
    }

    // replyからJSON部分を除去してクリーンなメッセージにする（既にJSON形式なのでそのまま使用）
    const cleanReply = planData.reply || "";

    // レスポンスを構築
    const response: any = {
      reply: cleanReply,
      mode: "precheckin",
      origin: origin,
    };

    // planがある場合のみ追加
    if (finalPlan && finalPlan.length > 0) {
      response.plan = finalPlan;
    }

    // フロントエンド互換性のため、plan[0].spotsから抽出した完全なSupabase形式のスポットデータを返す
    if (matchedSpots && matchedSpots.length > 0) {
      response.spots = matchedSpots;
    }

    return response;
  } catch (error: any) {
    console.error("[precheckin] Error generating plan:", error);
    throw error;
  }
}

