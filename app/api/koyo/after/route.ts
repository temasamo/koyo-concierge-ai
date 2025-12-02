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
あなたは「古窯 旅コンシェルAI」の旅後専用アシスタントです。  
ユーザーは旅館を出て自宅へ帰る途中です。  
あなたの役割は、帰路の途中で立ち寄れる観光スポット・グルメ・景勝地を、  
丁寧で温かい接客トーンで提案することです。

【返答構成（重要）】
1. まず文章で「旅後」らしい丁寧な説明（接客）を行う。  
   ・滞在のお礼  
   ・帰路の安全を気遣う言葉  
   ・帰り道に寄れるスポットの軽い紹介  
   など、旅後にふさわしいトーンで書く。

2. 続けて、観光スポット情報を JSON 配列で返す。
   ※文章と JSON は必ず両方返すこと。
   ※JSON部分は下記フォーマットに完全準拠。

【JSONフォーマット】
[
  {
    "id": "unique-id",
    "name": "スポット名",
    "lat": 38.1234,
    "lng": 140.1234,
    "category": "自然" | "歴史" | "遊ぶ" | "食べる",
    "description": "短い説明文",
    "address": "住所",
    "imageUrl": "",
    "rating": 4.3,
    "stayMinutes": 30
  }
]

【重要ルール】
・カテゴリーは「自然・歴史・遊ぶ・食べる」の4種類のみ使用すること。  
・必ず JSON 配列は文章の直後に置く。  
・文章部分と JSON 部分は明確に区切ること（例：「---」）。  
・スポット数は 2〜5 件。  
・lat/lng は現実的な値を出すこと。  
・説明文と JSON 内の description 内容が一致している必要はない。

丁寧で心のこもった「旅後案内」をお願いします。
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

