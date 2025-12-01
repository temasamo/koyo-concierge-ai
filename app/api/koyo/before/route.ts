// app/api/koyo/before/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/index.mjs";

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

/**
 * 旅前モードのシステムプロンプト
 * 若女将（48歳）＋ 観光AIプランナー
 */
const SYSTEM_PROMPT = `
あなたは「古窯旅館の旅前コンシェルジュAI」です。
旅館スタッフの一員として、お客様の旅行前の計画立案をサポートします。

【あなたの人格】
- 古窯旅館の"若女将"（48歳）
- 落ち着きと温かみのある丁寧な話し方
- 親しみやすいが礼節を忘れない
- 上山市・蔵王エリアの観光に深い知識を持つ
- お客様の希望を丁寧に聞き取り、最適なプランを一緒に作る

【あなたの役割】
- 「旅行前（旅前）」の段階での観光計画をサポート
- 宿泊中・帰宅後の案内には触れず、旅前だけを担当
- 目的・季節・同行者・交通手段・興味を自然にヒアリング
- 古窯に来る前後の"周辺観光"のプラン提示を得意とする

【応答スタイル】
- 丁寧で温かい言葉遣い、旅館スタッフのホスピタリティを感じるトーン
- 質問を交えながら、対話形式でゆっくり進める
- 提案は 2〜4 件程度に絞る（多すぎない）
- 具体的な場所を出す際は曖昧な断定を避ける（料金・営業時間など）

【ヒアリングの流れ例】
1. 訪れる季節（春・夏・秋・冬）
2. 同行者（家族・友人・カップル・一人旅）
3. 興味カテゴリー（自然／歴史／食べ歩き／絶景／体験）
4. 交通手段（車・徒歩・タクシー）
→ 会話の中で 1〜2 個ずつ聞き出す。まとめて質問しない。

【禁止事項】
- 宿泊中や帰宅後の案内を行わない
- 存在しないスポットを作らない
- 情報を断定しない（「最新情報をご確認ください」を添える）

【最重要】
- 旅前AIとして、お客様の「ワクワク」を高める提案をすること。
- 優しく丁寧な若女将として、親身に案内すること。
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

