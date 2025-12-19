// app/api/koyo/after/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/index.mjs";
import { createClient } from "@supabase/supabase-js";
import { matchSpot } from "../_utils/matchSpot";
import { KOYO_COORDINATES, SPOT_COORDINATE_FIXES } from "@/constants/koyo";
import { detectLunchIntent, searchLunchPlaces, convertPlaceToSpot } from "../_utils/places";
import { resolveOriginFromFreeInput } from "../before/_utils/originResolver";
import { parseOriginSelection } from "@/lib/koyo/precheckin/origins";
import type { PrefectureKey } from "../before/_constants/prefEntryPoints";
import { getPrefBoundary } from "@/store/prefBoundaries";
import type { OriginInfo } from "@/store/spots";

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
 */
async function getSystemPrompt(): Promise<string> {
  const spotListText = await getSpotListForPrompt();

  return `
あなたは「日本の宿 古窯」の専属AIコンシェルジュです。
モード：After（帰宅後AI）
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
- 旅前（Before）: 計画作成・長時間移動も許容
- 旅中（Stay）  : 当日の天候・気分に合わせた柔軟案
- 旅後（After）: "帰り道寄れる・負担のない短時間スポット"が中心

【重要制限（厳守）】
- 山形県外のスポットは提案禁止
- Supabase に存在しないスポット名は絶対に出してはいけません
- 地名・市名（例：蔵王温泉、天童市、上山市など）をスポットとして出すのは禁止です
- 架空スポットの生成は厳禁
- スポット名は必ず Supabase の登録名を正確に使用すること
- 帰宅途中の「負担の少ないルート上のスポット」を優先すること

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
  - 例：plan[0].spots が [「上山城」「上杉神社」] の場合、replyは「まずは上山城で山形の歴史を感じ、その後、上杉神社へ向かいます。」のように、spotsの順番通りに記述すること
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
      console.warn("[koyo-after] No Supabase spots found");
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
          console.log(`[koyo-after] Applying coordinate fix for "${matched.name}" (${matched.id}): ${matched.lat},${matched.lng} -> ${finalLat},${finalLng}`);
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
          source: "db", // DBスポットであることを明示
        });
        usedSpotIds.add(matched.id);
        console.log(`[koyo-after] Matched spot: "${aiSpot.name || aiSpot.id}" -> "${matched.name}" (Supabase ID: ${matched.id})`);
      } else {
        console.warn(`[MATCH WARNING] No match found for: "${aiSpot.name || aiSpot.id}"`);
      }
    }

    return matchedSpots.length > 0 ? matchedSpots : undefined;
  } catch (error) {
    console.error("[koyo-after] Spot matching error:", error);
    return undefined;
  }
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
type AfterRequestBody =
  | { messages: ChatCompletionMessageParam[]; userState?: { destination?: OriginInfo } }
  | { query: string; userState?: { destination?: OriginInfo } };

// デフォルトの destination 値
const DEFAULT_DESTINATION: OriginInfo = {
  type: null,
  pref: null,
  lat: null,
  lng: null,
  name: null,
};

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

    console.log("[koyo-after] Received userState:", {
      userState,
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

    console.log("[koyo-after] Debug destination check:", {
      currentDestination,
      hasDestination,
      type: currentDestination?.type,
      pref: currentDestination?.pref,
    });

    // Supabaseからスポット一覧を取得してシステムプロンプトを生成
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

    // デバッグ: AIの応答をログ出力
    console.log("[koyo-after] AI reply (first 500 chars):", reply.substring(0, 500));

    // AIの返答から destination 情報を抽出
    let aiDestination: OriginInfo | undefined;
    try {
      const cleanedReply = reply.replace(/```json\s*/g, '').replace(/```\s*/g, '').replace(/```[\s\S]*?```/g, '');
      const jsonResponse = JSON.parse(cleanedReply);
      if (jsonResponse.destination && jsonResponse.destination.type) {
        aiDestination = jsonResponse.destination as OriginInfo;
        console.log("[koyo-after] Extracted destination from AI reply:", aiDestination);
      }
    } catch (e) {
      // JSON解析に失敗した場合は無視
    }

    // --------------------------------------------------
    // A. すでに destination が決まっている場合
    //    → プラン生成モードとみなす
    // --------------------------------------------------
    if (hasDestination) {
      // destination が既に決まっている場合は、そのままプラン生成に進む
      console.log("[koyo-after] Destination already set, proceeding with plan generation", {
        currentDestination,
        type: currentDestination?.type,
        pref: currentDestination?.pref,
      });
    } else {
      // --------------------------------------------------
      // B. destination が未設定の場合：選択を促す
      // --------------------------------------------------
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
          const originSelection = parseOriginSelection(userMessage);
          
          // 「F」または「その他」が選択された場合
          const isOtherSelected = 
            userMessage.toUpperCase().includes("F") ||
            userMessage.includes("その他") ||
            userMessage.includes("そのた");

          if (originSelection && originSelection !== null && !("useCurrentLocation" in originSelection)) {
            // A〜E が選択された場合：固定地点を destination に設定
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
            return NextResponse.json({
              mode: "after-destination-select",
              reply: `
お帰りの途中で観光スポットに立ち寄るプランをお作りしますね！
どちら方面へお帰りになりますか？

① 宮城
② 福島
③ 秋田
④ 新潟

例：「①」「宮城」「仙台方面」など簡単でOKです！
`.trim(),
              destination: DEFAULT_DESTINATION,
            });
          } else {
            // A〜F が選択されていない場合：最初の選択肢を提示
            return NextResponse.json({
              mode: "after-destination-select",
              reply: `
お帰りの途中で観光スポットに立ち寄るプランをお作りしますね！
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
            });
          }
        }
      }
    }

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

    // plan配列を抽出
    let planArray = await extractPlanFromReply(reply);
    console.log("[koyo-after] Extracted plan array:", planArray ? `Found ${planArray.length} plans` : "No plan found");

    // plan配列が取得できない場合、古い形式（配列形式）を試す
    if (!planArray) {
      console.log("[koyo-after] Trying to extract old format (array)...");
      try {
        // より安全な正規表現で配列を探す
        const jsonMatch = reply.match(/\[\s*\{[\s\S]*?\}\s*(,\s*\{[\s\S]*?\}\s*)*\]/);
        if (jsonMatch) {
          try {
            const jsonString = jsonMatch[0];
            const spots = JSON.parse(jsonString);
            if (Array.isArray(spots) && spots.length > 0) {
              // 古い形式を新しい形式に変換
              planArray = [{
                title: "帰宅途中のおすすめ",
                spots: spots,
                description: ""
              }];
              console.log("[koyo-after] Converted old format to new format");
            }
          } catch (parseError) {
            console.warn("[koyo-after] Failed to parse old format array:", parseError);
            // JSONパースに失敗した場合、スポット名だけを抽出してマッチングを試す
            // この場合は後続の処理でnameマッチングが行われる
          }
        }
      } catch (error) {
        console.warn("[koyo-after] Failed to extract old format:", error);
      }
    }

    // plan[0].spotsからスポットを抽出し、Supabaseとマッチング
    let matchedSpots: any[] | undefined;
    let finalPlan: any[] | undefined;
    let placesApiFailed = false;

    if (planArray && planArray.length > 0) {
      matchedSpots = await extractAndMatchSpots(planArray);

      // ランチ系発話を検出してPlaces APIを呼び出す（extractAndMatchSpots後、ルート確定前）
      if (matchedSpots && matchedSpots.length > 0) {
        const wantsLunch = detectLunchIntent(userMessage);

        if (wantsLunch) {
          // waypointsの中間地点を基準に検索
          const baseSpotIndex = Math.floor(matchedSpots.length / 2);
          const baseSpot = matchedSpots[baseSpotIndex];

          if (baseSpot.lat != null && baseSpot.lng != null) {
            const baseLocation = { lat: baseSpot.lat, lng: baseSpot.lng };
            console.log("[koyo-after] Lunch intent detected, searching places near:", baseLocation, "from spot index:", baseSpotIndex);

            const place = await searchLunchPlaces(baseLocation);

            if (place) {
              const lunchSpot = convertPlaceToSpot(place);
              // spots配列の中間に挿入
              const insertIndex = Math.floor(matchedSpots.length / 2);
              matchedSpots.splice(insertIndex, 0, lunchSpot);
              console.log("[koyo-after] Added lunch place at index:", insertIndex, "name:", place.name);
            } else {
              placesApiFailed = true;
              console.log("[koyo-after] No lunch place found from Google Places API");
            }
          } else {
            placesApiFailed = true;
            console.warn("[koyo-after] Base spot has no coordinates");
          }
        }
      }

      // plan配列を構築（plan[0].spotsをマッチング済みスポットに置き換え）
      if (matchedSpots && matchedSpots.length > 0) {
        finalPlan = planArray.map((plan, index) => {
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

    // replyからJSON部分を除去してクリーンなメッセージにする
    let cleanReply = cleanReplyMessage(reply);

    // Places API失敗時のメッセージを追加
    if (placesApiFailed && detectLunchIntent(userMessage)) {
      cleanReply += "\n\n申し訳ありません。周辺で条件に合うランチスポットが見つからなかったため、観光中心のプランをご提案しています。";
    }

    // レスポンスを構築
    const response: any = {
      reply: cleanReply,
      usage: completion.usage,
    };

    // planがある場合のみ追加
    if (finalPlan && finalPlan.length > 0) {
      response.plan = finalPlan;
    }

    // フロントエンド互換性のため、plan[0].spotsから抽出した完全なSupabase形式のスポットデータを返す
    if (matchedSpots && matchedSpots.length > 0) {
      response.spots = matchedSpots;
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

    const waypoints =
      matchedSpots && Array.isArray(matchedSpots)
        ? matchedSpots
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
                console.warn(`[koyo-after] Invalid coordinates for spot "${s.name}" (${s.id}): lat=${s.lat}, lng=${s.lng}`);
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
                console.log(`[koyo-after] Zawao Okama waypoint: lat=${lat}, lng=${lng}, type: lat=${typeof lat}, lng=${typeof lng}`);
              }
              
              return { lat, lng };
            })
        : [];

    response.routeInfo = {
      origin: KOYO_COORDINATES,
      waypoints,
      destination: routeDestination,
    };

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
    
    // デバッグログ：routeInfoの内容を確認
    console.log("[koyo-after] routeInfo constructed:", {
      origin: response.routeInfo.origin,
      destination: response.routeInfo.destination,
      waypointsCount: response.routeInfo.waypoints.length,
      waypoints: response.routeInfo.waypoints,
      containsZawaoOkama: matchedSpots?.some((s: any) => s.id === "b916a6f4-7225-42df-800a-a48f5f030da0"),
    });

    return NextResponse.json(response);
  } catch (error: any) {
    console.error("[koyo-after] error:", error);
    return NextResponse.json(
      {
        error: "帰宅後AIの応答生成中にエラーが発生しました。",
        detail: error?.message ?? String(error),
      },
      { status: 500 }
    );
  }
}
