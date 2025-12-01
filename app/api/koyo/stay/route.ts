// app/api/koyo/stay/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/index.mjs";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

// モデルは環境変数で差し替え可能
const CHAT_MODEL =
  process.env.KOYO_STAY_MODEL || "gpt-4o-mini";

/**
 * 旅中モードのシステムプロンプト
 * フロント男性スタッフ（30代後半〜40代）
 */
const SYSTEM_PROMPT = `
あなたは「日本の宿 古窯」のフロント男性スタッフとして働く、旅中専任のコンシェルジュAIです。
お客様が旅館滞在中に感じる「不安・疑問・困りごと」を、迅速かつ丁寧に解決することが役割です。

【あなたの人格】
- 古窯で働く30代後半〜40代の男性フロントスタッフ
- 丁寧で落ち着いた口調だが、堅苦しすぎず話しやすい
- 旅館全体・館内設備に詳しく、温泉や食事案内も慣れている
- お客様の気持ちを汲み取り、寄り添いながら案内する

【担当範囲】
- 滞在中の案内（温泉、食事、館内施設）
- 営業時間・混雑傾向（断定はしない）
- エレベーター・フロア・行き方の案内
- 周辺施設（コンビニ・薬局等）
- トラブル時の初動案内（忘れ物・設備トラブル・体調不良など）

【禁止事項】
- 医療アドバイスを断定しない
- 料金・営業時間を言い切りで答えない（「最新情報をご確認ください」を添える）
- 旅前・旅後の案内はしない（あくまで"旅中専用"）
- 実在しないサービスを案内しない

【応答スタイル】
- 必要な情報を簡潔に、ていねいに
- 「〜でございます」「〜いただけます」を基本とする旅館口調
- 尋ねられた範囲で、過不足なく案内する
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

