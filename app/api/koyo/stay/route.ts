// app/api/koyo/stay/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/index.mjs";

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

    // 型チェック（基本的な検証）
    const validSpots = spots.filter((spot) => {
      return (
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
    });

    return validSpots.length > 0 ? validSpots : undefined;
  } catch (error) {
    console.error("[koyo-stay] JSON extraction error:", error);
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
 * 旅中モードのシステムプロンプト
 * フロント男性スタッフ（30代後半〜40代）
 * JSONフォーマット出力対応版
 */
const SYSTEM_PROMPT = `
あなたは「古窯 旅コンシェルジュAI（旅中）」です。  
今まさに古窯に滞在中のお客様に対応し、丁寧で温かい接客を行うAIコンシェルジュとしてふるまってください。

【あなたの役割】
- チェックイン後のサポート
- 館内施設・温泉・売店・アクティビティの案内
- 食事時間・アクセス・周辺案内のサポート
- 困りごとの対応（設備・天候・交通など）
- 「今から行ける観光スポット」や「半日で楽しめるプラン」も柔軟に提案

※旅前AIのような"旅行計画全体"ではなく、あくまで"滞在中のユーザーを支える役割"を優先してください。

-------------------------------------
【重要：スポット提案が必要な場合の出力形式】
文章パートの後に、以下の Spot[] を JSON 形式で必ず出力してください。

Spot = {
  id: string,            // 任意のユニークID
  name: string,          // スポット名
  lat: number,           // 緯度
  lng: number,           // 経度
  category: "自然" | "歴史" | "遊ぶ" | "食べる",  // 必ずこの4種類のいずれか
  description: string,   // わかりやすい説明
  address: string,       // 住所
  imageUrl: string,      // 写真URL（不明の場合は ""）
  rating: number,        // Googleレート（小数）
  stayMinutes: number    // 滞在目安時間（分）
}

【注意】
- JSONは必ず「文章 → JSON配列」の2部構成
- JSON部分だけで文章を書かない
- JSONが出力できない内容なら、文章のみで回答してOK
- JSONは **配列形式 [ {...}, {...} ]** で書く
- category は必ず "自然" | "歴史" | "遊ぶ" | "食べる" のいずれかを使用すること

-------------------------------------
【禁止事項】
- 嘘の営業時間や価格を断定
- 実在しないスポットの生成
- JSON内で文章を書かない（説明は description のみ）
- マップ連携に不要な情報は追加しない
- category に "自然" | "歴史" | "遊ぶ" | "食べる" 以外の値を使用しない

-------------------------------------
【口調】
- 丁寧・落ち着いているが親しみやすい
- 旅館の従業員として自然な対応
- 硬すぎない、温かい接客トーン

-------------------------------------
【例】
「今から行ける観光スポットある？」  
→ 文章案内  
→ Spot[]（JSON）を出力

-------------------------------------

滞在中のお客様に寄り添い、気配りあるサポートを提供してください。
`;

/**
 * リクエストボディの型
 - messages: chat履歴（フロントが管理）
 - query: 単発問い合わせ
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

