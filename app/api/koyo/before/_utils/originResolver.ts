/**
 * Origin Resolver
 * 自由入力（G）の場合に県名を推定し、県境座標を決定する
 */

import type { Origin } from "@/lib/koyo/precheckin/origins";
import type { PrefectureKey, EntryPoint } from "../_constants/prefEntryPoints";
import { getDefaultEntryPoint } from "../_constants/prefEntryPoints";

/**
 * 県名推定結果
 */
export type OriginResolutionResult =
  | {
      type: "resolved";
      origin: Origin;
      prefecture: PrefectureKey;
      entryPoint: EntryPoint;
    }
  | {
      type: "ambiguous";
      message: string;
      candidates: PrefectureKey[];
    }
  | {
      type: "unknown";
      message: string;
    };

/**
 * 県名キーワードマッピング
 * ユーザーの入力から県名を推定するためのキーワード
 */
const PREFECTURE_KEYWORDS: Record<PrefectureKey, string[]> = {
  miyagi: [
    "宮城",
    "仙台",
    "miyagi",
    "せんだい",
    "sendai",
    "宮城県",
    "宮城から",
    "仙台から",
    "宮城経由",
    "仙台経由",
  ],
  fukushima: [
    "福島",
    "fukushima",
    "福島県",
    "福島から",
    "福島経由",
    "会津",
    "郡山",
    "いわき",
    "白河",
  ],
  akita: [
    "秋田",
    "akita",
    "秋田県",
    "秋田から",
    "秋田経由",
    "大館",
    "能代",
    "本荘",
  ],
  niigata: [
    "新潟",
    "niigata",
    "新潟県",
    "新潟から",
    "新潟経由",
    "長岡",
    "上越",
    "新発田",
    "村上",
  ],
};

/**
 * 曖昧な地域キーワード（複数の県に該当する可能性がある）
 */
const AMBIGUOUS_REGIONS: Record<string, PrefectureKey[]> = {
  関東: ["fukushima", "niigata"],
  東北: ["miyagi", "fukushima", "akita"],
  東日本: ["miyagi", "fukushima", "akita", "niigata"],
  首都圏: ["fukushima", "niigata"],
  東京: ["fukushima", "niigata"],
  埼玉: ["fukushima", "niigata"],
  千葉: ["fukushima", "niigata"],
  神奈川: ["fukushima", "niigata"],
  群馬: ["fukushima", "niigata"],
  栃木: ["fukushima", "niigata"],
  茨城: ["fukushima", "niigata"],
};

/**
 * ユーザーの自由入力を解析して県名を推定する
 * @param message ユーザーの入力（例：「仙台」「関東から」など）
 * @returns OriginResolutionResult
 */
export function resolveOriginFromFreeInput(message: string): OriginResolutionResult {
  if (!message || typeof message !== "string") {
    return {
      type: "unknown",
      message: "出発地を教えてください。",
    };
  }

  const normalizedMessage = message.trim().toLowerCase();

  // 1. 曖昧な地域キーワードをチェック
  for (const [region, candidates] of Object.entries(AMBIGUOUS_REGIONS)) {
    if (normalizedMessage.includes(region.toLowerCase())) {
      return {
        type: "ambiguous",
        message: `${region}からお越しの場合は、以下のどちら経由ですか？\n${candidates
          .map((pref, idx) => {
            const prefNames: Record<PrefectureKey, string> = {
              miyagi: "宮城",
              fukushima: "福島",
              akita: "秋田",
              niigata: "新潟",
            };
            return `${idx + 1}. ${prefNames[pref]}経由`;
          })
          .join("\n")}`,
        candidates,
      };
    }
  }

  // 2. 県名キーワードでマッチング
  const matchedPrefs: PrefectureKey[] = [];
  for (const [pref, keywords] of Object.entries(PREFECTURE_KEYWORDS)) {
    if (keywords.some((keyword) => normalizedMessage.includes(keyword.toLowerCase()))) {
      matchedPrefs.push(pref as PrefectureKey);
    }
  }

  // 3. マッチした県が1つの場合
  if (matchedPrefs.length === 1) {
    const prefecture = matchedPrefs[0];
    const entryPoint = getDefaultEntryPoint(prefecture);
    return {
      type: "resolved",
      origin: {
        name: entryPoint.name,
        lat: entryPoint.lat,
        lng: entryPoint.lng,
      },
      prefecture,
      entryPoint,
    };
  }

  // 4. マッチした県が複数の場合（曖昧）
  if (matchedPrefs.length > 1) {
    return {
      type: "ambiguous",
      message: `出発地が複数の県に該当する可能性があります。以下のどちら経由ですか？\n${matchedPrefs
        .map((pref, idx) => {
          const prefNames: Record<PrefectureKey, string> = {
            miyagi: "宮城",
            fukushima: "福島",
            akita: "秋田",
            niigata: "新潟",
          };
          return `${idx + 1}. ${prefNames[pref]}経由`;
        })
        .join("\n")}`,
      candidates: matchedPrefs,
    };
  }

  // 5. マッチしない場合
  return {
    type: "unknown",
    message: `出発地「${message}」を認識できませんでした。

以下のいずれかを選択してください：

【山形県内の出発地】
A. 山形駅
B. 山形空港
C. かみのやま温泉駅
D. 山形蔵王IC（高速）
E. かみのやま温泉IC（高速）
F. 現在地を使う

【他県からの出発地】
- 宮城（仙台）
- 福島
- 秋田
- 新潟

例：「A」「空港」「仙台」など簡単でOKです！`,
  };
}

/**
 * 県名から直接Originを取得する（候補が1つに絞られた場合）
 * @param prefecture 県名
 * @returns Origin
 */
export function getOriginFromPrefecture(prefecture: PrefectureKey): Origin {
  const entryPoint = getDefaultEntryPoint(prefecture);
  return {
    name: entryPoint.name,
    lat: entryPoint.lat,
    lng: entryPoint.lng,
  };
}

