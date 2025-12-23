// app/api/koyo/before/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/index.mjs";
import { createClient } from "@supabase/supabase-js";
import { matchSpot } from "../_utils/matchSpot";
import { detectPreCheckinIntent } from "@/lib/koyo/intents";
import { parseOriginSelection, type Origin } from "@/lib/koyo/precheckin/origins";
import { generatePrecheckinPlan } from "@/lib/koyo/precheckin/generatePrecheckinPlan";
import { resolveOriginFromFreeInput, getOriginFromPrefecture } from "./_utils/originResolver";
import type { PrefectureKey } from "./_constants/prefEntryPoints";
import type { OriginInfo } from "@/store/spots";
import { KOYO_COORDINATES, SPOT_COORDINATE_FIXES } from "@/constants/koyo";
import { getPrefBoundary } from "@/store/prefBoundaries";
import { detectStopIntent, integratePlaces } from "../_utils/places";
import { detectStopIntent as detectStopIntentFromUtils } from "../_utils/detectStopIntent";
import type { StopIntent } from "@/types/route";

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
あなたは「古窯 旅館コンシェルAI（旅前）」です。
「旅前（Before）モード」とは、旅行全体の計画を立てるためのモードであり、
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

/**
 * リクエストボディの型
 * - messages: chat履歴（フロントが管理）
 * - query: 単発問い合わせ
 * - userState: ユーザーの状態（origin、originInputModeなど）
 */
