// app/api/koyo/after/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/index.mjs";
import { createClient } from "@supabase/supabase-js";
import { matchSpot } from "../_utils/matchSpot";
import { KOYO_COORDINATES, SPOT_COORDINATE_FIXES } from "@/constants/koyo";
import { integratePlaces } from "../_utils/places";
import { detectStopIntent } from "../_utils/detectStopIntent";
import { detectFoodKeyword } from "../_utils/stopIntentHelpers";
import { searchSpotsFromDB } from "../_utils/searchSpotsFromDB";
import { extractSelections } from "../_utils/extractSelections";
import { resolveOriginFromFreeInput } from "../before/_utils/originResolver";
import { parseOriginSelection } from "@/lib/koyo/precheckin/origins";
import { normalizeUserSelection } from "@/lib/koyo/text/normalizeUserSelection";
import type { PrefectureKey } from "../before/_constants/prefEntryPoints";
import { getPrefBoundary } from "@/store/prefBoundaries";
import type { OriginInfo, Spot } from "@/store/spots";
import type { RouteInfo, StopIntent } from "@/types/route";
import { parseAfterDestination } from "@/lib/koyo/after/destination";
import { detectModeMismatch } from "@/lib/koyo/intents";

// モデルは環境変数で差し替え可能
const CHAT_MODEL =
  process.env.KOYO_AFTER_MODEL || "gpt-4o-mini";

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
      console.error("[koyo-after] Supabase error:", error);
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
    console.error("[koyo-after] Error fetching spots:", error);
    return "【注意】スポット一覧の取得中にエラーが発生しました。";
  }
}

/**
 * 帰宅後モードのシステムプロンプトを生成（Supabaseスポット一覧を自動注入）
 * After System Prompt (ver.2)
 * @param stopIntent ユーザーの立ち寄り意図（オプショナル）
 */
