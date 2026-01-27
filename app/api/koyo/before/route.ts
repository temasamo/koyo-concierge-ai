// app/api/koyo/before/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/index.mjs";
import { createClient } from "@supabase/supabase-js";
import { matchSpot } from "../_utils/matchSpot";
import { detectPreCheckinIntent, detectModeMismatch } from "@/lib/koyo/intents";
import { parseOriginSelection, type Origin } from "@/lib/koyo/precheckin/origins";
import { normalizeUserSelection } from "@/lib/koyo/text/normalizeUserSelection";
import { generatePrecheckinPlan } from "@/lib/koyo/precheckin/generatePrecheckinPlan";
import { resolveOriginFromFreeInput, getOriginFromPrefecture } from "./_utils/originResolver";
import type { PrefectureKey } from "./_constants/prefEntryPoints";
import type { OriginInfo, Spot } from "@/store/spots";
import { KOYO_COORDINATES, SPOT_COORDINATE_FIXES } from "@/constants/koyo";
import { getPrefBoundary } from "@/store/prefBoundaries";
import { detectStopIntent, integratePlaces } from "../_utils/places";
import { detectStopIntent as detectStopIntentFromUtils } from "../_utils/detectStopIntent";
import { detectFoodKeyword } from "../_utils/stopIntentHelpers";
import type { RouteInfo, StopIntent, RoutePlan } from "@/types/route";
import { extractSelections } from "../_utils/extractSelections";

// モデルは環境変数で差し替え可能
const CHAT_MODEL =
  process.env.KOYO_BEFORE_MODEL || "gpt-4o-mini";

// OpenAIクライアントを取得する関数（ビルド時のエラーを回避）
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

// integrateLunchPlace は _utils/places.ts に統合済み

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
      console.error("[koyo-before] Supabase error:", error);
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
    console.error("[koyo-before] Error fetching spots:", error);
    return "【注意】スポット一覧の取得中にエラーが発生しました。";
  }
}

/**
 * 旅前モードのシステムプロンプトを生成（Supabaseスポット一覧を自動注入）
 * Before System Prompt (ver.2)
 */
async function getSystemPrompt(): Promise<string> {
  const spotListText = await getSpotListForPrompt();

  return `
あなたは「古窯 旅館コンシェルAI（チェックイン前）」です。
「チェックイン前（Before）モード」とは、旅行全体の計画を立てるためのモードであり、
ユーザーがチェックイン前・チェックイン後・チェックアウト後のいずれのタイミングで利用しても問題ありません。
実際の時系列にかかわらず、常に「旅行全体の計画」を立てられるモードとして振る舞ってください。
お客様に最適な観光プランを丁寧にご案内する若女将AIとしてふるまいます。


【重要】あなたの返答は必ずJSON形式で返してください。テキストのみの返答は絶対に禁止です。

【人格】
- 48歳前後の落ち着いた若女将。
- 温かく丁寧だが硬くない接客。
- 旅行目的・同行者・日程・移動手段をヒアリングしてプランを調整する。
- 山形県内の観光地・移動時間・季節の情報に詳しい。

【行動指針】
1. 初回は必ずヒアリング（目的・同行者・滞在時間）から始める。
2. 必ず Supabase に登録されたスポットのみを使用する。
3. スポット名は Supabase の登録名をそのまま使う。
4. スポットが不確定な場合は推測しない（空の spots を返す）。
5. プラン数は 1〜3 個。
6. plan[0] を「主プラン」とする。

【観光スポット一覧（Supabaseから自動取得）】
${spotListText}

--------------------------------------------------
【重要制限（厳守）】
- 山形県外のスポットは提案禁止
- Supabase に存在しないスポット名は絶対に出してはいけません
- 地名・市名（例：蔵王温泉、天童市、上山市など）をスポットとして出すのは禁止です
- 架空スポットの生成は厳禁
- スポット名は必ず Supabase の登録名を正確に使用すること

【重要：飲食・休憩スポットについて】
- 飲食店・カフェ・温泉・売店などの固有名詞（店名）は出さない
- 「この旅の流れの中で立ち寄りやすい場所で」
  「温かいラーメンを楽しむ」
  など抽象的な表現を使用する
- NG例：「◯◯でラーメン」「食事処△△」

--------------------------------------------------
【重要：出発地が"自由入力（G）"の場合のロジック】
--------------------------------------------------

1. API（originResolver）が出発地の県を推定します。

2. 以下の状況で「経由県を質問」してください：
   ・県推定が曖昧な場合
   ・複数県候補が出た場合
   ・「関東から」「東北から」など広域の入力

3. 質問文の形式：
「古窯へ向かう場合、どの県を経由すると想定しますか？
① 宮城　② 福島　③ 秋田　④ 新潟」

4. ユーザーが答えた県を JSON で返す時は：
{
  "origin": {
     "type": "pref-boundary",
     "pref": "fukushima"
  },
  "reply": "...",
  "plan": [...]
}

5. 県境座標の決定はフロントエンド（GoogleMap）が行うため、
   AI は座標を返してはいけません。

--------------------------------------------------
【季節ルール】
冬（12〜3月）は以下の注意文を含める：
「雪道が多いため、お車の場合は通常より余裕を持ったご計画がおすすめです。」

--------------------------------------------------
【出力形式（最重要）】
**必ず以下のJSON形式で返してください。テキストのみの返答は禁止です。**

{
  "reply": "若女将の丁寧な文章（必ず提案するスポット名を含めてください）",
  "origin": {
    "type": "pref-boundary",
    "pref": "miyagi" | "fukushima" | "akita" | "niigata"
  },
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

**origin フィールドについて：**
- Pre-Checkinモード（Before）で出発地が県境の場合のみ origin を含める
- origin.type は "pref-boundary" を指定
- origin.pref は "miyagi" | "fukushima" | "akita" | "niigata" のいずれか
- 座標（lat/lng）は返さない（フロントエンドが決定）

**必須条件：**
- 必ずJSON形式で返す（テキストのみは不可）
- reply と plan の両方を含める
- **【最重要】replyには必ず提案するスポット名を自然な文章で含めること**
  - reply内でスポット名を言及する場合、必ず plan[0].spots[].name の正確な名称を使用すること
  - plan[0].spots に含まれるすべてのスポット名を reply に含めること
  - **replyで説明する順番も plan[0].spots の順番と完全に一致させてください**
  - スポット名を列挙するだけではなく、自然な文章に組み込むこと
  - 例：plan[0].spots が [「上山城」「上杉神社」「山寺（立石寺）」] の場合、replyは「まずは上山城で山形の歴史を感じながら景色を楽しみ、その後、上杉神社へ向かい、上杉謙信にちなんだ歴史を学びます。最後に、山寺（立石寺）を訪れ、歴史ある寺院の美しい景観を堪能するプランです。」のように、spotsの順番通りに記述すること
- スポットの id は Supabase の id をそのまま使用すること
- スポット名は Supabase の登録名を正確に使用すること（推測や略称は禁止）
- JSON の前後に説明文やコードブロックは付けない
- スポットが0件の場合は plan を空配列にする
`;
}

/**
 * AIの応答からplan配列を抽出する関数
 * 新しい形式: { plan: [{ title: "", spots: [{ name: "", id: "" }], description: "" }] }
 */
