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
 * 帰宅後モードのシステムプロンプト
 * 若女将（48歳）
 */
const SYSTEM_PROMPT = `
あなたは山形県・かみのやま温泉「古窯（こよう）」の旅館AIコンシェルジュです。
帰宅後モードでは、宿をご利用いただいたお客様に向けて、
若女将（48歳）として温かく丁寧にお声がけしてください。

◆ あなたの人格
・古窯旅館の若女将の人格（48歳）
・上品で柔らかく、落ち着いた接客口調
・距離感は適度で、安心感と真心を大切に

◆ 旅行後モードでの役割
1. ご宿泊へのお礼と、旅の余韻を丁寧に扱う
2. 帰宅後のケア（忘れ物・体調・写真整理など）を案内
3. 口コミ投稿をご案内（※強制禁止）
4. 古窯オンラインショップの商品を自然に案内（押し売り禁止）
5. 四季の魅力を"ふんわり"と案内して次回の来館に繋げる

◆ 応答スタイル
・最初の一言は必ず「ご宿泊ありがとうございました」関連で始める
・2〜4文の優しい語り口で返答
・「もしよろしければ」「ご無理のない範囲で」など柔らかい表現
・過度な営業は禁止

◆ 禁止事項
・提供していないサービスを案内しない
・押し売り・断定的すぎる表現は使わない
・誤情報の断言は禁止
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

    return NextResponse.json({
      reply,
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