async function getSystemPrompt(stopIntent?: { type: string; foodCategory?: string } | null): Promise<string> {
  const spotListText = await getSpotListForPrompt();
  
  // ユーザーの意図をシステムプロンプトに反映
  let userIntentNote = "";
  if (stopIntent && stopIntent.foodCategory) {
    userIntentNote = `
【ユーザーの希望（重要）】
ユーザーは「${stopIntent.foodCategory}」を希望しています。
reply内で食事について言及する際は、必ず「${stopIntent.foodCategory}」に関連する表現を使用してください。
ただし、店名・固有名詞は絶対に出さないでください。

例：
- 「${stopIntent.foodCategory}を楽しむために」
- 「${stopIntent.foodCategory}を味わう」
- 「${stopIntent.foodCategory}を楽しめる場所に立ち寄る」
- 「${stopIntent.foodCategory}を楽しむ時間を設ける」（簡潔に）

NG例：
- 「ラーメンを楽しむ」（ユーザーが「山形牛」を希望している場合）
- 「◯◯で${stopIntent.foodCategory}」（店名を出すのは禁止）
`;
  }

  return `
あなたは「日本の宿 古窯」の専属AIコンシェルジュです。
モード：After（チェックアウト後AI）
人格：48歳前後の落ち着いた若女将。丁寧で温かい接客の言葉遣い。
役割：チェックアウト後のお見送り、帰宅途中に寄れるスポット案内、負担の少ない提案、安全配慮。

【重要】あなたの返答は必ずJSON形式で返してください。テキストのみの返答は絶対に禁止です。

【AIの基本方針】
- ユーザーはチェックアウト後であり「帰宅途中」という前提で対応する。
- 旅行の余韻を大切にしつつ、落ち着いた丁寧なトーンで話す。
- 道中の安全への配慮を必ず添える（例：天気や道路状況への気遣い）。
- "負担のない"提案を最優先にする（移動時間・距離・体力消費を軽減）。
- 山形県内のみ案内対象。ただし「帰宅方向にある場所」は優先して良い。
- Supabaseのスポット以外は絶対に出さない（推測生成は厳禁）。

【Afterモードの提案の特徴】
- チェックイン前（Before）: 計画作成・長時間移動も許容
- 滞在中（Stay）  : 当日の天候・気分に合わせた柔軟案
- 旅後（After）: "帰り道寄れる・負担のない短時間スポット"が中心

【重要制限（厳守）】
- 山形県外のスポットは提案禁止
- Supabase に存在しないスポット名は絶対に出してはいけません
- 地名・市名（例：蔵王温泉、天童市、上山市など）をスポットとして出すのは禁止です
- 架空スポットの生成は厳禁
- スポット名は必ず Supabase の登録名を正確に使用すること
- 帰宅途中の「負担の少ないルート上のスポット」を優先すること

【重要：飲食・休憩スポットについて】
- 飲食店・カフェ・温泉・売店などの固有名詞（店名）は出さない
- 「この旅の流れの中で立ち寄りやすい場所で」
  「温かい食事を楽しむ」
  など抽象的な表現を使用する
- ユーザーが特定の食べ物を希望している場合は、その食べ物に関連する表現を使用すること
- NG例：「◯◯でラーメン」「食事処△△」
${userIntentNote}

【季節ルール】
- 冬（12〜3月）は安全配慮の文言を必ず追加する。
  例：「冬季は凍結が多く、特に夕方以降は路面が滑りやすくなりますので、お気をつけてお進みくださいませ。」

【ヒアリング（重要）】
ユーザーから情報が不足している場合、丁寧に短く確認する。

**帰路方向の確認（必須）**
まず、以下の選択肢を提示してください：
A. 山形駅
B. 山形空港
C. かみのやま温泉駅
D. 山形蔵王IC（高速）
E. かみのやま温泉IC（高速）
F. その他

ユーザーが「F. その他」を選択した場合のみ、以下の県境選択を提示してください：
① 宮城
② 福島
③ 秋田
④ 新潟

例：「①」「宮城」「仙台方面」など簡単でOKです。

**その他のヒアリング例**
- 「途中でお食事をとりたいご予定はございますか？」
- 「立ち寄りたいジャンル（カフェ・景色・温泉など）はございますか？」

必要なヒアリングを行った後にプランを生成する。

【利用できるスポット（Supabase データのみ）】
以下は Supabase から取得した「公式スポット一覧」です。
この一覧にあるスポット名のみ、プランに使用できます。
一覧にないスポットは、名前が似ていても **絶対に使用禁止**。

${spotListText}

--------------------------------------------------
【返信形式（統一仕様・最重要）】
**必ず以下のJSON形式で返してください。テキストのみの返答は禁止です。**

{
  "reply": "ユーザーへの丁寧な文章",
  "plan": [
    {
      "title": "1つ目の提案タイトル",
      "spots": [
        { "name": "スポット名", "id": "SupabaseのID" },
        ...
      ]
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
  - 例：plan[0].spots が [「上山城」「上杉神社」] の場合、replyは「上山城で山形の歴史を感じ、その後、上杉神社へ向かいます。」のように、spotsの順番通りに簡潔に記述すること
  - 例（飲食希望時）：plan[0].spots が [「丹野こんにゃく」「スモっち（いではこっこ）」] の場合、replyは「丹野こんにゃくで温かい食事を味わい、その後、スモっち（いではこっこ）でラーメンを楽しめます。」のように、簡潔に記述すること
  - **replyの文章は簡潔に、1文あたり30文字以内を目安にすること**
  - スポット名は自然に文章に組み込むこと（列挙しない）
  - 「〜を楽しむ時間を設けるために」のような冗長な表現は避けること
  - 「まずは」「その後」などの接続詞は必要最小限にすること
  - 複数スポットがある場合：「スポットAで〜、その後、スポットBで〜」のように簡潔に記述すること
- plan は1件のみでOK（Afterは複数案は不要）
- spots の id は Supabase の ID と一致させること
- スポット名は Supabase の登録名を正確に使用すること（推測や略称は禁止）
- JSON 前後に \`\`\` や余計な文章は禁止

【提案内容のルール】
- スポット数は 1〜3 件。
- 距離の短さ・移動負担の軽さを最優先。
- カフェ・景観・軽い観光・買い物・温泉・お土産が中心。
- 長距離移動が必要なプランは不可。
- 絶対に Supabase に存在しないスポットを提案しない。

【禁止事項】
- 山形県外スポット
- Supabaseに存在しないスポット
- 推測で作った施設名
- 長距離で負担の大きい提案（庄内、米沢など）※Afterでは原則不可

【返答トーン】
- 丁寧・温かい・落ち着いた若女将
- 帰宅の安全を第一に気遣う
- 「今日も素敵な一日となりますように」といった余韻のあるメッセージ

--------------------------------------------------
以上のルールに従い、
「帰宅後AIとしての丁寧な案内」＋「帰宅途中のプランJSON」を返してください。
JSON形式で返さない場合は、プラン提案ができません。
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
    // ```json ... ``` を除去
    cleanedReply = cleanedReply.replace(/```json\s*/g, '').replace(/```\s*/g, '');
    // ``` ... ``` を除去
    cleanedReply = cleanedReply.replace(/```[\s\S]*?```/g, '');
    
    // まず、JSON形式のレスポンスを試す（全体がJSONの場合）
    try {
      const jsonResponse = JSON.parse(cleanedReply);
      if (jsonResponse.plan && Array.isArray(jsonResponse.plan)) {
        planArray = jsonResponse.plan;
        console.log("[koyo-after] Found plan in full JSON response");
      }
    } catch {
      // JSON形式でない場合は、テキストから抽出を試す
    }

    // JSON形式で取得できなかった場合、テキストから抽出
    if (!planArray) {
      // テキスト内に埋め込まれたJSONを抽出する
      // 方法1: { "plan": [...] } を含むJSONオブジェクト全体を探す
      // ネストされたJSONに対応するため、{ と } のバランスを考慮
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
              console.log("[koyo-after] Found plan in extracted JSON object");
            }
          } catch (parseError) {
            console.warn("[koyo-after] Failed to parse extracted JSON:", parseError);
          }
        }
      }
      
      // 方法2: 正規表現で { "plan": [...] } 形式を探す（フォールバック）
      if (!planArray) {
        // より柔軟な正規表現：plan配列を含むJSONオブジェクト全体を抽出
        const planMatch = cleanedReply.match(/\{\s*"plan"\s*:\s*\[[\s\S]*?\]\s*\}/);
        if (planMatch) {
          try {
            const planObj = JSON.parse(planMatch[0]);
            if (planObj.plan && Array.isArray(planObj.plan)) {
              planArray = planObj.plan;
              console.log("[koyo-after] Found plan in regex match");
            }
          } catch (parseError) {
            console.warn("[koyo-after] Failed to parse regex matched JSON:", parseError);
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
              console.log("[koyo-after] Found plan in outer match");
            }
          } catch (parseError) {
            console.warn("[koyo-after] Failed to parse outer match JSON:", parseError);
          }
        }
      }
      
      if (!planArray) {
        console.warn("[koyo-after] No plan JSON pattern found in reply");
        console.warn("[koyo-after] Reply preview:", cleanedReply.substring(0, 500));
      }
    }

    if (!planArray || planArray.length === 0) {
      return undefined;
    }

    // plan[0].spotsが空または存在しない場合はundefinedを返す
    const firstPlan = planArray[0];
    if (!firstPlan || !firstPlan.spots || !Array.isArray(firstPlan.spots) || firstPlan.spots.length === 0) {
      return undefined;
    }

    return planArray;
  } catch (error) {
    console.error("[koyo-after] Plan extraction error:", error);
    return undefined;
  }
}

/**
 * 候補スポットIDリストを含むシステムプロンプトを生成
 * Phase2-1: DB候補→LLM選択方式
 */
async function getSystemPromptWithCandidates(
  stopIntent: StopIntent | null,
  candidateIds: string[],
  candidateSpots: Spot[]
): Promise<string> {
  const basePrompt = await getSystemPrompt(stopIntent ? { type: stopIntent.type, foodCategory: stopIntent.foodCategory } : null);
  
  // 候補IDリストをプロンプトに含める
  const candidateListText = candidateIds
    .map((id, idx) => {
      const spot = candidateSpots.find(s => s.id === id);
      return `[${idx + 1}] ${spot?.name || "不明"} (ID: ${id})`;
    })
    .join("\n");
  
  return `${basePrompt}

【候補スポット（選択してください）】
以下の候補から1〜3件を選択してください。

${candidateListText}

【選択方法】
JSON形式で返してください:
{
  "reply": "ユーザーへの丁寧な文章",
  "selectedSpotIds": ["id1", "id2"]
}

重要: selectedSpotIdsには、上記候補IDリストに含まれるIDのみを指定してください。
plan配列は不要です（候補IDから選択する方式に変更しました）。`;
}

/**
 * LLMの応答からselectedSpotIdsを抽出
 */
function extractSelectedSpotIds(reply: string, candidateIds: string[]): string[] {
  try {
    const cleanedReply = reply.replace(/```json\s*/g, '').replace(/```\s*/g, '');
    const jsonResponse = JSON.parse(cleanedReply);
    
    console.log("[extractSelectedSpotIds] Parsed JSON:", {
      hasSelectedSpotIds: !!jsonResponse.selectedSpotIds,
      selectedSpotIdsType: typeof jsonResponse.selectedSpotIds,
      selectedSpotIdsIsArray: Array.isArray(jsonResponse.selectedSpotIds),
      selectedSpotIdsValue: jsonResponse.selectedSpotIds,
      hasPlan: !!jsonResponse.plan,
      candidateIdsCount: candidateIds.length,
    });
    
    // 優先: selectedSpotIds から取得
    if (jsonResponse.selectedSpotIds && Array.isArray(jsonResponse.selectedSpotIds)) {
      // 候補IDリストに含まれるもののみを返す
      const filtered = jsonResponse.selectedSpotIds.filter((id: string) => candidateIds.includes(id));
      console.log("[extractSelectedSpotIds] Filtered IDs from selectedSpotIds:", {
        originalCount: jsonResponse.selectedSpotIds.length,
        filteredCount: filtered.length,
        filteredIds: filtered,
      });
      return filtered;
    }
    
    // フォールバック: plan 配列からIDを抽出
    if (jsonResponse.plan && Array.isArray(jsonResponse.plan) && jsonResponse.plan.length > 0) {
      const firstPlan = jsonResponse.plan[0];
      if (firstPlan.spots && Array.isArray(firstPlan.spots)) {
        const idsFromPlan = firstPlan.spots
          .map((spot: any) => spot.id)
          .filter((id: string) => id && candidateIds.includes(id));
        console.log("[extractSelectedSpotIds] Extracted IDs from plan:", {
          planSpotsCount: firstPlan.spots.length,
          extractedCount: idsFromPlan.length,
          extractedIds: idsFromPlan,
        });
        return idsFromPlan;
      }
    }
  } catch (e) {
    console.warn("[extractSelectedSpotIds] Failed to parse JSON:", e);
    console.warn("[extractSelectedSpotIds] Reply preview:", reply.substring(0, 500));
  }
  
  return [];
}

/**
 * plan[0].spotsからスポットを抽出し、Supabaseとマッチングする関数
 * @deprecated Phase2-1で廃止。DB候補→LLM選択方式に移行済み。
 * この関数は削除されました。searchSpotsFromDB + extractSelectedSpotIdsを使用してください。
 */

/**
 * チャット履歴から「直近の」StopIntentを含むユーザーメッセージを探す
 * @param userMessages チャット履歴
 * @returns StopIntentを含む直近のメッセージ（見つからない場合はnull）
 */
function findLatestStopIntentMessage(userMessages: ChatCompletionMessageParam[]): string | null {
  // 新しい発話ほど優先（古いlunch意図が残っていると、今回のsightseeingが上書きされずに混ざるため）
  for (let i = userMessages.length - 1; i >= 0; i--) {
    const message = userMessages[i];
    if (message?.role === "user" && typeof message.content === "string") {
      const stopIntent = detectStopIntent(message.content);
      if (stopIntent) {
        console.log("[koyo-after] Found latest stopIntent in message:", message.content, "stopIntent:", stopIntent);
        return message.content;
      }
    }
  }
  return null;
}

/**
 * Places API検索が失敗した場合、reply内の断定表現を抽象表現に置き換える
 * @param reply 元のreply
 * @param stopIntent StopIntent（nullの場合はそのまま返す）
 * @returns サニタイズされたreply
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
 * reply内のスポット名の順序をfinalPlanの順序に合わせて修正する関数
 * @param reply 元のreply
 * @param finalSpotsOrder finalPlan[0].spotsの順序（スポット名の配列）
 * @returns 順序を修正したreply
 */
function reorderReplySpots(reply: string, finalSpotsOrder: string[]): string {
  if (!finalSpotsOrder || finalSpotsOrder.length === 0) {
    return reply;
  }

  // reply内のスポット名を抽出（finalSpotsOrderに含まれるもののみ）
  // 複数回出現する可能性があるため、最初の出現位置のみを記録
  const foundSpots: Array<{ name: string; index: number }> = [];
  for (const spotName of finalSpotsOrder) {
    const index = reply.indexOf(spotName);
    if (index !== -1) {
      foundSpots.push({ name: spotName, index });
    }
  }

  // 見つかったスポットが2つ未満の場合は順序修正不要
  if (foundSpots.length < 2) {
    return reply;
  }

  // reply内のスポット名の出現順序を確認
  const replyOrder = foundSpots.sort((a, b) => a.index - b.index).map(s => s.name);
  const finalOrder = finalSpotsOrder.filter(name => replyOrder.includes(name));

  // 順序が一致している場合は修正不要
  if (replyOrder.join(',') === finalOrder.join(',')) {
    return reply;
  }

  // 順序が異なる場合、replyを再構築
  // 各スポット名を含む文を抽出し、finalSpotsOrderの順序に合わせて並び替え
  const spotSentences: Array<{ name: string; sentence: string; originalIndex: number }> = [];
  
  // replyを文単位に分割（「。」で区切る）
  const sentences = reply.split('。').filter(s => s.trim().length > 0);
  
  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i];
    for (const spotName of finalOrder) {
      if (sentence.includes(spotName)) {
        spotSentences.push({
          name: spotName,
          sentence: sentence.trim(),
          originalIndex: i,
        });
        break; // 1つの文に複数のスポット名が含まれる場合は最初のもののみ
      }
    }
  }

  // finalSpotsOrderの順序に合わせて文を並び替え
  const reorderedSentences: string[] = [];
  const usedSentences = new Set<number>();
  
  for (const spotName of finalOrder) {
    const spotSentence = spotSentences.find(s => s.name === spotName && !usedSentences.has(s.originalIndex));
    if (spotSentence) {
      reorderedSentences.push(spotSentence.sentence);
      usedSentences.add(spotSentence.originalIndex);
    }
  }

  // スポット名を含まない文も保持（順序は維持）
  const nonSpotSentences: string[] = [];
  for (let i = 0; i < sentences.length; i++) {
    if (!usedSentences.has(i)) {
      nonSpotSentences.push(sentences[i].trim());
    }
  }

  // 再構築：スポット名を含む文をfinalSpotsOrderの順序で配置し、その他の文は元の位置に配置
  const resultSentences: string[] = [];
  let spotIndex = 0;
  
  for (let i = 0; i < sentences.length; i++) {
    if (usedSentences.has(i)) {
      // スポット名を含む文は、finalSpotsOrderの順序で配置
      if (spotIndex < reorderedSentences.length) {
        resultSentences.push(reorderedSentences[spotIndex]);
        spotIndex++;
      }
    } else {
      // スポット名を含まない文は元の位置に配置
      resultSentences.push(sentences[i].trim());
    }
  }

  // 残りのスポット名を含む文を追加（元のreplyに含まれていなかった場合）
  while (spotIndex < reorderedSentences.length) {
    resultSentences.push(reorderedSentences[spotIndex]);
    spotIndex++;
  }

  const reorderedReply = resultSentences.join('。') + '。';
  
  console.log("[koyo-after] Reply spot order reordered:", {
    originalOrder: replyOrder,
    finalOrder: finalOrder,
    originalReply: reply.substring(0, 150),
    reorderedReply: reorderedReply.substring(0, 150),
  });

  return reorderedReply;
}

/**
 * replyからJSON部分を除去してクリーンなメッセージを返す関数
 * 新しい形式: { plan: [...] } に対応
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
      return jsonResponse.reply;
    }
  } catch {
    // JSON形式でない場合は、テキストから抽出を試す
  }

  // { "plan": [...] } 形式のJSONを削除
  const cleaned = cleanedReply.replace(/\{\s*"plan"\s*:\s*\[[\s\S]*?\]\s*\}/g, "").trim();
  
  // { "reply": "...", "plan": [...] } 形式のJSONからreply部分を抽出
  const replyMatch = cleaned.match(/\{\s*"reply"\s*:\s*"([^"]*)"\s*[,}]/);
  if (replyMatch && replyMatch[1]) {
    return replyMatch[1];
  }

  // 従来の配列形式も削除（後方互換性のため）
  const cleaned2 = cleaned.replace(/\[\s*\{[\s\S]*?\}\s*(,\s*\{[\s\S]*?\}\s*)*\]/g, "").trim();

  // 「--」や余計な区切り文字が残る場合も削除
  return cleaned2.replace(/--/g, "").trim();
}

/**
 * リクエストボディの型
 * - messages: chat履歴（フロントが管理）
 * - query: 単発問い合わせ
 */
// Phase2-2: After状態を保持するためのコンテキスト
type AfterContext = {
  phase?: "after:phase2_1" | "after:phase2_2_waiting_selection" | "after:phase2_2_done";
  optionalSpots?: Spot[]; // Phase2-1で保持した候補
  spots?: Spot[]; // Phase2-2で確定した経由地（順番変更用）
  routeInfoKey?: "direct"; // 直行ルートを意味するフラグ
  routeInfo?: RouteInfo | null; // 後方互換性のため追加
  origin?: { lat: number; lng: number };
  destination?: { lat: number; lng: number };
};

type AfterRequestBody =
  | { 
      messages: ChatCompletionMessageParam[]; 
      userState?: { 
        destination?: OriginInfo; 
        origin?: OriginInfo;
        originInputMode?: "free" | "current_location" | undefined;
        routePlanId?: string | null;
        spots?: Spot[];
        routeInfo?: RouteInfo | null;
        context?: { after?: AfterContext } 
      } 
    }
  | { 
      query: string; 
      userState?: { 
        destination?: OriginInfo; 
        origin?: OriginInfo;
        originInputMode?: "free" | "current_location" | undefined;
        routePlanId?: string | null;
        spots?: Spot[];
        routeInfo?: RouteInfo | null;
        context?: { after?: AfterContext } 
      } 
    };

// デフォルトの destination 値
const DEFAULT_DESTINATION: OriginInfo = {
  type: null,
  pref: null,
  lat: null,
  lng: null,
  name: null,
};

function getAfterDestinationAskPreface(stopIntent: StopIntent | null): string {
  if (!stopIntent) {
    return "観光スポットに立ち寄るプランをお作りしますね！";
  }
  switch (stopIntent.type) {
    case "lunch":
      return "お帰りの途中でお食事（ランチ）ですね！";
    case "cafe":
      return "お帰りの途中でカフェに立ち寄りたいですね！";
    case "rest":
      return "お帰りの途中で少し休憩できる場所を探しましょう！";
    case "onsen":
      return "お帰りの途中で温泉に立ち寄りたいですね！";
    case "shop":
      return "お帰りの途中でお土産・お買い物ですね！";
    default:
      return "お帰りの途中で立ち寄り先をご提案しますね！";
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as AfterRequestBody;

    // 1️⃣ ユーザーメッセージを取得
    let userMessages: ChatCompletionMessageParam[];
    let userMessage: string;

    if ("messages" in body && Array.isArray(body.messages)) {
      // フロントの履歴を採用
      userMessages = body.messages;
      const lastUserMessage = userMessages.filter((m) => m.role === "user").pop();
      userMessage =
        typeof lastUserMessage?.content === "string" ? lastUserMessage.content : "";
    } else if ("query" in body && typeof body.query === "string") {
      // 単発問い合わせモード（MVP向け）
      userMessage = body.query;
      userMessages = [{ role: "user", content: body.query }];
    } else {
      return NextResponse.json(
        { error: "messages または query が必要です。" },
        { status: 400 }
      );
    }

    // 2️⃣ ユーザー状態（destination）を取得
    const userState = body.userState || {};
    let currentDestination: OriginInfo = userState.destination || DEFAULT_DESTINATION;

    // 「順番を逆に」コマンドの検出（LLM呼び出し前にショートサーキット）
    const normalizedUserMessage = userMessage.trim().toLowerCase();
    const isReverseCommand =
      normalizedUserMessage === "順番を逆に" ||
      normalizedUserMessage === "順番を逆" ||
      normalizedUserMessage.includes("順番を逆に");

    if (isReverseCommand) {
      console.log("[koyo-after] 🔄 REVERSE COMMAND detected - Short-circuiting LLM call");
      
      // 逆順用の元データ取得（優先順位: userState > context.after）
      const sourceRouteInfo = userState.routeInfo || userState.context?.after?.routeInfo;
      // 重要: routePlan.spotsを優先（Places API由来のスポットも含む）
      // userStateにroutePlanが含まれている場合は、そのspotsを使用
      const sourceRoutePlan = (body as any).routePlan;
      const sourceSpots = sourceRoutePlan?.spots || userState.spots || userState.context?.after?.spots;
      const sourceRoutePlanId = userState.routePlanId || sourceRoutePlan?.planId;
      const sourceOptionalSpots = userState.context?.after?.optionalSpots;
      
      console.log("[koyo-after] Reverse command - Source data:", {
        hasUserStateRouteInfo: !!userState.routeInfo,
        hasUserStateSpots: !!userState.spots,
        hasContextAfterRouteInfo: !!userState.context?.after?.routeInfo,
        hasContextAfterSpots: !!userState.context?.after?.spots,
        hasRoutePlan: !!sourceRoutePlan,
        sourceSpotsCount: sourceSpots?.length || 0,
        sourceRouteInfoWaypointsCount: sourceRouteInfo?.waypoints?.length || 0,
        sourceRoutePlanSpotsCount: sourceRoutePlan?.spots?.length || 0,
      });

      // ガード: routeInfoまたはspotsが無い場合はNOOP返信
      if (!sourceRouteInfo || !sourceSpots || sourceSpots.length === 0) {
        console.log("[koyo-after] Reverse command - NOOP: No routeInfo or spots");
        return NextResponse.json({
          phase: "after:phase2_2_done",
          reply: "順番を逆にするルートがまだありません。先に経由地を追加してください。",
          routePlan: userState.context?.after ? undefined : null,
          routeInfo: sourceRouteInfo || null,
          spots: sourceSpots || [],
          optionalSpots: sourceOptionalSpots,
        });
      }

      // ガード: spotsが1件以下の場合はNOOP返信
      if (sourceSpots.length <= 1) {
        console.log("[koyo-after] Reverse command - NOOP: spots.length <= 1");
        return NextResponse.json({
          phase: "after:phase2_2_done",
          reply: "経由地が1件以下のため、順番は変更されませんでした。",
          routePlan: userState.context?.after ? undefined : null,
          routeInfo: sourceRouteInfo,
          spots: sourceSpots,
          optionalSpots: sourceOptionalSpots,
        });
      }

      // 逆順処理（routeInfo.waypointsを基準にspotsを再構築）
      // 重要: routeInfo.waypointsとspotsの整合性を保つため、waypointsからspotIdを使ってspotsを再構築
      const reversedWaypoints = [...(sourceRouteInfo.waypoints || [])].reverse();
      
      // waypointsからspotIdを使ってspotsを再構築（Places API由来のスポットも含める）
      const waypointSpotMap = new Map<string, Spot>();
      // まずsourceSpotsからマップを作成
      (sourceSpots as Spot[]).forEach((spot: Spot) => {
        waypointSpotMap.set(spot.id, spot);
      });
      
      // reversedWaypointsの順序でspotsを再構築
      const reversedSpots: Spot[] = [];
      for (const waypoint of reversedWaypoints) {
        if (waypoint.spotId) {
          const spot = waypointSpotMap.get(waypoint.spotId);
          if (spot) {
            reversedSpots.push(spot);
          } else {
            // waypointsにspotIdがあるがspotsに存在しない場合（Places API由来など）
            // waypointの座標から最小限のSpotオブジェクトを作成
            console.warn("[koyo-after] Reverse command - spot not found in sourceSpots, creating from waypoint:", waypoint.spotId);
            reversedSpots.push({
              id: waypoint.spotId,
              name: `スポット${reversedSpots.length + 1}`,
              lat: waypoint.lat,
              lng: waypoint.lng,
              category: null,
              city: null,
              season: null,
              drive_time: null,
              walk_time: null,
              stay_time: null,
              url: null,
              tags: null,
              drive_minutes: null,
            } as Spot);
          }
        }
      }
      
      // ガード: reversedSpotsの件数がwaypointsと一致しない場合は警告
      if (reversedSpots.length !== reversedWaypoints.length) {
        console.warn("[koyo-after] Reverse command - spots count mismatch:", {
          reversedSpotsCount: reversedSpots.length,
          reversedWaypointsCount: reversedWaypoints.length,
          sourceSpotsCount: sourceSpots.length,
          sourceWaypointsCount: sourceRouteInfo.waypoints?.length || 0,
        });
      }

      // routeInfoを更新
      const reversedRouteInfo = {
        ...sourceRouteInfo,
        waypoints: reversedWaypoints,
      };

      // routePlanを更新（planId維持）
      let reversedRoutePlan = null;
      if (sourceRoutePlanId) {
        // 既存のroutePlanを更新（planId維持）
        reversedRoutePlan = {
          planId: sourceRoutePlanId,
          mode: "AFTER" as const,
          origin: sourceRouteInfo.origin,
          destination: sourceRouteInfo.destination,
          spots: reversedSpots.map((s) => ({
            id: s.id,
            name: s.name,
            lat: s.lat,
            lng: s.lng,
            category: s.category,
            city: s.city,
            season: s.season,
            drive_time: s.drive_time,
            walk_time: s.walk_time,
            stay_time: s.stay_time,
            url: s.url,
            tags: s.tags,
            drive_minutes: s.drive_minutes,
            stayMinutes: s.stayMinutes || (s.stay_time ? parseInt(s.stay_time.match(/\d+/)?.[0] || "0") : null),
            source: (s as any).source || "db",
          })),
          constraints: {},
          bCallCount: 0,
        };
      }

      const reversedSpotList = reversedSpots
        .map((s, idx) => `(${idx + 1}) ${s.name}`)
        .join("、");

      console.log("[koyo-after] Reverse command - Success:", {
        originalSpotsCount: sourceSpots.length,
        reversedSpotsCount: reversedSpots.length,
        originalWaypointsCount: sourceRouteInfo.waypoints?.length || 0,
        reversedWaypointsCount: reversedWaypoints.length,
        routePlanId: sourceRoutePlanId,
      });

      return NextResponse.json({
        phase: "after:phase2_2_done",
        reply: `了解です。順番を逆にして、${reversedSpotList}の順でルートを更新しました。`,
        routePlan: reversedRoutePlan,
        routeInfo: reversedRouteInfo,
        spots: reversedSpots,
        optionalSpots: sourceOptionalSpots, // optionalSpotsはそのまま返す
      });
    }

    // 分岐トレースログ：入力情報
    const normalizedMessage = userMessage.trim().toUpperCase();
    console.log("[koyo-after] 🔍 BRANCH TRACE - Input:", {
      userMessageRaw: userMessage,
      userMessageNormalized: normalizedMessage,
      currentDestination,
      destinationType: currentDestination?.type,
      destinationPref: currentDestination?.pref,
    });

    let hasDestination =
      currentDestination &&
      currentDestination.type !== null &&
      // pref-boundary の場合は lat/lng が null でも OK
      (currentDestination.type === "pref-boundary" ||
        (currentDestination.lat !== null && currentDestination.lng !== null));

    // Phase1.75: モード相違検出
    const modeMismatch = detectModeMismatch(userMessage, "after");
    if (modeMismatch.detected) {
      console.log("[koyo-after] ⚠️ MODE MISMATCH detected:", modeMismatch.reason);
      return NextResponse.json({
        reply: "その内容は、今お話ししている流れと少し異なりそうですね。どのタイミングのお話か、確認してもよろしいでしょうか？（チェックイン前／滞在中／チェックアウト後 など）",
        destination: DEFAULT_DESTINATION,
        debug: { branch: "after:mode_mismatch", mode_mismatch: true, reason: modeMismatch.reason },
      });
    }

    // Phase2-2: 候補選択処理（context.after が存在する場合）
    const afterContext = userState.context?.after;
    
    // 候補選択処理（optionalSpots が存在する場合）
    if (afterContext?.optionalSpots && Array.isArray(afterContext.optionalSpots) && afterContext.optionalSpots.length > 0) {
      console.log("[koyo-after] Phase2-2: Processing selection from optionalSpots:", afterContext.optionalSpots.length);
      
      const optionalSpots = afterContext.optionalSpots;
      const selections = extractSelections(userMessage);
      
      console.log("[koyo-after] Phase2-2: Extracted selections:", selections, "from message:", userMessage);
      
      // 「0（寄らない）」の処理を最初にチェック
      if (selections.length === 1 && selections[0] === 0) {
        // 「0（寄らない）」が選択された場合
        // 直行ルートのrouteInfoを生成（Phase2-1と同じ形式）
        if (afterContext.routeInfoKey === "direct" && afterContext.origin && afterContext.destination) {
          // 直行ルートのrouteInfoを生成（Phase2-1と同じ形式）
          // 注意: Directions APIはフロント側で呼ばれるため、API側は{ origin, waypoints, destination }のみ返す
          // フロント側がDirections APIを呼んで完全形（distance/duration/legs/polyline等）を生成する
          const directRouteInfo: RouteInfo = {
            origin: afterContext.origin,
            waypoints: [], // 空配列（直行ルート）
            destination: afterContext.destination,
          };
          
          console.log("[koyo-after] Phase2-2: Processing '0' selection (no waypoints)");
          
          return NextResponse.json({
            reply: `了解です。直行ルートのまま進めます。何かご不明な点がございましたら、お気軽にお尋ねください。`,
            phase: "after:phase2_2_done",
            spots: [], // 経由地なし
            optionalSpots: optionalSpots, // 候補は残す
            routeInfo: directRouteInfo, // Phase2-1と同じ形式（フロント側がDirections APIで完全形を生成）
            destination: hasDestination ? currentDestination : undefined,
            debug: { branch: "after:phase2_2_done_no_waypoints", phase: "after:phase2_2_done" },
          });
        } else {
          // routeInfoKeyまたは座標がない場合はエラー（通常は発生しない）
          console.warn("[koyo-after] Phase2-2: routeInfoKey or coordinates not found in afterContext", {
            routeInfoKey: afterContext.routeInfoKey,
            hasOrigin: !!afterContext.origin,
            hasDestination: !!afterContext.destination,
          });
          return NextResponse.json({
            reply: "システムエラーが発生しました。もう一度お試しください。",
            destination: hasDestination ? currentDestination : undefined,
            optionalSpots: optionalSpots,
            debug: { branch: "after:phase2_2_error_no_routeinfo" },
          });
        }
      }
      
      if (selections.length === 0) {
        // 選択が0件なら「1〜Nの番号で選んでください」返信
        const numberedList = optionalSpots
          .map((s, idx) => {
            const category = s.category || "観光スポット";
            return `(${idx + 1}) ${s.name}（${category}）`;
          })
          .join("\n");
        
        return NextResponse.json({
          reply: `候補から選んでください。以下の番号でお知らせください。

${numberedList}

この中から、経由地として組み込みたい番号を送ってください。
例：1 / 2 / 1と2
※「寄らない」場合は 0 と送ってください。`,
          destination: hasDestination ? currentDestination : undefined,
          optionalSpots: optionalSpots,
          debug: { branch: "after:phase2_2_waiting_selection", phase: "after:phase2_2_waiting_selection" },
        });
      }
      
      // 選択されたSpotを取得（1-index）
      const selectedSpots = selections
        .map(i => optionalSpots[i - 1])
        .filter(Boolean)
        .filter((spot): spot is Spot => spot !== undefined && spot.lat !== null && spot.lng !== null);
      
      console.log("[koyo-after] Phase2-2: Selected spots:", selectedSpots.map(s => s.name));
      
      if (selectedSpots.length === 0) {
        // 有効な選択が0件の場合
        const numberedList = optionalSpots
          .map((s, idx) => {
            const category = s.category || "観光スポット";
            return `(${idx + 1}) ${s.name}（${category}）`;
          })
          .join("\n");
        
        return NextResponse.json({
          reply: `選択された番号に対応する候補が見つかりませんでした。以下の番号で選んでください。

${numberedList}

この中から、経由地として組み込みたい番号を送ってください。
例：1 / 2 / 1と2
※「寄らない」場合は 0 と送ってください。`,
          destination: hasDestination ? currentDestination : undefined,
          optionalSpots: optionalSpots,
          debug: { branch: "after:phase2_2_waiting_selection", phase: "after:phase2_2_waiting_selection" },
        });
      }
      
      // routeInfo.waypoints を生成（唯一の経路）
      const waypoints = selectedSpots.map(s => ({
        lat: s.lat!,
        lng: s.lng!,
        spotId: s.id,
      }));
      
      // routeInfo を構築（origin/destination は既存の値を使用）
      let routeOrigin: { lat: number; lng: number } = { ...KOYO_COORDINATES };
      let routeDestination: { lat: number; lng: number } = { ...KOYO_COORDINATES };
      
      // destination の座標を取得
      if (hasDestination && currentDestination) {
        if (currentDestination.type === "pref-boundary" && currentDestination.pref) {
          // pref-boundary の場合は境界座標を取得
          const prefBoundary = getPrefBoundary(currentDestination.pref);
          if (prefBoundary) {
            routeDestination = prefBoundary;
          }
        } else if (currentDestination.lat && currentDestination.lng) {
          routeDestination = {
            lat: currentDestination.lat,
            lng: currentDestination.lng,
          };
        }
      }
      
      // destination が未確定の場合はエラー
      if (!hasDestination) {
        return NextResponse.json({
          reply: "目的地が確定していないため、経由地を選択できません。まず目的地を確定してください。",
          destination: DEFAULT_DESTINATION,
          optionalSpots: optionalSpots,
          debug: { branch: "after:phase2_2_error_no_destination" },
        });
      }
      
      // レスポンスを構築
      // 選択されたスポットを番号付きで表示（選択された順序で）
      const selectedSpotList = selectedSpots
        .map((s, idx) => {
          // optionalSpotsから元のインデックスを取得
          const originalIndex = optionalSpots.findIndex(opt => opt.id === s.id);
          const displayNumber = originalIndex !== -1 ? originalIndex + 1 : idx + 1;
          return `(${displayNumber}) ${s.name}`;
        })
        .join("、");
      
      const routeInfo: RouteInfo = {
        origin: routeOrigin,
        waypoints: waypoints,
        destination: routeDestination,
      };

      const response: any = {
        reply: `了解です。${selectedSpotList}を経由地として組み込み、ルートを更新しました。

この順番で問題なければこのまま進めます。入れ替えたい場合は「順番を逆に」などと送ってください。`,
        phase: "after:phase2_2_done",
        spots: selectedSpots, // 確定経由地のみ
        optionalSpots: optionalSpots, // 候補は残す
        routeInfo,
        destination: hasDestination ? currentDestination : undefined,
        debug: { branch: "after:phase2_2_done", phase: "after:phase2_2_done" },
      };
      
      // routePlan を構築（setRoutePlan用）
      if (hasDestination && currentDestination) {
        const planId = `plan_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        response.routePlan = {
          planId,
          mode: "AFTER",
          origin: routeOrigin,
          destination: routeDestination,
          spots: selectedSpots,
          constraints: {},
          bCallCount: 0,
        };
      }
      
      console.log("[koyo-after] Phase2-2: Response constructed:", {
        selectedSpotsCount: selectedSpots.length,
        waypointsCount: waypoints.length,
        optionalSpotsCount: optionalSpots.length,
      });
      
      return NextResponse.json(response);
    }

    // Phase2-1: stopIntent検出（先に検出）
    // まず「今回の発話」を最優先し、無ければ履歴から「直近のstopIntent」を拾う
    const currentStopIntent = detectStopIntent(userMessage);
    const latestIntentMessage = findLatestStopIntentMessage(userMessages);
    const stopIntentMessage = currentStopIntent ? userMessage : (latestIntentMessage || userMessage);
    const historyStopIntent = latestIntentMessage ? detectStopIntent(latestIntentMessage) : null;
    let stopIntent = currentStopIntent ?? historyStopIntent;
    
    // stopIntentResolvedFrom の判定
    let stopIntentResolvedFrom: "current" | "history" | "default_sightseeing";
    if (currentStopIntent) {
      stopIntentResolvedFrom = "current";
    } else if (historyStopIntent) {
      stopIntentResolvedFrom = "history";
    } else {
      stopIntentResolvedFrom = "default_sightseeing";
    }
    
    // stopIntent が null の場合、sightseeing デフォルトにフォールバック
    if (!stopIntent) {
      console.warn("[koyo-after] stopIntent復元失敗: sightseeingデフォルトにフォールバック", {
        rawUserMessage: userMessage,
        latestIntentMessage: latestIntentMessage || null,
      });
      stopIntent = {
        type: "sightseeing",
        subType: null,
        fallbackKeyword: "観光",
        keyword: "観光",
      };
      stopIntentResolvedFrom = "default_sightseeing";
    }
    
    // stopIntent 復元過程のログ出力
    console.log("[koyo-after] stopIntent resolved:", {
      rawUserMessage: userMessage,
      latestIntentMessage: latestIntentMessage || null,
      stopIntentMessage: stopIntentMessage,
      stopIntentType: stopIntent.type,
      subType: stopIntent.subType || null,
      stopIntent復元成功: !!stopIntent,
      stopIntentResolvedFrom,
    });
    
    // 分岐トレースログ：判定結果
    console.log("[koyo-after] 🔍 BRANCH TRACE - Conditions:", {
      hasDestination,
      stopIntent: { type: stopIntent.type, foodCategory: stopIntent.foodCategory, subType: stopIntent.subType },
      stopIntentResolvedFrom,
    });
    
    // Phase2-1: Afterは常に「候補→LLM選択」フローを走らせる（stopIntent は必ず存在する）
    let reply: string = "";

    // --------------------------------------------------
    // A. すでに destination が決まっている場合
    //    → プラン生成モードとみなす
    // --------------------------------------------------
    if (hasDestination) {
      // destination が既に決まっている場合は、そのままプラン生成に進む
      console.log("[koyo-after] ✅ BRANCH: A_plan_generation (hasDestination=true)");
      console.log("[koyo-after] Destination already set, proceeding with plan generation", {
        currentDestination,
        type: currentDestination?.type,
        pref: currentDestination?.pref,
      });
    } else {
      /*
      TEMP DISABLED (structure recovery)
      - parseAfterDestination
      - prefSelectionMap
      - detailed branching
      TODO: Restore after Phase 1.5 completion
      */
      console.log("[koyo-after] ✅ BRANCH: B_destination_select (hasDestination=false)");
      // --------------------------------------------------
      // B. destination が未設定の場合：選択を促す
      // --------------------------------------------------
      
      // Phase2 Step3: F（その他）選択時の処理（最優先）
      const isOtherSelected = 
        userMessage.toUpperCase().includes("F") ||
        userMessage.includes("その他") ||
        userMessage.includes("そのた");
      
      if (isOtherSelected) {
        console.log("[koyo-after] Phase2 Step3 - F selected → asking pref boundary");
        return NextResponse.json({
          mode: "after-destination-select",
          reply: `
どちら方面へお帰りになりますか？

① 宮城
② 福島
③ 秋田
④ 新潟

例：「①」「宮城」「仙台方面」など簡単でOKです！
`.trim(),
          destination: DEFAULT_DESTINATION,
          debug: { branch: "after:B4_other_selected" },
        });
      }
      
      // Phase2 Step1: parseAfterDestination の動作確認
      const userMessageNormalized = normalizeUserSelection(userMessage);
      console.log("[koyo-after] Phase2 Step1 - parseAfterDestination input:", {
        userMessageRaw: userMessage,
        userMessageNormalized,
      });
      
      const afterParsedDestination = parseAfterDestination(userMessage);
      console.log("[koyo-after] Phase2 Step1 - parseAfterDestination result:", {
        result: afterParsedDestination,
        hasDestinationBefore: hasDestination,
        currentDestinationBefore: currentDestination,
      });
      
      if (afterParsedDestination) {
        console.log("[koyo-after] Phase2 Step1 - Setting destination from parseAfterDestination");
        currentDestination = afterParsedDestination;
        hasDestination = true;
        console.log("[koyo-after] Phase2 Step1 - After setting:", {
          hasDestinationAfter: hasDestination,
          currentDestinationAfter: currentDestination,
        });
      } // ← if (afterParsedDestination)
      else {
        console.log("[koyo-after] Phase2 Step1 - parseAfterDestination returned null, keeping hasDestination=false");
      }
      
      // ================================
      // Phase2 Step2: Destination confirmed → proceed
      // ================================
      if (hasDestination && currentDestination) {
        console.log("[koyo-after] Phase2 Step2 - Destination confirmed:", currentDestination);
        // NOTE:
        // - Do NOT return here
        // - Skip destination selection phase
        // - Let downstream logic continue normally
      }
      
      // 【After専用】柔軟なdestination解析を先に実行（記号数字・全角数字・文字入力に対応）
      /*
      const afterParsedDestination = parseAfterDestination(userMessage);
      if (afterParsedDestination) {
        console.log("[koyo-after] ✅ BRANCH: B0_after_destination_parsed (柔軟解析成功)");
        console.log("[koyo-after] Parsed destination from flexible input:", afterParsedDestination);
        currentDestination = afterParsedDestination;
        hasDestination = true;
        console.log("[koyo-after] Destination set via parseAfterDestination, proceeding with plan generation");
      } else {
        // 【フォールバック】既存の prefSelectionMap 処理（削除しない）
        // まず「①」「②」「③」「④」の県境選択をチェック（優先）
        const prefSelectionMap: Record<string, PrefectureKey> = {
          "①": "miyagi",
          "1": "miyagi",
          "②": "fukushima",
          "2": "fukushima",
          "③": "akita",
          "3": "akita",
          "④": "niigata",
          "4": "niigata",
        };

        let selectedPref: PrefectureKey | undefined;
        for (const [key, pref] of Object.entries(prefSelectionMap)) {
          if (userMessage.includes(key)) {
            selectedPref = pref;
            break;
          }
        }

        // 県境が選択された場合（数字記号で選択）
        if (selectedPref) {
          console.log("[koyo-after] ✅ BRANCH: B1_pref_boundary_selected (県境選択)");
          console.log("[koyo-after] Selected pref-boundary destination (from number):", selectedPref);
          currentDestination = {
            type: "pref-boundary",
            pref: selectedPref,
            lat: null,
            lng: null,
            name: null,
          } as OriginInfo;
          hasDestination = true;
          console.log("[koyo-after] Pref-boundary destination set, proceeding with plan generation");
      } else {
        // 県境が選択されていない場合、県名から県境を推定
        const resolution = resolveOriginFromFreeInput(userMessage);
        if (resolution.type === "resolved") {
          // 県名から県境が特定できた場合
          console.log("[koyo-after] ✅ BRANCH: B2_pref_boundary_resolved (県名から県境特定)");
          console.log("[koyo-after] Resolved pref-boundary from free input:", resolution.prefecture);
          currentDestination = {
            type: "pref-boundary",
            pref: resolution.prefecture,
            lat: null,
            lng: null,
            name: null,
          } as OriginInfo;
          hasDestination = true;
          console.log("[koyo-after] Pref-boundary destination set, proceeding with plan generation");
        } else {
          // 県名が特定できない場合、「A〜F」の選択を解析
          // ユーザー選択入力を正規化してからパース
          const userMessageNormalized = normalizeUserSelection(userMessage);
          const originSelection = parseOriginSelection(userMessageNormalized);
          
          // 「F」または「その他」が選択された場合
          const isOtherSelected = 
            userMessage.toUpperCase().includes("F") ||
            userMessage.includes("その他") ||
            userMessage.includes("そのた");

          if (originSelection && originSelection !== null && !("useCurrentLocation" in originSelection)) {
            // A〜E が選択された場合：固定地点を destination に設定
            console.log("[koyo-after] ✅ BRANCH: B3_fixed_destination_selected (A〜E選択)");
            console.log("[koyo-after] Selected fixed destination:", originSelection);
            currentDestination = {
              type: "fixed",
              pref: null,
              lat: originSelection.lat,
              lng: originSelection.lng,
              name: originSelection.name,
            } as OriginInfo;
            hasDestination = true;
            console.log("[koyo-after] Fixed destination set, proceeding with plan generation");
          } else if (isOtherSelected) {
            // F（その他）が選択された場合：県境選択を促す
            // NOTE: 復旧時は「観光スポットに立ち寄るプランをお作りしますね！」の前置きを削除すること
            // 理由：初回（992行目）で既に説明済みのため、2回目以降は質問のみの方が自然
            console.log("[koyo-after] ✅ BRANCH: B4_other_selected (F選択、県境選択を促す)");
            return NextResponse.json({
              mode: "after-destination-select",
              reply: `
どちら方面へお帰りになりますか？

① 宮城
② 福島
③ 秋田
④ 新潟

例：「①」「宮城」「仙台方面」など簡単でOKです！
`.trim(),
              destination: DEFAULT_DESTINATION,
              debug: { branch: "after:B4_other_selected" },
            });
          } else {
            // A〜F が選択されていない場合：最初の選択肢を提示
            // NOTE: この分岐は初回質問なので、「観光スポットに立ち寄るプランをお作りしますね！」を含める
            console.log("[koyo-after] ✅ BRANCH: B5_destination_ask (destination質問)");
            return NextResponse.json({
              mode: "after-destination-select",
              reply: `
${getAfterDestinationAskPreface(stopIntent)}
まず、どちら方面へお帰りになりますか？

A. 山形駅
B. 山形空港
C. かみのやま温泉駅
D. 山形蔵王IC（高速）
E. かみのやま温泉IC（高速）
F. その他

例：「A」「山形駅」「F」など簡単でOKです！
`.trim(),
              destination: DEFAULT_DESTINATION,
              debug: { branch: "after:B5_destination_ask" },
            });
          }
        }
      }
      }
      */
      
      // Temporary simplified return (structure recovery)
      // Phase2 Step2: hasDestination === true の場合は再質問しない
      if (!hasDestination) {
        console.log("[koyo-after] Phase2 Step2 - Destination not set, asking user");
        return NextResponse.json({
          mode: "after-destination-select",
          reply: `
${getAfterDestinationAskPreface(stopIntent)}
まず、どちら方面へお帰りになりますか？

A. 山形駅
B. 山形空港
C. かみのやま温泉駅
D. 山形蔵王IC（高速）
E. かみのやま温泉IC（高速）
F. その他

例：「A」「山形駅」「F」など簡単でOKです！
`.trim(),
        destination: DEFAULT_DESTINATION,
        debug: { branch: "after:B_destination_select_simplified" },
      });
      } // ← if (!hasDestination)
    } // ← else (destination select)

    // destination が設定された場合、再度 hasDestination をチェック
    if (!hasDestination && currentDestination && currentDestination.type !== null) {
      hasDestination = 
        currentDestination.type === "pref-boundary" ||
        (currentDestination.lat !== null && currentDestination.lng !== null);
      if (hasDestination) {
        console.log("[koyo-after] Destination was set during processing, updating hasDestination:", {
          currentDestination,
          hasDestination,
        });
      }
    }

    // Phase2-1: DB候補→LLM選択方式（stopIntent は必ず存在する）
    let matchedSpots: Spot[] = [];
    let dbCandidates: Spot[] = [];
    let dbCount = 0;
    let dbMatchCount = 0;
    let hasFoodKeyword = false;
    let foodKeyword: string | null = null;
    let llmReply = reply;
    let placesApiFailed = false;
    let placesAdded = false;
    let forceCallPlaces = false;
    let reason: string | null = null;
    let completion: any = undefined; // LLM呼び出し結果
    let aiDestination: OriginInfo | undefined; // LLM返答から抽出
    
    // stopIntent は必ず存在する（sightseeing デフォルトでフォールバック済み）
    {
      try {
        // 料理ジャンルキーワード検出（lunch用）
        const foodKeywordResult = detectFoodKeyword(stopIntentMessage);
        hasFoodKeyword = foodKeywordResult.hasFoodKeyword;
        foodKeyword = foodKeywordResult.foodKeyword;

        // Places検索キーワードへも反映（detectStopIntentのfoodCategoryKeywordsに無いジャンル対策）
        // 例: 「焼肉食べたい」→ stopIntent.foodCategory が空でも、foodKeyword="焼肉" を Places に渡す
        if (stopIntent.type === "lunch" && foodKeyword && !(stopIntent as any).foodCategory) {
          (stopIntent as any).keyword = foodKeyword;
        }
        
        console.log("[koyo-after] Phase2-1: stopIntent detected", {
          type: stopIntent.type,
          foodCategory: stopIntent.foodCategory,
          hasFoodKeyword,
          foodKeyword,
        });
        
        // DBから候補を検索
        const dbResult = await searchSpotsFromDB({
          stopIntent,
          origin: KOYO_COORDINATES,
          destination: hasDestination && currentDestination
            ? (currentDestination.type === "pref-boundary" && currentDestination.pref
                ? getPrefBoundary(currentDestination.pref as PrefectureKey)
                : (currentDestination.type === "fixed" || currentDestination.type === "current") && currentDestination.lat && currentDestination.lng
                ? { lat: currentDestination.lat, lng: currentDestination.lng }
                : KOYO_COORDINATES)
            : KOYO_COORDINATES,
          limit: 10,
          foodKeyword: foodKeyword || null,
        });
        
        dbCandidates = dbResult.spots;
        dbCount = dbResult.dbCount;
        dbMatchCount = dbResult.dbMatchCount;
        
        console.log("[koyo-after] Phase2-1: DB search completed", {
          stopIntentType: stopIntent.type,
          subType: stopIntent.subType || null,
          dbCount,
          dbMatchCount,
          candidatesCount: dbCandidates.length,
          willCallPlaces: dbCandidates.length < 3,
        });
        
        // 候補IDリストをLLMに渡す
        const candidateIds = dbCandidates.map(s => s.id);
        const systemPrompt = await getSystemPromptWithCandidates(stopIntent, candidateIds, dbCandidates);
        
        console.log("[koyo-after] Phase2-1: LLM call starting", {
          candidateIdsCount: candidateIds.length,
        });
        
        // LLM呼び出し（候補IDから選択）
        const openai = getOpenAIClient();
        completion = await openai.chat.completions.create({
          model: CHAT_MODEL,
          messages: [
            { role: "system", content: systemPrompt },
            ...userMessages,
          ],
          response_format: { type: "json_object" },
        });
        
        llmReply = completion.choices[0]?.message?.content ?? "";
        
        console.log("[koyo-after] Phase2-1: LLM reply received", {
          replyLength: llmReply.length,
          replyPreview: llmReply.substring(0, 500),
        });
        
        // LLMは候補IDから選択
        const selectedIds = extractSelectedSpotIds(llmReply, candidateIds);
        matchedSpots = dbCandidates.filter(s => selectedIds.includes(s.id));
        
        console.log("[koyo-after] Phase2-1: Selected spots", {
          selectedIdsCount: selectedIds.length,
          selectedIds: selectedIds,
          candidateIdsCount: candidateIds.length,
          candidateIdsPreview: candidateIds.slice(0, 3),
          matchedSpotsCount: matchedSpots.length,
        });
        
        // AIの返答から destination 情報を抽出（llmReply から）
        try {
          const cleanedLlmReply = llmReply.replace(/```json\s*/g, '').replace(/```\s*/g, '').replace(/```[\s\S]*?```/g, '');
          const jsonResponse = JSON.parse(cleanedLlmReply);
          if (jsonResponse.destination && jsonResponse.destination.type) {
            aiDestination = jsonResponse.destination as OriginInfo;
            console.log("[koyo-after] Extracted destination from LLM reply:", aiDestination);
          }
        } catch (e) {
          // JSON解析に失敗した場合は無視
        }
      } catch (phase2Error: any) {
        console.error("[koyo-after] Phase2-1 error:", phase2Error);
        console.error("[koyo-after] Phase2-1 error stack:", phase2Error?.stack);
        // Phase2-1でエラーが発生した場合、既存のreplyを使用して続行
        llmReply = reply;
        matchedSpots = [];
      }
      
      // lunch例外: forceCallPlacesの判定
      if (stopIntent.type === "lunch") {
        if (hasFoodKeyword && dbMatchCount === 0) {
          // 料理ジャンル明示あり + DBに該当なし → 強制Places呼び出し
          forceCallPlaces = true;
          reason = "lunch_keyword_no_db_match";
        } else if (matchedSpots.length < 3) {
          // 従来の閾値
          forceCallPlaces = false;
          reason = "lunch_db_insufficient";
        } else {
          forceCallPlaces = false;
          reason = "lunch_db_sufficient";
        }
      } else if (stopIntent.type === "onsen" || stopIntent.type === "shop") {
        // onsen/shop: dbCount < 3 のときPlaces呼ぶ
        if (matchedSpots.length < 3) {
          forceCallPlaces = false; // minRequiredCountで判定
          reason = stopIntent.type === "onsen" ? "onsen_db_empty" : "shop_db_empty";
        } else {
          forceCallPlaces = false;
          reason = `${stopIntent.type}_db_sufficient`;
        }
      } else {
        // rest/cafe: 基本Places呼ばない（0件など最低限のフォールバックのみ）
        if (matchedSpots.length < 3) {
          forceCallPlaces = false;
          reason = `${stopIntent.type}_db_insufficient`;
        } else {
          forceCallPlaces = false;
          reason = `${stopIntent.type}_db_sufficient`;
        }
      }
      
      // Places API呼び出し（forceCallPlacesまたはmatchedSpots.length < 3の場合）
      const willCallPlaces = forceCallPlaces || matchedSpots.length < 3;
      
      if (willCallPlaces) {
        // destination座標を取得
        let destinationCoords: { lat: number; lng: number } | undefined;
        
        if (hasDestination && currentDestination) {
          if (currentDestination.type === "pref-boundary" && currentDestination.pref) {
            destinationCoords = getPrefBoundary(currentDestination.pref as PrefectureKey);
          } else if ((currentDestination.type === "fixed" || currentDestination.type === "current") && currentDestination.lat && currentDestination.lng) {
            destinationCoords = {
              lat: currentDestination.lat,
              lng: currentDestination.lng,
            };
          }
        }
        
        if (!destinationCoords) {
          destinationCoords = KOYO_COORDINATES;
        }
        
        const result = await integratePlaces(
          matchedSpots,
          stopIntent,
          KOYO_COORDINATES,
          destinationCoords,
          {
            minRequiredCount: 3,
            forceCallPlaces,
            reason,
            allCandidates: dbCandidates, // DBから取得した全候補（重複チェック用）
          }
        );
        
        matchedSpots = result.spots;
        placesApiFailed = result.placesApiFailed;
        placesAdded = result.placesAdded;
      }
      
      // 統一ログ出力
      const stopIntentFallback = stopIntentResolvedFrom === "default_sightseeing";
      console.log("[koyo-after] Phase2-1 DB priority search result:", {
        stopIntentType: stopIntent.type,
        subType: stopIntent.subType || null,
        foodCategory: stopIntent.foodCategory || null,
        foodKeyword: foodKeyword || null,
        stopIntentResolvedFrom,
        stopIntentFallback,
        dbCount,
        dbMatchCount,
        minRequiredCount: 3,
        willCallPlaces: forceCallPlaces || matchedSpots.length < 3,
        forceCallPlaces,
        forcedPlacesCall: forceCallPlaces,
        placesCalled: forceCallPlaces || matchedSpots.length < 3,
        placesAdded,
        placesApiFailed,
        reason,
      });
    } // ← stopIntent ブロックの終了（stopIntent は必ず存在する）
    
    // plan配列を構築（LLMのreplyから抽出、またはselectedSpotIdsから生成）
    let finalPlan: any[] | undefined;
    
    // LLMのreplyからplan配列とreplyを抽出
    let planArray = await extractPlanFromReply(llmReply);
    let cleanReply = llmReply;
    
    // LLMのreplyからreplyフィールドを抽出（JSON形式の場合）
    try {
      const cleanedLlmReply = llmReply.replace(/```json\s*/g, '').replace(/```\s*/g, '');
      const jsonResponse = JSON.parse(cleanedLlmReply);
      if (jsonResponse.reply && typeof jsonResponse.reply === "string") {
        cleanReply = jsonResponse.reply;
      }
    } catch (e) {
      // JSON形式でない場合はそのまま使用
    }
    
    // replyからJSON部分を除去してクリーンなメッセージにする
    cleanReply = cleanReplyMessage(cleanReply);
    
    if (planArray && planArray.length > 0) {
      // plan配列が取得できた場合
      if (matchedSpots && matchedSpots.length > 0) {
        finalPlan = planArray.map((plan, index) => {
          if (index === 0) {
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
        finalPlan = undefined;
      }
    } else if (matchedSpots && matchedSpots.length > 0) {
      // plan配列が取得できなかった場合、selectedSpotIdsから生成
      finalPlan = [{
        title: "帰宅途中のおすすめ",
        spots: matchedSpots.map((spot) => ({
          name: spot.name,
          id: spot.id,
        })),
        description: "",
      }];
    }

    // placesAddedフラグに応じてユーザーメッセージを追記
    if (placesAdded && stopIntent) {
      if (stopIntent.type === "lunch" && forceCallPlaces) {
        // lunchでforceCallPlacesの場合
        cleanReply += "\n\n（ご指定の料理ジャンルに合う候補がDBに無かったため、周辺検索で候補を追加しました）";
      } else if (stopIntent.type === "onsen" || stopIntent.type === "shop") {
        // onsen/shopの場合
        cleanReply += "\n\n（DBに該当カテゴリが少ないため、周辺検索で候補を追加しました）";
      } else {
        // その他の場合（従来のメッセージ）
        cleanReply += " 帰路に無理なくご希望の場所を組み込みました。";
      }
    }

    // Places API検索が失敗した場合、reply内の断定表現を抽象表現に置き換える
    if (placesApiFailed && stopIntent) {
      cleanReply = sanitizeReplyForFailedPlaces(cleanReply, stopIntent);
    }

    // Phase2-1: reply文を「確定 → 候補」の2段構造にする
    // destination名を取得（currentDestination.name または aiDestination.name）
    let destinationName = "目的地";
    if (hasDestination && currentDestination && currentDestination.name) {
      destinationName = currentDestination.name;
    } else if (currentDestination && currentDestination.type === "pref-boundary" && currentDestination.pref) {
      // pref-boundary の場合、県名から生成
      const prefNameMap: Record<PrefectureKey, string> = {
        miyagi: "宮城",
        fukushima: "福島",
        akita: "秋田",
        niigata: "新潟",
      };
      const prefName = prefNameMap[currentDestination.pref];
      destinationName = prefName ? `${prefName}方面` : "目的地";
    } else if (aiDestination && aiDestination.name) {
      destinationName = aiDestination.name;
    } else if (aiDestination && aiDestination.type === "pref-boundary" && aiDestination.pref) {
      // pref-boundary の場合、県名から生成
      const prefNameMap: Record<PrefectureKey, string> = {
        miyagi: "宮城",
        fukushima: "福島",
        akita: "秋田",
        niigata: "新潟",
      };
      const prefName = prefNameMap[aiDestination.pref];
      destinationName = prefName ? `${prefName}方面` : "目的地";
    }

    // optionalSpots から最大3件を抽出（reply用）
    const optionalSpotsForReply = matchedSpots && matchedSpots.length > 0
      ? matchedSpots.slice(0, 3)
      : [];

    // Phase2-1: reply冒頭に「確定ルート」「候補」の説明を追加（${cleanReply}は削除、短い補足のみ）
    if (optionalSpotsForReply.length > 0) {
      // 番号付きリストを生成
      const numberedList = optionalSpotsForReply
        .map((s: any, idx: number) => {
          const category = s.category || "観光スポット";
          return `(${idx + 1}) ${s.name}（${category}）`;
        })
        .join("\n");
      
      const candidateCount = optionalSpotsForReply.length;
      const candidateText = candidateCount === 1 
        ? "次の1つです："
        : `次の${candidateCount}つです：`;
      
      cleanReply = `まず、古窯から${destinationName}への【確定】直行ルートを作りました。
途中で立ち寄れそうな候補は${candidateText}
${numberedList}

この中から、経由地として組み込みたい番号を送ってください。
例：1 / 2 / 1と2
※「寄らない」場合は 0 と送ってください。

（補足）気になる点があれば、目的地の変更もできます。`;
    } else {
      cleanReply = `まず、古窯から${destinationName}への【確定】直行ルートを作りました。

（補足）気になる点があれば、目的地の変更もできます。`;
    }

    // レスポンスを構築
    const response: any = {
      reply: cleanReply,
    };
    
    // usageはLLM呼び出しがあった場合のみ追加
    if (stopIntent && typeof completion !== 'undefined' && completion?.usage) {
      response.usage = completion.usage;
    }

    // planがある場合のみ追加
    if (finalPlan && finalPlan.length > 0) {
      response.plan = finalPlan;
    }

    // Phase2-1: data.spots は optionalSpots（候補）のみに固定
    // confirmedSpots（古窯/目的地）は routeInfo.origin/destination で持つため、spots には含めない
    if (matchedSpots && matchedSpots.length > 0) {
      response.spots = matchedSpots; // optionalSpots のみ
    }

    // Phase2-1: optionalSpots を追加（matchedSpots をそのまま、spotRole: "optional" を付与）
    if (matchedSpots && matchedSpots.length > 0) {
      // 検証ログ3: optionalSpotsを返す直前で、各スポットのname/tags/categoryを3件分ログ出し
      const sampleSpots = matchedSpots.slice(0, 3).map((s: any) => ({
        id: s.id,
        name: s.name,
        tags: s.tags,
        category: s.category,
        source: s.id?.startsWith("places_") ? "places" : "db",
      }));
      console.log("[after] optionalSpots sample (first 3):", sampleSpots);
      
      response.optionalSpots = matchedSpots.map((spot: any) => ({
        ...spot,
        spotRole: "optional" as const,
      }));
    }

    // routeInfo を構築（Afterモード：originは古窯固定、destinationは県境または古窯）
    // destination の決定ロジック
    let routeDestination: { lat: number; lng: number } = KOYO_COORDINATES;
    let finalDestination: OriginInfo = DEFAULT_DESTINATION;

    // デバッグ: destination決定前の状態を確認
    console.log("[koyo-after] Before routeInfo construction:", {
      hasDestination,
      currentDestination,
      currentDestinationType: currentDestination?.type,
      currentDestinationPref: currentDestination?.pref,
      aiDestination,
      aiDestinationType: aiDestination?.type,
    });

    // 優先順位: 1. currentDestination (userState or newly set) > 2. aiDestination (AI返答) > 3. 古窯固定
    if (hasDestination && currentDestination && currentDestination.type === "pref-boundary" && currentDestination.pref) {
      // userState に pref-boundary が設定されている場合
      const prefBoundary = getPrefBoundary(currentDestination.pref as PrefectureKey);
      routeDestination = prefBoundary;
      finalDestination = currentDestination;
      console.log("[koyo-after] Using pref-boundary destination from userState:", routeDestination);
    } else if (aiDestination && aiDestination.type === "pref-boundary" && aiDestination.pref) {
      // AIの返答に pref-boundary が含まれている場合
      const prefBoundary = getPrefBoundary(aiDestination.pref as PrefectureKey);
      routeDestination = prefBoundary;
      finalDestination = aiDestination;
      console.log("[koyo-after] Using pref-boundary destination from AI reply:", routeDestination);
    } else if (hasDestination && currentDestination && (currentDestination.type === "fixed" || currentDestination.type === "current") && currentDestination.lat && currentDestination.lng) {
      // userState に固定地点または現在地が設定されている場合
      routeDestination = {
        lat: currentDestination.lat,
        lng: currentDestination.lng,
      };
      finalDestination = currentDestination;
      console.log("[koyo-after] Using fixed/current destination from userState:", routeDestination);
    } else {
      console.log("[koyo-after] Using default Koyo destination");
    }

    // Phase2-1: waypoints を空配列に固定（matchedSpots は候補として扱い、ルートに含めない）
    // 既存の matchedSpots → waypoints 変換処理（1230-1264行目付近）は Phase2-1 では使用しない
    const routeInfo: RouteInfo = {
      origin: KOYO_COORDINATES,
      waypoints: [], // Phase2-1: optionalは含めない
      destination: routeDestination,
    };
    response.routeInfo = routeInfo;

    // destination を返す（フロントエンドで保持するため）
    // hasDestination が true の場合、currentDestination を返す
    console.log("[koyo-after] Final destination check:", {
      hasDestination,
      currentDestination,
      currentDestinationType: currentDestination?.type,
      finalDestination,
      finalDestinationType: finalDestination?.type,
    });
    
    if (hasDestination && currentDestination && currentDestination.type !== null) {
      response.destination = currentDestination;
      console.log("[koyo-after] Returning destination in response:", currentDestination);
    } else if (finalDestination && finalDestination.type !== null) {
      response.destination = finalDestination;
      console.log("[koyo-after] Returning finalDestination in response:", finalDestination);
    } else {
      console.log("[koyo-after] No destination to return");
    }

    // Phase2-1: confirmedSpots を追加（古窯 + destination）
    const confirmedSpots: any[] = [
      {
        id: "koyo",
        name: "日本の宿 古窯",
        lat: KOYO_COORDINATES.lat,
        lng: KOYO_COORDINATES.lng,
        source: "virtual",
        spotRole: "confirmed" as const,
      },
    ];

    // destination の名前を取得（finalDestination.name または currentDestination.name）
    let confirmedDestinationName = "目的地";
    if (hasDestination && currentDestination && currentDestination.name) {
      confirmedDestinationName = currentDestination.name;
    } else if (finalDestination && finalDestination.name) {
      confirmedDestinationName = finalDestination.name;
    } else if (finalDestination && finalDestination.type === "pref-boundary" && finalDestination.pref) {
      // pref-boundary の場合、県名から生成
      const prefNameMap: Record<PrefectureKey, string> = {
        miyagi: "宮城",
        fukushima: "福島",
        akita: "秋田",
        niigata: "新潟",
      };
      const prefName = prefNameMap[finalDestination.pref];
      confirmedDestinationName = prefName ? `${prefName}方面` : "目的地";
    }

    confirmedSpots.push({
      id: "destination",
      name: confirmedDestinationName,
      lat: routeDestination.lat,
      lng: routeDestination.lng,
      source: "virtual",
      spotRole: "confirmed" as const,
    });

    response.confirmedSpots = confirmedSpots;
    
    // デバッグログ：routeInfoの内容を確認
    console.log("[koyo-after] routeInfo constructed:", {
      origin: response.routeInfo?.origin,
      destination: response.routeInfo?.destination,
      waypointsCount: response.routeInfo?.waypoints?.length || 0,
      waypoints: response.routeInfo?.waypoints,
      confirmedSpotsCount: response.confirmedSpots?.length || 0,
      optionalSpotsCount: response.optionalSpots?.length || 0,
      hasRouteInfo: !!response.routeInfo,
    });

    // routeInfoが設定されていることを確認
    if (!response.routeInfo) {
      console.error("[koyo-after] ERROR: routeInfo is not set!");
      // フォールバック: 最低限のrouteInfoを設定
      const fallbackRouteInfo: RouteInfo = {
        origin: KOYO_COORDINATES,
        waypoints: [],
        destination: KOYO_COORDINATES,
      };
      response.routeInfo = fallbackRouteInfo;
    }

    response.debug = { branch: "after:A_plan_generation" };
    
    // 最終的なレスポンス内容をログ出力
    console.log("[koyo-after] Final response structure:", {
      hasReply: !!response.reply,
      hasRouteInfo: !!response.routeInfo,
      hasSpots: !!response.spots,
      hasOptionalSpots: !!response.optionalSpots,
      hasDestination: !!response.destination,
      hasPlan: !!response.plan,
    });
    
    return NextResponse.json(response);
  } catch (error: any) {
    console.error("[koyo-after] ❌ BRANCH: UNHANDLED_ERROR:", error);
    console.error("[koyo-after] error:", error);
    console.error("[koyo-after] error stack:", error?.stack);
    console.error("[koyo-after] error name:", error?.name);
    return NextResponse.json(
      {
        error: "チェックアウト後AIの応答生成中にエラーが発生しました。",
        detail: error?.message ?? String(error),
        debug: { branch: "after:UNHANDLED_ERROR", errorName: error?.name },
      },
      { status: 500 }
    );
  }
}