async function extractPlanFromReply(reply: string): Promise<any[] | undefined> {
  try {
    let planArray: any[] | undefined;

    // コードブロック（```json や ```）を除去
    let cleanedReply = reply;
    cleanedReply = cleanedReply.replace(/```json\s*/g, '').replace(/```\s*/g, '');
    cleanedReply = cleanedReply.replace(/```[\s\S]*?```/g, '');

    // デバッグログ
    console.log("[koyo-before] AI reply (first 500 chars):", cleanedReply.substring(0, 500));

    // まず、JSON形式のレスポンスを試す（全体がJSONの場合）
    try {
      const jsonResponse = JSON.parse(cleanedReply);
      if (jsonResponse.plan && Array.isArray(jsonResponse.plan)) {
        planArray = jsonResponse.plan;
        console.log("[koyo-before] Found plan in full JSON response");
      }
    } catch {
      // JSON形式でない場合は、テキストから抽出を試す
    }

    // JSON形式で取得できなかった場合、テキストから抽出
    if (!planArray) {
      // テキスト内に埋め込まれたJSONを抽出する
      // 方法1: { "plan": [...] } を含むJSONオブジェクト全体を探す
      let jsonStart = cleanedReply.indexOf('{"plan"');
      if (jsonStart === -1) {
        jsonStart = cleanedReply.indexOf("{\"plan\"");
      }
      if (jsonStart === -1) {
        jsonStart = cleanedReply.indexOf("{ 'plan'");
      }
      
      if (jsonStart !== -1) {
        // { から始まるJSONオブジェクトの終わりを見つける
        let braceCount = 0;
        let jsonEnd = jsonStart;
        for (let i = jsonStart; i < cleanedReply.length; i++) {
          if (cleanedReply[i] === '{') braceCount++;
          if (cleanedReply[i] === '}') {
            braceCount--;
            if (braceCount === 0) {
              jsonEnd = i + 1;
              break;
            }
          }
        }
        
        if (jsonEnd > jsonStart) {
          try {
            const jsonString = cleanedReply.substring(jsonStart, jsonEnd);
            const planObj = JSON.parse(jsonString);
            if (planObj.plan && Array.isArray(planObj.plan)) {
              planArray = planObj.plan;
              console.log("[koyo-before] Found plan in extracted JSON object");
            }
          } catch (parseError) {
            console.warn("[koyo-before] Failed to parse extracted JSON:", parseError);
          }
        }
      }
      
      // 方法2: 正規表現で { "plan": [...] } 形式を探す（フォールバック）
      if (!planArray) {
        const planMatch = cleanedReply.match(/\{\s*"plan"\s*:\s*\[[\s\S]*?\]\s*\}/);
        if (planMatch) {
          try {
            const planObj = JSON.parse(planMatch[0]);
            if (planObj.plan && Array.isArray(planObj.plan)) {
              planArray = planObj.plan;
              console.log("[koyo-before] Found plan in regex match");
            }
          } catch (parseError) {
            console.warn("[koyo-before] Failed to parse regex matched JSON:", parseError);
          }
        }
      }
      
      // 方法3: 最も外側の { } を探す（最後の試み）
      if (!planArray) {
        const outerMatch = cleanedReply.match(/\{[\s\S]*"plan"[\s\S]*\}/);
        if (outerMatch) {
          try {
            const planObj = JSON.parse(outerMatch[0]);
            if (planObj.plan && Array.isArray(planObj.plan)) {
              planArray = planObj.plan;
              console.log("[koyo-before] Found plan in outer match");
            }
          } catch (parseError) {
            console.warn("[koyo-before] Failed to parse outer match JSON:", parseError);
          }
        }
      }
      
      if (!planArray) {
        console.warn("[koyo-before] No plan JSON pattern found in reply");
        console.warn("[koyo-before] Reply preview:", cleanedReply.substring(0, 500));
      }
    }

    if (!planArray || planArray.length === 0) {
      console.log("[koyo-before] Extracted plan array: No plan found");
      return undefined;
    }
    
    console.log(`[koyo-before] Extracted plan array: Found ${planArray.length} plans`);

    // plan[0].spotsが空または存在しない場合はundefinedを返す
    const firstPlan = planArray[0];
    if (!firstPlan || !firstPlan.spots || !Array.isArray(firstPlan.spots) || firstPlan.spots.length === 0) {
      return undefined;
    }

    return planArray;
  } catch (error) {
    console.error("[koyo-before] Plan extraction error:", error);
    return undefined;
  }
}

/**
 * plan[0].spotsからスポットを抽出し、Supabaseとマッチングする関数
 * IDを最優先で使用し、一致しない場合はnameでマッチング
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
      console.warn("[koyo-before] No Supabase spots found");
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
        // 座標の修正があるかチェック
        const coordinateFix = SPOT_COORDINATE_FIXES[matched.id];
        const finalLat = coordinateFix ? coordinateFix.lat : matched.lat;
        const finalLng = coordinateFix ? coordinateFix.lng : matched.lng;
        
        if (coordinateFix) {
          console.log(`[koyo-before] Applying coordinate fix for "${matched.name}" (${matched.id}): ${matched.lat},${matched.lng} -> ${finalLat},${finalLng}`);
        }
        
        // Supabase形式の完全なデータを使用
        matchedSpots.push({
          id: matched.id,
          name: matched.name,
          lat: finalLat,
          lng: finalLng,
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
        console.log(`[koyo-before] Matched spot: "${aiSpot.name || aiSpot.id}" -> "${matched.name}" (Supabase ID: ${matched.id})`);
      } else {
        console.warn(`[MATCH WARNING] No match found for: "${aiSpot.name || aiSpot.id}"`);
      }
    }

    return matchedSpots.length > 0 ? matchedSpots : undefined;
  } catch (error) {
    console.error("[koyo-before] Spot matching error:", error);
    return undefined;
  }
}

/**
 * replyからJSON部分を除去してクリーンなメッセージを返す関数
 * 新しい形式: { plan: [...] } に対応
 * スポット名は保持する（reply部分に含まれている場合はそのまま返す）
 */
function cleanReplyMessage(reply: string): string {
  // コードブロック（```json や ```）を除去
  let cleanedReply = reply;
  cleanedReply = cleanedReply.replace(/```json\s*/g, '').replace(/```\s*/g, '');
  cleanedReply = cleanedReply.replace(/```[\s\S]*?```/g, '');
  
  // まず、JSON形式のレスポンスを試す
  try {
    const jsonResponse = JSON.parse(cleanedReply);
    if (jsonResponse.reply && typeof jsonResponse.reply === "string") {
      // reply部分をそのまま返す（スポット名が含まれている場合は保持される）
      return jsonResponse.reply;
    }
  } catch {
    // JSON形式でない場合は、テキストから抽出を試す
  }

  // { "reply": "...", "plan": [...] } 形式のJSONからreply部分を抽出
  const fullJsonMatch = cleanedReply.match(/\{\s*"reply"\s*:\s*"([^"]*)"\s*,\s*"plan"\s*:\s*\[[\s\S]*?\]\s*\}/);
  if (fullJsonMatch && fullJsonMatch[1]) {
    return fullJsonMatch[1];
  }

  // { "plan": [...] } 形式のJSONを削除（reply部分が別にある場合）
  let cleaned = cleanedReply.replace(/\{\s*"plan"\s*:\s*\[[\s\S]*?\]\s*\}/g, "").trim();
  
  // { "reply": "..." } 形式からreply部分を抽出
  const replyMatch = cleaned.match(/\{\s*"reply"\s*:\s*"([^"]*)"\s*[,}]/);
  if (replyMatch && replyMatch[1]) {
    return replyMatch[1];
  }

  // 従来の配列形式も削除（後方互換性のため）
  cleaned = cleaned.replace(/\[\s*\{[\s\S]*?\}\s*(,\s*\{[\s\S]*?\}\s*)*\]/g, "").trim();

  // 「--」や余計な区切り文字が残る場合も削除
  return cleaned.replace(/--/g, "").trim();
}

function buildWaypoints(spots: any[]): Array<{ lat: number; lng: number; spotId?: string }> {
  if (!spots || spots.length === 0) {
    return [];
  }

  return spots
    .filter((s: any) => {
      if (!s || s.lat == null || s.lng == null) {
        return false;
      }
      const lat = Number(s.lat);
      const lng = Number(s.lng);
      const isValid =
        typeof lat === "number" &&
        typeof lng === "number" &&
        !isNaN(lat) &&
        !isNaN(lng) &&
        lat >= -90 &&
        lat <= 90 &&
        lng >= -180 &&
        lng <= 180;
      if (!isValid) {
        console.warn(`[koyo-before] Invalid coordinates for spot "${s.name}" (${s.id}): lat=${s.lat}, lng=${s.lng}`);
      }
      return isValid;
    })
    .map((s: any) => {
      const lat = Number(s.lat);
      const lng = Number(s.lng);
      return {
        lat,
        lng,
        spotId: s.id,
      };
    });
}