type BeforeRequestBody =
  | { messages: ChatCompletionMessageParam[]; userState?: { origin?: OriginInfo; originInputMode?: "free" } }
  | { query: string; userState?: { origin?: OriginInfo; originInputMode?: "free" } };

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
    
    console.log("[koyo-before] Received userState:", {
      userState,
      currentOrigin,
      originType: currentOrigin?.type,
      originPref: currentOrigin?.pref,
      originInputMode,
      userMessage,
    });

    const hasOrigin =
      currentOrigin &&
      currentOrigin.type !== null &&
      // pref-boundary の場合は lat/lng が null でも OK
      (currentOrigin.type === "pref-boundary" ||
        (currentOrigin.lat !== null && currentOrigin.lng !== null));

    console.log("[koyo-before] Debug origin check:", {
      currentOrigin,
      hasOrigin,
      type: currentOrigin?.type,
      pref: currentOrigin?.pref,
    });

    const isPreCheckinIntent = detectPreCheckinIntent(userMessage);
    const originSelection = parseOriginSelection(userMessage); // 「A〜G」などの返答

    // --------------------------------------------------
    // A. すでに origin が決まっている場合
    //    → 「Pre-Checkin プラン生成モード」とみなす
    // --------------------------------------------------
    if (hasOrigin) {
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
        const stopIntent = detectStopIntentFromUtils(stopIntentMessage);
        const result = await integratePlaces(finalSpots, stopIntent, originForPlan, KOYO_COORDINATES);
        finalSpots = result.spots;
        const placesApiFailed = result.placesApiFailed;
        const placesAdded = result.placesAdded;

        // routeInfo を構築（origin/waypoints/destination）
        let routeOrigin: { lat: number; lng: number };
        if (currentOrigin.type === "pref-boundary" && currentOrigin.pref) {
          const prefBoundary = getPrefBoundary(currentOrigin.pref);
          routeOrigin = prefBoundary;
        } else {
          routeOrigin = {
            lat: currentOrigin.lat as number,
            lng: currentOrigin.lng as number,
          };
        }

        const waypoints =
          finalSpots.length > 0
            ? finalSpots
                .filter((s: any) => s.lat != null && s.lng != null)
                .map((s: any) => ({ lat: s.lat, lng: s.lng }))
            : [];

        const destination = KOYO_COORDINATES;

        // replyはAIが生成したものをそのまま使用（Places API結果は追記しない）
        let reply = plan.reply || "";
        
        // 体験コメントを追記（placesAdded === true の場合のみ）
        if (placesAdded && stopIntent) {
          const experienceComment = appendExperienceComment(stopIntent, placesAdded);
          if (experienceComment) {
            reply += " " + experienceComment;
          }
        }
        
        // Places API検索が失敗した場合、reply内の断定表現を抽象表現に置き換える
        if (placesApiFailed && stopIntent) {
          reply = sanitizeReplyForFailedPlaces(reply, stopIntent);
        }

        // ✅ Pre-Checkin 時だけ origin を返す
        return NextResponse.json({
          ...plan,
          spots: finalSpots,
          reply,
          origin: currentOrigin,
          routeInfo: {
            origin: routeOrigin,
            waypoints,
            destination,
          },
        });
      } catch (error: any) {
        console.error("[koyo-before] Pre-Checkin plan generation error:", error);
        return NextResponse.json(
          {
            error: "Pre-Checkinプランの生成中にエラーが発生しました。",
            detail: error?.message ?? String(error),
            origin: currentOrigin,
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
    // Gが選択された場合を明示的に検出（Bセクションより前にチェック）
    const isGSelected = userMessage.trim().toUpperCase() === "G";
    
    // 自由入力モード中はBセクションをスキップ
    if (!originSelection && !isGSelected && originInputMode !== "free") {
      return NextResponse.json({
        mode: "precheckin-origin-select",
        reply: `
チェックイン前の観光プランをお作りしますね！
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

    // --------------------------------------------------
    // C. A〜G の選択に対する回答（originSelection が取れた場合）
    // --------------------------------------------------
    if (originSelection) {
      // F. 現在地を使う
      if ("useCurrentLocation" in originSelection && originSelection.useCurrentLocation) {
        return NextResponse.json({
          mode: "precheckin-origin-select",
          reply:
            "現在地を使用する場合は、ブラウザの位置情報を許可してください。位置情報が取得できない場合は、A〜Eから選択してください。",
          requiresLocation: true,
          origin: DEFAULT_ORIGIN,
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
          const stopIntent = detectStopIntentFromUtils(stopIntentMessage);
          const result = await integratePlaces(finalSpots, stopIntent, originSelection, KOYO_COORDINATES);
          finalSpots = result.spots;
          const placesApiFailed = result.placesApiFailed;
          const placesAdded = result.placesAdded;

          const waypoints =
            finalSpots.length > 0
              ? finalSpots
                  .filter((s: any) => s.lat != null && s.lng != null)
                  .map((s: any) => ({ lat: s.lat, lng: s.lng }))
              : [];

          // replyはAIが生成したものをそのまま使用（Places API結果は追記しない）
          let reply = plan.reply || "";
          
          // 体験コメントを追記（placesAdded === true の場合のみ）
          if (placesAdded && stopIntent) {
            const experienceComment = appendExperienceComment(stopIntent, placesAdded);
            if (experienceComment) {
              reply += " " + experienceComment;
            }
          }
          
          // Places API検索が失敗した場合、reply内の断定表現を抽象表現に置き換える
          if (placesApiFailed && stopIntent) {
            reply = sanitizeReplyForFailedPlaces(reply, stopIntent);
          }

          return NextResponse.json({
            ...plan,
            spots: finalSpots,
            reply,
            origin: {
              type: "fixed",
              pref: null,
              name: originSelection.name,
              lat: originSelection.lat,
              lng: originSelection.lng,
            } as OriginInfo,
            routeInfo: {
              origin: { lat: originSelection.lat, lng: originSelection.lng },
              waypoints,
              destination: KOYO_COORDINATES,
            },
          });
        } catch (error: any) {
          console.error("[koyo-before] Pre-Checkin plan generation error:", error);
          return NextResponse.json(
            {
              error: "Pre-Checkinプランの生成中にエラーが発生しました。",
              detail: error?.message ?? String(error),
              origin: DEFAULT_ORIGIN,
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
          const stopIntent = detectStopIntentFromUtils(stopIntentMessage);
          const result = await integratePlaces(finalSpots, stopIntent, resolution.origin, KOYO_COORDINATES);
          finalSpots = result.spots;
          const placesApiFailed = result.placesApiFailed;
          const placesAdded = result.placesAdded;

          const prefBoundary = getPrefBoundary(resolution.prefecture);
          const waypoints =
            finalSpots.length > 0
              ? finalSpots
                  .filter((s: any) => s.lat != null && s.lng != null)
                  .map((s: any) => ({ lat: s.lat, lng: s.lng }))
              : [];

          // replyはAIが生成したものをそのまま使用（Places API結果は追記しない）
          let reply = plan.reply || "";
          
          // 体験コメントを追記（placesAdded === true の場合のみ）
          if (placesAdded && stopIntent) {
            const experienceComment = appendExperienceComment(stopIntent, placesAdded);
            if (experienceComment) {
              reply += " " + experienceComment;
            }
          }
          
          // Places API検索が失敗した場合、reply内の断定表現を抽象表現に置き換える
          if (placesApiFailed && stopIntent) {
            reply = sanitizeReplyForFailedPlaces(reply, stopIntent);
          }

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
            waypointsCount: waypoints.length,
            spotsCount: finalSpots.length,
          });

          // originが確定した時点でoriginInputModeを削除（リセット）
          // originInputModeを含めない = フロントエンド側で削除される
          return NextResponse.json({
            ...plan,
            spots: finalSpots,
            reply,
            origin: originResponse,
            routeInfo: {
              origin: prefBoundary,
              waypoints,
              destination: KOYO_COORDINATES,
            },
            // originInputModeは含めない（削除を意味する）
          });
        } catch (error: any) {
          console.error("[koyo-before] Pre-Checkin plan generation error:", error);
          return NextResponse.json(
            {
              error: "Pre-Checkinプランの生成中にエラーが発生しました。",
              detail: error?.message ?? String(error),
              origin: DEFAULT_ORIGIN,
            },
            { status: 500 }
          );
        }
      }

      if (resolution.type === "ambiguous") {
        // 曖昧な場合はoriginInputModeを維持（次の入力で再試行）
        return NextResponse.json({
          type: "ask-pref",
          mode: "precheckin-origin-select",
          reply: resolution.message,
          message: resolution.message,
          choices: resolution.candidates,
          origin: DEFAULT_ORIGIN,
          originInputMode: "free", // 自由入力モードを維持
        });
      }

      if (resolution.type === "unknown") {
        // 不明な場合もoriginInputModeを維持（再入力を促す）
        return NextResponse.json({
          mode: "precheckin-origin-select",
          reply: resolution.message,
          origin: DEFAULT_ORIGIN,
          originInputMode: "free", // 自由入力モードを維持
        });
      }
    }

    // --------------------------------------------------
    // E. ここまで来たら「Pre-Checkin ではない通常の Before」
    // --------------------------------------------------

    // Beforeモードではorigin未確定なら必ず出発地を聞く（状態ベースで判定）
    // ただし、自由入力モード中はスキップ（A〜Gの選択肢を再表示しない）
    if (!hasOrigin && !originSelection && originInputMode !== "free") {
      return NextResponse.json({
        mode: "precheckin-origin-select",
        reply: `
チェックイン前の観光プランをお作りしますね！
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
    // チャット履歴から最初のStopIntentを含むメッセージを探す
    const stopIntentMessage = findStopIntentMessage(userMessages) || userMessage;
    const stopIntent = detectStopIntentFromUtils(stopIntentMessage);
    
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
        destinationCoords
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
      const result = await integratePlaces(baseSpots, stopIntent, originForPlaces, KOYO_COORDINATES);
      
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

    // レスポンスを構築
    const response: any = {
      reply: cleanReply,
      usage: completion.usage,
    };

    // planがある場合のみ追加
    // @ts-ignore - TypeScriptの型チェックが厳しすぎるため、型アサーションを使用
    if (finalPlan != null && Array.isArray(finalPlan) && finalPlan.length > 0) {
      response.plan = finalPlan;
    }
    
    // フロントエンド互換性のため、統合後のspotsを返す
    // finalSpotsは既に1204-1225行目で定義済み
    if (finalSpots != null && Array.isArray(finalSpots) && finalSpots.length > 0) {
      response.spots = finalSpots;
    }

    // すべてのレスポンスに origin を含める
    // AIの返答に origin が含まれている場合はそれを使用、そうでなければ DEFAULT_ORIGIN
    response.origin = aiOrigin || DEFAULT_ORIGIN;

    // routeInfo を構築
    // AIの返答に origin 情報が含まれている場合はそれを使用、そうでなければ古窯固定
    let routeOrigin: { lat: number; lng: number } = KOYO_COORDINATES;
    
    if (aiOrigin && aiOrigin.type === "pref-boundary" && aiOrigin.pref) {
      // 県境の場合は県境座標を使用
      const prefBoundary = getPrefBoundary(aiOrigin.pref as PrefectureKey);
      routeOrigin = prefBoundary;
      console.log("[koyo-before] Using pref-boundary origin:", routeOrigin);
    } else if (aiOrigin && (aiOrigin.type === "fixed" || aiOrigin.type === "current") && aiOrigin.lat && aiOrigin.lng) {
      // 固定地点または現在地の場合はその座標を使用
      routeOrigin = {
        lat: aiOrigin.lat,
        lng: aiOrigin.lng,
      };
      console.log("[koyo-before] Using fixed/current origin:", routeOrigin);
    } else {
      console.log("[koyo-before] Using default Koyo origin");
    }

    const waypoints =
      finalSpots && Array.isArray(finalSpots)
        ? finalSpots
            .filter((s: any) => {
              // 座標の型と値の検証を強化
              const isValid = 
                s.lat != null && 
                s.lng != null &&
                typeof s.lat === "number" &&
                typeof s.lng === "number" &&
                !isNaN(s.lat) &&
                !isNaN(s.lng) &&
                s.lat >= -90 && s.lat <= 90 &&
                s.lng >= -180 && s.lng <= 180;
              
              if (!isValid) {
                console.warn(`[koyo-before] Invalid coordinates for spot "${s.name}" (${s.id}): lat=${s.lat}, lng=${s.lng}`);
              }
              
              return isValid;
            })
            .map((s: any) => {
              // 座標を数値型に明示的に変換
              const lat = Number(s.lat);
              const lng = Number(s.lng);
              
              // 蔵王お釜のIDをチェック（デバッグ用）
              const zawaoOkamaId = "b916a6f4-7225-42df-800a-a48f5f030da0";
              if (s.id === zawaoOkamaId) {
                console.log(`[koyo-before] Zawao Okama waypoint: lat=${lat}, lng=${lng}, type: lat=${typeof lat}, lng=${typeof lng}`);
              }
              
              return { lat, lng };
            })
        : [];

    response.routeInfo = {
      origin: routeOrigin,
      waypoints,
      destination: KOYO_COORDINATES,
    };
    
    // デバッグログ：routeInfoの内容を確認
    console.log("[koyo-before] routeInfo constructed:", {
      origin: response.routeInfo.origin,
      destination: response.routeInfo.destination,
      waypointsCount: response.routeInfo.waypoints.length,
      waypoints: response.routeInfo.waypoints,
      containsZawaoOkama: finalSpots?.some((s: any) => s.id === "b916a6f4-7225-42df-800a-a48f5f030da0"),
    });

    return NextResponse.json(response);
  } catch (error: any) {
    console.error("[koyo-before] error:", error);
    return NextResponse.json(
      {
        error: "旅前AIの応答生成中にエラーが発生しました。",
        detail: error?.message ?? String(error),
        origin: DEFAULT_ORIGIN,
      },
      { status: 500 }
    );
  }
}
