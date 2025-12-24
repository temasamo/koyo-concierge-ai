/**
 * After モード専用：destination 入力の正規化と解析
 * 
 * After（帰宅後）モードにおいて、目的地方向の選択入力を柔軟に解釈する。
 * 記号数字（①④）、半角数字（1,4）、全角数字（１，４）、文字入力（新潟 / 新潟方面 / にいがた / Niigata）
 * をすべて同一意図として解釈する。
 * 
 * Before / Stay には影響させず、After 専用の柔軟ロジック。
 */

import type { OriginInfo } from "@/store/spots";
import type { PrefectureKey } from "@/app/api/koyo/before/_constants/prefEntryPoints";

/**
 * destination 入力を正規化する（After専用）
 * @param input ユーザーの入力（例：「④」「4」「４」「新潟」「新潟方面」「にいがた」「Niigata」）
 * @returns 正規化された文字列
 */
export function normalizeDestinationInput(input: string): string {
  if (!input) return "";

  return input
    .trim()
    .toLowerCase()
    // 丸数字を通常数字へ
    .replace(/[①１]/g, "1")
    .replace(/[②２]/g, "2")
    .replace(/[③３]/g, "3")
    .replace(/[④４]/g, "4")
    // 全角数字 → 半角
    .replace(/[０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
    // よくある表記ゆれ
    .replace("方面", "")
    .replace("にいがた", "新潟")
    .replace("niigata", "新潟");
}

/**
 * After モード用固定地点（A〜E）のマッピング
 * 入力 → 固定地点情報のマッピング
 */
export const AFTER_FIXED_DESTINATION_MAP: Record<string, {
  type: "fixed";
  name: string;
  lat: number;
  lng: number;
}> = {
  // A: 山形駅
  "A": { type: "fixed", name: "山形駅", lat: 38.248662864893596, lng: 140.327528420525 },
  "a": { type: "fixed", name: "山形駅", lat: 38.248662864893596, lng: 140.327528420525 },
  "山形駅": { type: "fixed", name: "山形駅", lat: 38.248662864893596, lng: 140.327528420525 },
  
  // B: 山形空港
  "B": { type: "fixed", name: "山形空港", lat: 38.4125, lng: 140.3711 },
  "b": { type: "fixed", name: "山形空港", lat: 38.4125, lng: 140.3711 },
  "山形空港": { type: "fixed", name: "山形空港", lat: 38.4125, lng: 140.3711 },
  "空港": { type: "fixed", name: "山形空港", lat: 38.4125, lng: 140.3711 },
  
  // C: かみのやま温泉駅
  "C": { type: "fixed", name: "かみのやま温泉駅", lat: 38.15233921920549, lng: 140.27857922264496 },
  "c": { type: "fixed", name: "かみのやま温泉駅", lat: 38.15233921920549, lng: 140.27857922264496 },
  "かみのやま温泉駅": { type: "fixed", name: "かみのやま温泉駅", lat: 38.15233921920549, lng: 140.27857922264496 },
  
  // D: 山形蔵王IC
  "D": { type: "fixed", name: "山形蔵王IC", lat: 38.24564526672003, lng: 140.38118390915645 },
  "d": { type: "fixed", name: "山形蔵王IC", lat: 38.24564526672003, lng: 140.38118390915645 },
  "山形蔵王IC": { type: "fixed", name: "山形蔵王IC", lat: 38.24564526672003, lng: 140.38118390915645 },
  "蔵王IC": { type: "fixed", name: "山形蔵王IC", lat: 38.24564526672003, lng: 140.38118390915645 },
  
  // E: かみのやま温泉IC
  "E": { type: "fixed", name: "かみのやま温泉IC", lat: 38.12676684858146, lng: 140.2560067803147 },
  "e": { type: "fixed", name: "かみのやま温泉IC", lat: 38.12676684858146, lng: 140.2560067803147 },
  "かみのやま温泉IC": { type: "fixed", name: "かみのやま温泉IC", lat: 38.12676684858146, lng: 140.2560067803147 },
};

/**
 * After モード用県境（pref-boundary）のマッピング
 * 入力 → 英語キー（pref）のマッピング
 */
const AFTER_PREF_BOUNDARY_MAP: Record<string, PrefectureKey> = {
  "1": "miyagi",
  "①": "miyagi",
  "宮城": "miyagi",
  "仙台": "miyagi",

  "2": "fukushima",
  "②": "fukushima",
  "福島": "fukushima",

  "3": "akita",
  "③": "akita",
  "秋田": "akita",

  "4": "niigata",
  "④": "niigata",
  "新潟": "niigata",
};

/**
 * After モード用 destination 解析関数
 * 優先順位：固定地点（fixed） > 県境（pref-boundary） > null
 * @param input ユーザーの入力
 * @returns OriginInfo（type: "fixed" | "pref-boundary"）または null
 */
export function parseAfterDestination(input: string): OriginInfo | null {
  if (!input) return null;

  const trimmed = input.trim();
  
  // 1. 固定地点（A〜E / 日本語名）を最優先でチェック
  const fixedDestination = AFTER_FIXED_DESTINATION_MAP[trimmed];
  if (fixedDestination) {
    return {
      type: "fixed",
      pref: null,
      lat: fixedDestination.lat,
      lng: fixedDestination.lng,
      name: fixedDestination.name,
    };
  }

  // 2. 県境（pref-boundary）をチェック
  const normalized = normalizeDestinationInput(input);
  const prefKey = AFTER_PREF_BOUNDARY_MAP[normalized];

  if (!prefKey) {
    return null;
  }

  // 表示用の日本語名を生成
  const prefNameMap: Record<PrefectureKey, string> = {
    miyagi: "宮城",
    fukushima: "福島",
    akita: "秋田",
    niigata: "新潟",
  };
  const prefName = prefNameMap[prefKey];

  return {
    type: "pref-boundary",
    pref: prefKey,
    lat: null,
    lng: null,
    name: `${prefName}方面`,
  };
}

