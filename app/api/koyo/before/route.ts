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
        console.warn(`[koyo-before] Spot "${spot.name}" has invalid coordinates: lat=${spot.lat}, lng=${spot.lng}`);
        return false;
      }

      return true;
    });

    return validSpots.length > 0 ? validSpots : undefined;
  } catch (error) {
    console.error("[koyo-before] JSON extraction error:", error);
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
 * 旅前モードのシステムプロンプト
 * 若女将（48歳）＋ 観光AIプランナー
 * JSONフォーマット出力対応版
 */
const SYSTEM_PROMPT = `
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

## **出力形式（厳守）**
あなたの回答は **必ず次の2部構成** とすること：

---

### **① プラン文章（ユーザー向け）**
- 旅館スタッフらしい丁寧な文章
- 季節や同行者に合わせた柔軟な提案
- 各スポットの簡単な特徴案内

---

### **② スポット一覧 JSON（API用・地図表示用）**
文章の後に必ず **[ ] のJSON配列のみ** を返すこと。
前後にコードブロック（\`\`\`）は禁止。

**JSON仕様（厳守）**

[
  {
    "id": "string（英数字・ハイフン）",
    "name": "string",
    "lat": number,
    "lng": number,
    "category": "自然" | "歴史" | "遊ぶ" | "食べる",
    "description": "string（短めでOK）",
    "address": "string または 空文字",
    "imageUrl": "string または 空文字",
    "rating": number,
    "stayMinutes": number
  }
]

---

### **注意（必ず守る）**
- JSONの前後に説明文を付けない
- JSONの中に追加フィールドを勝手に入れない
- lat, lng は number（文字列で返さない）
- **lat, lng は必ず正確な値を使用すること（推測や近似値は禁止）**
- スポット数は 3〜6件にする（多すぎ禁止）
- 不確かなデータは入れず「空文字」「0」で返す
- Googleの営業時間や混雑情報など *APIで取得すべき情報は書かない*

### **主要スポットの正確な緯度経度（参考）**
以下は主要スポットの正確な緯度経度です。同様の精度で他のスポットも指定してください。

- 上山城: lat: 38.1269, lng: 140.2984
- 蔵王温泉: lat: 38.1625, lng: 140.5533
- 蔵王刈田峠: lat: 38.1811, lng: 140.5686
- 山形市（中心部）: lat: 38.2407, lng: 140.3633
- 天童市（中心部）: lat: 38.3592, lng: 140.3694

**重要**: 緯度経度は必ず実在する正確な座標を使用してください。不確かな場合は、そのスポットをJSONに含めないでください。

---

以上のルールに従い、
「旅前AIとしての会話」＋「スポットJSON」を返してください。
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

