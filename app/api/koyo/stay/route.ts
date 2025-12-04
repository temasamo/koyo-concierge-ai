// app/api/koyo/stay/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/index.mjs";
import { createClient } from "@supabase/supabase-js";
import { matchSpot } from "../_utils/matchSpot";

// モデルは環境変数で差し替え可能
const CHAT_MODEL =
  process.env.KOYO_STAY_MODEL || "gpt-4o-mini";

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
      console.error("[koyo-stay] Supabase error:", error);
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
    console.error("[koyo-stay] Error fetching spots:", error);
    return "【注意】スポット一覧の取得中にエラーが発生しました。";
  }
}

/**
 * 旅中モードのシステムプロンプトを生成（Supabaseスポット一覧を自動注入）
 * Stay System Prompt (ver.2)
 */
async function getSystemPrompt(): Promise<string> {
  const spotListText = await getSpotListForPrompt();

  return `
あなたは「古窯 旅館コンシェルAI（旅中）」としてふるまいます。
ユーザーが古窯にご宿泊中（チェックイン前〜チェックアウトまで）に、
今日の過ごし方・行動プランを最適化する役割のAIです。

【重要】あなたの返答は必ずJSON形式で返してください。テキストのみの返答は絶対に禁止です。

--------------------------------------------------
【あなたの人格（旅中AI）】
- 48歳前後の落ち着いた若女将。
- 丁寧で温かい接客の言葉遣い。
- 過度に堅苦しくない、親しみやすいコンシェルジュトーン。
- 上山・山形市・天童・蔵王など、地元の地理・季節・道路事情に詳しい。
- 滞在中の "困りごとを一緒に解決する姿勢" を大切にする。

--------------------------------------------------
【あなたの役割（Stay の定義）】
ユーザーが古窯に「ご宿泊している状態」で使う AI として、
今日 / 今から / この後 の行動を最適化します。

- 今日の予定の相談（例：午前中だけ、夕食まで、1日フリー など）
- 当日の天候に合わせた柔軟なプラン調整
- 「今から行ける場所」「半日でできること」の提案
- 館内設備（温泉・貸切風呂・売店・マッサージ）の案内
- 周辺観光（Supabaseのスポットのみ）との組み合わせ
- 混雑回避・安全配慮（雪道、夕方の道路凍結など）

※ Stay は「旅行当日の0:00 〜 チェックアウト後」までを担当します。

--------------------------------------------------
【行動範囲ルール（最重要）】
Stay では、案内する範囲を「ユーザーの今日の空き時間」に合わせて変えてください。

必ず時間をヒアリングし、下記のルールで案内範囲を決定すること。

■ 1〜2時間未満（短時間）
古窯から 30〜60分圏内の近場スポット。

■ 半日（3〜5時間程度）
60分圏内のスポット＋2〜3件のミニプラン。

■ 今日1日フリー / 2泊3日の2日目 など
山形県全域を案内対象としてよい。
（例：羽黒山、庄内方面、米沢方面、置賜方面）
※ ただし、Supabase に登録されているスポットのみ使用可能。

■ NG（Stay 全般）
- 山形県外（宮城・秋田・東京など）
- Supabase に存在しないスポット
- 架空スポットの生成

--------------------------------------------------
【安全配慮（必須）】
冬季（12〜3月）は必ず以下の配慮を加えること：
- 雪道・凍結の注意
- 日没時間（夕方4〜5時）の早さ
- 車での移動の負担への配慮
- 「無理のない範囲で」のニュアンスを添える

--------------------------------------------------
【利用できるスポット（Supabase データのみ）】
以下は Supabase から取得した「公式スポット一覧」です。
この一覧にあるスポット名のみ、プランに使用できます。
一覧にないスポットは、名前が似ていても **絶対に使用禁止**。

${spotListText}

--------------------------------------------------
【プラン出力仕様（最重要）】
**必ず以下のJSON形式で返してください。テキストのみの返答は禁止です。**

{
  "reply": "若女将として温かく丁寧な文章（今日の状況を踏まえてわかりやすく案内）",
  "plan": [
    {
      "title": "○時間プラン / 今日のおすすめ",
      "spots": [
        {
          "id": "SupabaseのID（必須）",
          "name": "Supabaseのname（必須）"
        }
      ],
      "description": "プランの説明"
    }
  ]
}

**必須条件：**
- 必ずJSON形式で返す（テキストのみは不可）
- reply と plan の両方を含める
- JSONの前後に説明文やコードブロック（\`\`\`）は付けない
- spots配列内の各スポットには **id と name のみ** を含める（lat/lngは不要）
- Supabase にないスポットは含めない
- スポット数は 3〜6 件程度
- plan配列は1件以上返すこと

--------------------------------------------------
【口調】
- 落ち着いた丁寧さ
- 近すぎず遠すぎない、旅館スタッフとして自然な距離感
- 優しく、安心感のあるトーン

--------------------------------------------------
【出力の必須条件】
1. まず、若女将としての丁寧な文章を返す
2. **必ず文章の後にJSON形式でplan配列を返す**
3. JSONは { "plan": [...] } の形式で返すこと
4. JSONの前後に説明文やコードブロックは付けない

以上のルールに従い、
「旅中AIとしての丁寧な案内」＋「今日の行動プランJSON」を返してください。
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
    cleanedReply = cleanedReply.replace(/```json\s*/g, '').replace(/```\s*/g, '');
    cleanedReply = cleanedReply.replace(/```[\s\S]*?```/g, '');

    // デバッグログ
    console.log("[koyo-stay] AI reply (first 500 chars):", cleanedReply.substring(0, 500));

    // まず、JSON形式のレスポンスを試す（全体がJSONの場合）
    try {
      const jsonResponse = JSON.parse(cleanedReply);
      if (jsonResponse.plan && Array.isArray(jsonResponse.plan)) {
        planArray = jsonResponse.plan;
        console.log("[koyo-stay] Found plan in full JSON response");
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
              console.log("[koyo-stay] Found plan in extracted JSON object");
            }
          } catch (parseError) {
            console.warn("[koyo-stay] Failed to parse extracted JSON:", parseError);
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
              console.log("[koyo-stay] Found plan in regex match");
            }
          } catch (parseError) {
            console.warn("[koyo-stay] Failed to parse regex matched JSON:", parseError);
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
              console.log("[koyo-stay] Found plan in outer match");
            }
          } catch (parseError) {
            console.warn("[koyo-stay] Failed to parse outer match JSON:", parseError);
          }
        }
      }
      
      if (!planArray) {
        console.warn("[koyo-stay] No plan JSON pattern found in reply");
        console.warn("[koyo-stay] Reply preview:", cleanedReply.substring(0, 500));
      }
    }

    if (!planArray || planArray.length === 0) {
      console.log("[koyo-stay] Extracted plan array: No plan found");
      return undefined;
    }
    
    console.log(`[koyo-stay] Extracted plan array: Found ${planArray.length} plans`);

    // plan[0].spotsが空または存在しない場合はundefinedを返す
    const firstPlan = planArray[0];
    if (!firstPlan || !firstPlan.spots || !Array.isArray(firstPlan.spots) || firstPlan.spots.length === 0) {
      return undefined;
    }

    return planArray;
  } catch (error) {
    console.error("[koyo-stay] Plan extraction error:", error);
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
      console.warn("[koyo-stay] No Supabase spots found");
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
        console.log(`[koyo-stay] Matched spot: "${aiSpot.name || aiSpot.id}" -> "${matched.name}" (Supabase ID: ${matched.id})`);
      } else {
        console.warn(`[MATCH WARNING] No match found for: "${aiSpot.name || aiSpot.id}"`);
      }
    }

    return matchedSpots.length > 0 ? matchedSpots : undefined;
  } catch (error) {
    console.error("[koyo-stay] Spot matching error:", error);
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
type StayRequestBody =
  | { messages: ChatCompletionMessageParam[] }
  | { query: string };

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as StayRequestBody;

    let userMessages: ChatCompletionMessageParam[];

    if ("messages" in body && Array.isArray(body.messages)) {
      // フロントの履歴を採用
      userMessages = body.messages;
    } else if ("query" in body && typeof body.query === "string") {
      // 単発問い合わせモード（MVP向け）
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
    console.log("[koyo-stay] AI reply (first 500 chars):", reply.substring(0, 500));

    // plan配列を抽出
    let planArray = await extractPlanFromReply(reply);
    console.log("[koyo-stay] Extracted plan array:", planArray ? `Found ${planArray.length} plans` : "No plan found");

    // plan配列が取得できない場合、古い形式（配列形式）を試す
    if (!planArray) {
      console.log("[koyo-stay] Trying to extract old format (array)...");
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
                title: "今日のおすすめ",
                spots: spots,
                description: ""
              }];
              console.log("[koyo-stay] Converted old format to new format");
            }
          } catch (parseError) {
            console.warn("[koyo-stay] Failed to parse old format array:", parseError);
            // JSONパースに失敗した場合、スポット名だけを抽出してマッチングを試す
            // この場合は後続の処理でnameマッチングが行われる
          }
        }
      } catch (error) {
        console.warn("[koyo-stay] Failed to extract old format:", error);
      }
    }

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
    console.error("[koyo-stay] error:", error);
    return NextResponse.json(
      {
        error: "旅中AIの応答生成中にエラーが発生しました。",
        detail: error?.message ?? String(error),
      },
      { status: 500 }
    );
  }
}
