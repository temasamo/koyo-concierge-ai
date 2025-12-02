// app/api/koyo/after/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/index.mjs";

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

/**
 * スポット情報の型定義
 */
export type Spot = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  category: "自然" | "歴史" | "遊ぶ" | "食べる";
  description: string;
  address: string;
  imageUrl: string;
  rating: number;
  stayMinutes: number;
};

/**
 * AIの応答からJSON配列を抽出する関数
 * 正規表現で [...] の部分を抽出し、パースして返す
 */
function extractSpotsFromReply(reply: string): Spot[] | undefined {
  try {
    // JSON配列を抽出（複数スポットに対応）
    const jsonMatch = reply.match(/\[\s*\{[\s\S]*?\}\s*(,\s*\{[\s\S]*?\}\s*)*\]/g);
    if (!jsonMatch) {
      return undefined;
    }

    // 最初にマッチしたJSON配列を使用
    const jsonString = jsonMatch[0];
    const spots = JSON.parse(jsonString) as Spot[];

    // 配列でない場合はundefined
    if (!Array.isArray(spots)) {
      return undefined;
    }

    // 型チェックと緯度経度の範囲検証（山形県の範囲内かチェック）
    const validSpots = spots.filter((spot) => {
      // 基本的な型チェック
      const basicCheck = (
        typeof spot.id === "string" &&
        typeof spot.name === "string" &&
        typeof spot.lat === "number" &&
        typeof spot.lng === "number" &&
        ["自然", "歴史", "遊ぶ", "食べる"].includes(spot.category) &&
        typeof spot.description === "string" &&
        typeof spot.address === "string" &&
        typeof spot.imageUrl === "string" &&
        typeof spot.rating === "number" &&
        typeof spot.stayMinutes === "number"
      );

      if (!basicCheck) return false;

      // 山形県の範囲内かチェック（緯度: 37.8～38.9, 経度: 139.5～140.5）
      const isInYamagataRange = (
        spot.lat >= 37.8 && spot.lat <= 38.9 &&
        spot.lng >= 139.5 && spot.lng <= 140.5
      );

      if (!isInYamagataRange) {
        console.warn(`[koyo-after] Spot "${spot.name}" has invalid coordinates: lat=${spot.lat}, lng=${spot.lng}`);
        return false;
      }

      return true;
    });

    return validSpots.length > 0 ? validSpots : undefined;
  } catch (error) {
    console.error("[koyo-after] JSON extraction error:", error);
    return undefined;
  }
}

/**
 * replyからJSON部分を除去してクリーンなメッセージを返す関数
 */
function cleanReplyMessage(reply: string): string {
  // JSON配列の部分を正規表現で削除（複数スポットに対応）
  const cleaned = reply.replace(/\[\s*\{[\s\S]*?\}\s*(,\s*\{[\s\S]*?\}\s*)*\]/g, "").trim();

  // 「--」や余計な区切り文字が残る場合も削除
  return cleaned.replace(/--/g, "").trim();
}

/**
 * 帰宅後モードのシステムプロンプト
 * 若女将（48歳）
 * JSONフォーマット出力対応版
 */
const SYSTEM_PROMPT = `
あなたは「古窯 旅コンシェルジュAI（旅後）」です。  
ご滞在を終え、これから帰宅されるお客様に向けて、  
丁寧で温かい接客を行うAIコンシェルジュとしてふるまってください。

【あなたの役割】
- チェックアウト後のお見送り対応
- 帰宅の経路に合わせた「立ち寄りスポット」提案
- 上山温泉・山形周辺のお土産スポットの案内
- 道中の安全情報（天候・道路）への配慮
- 帰り道に合った「無理のない」提案
- 帰宅後の余韻を楽しめる情報提供

※旅前・旅中とは異なり、旅後は「帰宅途中に寄れる場所」「負担のないスポット」を優先して案内してください。

--------------------------------------------------
【行動範囲の制約（最重要）】
案内するスポットは、必ず  
「上山市」「山形市」「蔵王温泉」「天童市」「山辺町」など  
古窯（上山温泉）から *車で30〜60分圏内* に限定してください。

山形県外（東京・仙台・北海道など）のスポットは  
文章にも JSON にも絶対に含めないでください。

--------------------------------------------------
【重要：スポット提案が必要な場合の出力形式】
文章パートの後に、以下の Spot[] を JSON 形式で必ず出力してください。

Spot = {
  id: string,
  name: string,
  lat: number,
  lng: number,
  category: "自然" | "歴史" | "遊ぶ" | "食べる",
  description: string,
  address: string,
  imageUrl: string,
  rating: number,
  stayMinutes: number
}

【注意】
- 文章 → JSON配列 の順で必ず出力
- JSONは実在する「山形エリア」限定
- JSON配列は必ず [ {...}, {...} ] の形式
- JSON内には説明以外の文章を書かない
- category は必ず4種類のいずれかを使う
- **lat, lng は必ず正確な値を使用すること（推測や近似値は禁止）**

【主要スポットの正確な緯度経度（参考）】
- 上山城: lat: 38.1269, lng: 140.2984
- 蔵王温泉: lat: 38.1625, lng: 140.5533
- 蔵王刈田峠: lat: 38.1811, lng: 140.5686
- 山形市（中心部）: lat: 38.2407, lng: 140.3633
- 天童市（中心部）: lat: 38.3592, lng: 140.3694

**重要**: 緯度経度は必ず実在する正確な座標を使用してください。不確かな場合は、そのスポットをJSONに含めないでください。

--------------------------------------------------
【禁止事項】
- 山形県外のスポットを出す（東京・京都など絶対NG）
- 実在しないスポットの生成
- JSON中で文章を書く
- 嘘の営業時間や価格を断定すること
- 無理な移動距離を提案すること

--------------------------------------------------
【口調】
- 丁寧で親しみやすい旅館スタッフのトーン
- 「お見送りの気持ち」を大切に、温かく自然な話し方
- 安全な帰路への配慮を必ず添える

--------------------------------------------------
【出力例】
「東京に帰る途中で寄れる場所ある？」  
→ 文章案内（山形エリアに限定）  
→ Spot[]（JSON）を出力

--------------------------------------------------

ご滞在の最後まで、お客様に寄り添った温かいサポートを提供してください。
`;

/**
 * リクエストボディの型
 - messages: chat履歴（フロントが管理）
 - query: 単発問い合わせ
 */
type AfterRequestBody =
  | { messages: ChatCompletionMessageParam[] }
  | { query: string };

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as AfterRequestBody;

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

    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...userMessages,
    ];

    const openai = getOpenAIClient();
    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages,
      temperature: 0.7,
    });

    const reply = completion.choices[0]?.message?.content ?? "";

    // JSON配列を抽出
    const spots = extractSpotsFromReply(reply);

    // replyからJSON部分を除去してクリーンなメッセージにする
    const cleanReply = cleanReplyMessage(reply);

    return NextResponse.json({
      reply: cleanReply,
      ...(spots && { spots }),
      usage: completion.usage,
    });
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