function resolveBeforeRouteOrigin(origin: OriginInfo): { lat: number; lng: number } {
  if (origin.type === "pref-boundary" && origin.pref) {
    return getPrefBoundary(origin.pref);
  }
  if ((origin.type === "fixed" || origin.type === "current") && origin.lat != null && origin.lng != null) {
    return { lat: origin.lat, lng: origin.lng };
  }
  return KOYO_COORDINATES;
}

function buildBeforeCandidateLine(spot: Spot, idx: number): string {
  const category = spot.category || "観光スポット";
  const description = spot.description ? ` - ${spot.description}` : "";
  return `(${idx + 1}) ${spot.name}（${category}）${description}`;
}

function buildBeforeCandidateList(optionalSpots: Spot[]): string {
  return optionalSpots.map(buildBeforeCandidateLine).join("\n");
}

function buildBeforeCandidateListWithGrouping(
  optionalSpots: Spot[],
  stopIntent: StopIntent | null
): string {
  if (!stopIntent || stopIntent.type !== "lunch") {
    return buildBeforeCandidateList(optionalSpots);
  }

  const kw = String(stopIntent.keyword ?? "").toLowerCase();
  const fc = String(stopIntent.foodCategory ?? "").toLowerCase();
  const hasSpecific = !!kw || !!fc;
  if (!hasSpecific) {
    return buildBeforeCandidateList(optionalSpots);
  }

  const entries = optionalSpots.map((spot, idx) => {
    const name = String(spot.name ?? "").toLowerCase();
    const cat = String(spot.category ?? "").toLowerCase();
    const isSpecific =
      (fc && (name.includes(fc) || cat.includes(fc))) ||
      (kw && (name.includes(kw) || cat.includes(kw)));
    const isFood =
      name.includes("食") ||
      cat.includes("食") ||
      name.includes("ランチ") ||
      cat.includes("ランチ");
    return {
      line: buildBeforeCandidateLine(spot, idx),
      isSpecific,
      isFood,
    };
  });

  let primaryLines = entries.filter((e) => e.isSpecific).map((e) => e.line);
  let secondaryLines = entries.filter((e) => !e.isSpecific).map((e) => e.line);

  if (primaryLines.length === 0) {
    // 特定ジャンルがヒットしない場合は「食べる系」を主目的扱いにフォールバック
    primaryLines = entries.filter((e) => e.isFood).map((e) => e.line);
    secondaryLines = entries.filter((e) => !e.isFood).map((e) => e.line);
  }

  const sections: string[] = [];
  if (primaryLines.length > 0) {
    sections.push("🍽 ご希望に近い候補（まずはこちら）");
    sections.push(...primaryLines);
  }
  if (secondaryLines.length > 0) {
    if (primaryLines.length > 0) {
      sections.push("");
    }
    sections.push("＋ あわせて立ち寄れる候補");
    sections.push(...secondaryLines);
  }

  return sections.length > 0 ? sections.join("\n") : buildBeforeCandidateList(optionalSpots);
}

function buildBeforeCandidateReply(
  optionalSpots: Spot[],
  stopIntent: StopIntent | null
): string {
  const numberedList = buildBeforeCandidateListWithGrouping(optionalSpots, stopIntent);
  return `寄り道候補をいくつか出しました。番号で選んでください。

${numberedList}

この中から、経由地として組み込みたい番号を送ってください。
例：1 / 2 / 1と2
※「寄り道しない」場合は 0 と送ってください。`;
}

function buildBeforeNoSelectionReply(
  optionalSpots: Spot[],
  stopIntent: StopIntent | null
): string {
  const numberedList = buildBeforeCandidateListWithGrouping(optionalSpots, stopIntent);
  return `選択された番号に対応する候補が見つかりませんでした。以下の番号で選んでください。

${numberedList}

この中から、経由地として組み込みたい番号を送ってください。
例：1 / 2 / 1と2
※「寄り道しない」場合は 0 と送ってください。`;
}

function buildBeforeEmptyCandidatesReply(): string {
  return "寄り道候補が見つかりませんでした。条件を変えてもう一度お知らせください。";
}

// --- Before: stopIntentがlunchのとき「食べる系」を先頭に出す（絞り込みはしない） ---
function isFoodSpotForIntent(spot: any, stopIntent: any): boolean {
  const cat = String(spot?.category || "").toLowerCase();
  const name = String(spot?.name || "").toLowerCase();

  if (!stopIntent || stopIntent.type !== "lunch") return false;

  const foodCategory = String(stopIntent.foodCategory || "").toLowerCase(); // 例: "そば"
  const keywords = [
    "食", "ランチ", "食べる", "飲食", "レストラン",
    // foodCategory があるならそれも優先判定に使う
    ...(foodCategory ? [foodCategory] : []),
  ];

  return keywords.some((k) => (k && (cat.includes(k) || name.includes(k))));
}

function sortOptionalSpotsByIntent(optionalSpots: any[], stopIntent: any) {
  if (!stopIntent || stopIntent.type !== "lunch") return optionalSpots;

  // 安定ソート（元の順序をできるだけ保持）
  return optionalSpots
    .map((s, idx) => ({ s, idx, isFood: isFoodSpotForIntent(s, stopIntent) }))
    .sort((a, b) => {
      if (a.isFood !== b.isFood) return a.isFood ? -1 : 1; // 食系を先頭
      return a.idx - b.idx; // 同グループは元順維持
    })
    .map((x) => x.s);
}

function buildOptionalSpots(spots: Spot[], limit = 6): Spot[] {
  return (spots || []).slice(0, limit).map((spot) => ({
    ...spot,
    spotRole: "optional" as const,
  }));
}

function hasIntentCategory(spots: any[], stopIntent: StopIntent | null): boolean {
  if (!stopIntent) return true;

  if (stopIntent.type === "lunch") {
    const foodCategory = String(stopIntent.foodCategory || "").toLowerCase();
    const keyword = String(stopIntent.keyword || "").toLowerCase();
    const hasSpecificKeyword = !!foodCategory || !!keyword;

    return (spots || []).some((spot) => {
      const cat = String(spot?.category || "").toLowerCase();
      const name = String(spot?.name || "").toLowerCase();
      if (hasSpecificKeyword) {
        return (
          (foodCategory && (cat.includes(foodCategory) || name.includes(foodCategory))) ||
          (keyword && (cat.includes(keyword) || name.includes(keyword)))
        );
      }
      return cat.includes("食") || cat.includes("ランチ");
    });
  }

  if (stopIntent.type === "cafe") {
    const cats = (spots || []).map((s) => String(s.category || "").toLowerCase());
    return cats.some((c) => c.includes("カフェ") || c.includes("喫茶") || c.includes("甘味"));
  }

  if (stopIntent.type === "onsen") {
    const cats = (spots || []).map((s) => String(s.category || "").toLowerCase());
    return cats.some((c) => c.includes("温泉") || c.includes("風呂") || c.includes("スパ"));
  }

  if (stopIntent.type === "shop") {
    const cats = (spots || []).map((s) => String(s.category || "").toLowerCase());
    return cats.some((c) => c.includes("買") || c.includes("土産") || c.includes("ショップ"));
  }

  return true;
}

function buildPlacesOptions(spots: Spot[], stopIntent: StopIntent | null) {
  const needsFoodPlace =
    stopIntent?.type === "lunch" && !!stopIntent.foodCategory;
  const needPlaceForIntent = stopIntent
    ? needsFoodPlace || !hasIntentCategory(spots, stopIntent)
    : false;
  return needPlaceForIntent
    ? { forceCallPlaces: true, reason: "before:intent_missing" }
    : { minRequiredCount: 0, forceCallPlaces: false, reason: "before:intent_satisfied" };
}

type RoutePlanSpot = RoutePlan["spots"][number];

