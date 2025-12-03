// app/api/koyo/before/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/index.mjs";
import { createClient } from "@supabase/supabase-js";

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
 * 若女将（48歳）＋ 観光AIプランナー
 */
async function getSystemPrompt(): Promise<string> {
  const spotListText = await getSpotListForPrompt();

  return `
あなたは「古窯 旅館コンシェルAI（旅前）」としてふるまいます。
ユーザーが古窯に旅行する前の計画を立てる際に、親切で丁寧に案内するAIです。

## あなたの人格（旅前AI／女将・若女将イメージ）
- 48歳前後の落ち着いた若女将。
- 丁寧で温かい接客の言葉遣い。
- 観光プランの調整が得意。
- 上山・蔵王の地理、季節、移動手段の知識に詳しい。

## 役割
- 旅行前の計画作成
- ヒアリング（旅行目的・同行者・日程・移動手段）
- スポット提案
- プラン案内 → JSON生成

--------------------------------------------------
【絶対ルール：スポット提案の制約】
- 返答に含めてよいスポットは **以下のSupabaseスポット一覧のみ** です。
- 一覧にないスポットは、名前が似ていても **一切使用不可**。
- スポット名は Supabase 登録名を正確に使用してください。
- AIの想像でスポットを作ってはいけません。

【観光スポット一覧（Supabaseから自動取得）】
${spotListText}

--------------------------------------------------
【行動範囲の制約（最重要）】
案内するスポットは、必ず  
「上山市」「山形市」「蔵王温泉」「天童市」「山辺町」  
など、古窯（上山温泉）から *車で30〜60分圏内* に限定してください。

山形県外のスポット（例：東京・大阪・京都・北海道など）は  
文章にもJSONにも絶対に含めないでください。

--------------------------------------------------
## **出力形式（厳守）**
あなたの回答は **必ず次の2部構成** とすること：

### **① プラン文章（ユーザー向け）**
- 旅館スタッフらしい丁寧な文章
- 季節や同行者に合わせた柔軟な提案
- 各スポットの簡単な特徴案内

### **② スポット一覧 JSON（API用・地図表示用）**
文章の後に必ず **[ ] のJSON配列のみ** を返すこと。
前後にコードブロック（\`\`\`）は禁止。

**JSON仕様（厳守）**
[
  {
    "id": "string（Supabaseのidをそのまま使用）",
    "name": "string（Supabaseのnameをそのまま使用）",
    "lat": number（Supabaseのlatをそのまま使用）,
    "lng": number（Supabaseのlngをそのまま使用）,
    "category": "自然" | "歴史" | "遊ぶ" | "食べる",
    "description": "string（短めでOK）",
    "address": "string または 空文字",
    "imageUrl": "string または 空文字",
    "rating": number,
    "stayMinutes": number
  }
]

【注意】
- JSONの前後に説明文を付けない
- JSONの中に追加フィールドを勝手に入れない
- lat, lng は Supabase の値をそのまま使用（推測や近似値は禁止）
- スポット数は 3〜6件にする（多すぎ禁止）
- 不確かなデータは入れず「空文字」「0」で返す
- 上記のSupabaseスポット一覧にないスポットは絶対に含めない

--------------------------------------------------
【禁止事項】
- 山形県外のスポットの生成（東京などは絶対NG）
- 実在しないスポットの生成
- Supabaseスポット一覧にないスポットの使用
- JSON内に文章を書く
- 嘘の営業時間や価格の断定

--------------------------------------------------
【口調】
- 丁寧で温かい接客の言葉遣い
- 観光プランの調整が得意な若女将として
- 硬すぎない、温かいトーン

--------------------------------------------------
以上のルールに従い、
「旅前AIとしての会話」＋「スポットJSON」を返してください。
`;
}

/**
 * AIの応答からJSON配列を抽出する関数（後方互換性のため保持）
 * 正規表現で [...] の部分を抽出し、パースして返す
 */
