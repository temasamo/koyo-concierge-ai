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
旅行前の計画段階で、お客様に最適な観光プランを丁寧にご案内する若女将AIとしてふるまいます。

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
 * リクエストボディの型
 * - messages: chat履歴（フロントが管理）
 * - query: 単発問い合わせ
 * - userState: ユーザーの状態（originなど）
 */
type BeforeRequestBody =
  | { messages: ChatCompletionMessageParam[]; userState?: { origin?: Origin } }
  | { query: string; userState?: { origin?: Origin } };

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as BeforeRequestBody;

    let userMessages: ChatCompletionMessageParam[];
    let userMessage: string;

    if ("messages" in body && Array.isArray(body.messages)) {
      // フロントの履歴を採用
      userMessages = body.messages;
      // 最後のユーザーメッセージを取得
      const lastUserMessage = userMessages
        .filter((m) => m.role === "user")
        .pop();
      userMessage = typeof lastUserMessage?.content === "string" 
        ? lastUserMessage.content 
        : "";
    } else if ("query" in body && typeof body.query === "string") {
      // 単発問い合わせモード（MVP向け）
      userMessage = body.query;
      userMessages = [
        {
          role: "user",
          content: body.query,
        },
      ];
    } else {
      return NextResponse.json(
        { error: "messages または query が必要です。" },
        { status: 400 }
      );
    }

    const userState = body.userState || {};

    // 1. Pre-Checkin Intent 判定
    const isPreCheckin = detectPreCheckinIntent(userMessage);

    if (isPreCheckin) {
      // origin 未設定 → 質問フェーズへ
      if (!userState.origin) {
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
`.trim()
        });
      }

      // origin がある → PreCheckin プラン生成モードへ
      try {
        const plan = await generatePrecheckinPlan({
          origin: userState.origin,
          userMessage: userMessage,
        });

        return NextResponse.json(plan);
      } catch (error: any) {
        console.error("[koyo-before] Pre-Checkin plan generation error:", error);
        return NextResponse.json(
          {
            error: "Pre-Checkinプランの生成中にエラーが発生しました。",
            detail: error?.message ?? String(error),
          },
          { status: 500 }
        );
      }
    }

    // 2. Origin選択回答の処理（Pre-Checkinモードでorigin未設定の場合の回答）
    const parsedOrigin = parseOriginSelection(userMessage);
    
    if (parsedOrigin && "useCurrentLocation" in parsedOrigin) {
      // 現在地指定の場合は、フロントエンドで処理する必要がある
      return NextResponse.json({
        mode: "precheckin-origin-select",
        reply: "現在地を使用する場合は、ブラウザの位置情報を許可してください。位置情報が取得できない場合は、A〜Eから選択してください。",
        requiresLocation: true,
      });
    } else if (parsedOrigin && "name" in parsedOrigin) {
      // originが選択された場合（A〜E）、Pre-Checkinプランを生成
      try {
        const plan = await generatePrecheckinPlan({
          origin: parsedOrigin,
          userMessage: userMessage,
        });

        return NextResponse.json(plan);
      } catch (error: any) {
        console.error("[koyo-before] Pre-Checkin plan generation error:", error);
        return NextResponse.json(
          {
            error: "Pre-Checkinプランの生成中にエラーが発生しました。",
            detail: error?.message ?? String(error),
          },
          { status: 500 }
        );
      }
    } else {
      // 3. 自由入力（G）の場合：県名を推定して県境座標を決定
      const resolution = resolveOriginFromFreeInput(userMessage);
      
      if (resolution.type === "resolved") {
        // 県名が特定できた場合、Pre-Checkinプランを生成
        try {
          const plan = await generatePrecheckinPlan({
            origin: resolution.origin,
            userMessage: userMessage,
          });

          return NextResponse.json(plan);
        } catch (error: any) {
          console.error("[koyo-before] Pre-Checkin plan generation error:", error);
          return NextResponse.json(
            {
              error: "Pre-Checkinプランの生成中にエラーが発生しました。",
              detail: error?.message ?? String(error),
            },
            { status: 500 }
          );
        }
      } else if (resolution.type === "ambiguous") {
        // 曖昧な入力の場合、質問を返す
        return NextResponse.json({
          mode: "precheckin-origin-select",
          reply: resolution.message,
          ambiguous: true,
          candidates: resolution.candidates,
        });
      } else {
        // 認識できない場合、質問を返す
        return NextResponse.json({
          mode: "precheckin-origin-select",
          reply: resolution.message,
        });
      }
    }

    // --- Pre-Checkin ではない（既存 Before の処理へ） ---

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

    // plan配列を抽出
    const planArray = await extractPlanFromReply(reply);

    // plan[0].spotsからスポットを抽出し、Supabaseとマッチング
    let matchedSpots: any[] | undefined;
    let finalPlan: any[] | undefined;

    if (planArray && planArray.length > 0) {
      matchedSpots = await extractAndMatchSpots(planArray);

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
    const cleanReply = cleanReplyMessage(reply);
    
    // デバッグログ
    console.log("[koyo-before] Cleaned reply:", cleanReply);
    console.log("[koyo-before] Cleaned reply contains spot names:", 
      matchedSpots && matchedSpots.length > 0 
        ? matchedSpots.some(spot => cleanReply.includes(spot.name))
        : false
    );

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

    return NextResponse.json(response);
  } catch (error: any) {
    console.error("[koyo-before] error:", error);
    return NextResponse.json(
      {
        error: "旅前AIの応答生成中にエラーが発生しました。",
        detail: error?.message ?? String(error),
      },
      { status: 500 }
    );
  }
}