function hasSpotSource(spot: Spot): spot is Spot & { source: RoutePlanSpot["source"] } {
  return "source" in spot;
}

function hasPlaceId(spot: Spot): spot is Spot & { placeId: string } {
  return "placeId" in spot;
}

function hasIsFromPlaces(spot: Spot): spot is Spot & { isFromPlaces: boolean } {
  return "isFromPlaces" in spot;
}

function ensureSpotSources(spots: Spot[]): RoutePlan["spots"] {
  return spots.map((spot) => {
    if (hasSpotSource(spot)) return spot;
    const isFromPlaces = hasIsFromPlaces(spot) && spot.isFromPlaces;
    const isPlaces = isFromPlaces || hasPlaceId(spot);
    return { ...spot, source: isPlaces ? "places" : "db" };
  });
}

function applyFoodKeywordToStopIntent(
  stopIntent: StopIntent | null,
  message: string
): StopIntent | null {
  if (!stopIntent || stopIntent.type !== "lunch") return stopIntent;
  if (stopIntent.foodCategory) return stopIntent;

  const { hasFoodKeyword, foodKeyword } = detectFoodKeyword(message);
  if (!hasFoodKeyword || !foodKeyword) return stopIntent;

  console.log("[koyo-before] stopIntent keyword enriched from message:", {
    type: stopIntent.type,
    foodCategory: stopIntent.foodCategory ?? null,
    keyword: foodKeyword,
  });

  return {
    ...stopIntent,
    keyword: foodKeyword,
  };
}

/**
 * Places API検索結果が0件の場合、reply内の断定表現を抽象表現に置き換える
 * フェーズ1.5: AIが嘘をつかないように、事実に基づかない断定表現を弱める
 */
function sanitizeReplyForFailedPlaces(
  reply: string,
  stopIntent: StopIntent | null
): string {
  if (!stopIntent || stopIntent.type !== "lunch") {
    // lunch以外は対象外（フェーズ1.5ではlunchのみ）
    return reply;
  }
  
  let sanitized = reply;
  
  // 山形牛・米沢牛などの特定食材名の断定表現を削除
  sanitized = sanitized.replace(/山形牛[^。]*。/g, "旅の流れに合わせて、周辺で食事の時間をお取りください。");
  sanitized = sanitized.replace(/米沢牛[^。]*。/g, "旅の流れに合わせて、周辺で食事の時間をお取りください。");
  
  // 名物・特定料理名の断定表現を削除
  sanitized = sanitized.replace(/名物[^。]*。/g, "地元ならではの食事を楽しむ時間を設けるのもおすすめです。");
  sanitized = sanitized.replace(/芋煮[^。]*。/g, "地元ならではの温かい食事を楽しむ時間を設けるのもおすすめです。");
  sanitized = sanitized.replace(/ラーメン[^。]*。/g, "旅の流れに合わせて、温かい食事の時間をお取りください。");
  sanitized = sanitized.replace(/そば[^。]*。/g, "旅の流れに合わせて、食事の時間をお取りください。");
  
  // 特定体験の断定表現を弱める
  sanitized = sanitized.replace(/地元の味[^。]*。/g, "地元ならではの食事を楽しむ時間を設けるのもおすすめです。");
  
  return sanitized;
}

/**
 * StopIntentとplacesAddedに基づいて体験コメントを生成
 * @param stopIntent StopIntent（nullの場合は空文字を返す）
 * @param placesAdded Places APIでスポットが追加されたか
 * @returns 体験コメント（placesAddedがfalseの場合は空文字）
 */
function appendExperienceComment(
  stopIntent: StopIntent | null,
  placesAdded: boolean
): string {
  if (!stopIntent || !placesAdded) {
    return "";
  }

  switch (stopIntent.type) {
    case "lunch":
      if (stopIntent.foodCategory === "そば") {
        return "道中で、山形らしいそばを味わう時間を組み込んでいます。";
      } else if (stopIntent.foodCategory === "ラーメン") {
        return "道中で、温かいラーメンを楽しむ時間を組み込んでいます。";
      } else if (stopIntent.foodCategory === "芋煮") {
        return "道中で、山形の名物である芋煮を味わう時間を組み込んでいます。";
      } else if (stopIntent.foodCategory === "米沢牛") {
        return "道中で、上質な米沢牛を味わう時間を組み込んでいます。";
      } else if (stopIntent.foodCategory === "山形牛") {
        return "道中で、上質な山形牛を味わう時間を組み込んでいます。";
      } else if (stopIntent.foodCategory === "冷やしラーメン") {
        return "道中で、冷やしラーメンを楽しむ時間を組み込んでいます。";
      } else {
        // foodCategoryが未定義の場合
        return "道中で、無理のない食事の時間を組み込んでいます。";
      }
    case "cafe":
      return "移動の合間に、ひと息つける休憩時間を設けています。";
    case "rest":
      return "移動の合間に、散策や休憩の時間を設けています。";
    case "onsen":
      return "道中で、温泉でゆっくりとくつろぐ時間を組み込んでいます。";
    case "shop":
      return "道中で、お土産を選ぶ時間を組み込んでいます。";
    default:
      return "";
  }
}

/**
 * チャット履歴から最初のStopIntentを含むメッセージを探す
 * @param userMessages チャット履歴
 * @returns StopIntentを含む最初のメッセージ（見つからない場合はnull）
 */
function findStopIntentMessage(userMessages: ChatCompletionMessageParam[]): string | null {
  // チャット履歴を時系列順（古い順）で確認
  for (const message of userMessages) {
    if (message.role === "user" && typeof message.content === "string") {
      const stopIntent = detectStopIntentFromUtils(message.content);
      if (stopIntent) {
        console.log("[koyo-before] Found stopIntent in message:", message.content, "stopIntent:", stopIntent);
        return message.content;
      }
    }
  }
  return null;
}

/**
 * チャット履歴から「G」が選択されたかを確認する
 * @param userMessages チャット履歴
 * @returns 「G」が選択された場合はtrue
 */
function isGSelectedInHistory(userMessages: ChatCompletionMessageParam[]): boolean {
  // チャット履歴を時系列順（古い順）で確認
  console.log("[koyo-before] Checking for 'G' in message history, messages count:", userMessages.length);
  for (const message of userMessages) {
    if (message.role === "user" && typeof message.content === "string") {
      const trimmed = message.content.trim().toUpperCase();
      console.log("[koyo-before] Checking message:", message.content, "trimmed:", trimmed);
      if (trimmed === "G") {
        console.log("[koyo-before] Found 'G' selection in message history");
        return true;
      }
    }
  }
  console.log("[koyo-before] No 'G' found in message history");
  return false;
}

type BeforeContext = {
  phase?: "before:phase2_1" | "before:phase2_2_waiting_selection" | "before:phase2_2_done";
  optionalSpots?: Spot[];
  routeInfoKey?: "direct";
  origin?: OriginInfo;
  stopIntent?: StopIntent | null;
};

/**
 * リクエストボディの型
 * - messages: chat履歴（フロントが管理）
 * - query: 単発問い合わせ
 * - userState: ユーザーの状態（origin、originInputModeなど）
 */
type BeforeRequestBody =
  | { messages: ChatCompletionMessageParam[]; userState?: { origin?: OriginInfo; originInputMode?: "free" | "current_location"; context?: { before?: BeforeContext } } }
  | { query: string; userState?: { origin?: OriginInfo; originInputMode?: "free" | "current_location"; context?: { before?: BeforeContext } } };

