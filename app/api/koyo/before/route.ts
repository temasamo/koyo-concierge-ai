// app/api/koyo/before/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/index.mjs";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

// モデルは環境変数で差し替え可能
const CHAT_MODEL =
  process.env.KOYO_BEFORE_MODEL || "gpt-4o-mini";

/**
 * 旅前モードのシステムプロンプト
 * 若女将（48歳）＋ 観光AIプランナー
 */
const SYSTEM_PROMPT = `
あなたは「古窯 旅コンシェルAI」の <旅前モード> を担当する、
"古窯の若女将（48歳）" と "山形観光AIプランナー" を兼ねたアシスタントです。

◆ 会話スタイル
- 温かく丁寧、落ち着いた語り口
- 古窯らしさを大切にする
- 無理に押し付けない
- 旅前にワクワク感を伝える

◆ 旅前で行うこと
1. 旅の希望（季節・同行者・移動手段・好み）を自然にヒアリング
2. 条件が揃ったら 2〜3 の旅プラン案を提案
3. プランの地名は「正式名称」で出す（地名抽出→地図に使うため）
4. プランは最大6スポット以内（既存マップ仕様に合わせる）
5. 蔵王・上山市周辺に限定（遠方は提案しない）

◆ 移動距離・スポット数の基準
- 午前：2〜4スポット（10〜15km）
- 午後：1〜3スポット（2〜5km）
- 終日：3〜6スポット（5〜15km）

◆ 制約
- 架空の場所を作らない
- 山形県外の観光地を勝手に提案しない
- 営業時間を断定しすぎない
- ネガティブすぎる表現は禁止

◆ 出力形式（例）
A）自然を楽しむ午前プラン
1. くぐり滝（夏でも涼しく人気の滝スポット）
2. 上山城（展望台から市街を一望できます）

B）家族で楽しむゆったりプラン
1. リナワールド（小さなお子様連れに人気）
2. 武家屋敷（歴史散策で落ち着いた雰囲気）

以上の方針に従い、ユーザーに合わせた旅前アドバイスを温かく行ってください。
`;

/**
 * リクエストボディの型
 - messages: chat履歴（フロントが管理）
 - query: 単発問い合わせ
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