async function extractSpotsFromReply(reply: string): Promise<any[] | undefined> {
  try {
    let extractedSpots: any[] | undefined;

    // まず、JSON形式のレスポンスを試す（{ reply: "...", spots: [...] }形式）
    try {
      const jsonResponse = JSON.parse(reply);
      if (jsonResponse.spots && Array.isArray(jsonResponse.spots)) {
        extractedSpots = jsonResponse.spots;
      }
    } catch {
      // JSON形式でない場合は、テキストから抽出を試す
    }

    // JSON形式で取得できなかった場合、テキストから抽出
    if (!extractedSpots) {
      const jsonMatch = reply.match(/\[\s*\{[\s\S]*?\}\s*(,\s*\{[\s\S]*?\}\s*)*\]/g);
      if (jsonMatch) {
        const jsonString = jsonMatch[0];
        const spots = JSON.parse(jsonString);
        if (Array.isArray(spots)) {
          extractedSpots = spots;
        }
      }
    }

    if (!extractedSpots || extractedSpots.length === 0) {
      return undefined;
    }

    // AIが返したスポットをSupabase形式に変換
    // idまたはnameを使ってSupabaseから完全なデータを取得
    const supabase = getSupabaseClient();
    const { data: supabaseSpots } = await supabase
      .from("spot_master")
      .select("*");

    if (!supabaseSpots || supabaseSpots.length === 0) {
      console.warn("[koyo-before] No Supabase spots found, returning AI spots as-is");
      return extractedSpots;
    }

    // AIが返したスポットのidまたはnameでSupabaseスポットをマッチング
    const matchedSpots: any[] = [];
    const usedSpotIds = new Set<string>();

    for (const aiSpot of extractedSpots) {
      // idでマッチングを試す
      let matched = supabaseSpots.find(
        (s) => !usedSpotIds.has(s.id) && s.id === aiSpot.id
      );

      // idでマッチしない場合はnameでマッチング
      if (!matched && aiSpot.name) {
        matched = supabaseSpots.find(
          (s) => !usedSpotIds.has(s.id) && s.name.trim() === aiSpot.name.trim()
        );
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
        console.log(`[koyo-before] Matched spot: "${aiSpot.name}" -> Supabase ID: ${matched.id}`);
      } else {
        console.warn(`[koyo-before] No Supabase match found for: "${aiSpot.name || aiSpot.id}"`);
      }
    }

    return matchedSpots.length > 0 ? matchedSpots : undefined;
  } catch (error) {
    console.error("[koyo-before] JSON extraction error:", error);
    return undefined;
  }
}

/**
 * replyからJSON部分を除去してクリーンなメッセージを返す関数
 */
function cleanReplyMessage(reply: string): string {
  // まず、JSON形式のレスポンスを試す
  try {
    const jsonResponse = JSON.parse(reply);
    if (jsonResponse.reply && typeof jsonResponse.reply === "string") {
      return jsonResponse.reply;
    }
  } catch {
    // JSON形式でない場合は、テキストから抽出を試す
  }

  // JSON配列の部分を正規表現で削除（複数スポットに対応）
  const cleaned = reply.replace(/\[\s*\{[\s\S]*?\}\s*(,\s*\{[\s\S]*?\}\s*)*\]/g, "").trim();

  // 「--」や余計な区切り文字が残る場合も削除
  return cleaned.replace(/--/g, "").trim();
}

/**
 * リクエストボディの型
 * - messages: chat履歴（フロントが管理）
 * - query: 単発問い合わせ
 */
type BeforeRequestBody =
  | { messages: ChatCompletionMessageParam[] }
  | { query: string };

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as BeforeRequestBody;

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
    });

    const reply = completion.choices[0]?.message?.content ?? "";

    // JSON配列を抽出（JSON形式とテキスト形式の両方に対応）
    // AIが返したスポットをSupabase形式に変換
    const spots = await extractSpotsFromReply(reply);

    // replyからJSON部分を除去してクリーンなメッセージにする
    const cleanReply = cleanReplyMessage(reply);

    return NextResponse.json({
      reply: cleanReply,
      ...(spots && { spots }),
      usage: completion.usage,
    });
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