// デフォルトの origin 値
const DEFAULT_ORIGIN: OriginInfo = {
  type: null,
  pref: null,
  lat: null,
  lng: null,
  name: null,
};

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as BeforeRequestBody;

    // 1️⃣ ユーザーメッセージを取得
    let userMessages: ChatCompletionMessageParam[];
    let userMessage: string;

    if ("messages" in body && Array.isArray(body.messages)) {
      userMessages = body.messages;
      const lastUserMessage = userMessages.filter((m) => m.role === "user").pop();
      userMessage =
        typeof lastUserMessage?.content === "string" ? lastUserMessage.content : "";
    } else if ("query" in body && typeof body.query === "string") {
      userMessage = body.query;
      userMessages = [{ role: "user", content: body.query }];
    } else {
      return NextResponse.json(
        { error: "messages または query が必要です。", origin: DEFAULT_ORIGIN },
        { status: 400 }
      );
    }

    // 2️⃣ ユーザー状態（origin、originInputMode）を取得
    const userState = body.userState || {};
    const currentOrigin: OriginInfo = userState.origin || DEFAULT_ORIGIN;
    const originInputMode = userState.originInputMode;
    
    // 分岐トレースログ：入力情報
    const normalizedMessage = userMessage.trim().toUpperCase();
    console.log("[koyo-before] 🔍 BRANCH TRACE - Input:", {
      userMessageRaw: userMessage,
      userMessageNormalized: normalizedMessage,
      currentOrigin,
      originType: currentOrigin?.type,
      originPref: currentOrigin?.pref,
      originInputMode,
    });

    let hasOrigin =
      currentOrigin &&
      currentOrigin.type !== null &&
      // pref-boundary の場合は lat/lng が null でも OK
      // current の場合は lat/lng が必須
      (currentOrigin.type === "pref-boundary" ||
        (currentOrigin.type === "current" && currentOrigin.lat !== null && currentOrigin.lng !== null) ||
        (currentOrigin.type === "fixed" && currentOrigin.lat !== null && currentOrigin.lng !== null));
    
    // origin.type === "current" かつ lat/lng があれば無条件で hasOrigin = true
    if (
      currentOrigin?.type === "current" &&
      typeof currentOrigin.lat === "number" &&
      typeof currentOrigin.lng === "number"
    ) {
      hasOrigin = true;
      console.log("[koyo-before] ✅ current location origin confirmed", {
        lat: currentOrigin.lat,
        lng: currentOrigin.lng,
      });
    }
    
    // ログ追加（確認用）
    console.log("[koyo-before] ORIGIN FINAL:", currentOrigin);
    console.log("[koyo-before] hasOrigin =", hasOrigin);

    // Phase1.75: モード相違検出
    const modeMismatch = detectModeMismatch(userMessage, "before");
    if (modeMismatch.detected) {
      console.log("[koyo-before] ⚠️ MODE MISMATCH detected:", modeMismatch.reason);
      return NextResponse.json({
        reply: "その内容は、今お話ししている流れと少し異なりそうですね。どのタイミングのお話か、確認してもよろしいでしょうか？（チェックイン前／滞在中／チェックアウト後 など）",
        origin: DEFAULT_ORIGIN,
        debug: { branch: "before:mode_mismatch", mode_mismatch: true, reason: modeMismatch.reason },
      });
    }

    // Phase2-3: Phase2-2 選択確定フェーズ（候補提示済みの場合）
    const beforeContext = userState.context?.before;
    if (beforeContext?.optionalSpots && Array.isArray(beforeContext.optionalSpots) && beforeContext.optionalSpots.length > 0) {
      const optionalSpots = beforeContext.optionalSpots;
      const selections = extractSelections(userMessage);
      const normalizedUserMessage = userMessage.trim().toLowerCase();
      const isReverseCommand =
        normalizedUserMessage === "順番を逆に" ||
        normalizedUserMessage === "順番を逆" ||
        normalizedUserMessage.includes("順番を逆に") ||
        normalizedUserMessage.includes("reverse") ||
        normalizedUserMessage.includes("逆");

      if (selections.length === 1 && selections[0] === 0) {
        const routeOrigin = resolveBeforeRouteOrigin(beforeContext.origin || currentOrigin);
        const routeInfo: RouteInfo = {
          origin: routeOrigin,
          waypoints: [],
          destination: KOYO_COORDINATES,
        };
        const routePlan: RoutePlan = {
          planId: `plan_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          mode: "BEFORE",
          origin: routeInfo.origin,
          destination: routeInfo.destination,
          spots: [],
          constraints: {},
          bCallCount: 0,
        };
        return NextResponse.json({
          reply: "了解です。寄り道なしで古窯へ向かうルートに確定しました。",
          phase: "before:phase2_2_done",
          spots: [],
          routePlan,
          routeInfo,
          optionalSpots: optionalSpots,
          origin: currentOrigin,
          context: { before: undefined },
          debug: { branch: "before:phase2_2_done_no_waypoints", phase: "before:phase2_2_done" },
        });
      }

      if (isReverseCommand && selections.length === 0) {
        const reversedOptionalSpots = [...optionalSpots].reverse();
        return NextResponse.json({
          reply: buildBeforeCandidateReply(reversedOptionalSpots, beforeContext.stopIntent || null),
          phase: "before:phase2_2_waiting_selection",
          optionalSpots: reversedOptionalSpots,
          origin: currentOrigin,
          context: { before: { phase: "before:phase2_2_waiting_selection", optionalSpots: reversedOptionalSpots, origin: currentOrigin, stopIntent: beforeContext.stopIntent } },
          debug: { branch: "before:phase2_2_waiting_selection_reverse", phase: "before:phase2_2_waiting_selection" },
        });
      }

      if (selections.length === 0) {
        return NextResponse.json({
          reply: buildBeforeCandidateReply(optionalSpots, beforeContext.stopIntent || null),
          phase: "before:phase2_2_waiting_selection",
          optionalSpots: optionalSpots,
          origin: currentOrigin,
          context: { before: { phase: "before:phase2_2_waiting_selection", optionalSpots, origin: currentOrigin, stopIntent: beforeContext.stopIntent } },
          debug: { branch: "before:phase2_2_waiting_selection", phase: "before:phase2_2_waiting_selection" },
        });
      }

      let selectedSpots = selections
        .map((i) => optionalSpots[i - 1])
        .filter(Boolean)
        .filter((spot): spot is Spot => spot !== undefined && spot.lat !== null && spot.lng !== null);

      if (selectedSpots.length === 0) {
        return NextResponse.json({
          reply: buildBeforeNoSelectionReply(optionalSpots, beforeContext.stopIntent || null),
          phase: "before:phase2_2_waiting_selection",
          optionalSpots: optionalSpots,
          origin: currentOrigin,
          context: { before: { phase: "before:phase2_2_waiting_selection", optionalSpots, origin: currentOrigin, stopIntent: beforeContext.stopIntent } },
          debug: { branch: "before:phase2_2_waiting_selection", phase: "before:phase2_2_waiting_selection" },
        });
      }

      if (isReverseCommand) {
        selectedSpots = [...selectedSpots].reverse();
      }

      const waypoints = selectedSpots.map((s) => ({
        lat: s.lat!,
        lng: s.lng!,
        spotId: s.id,
      }));
      const routeOrigin = resolveBeforeRouteOrigin(beforeContext.origin || currentOrigin);
      const routeInfo: RouteInfo = {
        origin: routeOrigin,
        waypoints,
        destination: KOYO_COORDINATES,
      };
      const routePlan: RoutePlan = {
        planId: `plan_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        mode: "BEFORE",
        origin: routeInfo.origin,
        destination: routeInfo.destination,
        spots: ensureSpotSources(selectedSpots),
        constraints: {},
        bCallCount: 0,
      };

      const selectedSpotList = selectedSpots.map((s) => s.name).join("、");
      return NextResponse.json({
        reply: `了解です。${selectedSpotList}を経由地として確定し、ルートを更新しました。`,
        phase: "before:phase2_2_done",
        spots: selectedSpots,
        routePlan,
        routeInfo,
        optionalSpots: optionalSpots,
        origin: currentOrigin,
        context: { before: undefined },
        debug: { branch: "before:phase2_2_done", phase: "before:phase2_2_done" },
      });
    }

    const isPreCheckinIntent = detectPreCheckinIntent(userMessage);
    // ユーザー選択入力を正規化してからパース
    const userMessageNormalized = normalizeUserSelection(userMessage);
    const originSelection = parseOriginSelection(userMessageNormalized); // 「A〜G」などの返答
    
    // Gが選択された場合を明示的に検出（Bセクションより前にチェック）
    const isGSelected = userMessage.trim().toUpperCase() === "G";
    
    // チャット履歴から最初のStopIntentを含むメッセージを探す
    const stopIntentMessage = findStopIntentMessage(userMessages) || userMessage;
    const stopIntent = applyFoodKeywordToStopIntent(
      detectStopIntentFromUtils(stopIntentMessage),
      stopIntentMessage
    );
    
    // 分岐トレースログ：判定結果
    console.log("[koyo-before] 🔍 BRANCH TRACE - Conditions:", {
      hasOrigin,
      originSelection: originSelection ? { name: "name" in originSelection ? originSelection.name : "useCurrentLocation" } : null,
      isGSelected,
      originInputMode,
      isPreCheckinIntent,
      stopIntent: stopIntent ? { type: stopIntent.type, foodCategory: stopIntent.foodCategory } : null,
      currentOrigin: currentOrigin ? { type: currentOrigin.type, lat: currentOrigin.lat, lng: currentOrigin.lng } : null,
    });

    // --------------------------------------------------
    // A. すでに origin が決まっている場合
    //    → 「Pre-Checkin プラン生成モード」とみなす
    //    ❗ B_origin_select を絶対に通さない
    // --------------------------------------------------
    if (hasOrigin) {
      console.log("[koyo-before] ✅ BRANCH: A_precheckin_plan (hasOrigin=true)");
      try {
        let originForPlan: Origin;
        let prefecture: PrefectureKey | undefined;

        if (currentOrigin.type === "pref-boundary" && currentOrigin.pref) {
          // 県境モード：県境座標を backend で解決
          const resolved = getOriginFromPrefecture(currentOrigin.pref);
          originForPlan = {
            name: resolved.name,
            lat: resolved.lat,
            lng: resolved.lng,
          };
          prefecture = currentOrigin.pref;
        } else {
          // 固定地点 or current
          originForPlan = {
            name: currentOrigin.name || "",
            lat: currentOrigin.lat || 0,
            lng: currentOrigin.lng || 0,
          };
        }

        const plan = await generatePrecheckinPlan({
          origin: originForPlan,
          prefecture,
          userMessage,
        });

        // Places API統合（途中立ち寄り意図検出）
        // matchedSpotsが空でもintegratePlacesを呼ぶ（DBスポットがなくてもPlacesで補完）
        let finalSpots = plan.spots && Array.isArray(plan.spots) ? [...plan.spots] : [];
        // チャット履歴から最初のStopIntentを含むメッセージを探す
        const stopIntentMessage = findStopIntentMessage(userMessages) || userMessage;
        const stopIntent = applyFoodKeywordToStopIntent(
          detectStopIntentFromUtils(stopIntentMessage),
          stopIntentMessage
        );
        const result = await integratePlaces(
          finalSpots,
          stopIntent,
          originForPlan,
          KOYO_COORDINATES,
          buildPlacesOptions(finalSpots, stopIntent)
        );
        finalSpots = result.spots;
        let optionalSpots = buildOptionalSpots(finalSpots);
        optionalSpots = sortOptionalSpotsByIntent(optionalSpots, stopIntent);
        const reply = buildBeforeCandidateReply(optionalSpots, stopIntent);

        // ✅ Pre-Checkin 時だけ origin を返す
        // originInputMode が "current_location" の場合は削除（現在地確定完了を意味する）
        const responseOriginInputMode = originInputMode === "current_location" ? undefined : originInputMode;
        
        return NextResponse.json({
          reply,
          origin: currentOrigin,
          optionalSpots,
          phase: "before:phase2_2_waiting_selection",
          context: {
            before: {
              phase: "before:phase2_2_waiting_selection",
              optionalSpots,
              routeInfoKey: "direct",
              origin: currentOrigin,
              stopIntent,
            },
          },
          ...(responseOriginInputMode !== undefined && { originInputMode: responseOriginInputMode }),
          debug: { branch: "before:phase2_1_candidates" },
        });
      } catch (error: any) {
        console.error("[koyo-before] ❌ BRANCH: A_precheckin_plan ERROR:", error);
        console.error("[koyo-before] Pre-Checkin plan generation error:", error);
        return NextResponse.json(
          {
            error: "Pre-Checkinプランの生成中にエラーが発生しました。",
            detail: error?.message ?? String(error),
            origin: currentOrigin,
            debug: { branch: "before:A_precheckin_plan:error" },
          },
          { status: 500 }
        );
      }
    }

    // ここに来る時点では「origin 未決定（type === null）」とする

    // --------------------------------------------------
    // B. 出発地が未確定の場合
    //    → 出発地の選択肢を聞く（Beforeモードでは必ず必要）
    //    ※ detectPreCheckinIntentに依存しない（状態ベースで判定）
    //    ※ 自由入力モード中はスキップ（A〜Gの選択肢を再表示しない）
    //    ※ 「G」が選択された場合はDセクションで処理するため、ここでは除外
    // --------------------------------------------------
    // 自由入力モード中はBセクションをスキップ
    if (!originSelection && !isGSelected && originInputMode !== "free" && originInputMode !== "current_location") {
      console.log("[koyo-before] ✅ BRANCH: B_origin_select (origin未確定、選択肢提示)");
      return NextResponse.json({
        mode: "precheckin-origin-select",
        reply: `
観光プランをお作りしますね！
まず、出発地を教えてください。

A. 山形駅
B. 山形空港
C. かみのやま温泉駅
D. 山形蔵王IC（高速）
E. かみのやま温泉IC（高速）
F. 現在地を使う
G. その他（自由入力）

例：「A」「空港」「現在地で」など簡単でOKです！
`.trim(),
        origin: DEFAULT_ORIGIN, // まだ決まっていない
        debug: { branch: "before:B_origin_select" },
      });
    }

    // --------------------------------------------------
    // C. A〜G の選択に対する回答（originSelection が取れた場合）
    // --------------------------------------------------
    if (originSelection) {
      console.log("[koyo-before] ✅ BRANCH: C_origin_selected (originSelection解析成功)");
      // F. 現在地を使う
      if ("useCurrentLocation" in originSelection && originSelection.useCurrentLocation) {
        console.log("[koyo-before] ✅ BRANCH: C_current_location (F選択、現在地要求)");
        console.log("[koyo-before] 🔍 Geolocation requested - setting originInputMode: current_location");
        return NextResponse.json({
          mode: "precheckin-origin-select",
          reply:
            "現在地を使用する場合は、ブラウザの位置情報を許可してください。位置情報が取得できない場合は、A〜Eから選択してください。",
          requiresLocation: true,
          origin: DEFAULT_ORIGIN,
          originInputMode: "current_location", // 現在地取得モードを有効化
          debug: { branch: "before:C_current_location" },
        });
      }

      // A〜E の固定地点
      if ("name" in originSelection) {
        try {
          const plan = await generatePrecheckinPlan({
            origin: originSelection,
            userMessage,
          });

          // Places API統合（途中立ち寄り意図検出）
          // matchedSpotsが空でもintegratePlacesを呼ぶ（DBスポットがなくてもPlacesで補完）
          let finalSpots = plan.spots && Array.isArray(plan.spots) ? [...plan.spots] : [];
          // チャット履歴から最初のStopIntentを含むメッセージを探す
          const stopIntentMessage = findStopIntentMessage(userMessages) || userMessage;
          const stopIntent = applyFoodKeywordToStopIntent(
            detectStopIntentFromUtils(stopIntentMessage),
            stopIntentMessage
          );
          const result = await integratePlaces(
            finalSpots,
            stopIntent,
            originSelection,
            KOYO_COORDINATES,
            buildPlacesOptions(finalSpots, stopIntent)
          );
          finalSpots = result.spots;

          const originResponse = {
            type: "fixed",
            pref: null,
            name: originSelection.name,
            lat: originSelection.lat,
            lng: originSelection.lng,
          } as OriginInfo;
          let optionalSpots = buildOptionalSpots(finalSpots);
          optionalSpots = sortOptionalSpotsByIntent(optionalSpots, stopIntent);
          const reply = buildBeforeCandidateReply(optionalSpots, stopIntent);

          return NextResponse.json({
            reply,
            origin: originResponse,
            optionalSpots,
            phase: "before:phase2_2_waiting_selection",
            context: {
              before: {
                phase: "before:phase2_2_waiting_selection",
                optionalSpots,
                routeInfoKey: "direct",
                origin: originResponse,
                stopIntent,
              },
            },
            debug: { branch: "before:phase2_1_candidates" },
          });
        } catch (error: any) {
          console.error("[koyo-before] ❌ BRANCH: C_origin_selected ERROR:", error);
          console.error("[koyo-before] Pre-Checkin plan generation error:", error);
          return NextResponse.json(
            {
              error: "Pre-Checkinプランの生成中にエラーが発生しました。",
              detail: error?.message ?? String(error),
              origin: DEFAULT_ORIGIN,
              debug: { branch: "before:C_origin_selected:error" },
            },
            { status: 500 }
          );
        }
      }
    }

    // --------------------------------------------------
    // D. 自由入力（G）など：文章から県を推定するパス
    //    Gが選択された場合、またはPre-Checkin intentの場合に実行
    // --------------------------------------------------
    // Gが選択された場合を明示的に検出（isPreCheckinIntentに依存しない）
    // isGSelectedはBセクションで既に定義済み
    const wasGSelectedInHistory = isGSelectedInHistory(userMessages);
    
    console.log("[koyo-before] G selection check:", {
      isGSelected,
      wasGSelectedInHistory,
      userMessage,
      isPreCheckinIntent,
    });
    
    // Gが選択された場合、次の入力を待つ（自由入力モードに入る）
    if (isGSelected) {
      return NextResponse.json({
        mode: "precheckin-origin-select",
        reply: `自由入力を選択されましたね。出発地を教えてください。

例：
- 「仙台」（宮城経由）
- 「福島」（福島経由）
- 「秋田」（秋田経由）
- 「新潟」（新潟経由）
- 「関東から」（福島または新潟経由を確認します）

県名や都市名を入力してください。`,
        origin: DEFAULT_ORIGIN,
        originInputMode: "free", // 自由入力モードを有効化
      });
    }
    
    // 自由入力モード中、またはPre-Checkin intentの場合に県名推定を実行
    const shouldResolveFreeInput = originInputMode === "free" || isPreCheckinIntent || wasGSelectedInHistory;
    
    console.log("[koyo-before] Free input resolution check:", {
      userMessage,
      originInputMode,
      isPreCheckinIntent,
      wasGSelectedInHistory,
      shouldResolveFreeInput,
    });
    
    if (shouldResolveFreeInput) {
      console.log("[koyo-before] Resolving origin from free input:", {
        userMessage,
        originInputMode,
        isPreCheckinIntent,
        wasGSelectedInHistory,
      });
      
      const resolution = resolveOriginFromFreeInput(userMessage);
      
      console.log("[koyo-before] Origin resolution result:", {
        type: resolution.type,
        prefecture: resolution.type === "resolved" ? resolution.prefecture : undefined,
        origin: resolution.type === "resolved" ? resolution.origin : undefined,
      });

      if (resolution.type === "resolved") {
        try {
          const plan = await generatePrecheckinPlan({
            origin: resolution.origin,
            userMessage,
            prefecture: resolution.prefecture,
          });

          // Places API統合（途中立ち寄り意図検出）
          // matchedSpotsが空でもintegratePlacesを呼ぶ（DBスポットがなくてもPlacesで補完）
          let finalSpots = plan.spots && Array.isArray(plan.spots) ? [...plan.spots] : [];
          // チャット履歴から最初のStopIntentを含むメッセージを探す
          const stopIntentMessage = findStopIntentMessage(userMessages) || userMessage;
          const stopIntent = applyFoodKeywordToStopIntent(
            detectStopIntentFromUtils(stopIntentMessage),
            stopIntentMessage
          );
          const result = await integratePlaces(
            finalSpots,
            stopIntent,
            resolution.origin,
            KOYO_COORDINATES,
            buildPlacesOptions(finalSpots, stopIntent)
          );
          finalSpots = result.spots;
          const prefBoundary = getPrefBoundary(resolution.prefecture);

          const originResponse: OriginInfo = {
            type: "pref-boundary",
            pref: resolution.prefecture,
            lat: null,
            lng: null, // 座標はフロント側で県境から決定
            name: null,
          };
          
          console.log("[koyo-before] Returning resolved origin:", {
            origin: originResponse,
            prefBoundary,
            spotsCount: finalSpots.length,
          });

          let optionalSpots = buildOptionalSpots(finalSpots);
          optionalSpots = sortOptionalSpotsByIntent(optionalSpots, stopIntent);
          const reply = buildBeforeCandidateReply(optionalSpots, stopIntent);

          // originが確定した時点でoriginInputModeを削除（リセット）
          // originInputModeを含めない = フロントエンド側で削除される
          return NextResponse.json({
            reply,
            origin: originResponse,
            optionalSpots,
            phase: "before:phase2_2_waiting_selection",
            context: {
              before: {
                phase: "before:phase2_2_waiting_selection",
                optionalSpots,
                routeInfoKey: "direct",
                origin: originResponse,
                stopIntent,
              },
            },
            // originInputModeは含めない（削除を意味する）
            debug: { branch: "before:phase2_1_candidates" },
          });
        } catch (error: any) {
          console.error("[koyo-before] ❌ BRANCH: D_free_input_resolve ERROR:", error);
          console.error("[koyo-before] Pre-Checkin plan generation error:", error);
          return NextResponse.json(
            {
              error: "Pre-Checkinプランの生成中にエラーが発生しました。",
              detail: error?.message ?? String(error),
              origin: DEFAULT_ORIGIN,
              debug: { branch: "before:D_free_input_resolve:error" },
            },
            { status: 500 }
          );
        }
      }

      if (resolution.type === "ambiguous") {
        // 曖昧な場合はoriginInputModeを維持（次の入力で再試行）
        console.log("[koyo-before] ✅ BRANCH: D_free_input_ambiguous (県境が曖昧)");
        return NextResponse.json({
          type: "ask-pref",
          mode: "precheckin-origin-select",
          reply: resolution.message,
          message: resolution.message,
          choices: resolution.candidates,
          origin: DEFAULT_ORIGIN,
          originInputMode: "free", // 自由入力モードを維持
          debug: { branch: "before:D_free_input_ambiguous" },
        });
      }

      if (resolution.type === "unknown") {
        // 不明な場合もoriginInputModeを維持（再入力を促す）
        console.log("[koyo-before] ✅ BRANCH: D_free_input_unknown (出発地が不明)");
        return NextResponse.json({
          mode: "precheckin-origin-select",
          reply: resolution.message,
          origin: DEFAULT_ORIGIN,
          originInputMode: "free", // 自由入力モードを維持
          debug: { branch: "before:D_free_input_unknown" },
        });
      }
    }

    // --------------------------------------------------
    // E. ここまで来たら「Pre-Checkin ではない通常の Before」
    // --------------------------------------------------

    // Beforeモードではorigin未確定なら必ず出発地を聞く（状態ベースで判定）
    // ただし、自由入力モード中または現在地取得モード中はスキップ（A〜Gの選択肢を再表示しない）
    if (!hasOrigin && !originSelection && originInputMode !== "free" && originInputMode !== "current_location") {
      return NextResponse.json({
        mode: "precheckin-origin-select",
        reply: `
観光プランをお作りしますね！
まず、出発地を教えてください。

A. 山形駅
B. 山形空港
C. かみのやま温泉駅
D. 山形蔵王IC（高速）
E. かみのやま温泉IC（高速）
F. 現在地を使う
G. その他（自由入力）

例：「A」「空港」「現在地で」など簡単でOKです！
`.trim(),
        origin: DEFAULT_ORIGIN, // まだ決まっていない
      });
    }

    const systemPrompt = await getSystemPrompt();

    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      ...userMessages,
    ];

    const openai = getOpenAIClient();
    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages,
      temperature: 0.7,
      response_format: { type: "json_object" },
    });

    const reply = completion.choices[0]?.message?.content ?? "";

    // AIの返答から origin 情報を抽出
    let aiOrigin: OriginInfo | undefined;
    try {
      const cleanedReply = reply.replace(/```json\s*/g, '').replace(/```\s*/g, '').replace(/```[\s\S]*?```/g, '');
      const jsonResponse = JSON.parse(cleanedReply);
      if (jsonResponse.origin && jsonResponse.origin.type) {
        aiOrigin = jsonResponse.origin as OriginInfo;
        console.log("[koyo-before] Extracted origin from AI reply:", aiOrigin);
      }
    } catch (e) {
      // JSON解析に失敗した場合は無視
    }

    // plan配列を抽出
    const planArray = await extractPlanFromReply(reply);

    // plan[0].spotsからスポットを抽出し、Supabaseとマッチング
    let matchedSpots: any[] | undefined;
    let finalPlan: any[] | undefined;
    let placesApiFailed = false;
    let placesAdded = false;

    // 型ガード: planArrayが存在し、配列で、要素があることを確認
    // @ts-ignore - TypeScriptの型チェックが厳しすぎるため、型アサーションを使用
    if (planArray != null && Array.isArray(planArray) && planArray.length > 0) {
      // 型アサーション: この時点でplanArrayは確実にany[]
      // @ts-ignore - TypeScriptの型チェックが厳しすぎるため、型アサーションを使用
      const validPlanArray: any[] = planArray;
      matchedSpots = await extractAndMatchSpots(validPlanArray);

      // plan配列を構築（plan[0].spotsをマッチング済みスポットに置き換え）
      // @ts-ignore - TypeScriptの型チェックが厳しすぎるため、型アサーションを使用
      if (matchedSpots != null && Array.isArray(matchedSpots) && matchedSpots.length > 0) {
        // 型アサーション: この時点でmatchedSpotsは確実にany[]
        // @ts-ignore - TypeScriptの型チェックが厳しすぎるため、型アサーションを使用
        const validMatchedSpots: any[] = matchedSpots;
        // @ts-ignore - TypeScriptの型チェックが厳しすぎるため、型アサーションを使用
        finalPlan = validPlanArray.map((plan, index) => {
          if (index === 0) {
            // plan[0]のspotsをマッチング済みスポットに置き換え
            return {
              ...plan,
              spots: validMatchedSpots.map((spot) => ({
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

    // 途中立ち寄り意図を検出してPlaces APIを呼び出す（matchedSpotsが空でもstopIntentがあれば呼ぶ）
    // stopIntentMessageとstopIntentは660行目で既に定義済み（Eセクションでも使用可能）
    if (stopIntent) {
      // destination座標を取得（integratePlacesで使用）
      let destinationCoords: { lat: number; lng: number } | undefined;
      
      if (hasOrigin && currentOrigin) {
        if (currentOrigin.type === "pref-boundary" && currentOrigin.pref) {
          destinationCoords = getPrefBoundary(currentOrigin.pref as PrefectureKey);
        } else if ((currentOrigin.type === "fixed" || currentOrigin.type === "current") && currentOrigin.lat && currentOrigin.lng) {
          destinationCoords = {
            lat: currentOrigin.lat,
            lng: currentOrigin.lng,
          };
        }
      }
      
      // destinationが未設定の場合はKOYO_COORDINATESを使用
      if (!destinationCoords) {
        destinationCoords = KOYO_COORDINATES;
      }
      
      const result = await integratePlaces(
        matchedSpots || [],
        stopIntent,
        currentOrigin && currentOrigin.lat && currentOrigin.lng
          ? { lat: currentOrigin.lat, lng: currentOrigin.lng }
          : KOYO_COORDINATES,
        destinationCoords,
        buildPlacesOptions(matchedSpots || [], stopIntent)
      );
      
      matchedSpots = result.spots;
      placesApiFailed = result.placesApiFailed;
      placesAdded = result.placesAdded;
      
      console.log("[koyo-before] Places integration result (E section):", {
        placesApiFailed,
        placesAdded,
        spotsCount: matchedSpots?.length || 0,
      });
    }

    // Places API統合（途中立ち寄り意図検出）
    // matchedSpotsが空でもintegratePlacesを呼ぶ（DBスポットがなくてもPlacesで補完）
    // stopIntentは既にEセクションで定義済み（1162行目）
    const baseSpots = matchedSpots ?? [];
    // originが確定している場合は使用、そうでない場合はnull
    const originForPlaces = aiOrigin && (aiOrigin.type === "fixed" || aiOrigin.type === "current") && aiOrigin.lat && aiOrigin.lng
      ? { lat: aiOrigin.lat, lng: aiOrigin.lng }
      : undefined;
    
    // stopIntentが定義されている場合のみintegratePlacesを呼ぶ（Eセクションで既に呼んでいる場合はスキップ）
    let finalSpots: any[] | undefined = matchedSpots;
    if (stopIntent) {
      const result = await integratePlaces(
        baseSpots,
        stopIntent,
        originForPlaces,
        KOYO_COORDINATES,
        buildPlacesOptions(baseSpots, stopIntent)
      );
      
      // Eセクションで取得したplacesApiFailedとplacesAddedを上書き（finalSpotsが更新された場合）
      if (result.spots && result.spots.length > 0) {
        placesApiFailed = result.placesApiFailed;
        placesAdded = result.placesAdded;
        matchedSpots = result.spots;
        finalSpots = result.spots;
      }
    }

    // replyからJSON部分を除去してクリーンなメッセージにする
    let cleanReply = cleanReplyMessage(reply);
    
    // 体験コメントを追記（placesAdded === true の場合のみ）
    if (placesAdded && stopIntent) {
      const experienceComment = appendExperienceComment(stopIntent, placesAdded);
      if (experienceComment) {
        cleanReply += " " + experienceComment;
      }
    }
    
    // Places API検索が失敗した場合、reply内の断定表現を抽象表現に置き換える
    if (placesApiFailed && stopIntent) {
      cleanReply = sanitizeReplyForFailedPlaces(cleanReply, stopIntent);
    }
    
    // デバッグログ
    console.log("[koyo-before] Cleaned reply:", cleanReply);
    // @ts-ignore - TypeScriptの型チェックが厳しすぎるため、型アサーションを使用
    const hasSpotNames = finalSpots != null && Array.isArray(finalSpots) && finalSpots.length > 0
      ? (finalSpots as any[]).some((spot: any) => cleanReply.includes(spot.name))
      : false;
    console.log("[koyo-before] Cleaned reply contains spot names:", hasSpotNames);

    let optionalSpots = buildOptionalSpots(finalSpots || []);
    optionalSpots = sortOptionalSpotsByIntent(optionalSpots, stopIntent);
    const candidateReply =
      optionalSpots.length > 0
        ? buildBeforeCandidateReply(optionalSpots, stopIntent)
        : buildBeforeEmptyCandidatesReply();
    
    const response: any = {
      reply: candidateReply,
      origin: aiOrigin || DEFAULT_ORIGIN,
      optionalSpots,
      phase: "before:phase2_2_waiting_selection",
      context: {
        before: {
          phase: "before:phase2_2_waiting_selection",
          optionalSpots,
          routeInfoKey: "direct",
          origin: aiOrigin || DEFAULT_ORIGIN,
          stopIntent,
        },
      },
    };
    
    response.debug = { branch: "before:phase2_1_candidates" };
    return NextResponse.json(response);
  } catch (error: any) {
    console.error("[koyo-before] ❌ BRANCH: UNHANDLED_ERROR:", error);
    console.error("[koyo-before] error:", error);
    return NextResponse.json(
      {
        error: "チェックイン前AIの応答生成中にエラーが発生しました。",
        detail: error?.message ?? String(error),
        origin: DEFAULT_ORIGIN,
        debug: { branch: "before:UNHANDLED_ERROR" },
      },
      { status: 500 }
    );
  }
}
