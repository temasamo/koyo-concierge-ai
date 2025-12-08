/**
 * Pre-Checkin モードで使用する
 * 「他県 → 山形県への流入地点（県境座標）」
 * Directions API の origin として使う
 */

export interface EntryPoint {
  id: string;
  name: string;
  lat: number;
  lng: number;
  note: string;
}

export type PrefectureKey = "miyagi" | "fukushima" | "akita" | "niigata";

export const PREF_ENTRY_POINTS: Record<PrefectureKey, EntryPoint[]> = {
  miyagi: [
    {
      id: "miyagi_1",
      name: "宮城 → 山形（関山峠）",
      lat: 38.17672,
      lng: 140.83952,
      note: "最も一般的な宮城→山形の流入ルート。国道48号（関山峠）。",
    },
    {
      id: "miyagi_2",
      name: "宮城 → 山形（笹谷峠・高速）",
      lat: 38.28219,
      lng: 140.54354,
      note: "東北自動車道 → 山形自動車道（笹谷）。高速利用者向け。",
    },
  ],

  fukushima: [
    {
      id: "fukushima_1",
      name: "福島 → 山形（米沢北IC 側）",
      lat: 37.91580,
      lng: 140.15944,
      note: "東北中央道→米沢北IC。山形県南部からの流入で最も現実的。",
    },
    {
      id: "fukushima_2",
      name: "福島 → 山形（西吾妻スカイバレー）",
      lat: 37.75690,
      lng: 140.08530,
      note: "季節営業。夏季の観光ルートとして自然な流入点。",
    },
  ],

  akita: [
    {
      id: "akita_1",
      name: "秋田 → 山形（真室川・国道13号）",
      lat: 38.91260,
      lng: 140.34150,
      note: "もっとも一般的な秋田→山形ルート。国道13号沿い。",
    },
    {
      id: "akita_2",
      name: "秋田 → 山形（鳥海ブルーライン入口）",
      lat: 39.00814,
      lng: 139.98507,
      note: "庄内方面へ向かう観光ルート。季節限定だが需要大。",
    },
  ],

  niigata: [
    {
      id: "niigata_1",
      name: "新潟 → 山形（関川）",
      lat: 38.05880,
      lng: 139.54170,
      note: "新潟→鶴岡・酒田方面の最重要流入地点。",
    },
    {
      id: "niigata_2",
      name: "新潟 → 山形（坂町）",
      lat: 38.07340,
      lng: 139.56291,
      note: "日本海東北道を降りて山形県に向かう位置として現実的。",
    },
  ],
} as const;

/**
 * 県名からデフォルトの流入地点を取得する
 * @param prefecture 県名（"miyagi" | "fukushima" | "akita" | "niigata"）
 * @returns デフォルトの流入地点（配列の最初の要素）
 */
export function getDefaultEntryPoint(prefecture: PrefectureKey): EntryPoint {
  const entryPoints = PREF_ENTRY_POINTS[prefecture];
  if (!entryPoints || entryPoints.length === 0) {
    throw new Error(`No entry points found for prefecture: ${prefecture}`);
  }
  return entryPoints[0];
}

/**
 * 県名から全ての流入地点を取得する
 * @param prefecture 県名
 * @returns 流入地点の配列
 */
export function getEntryPoints(prefecture: PrefectureKey): EntryPoint[] {
  return PREF_ENTRY_POINTS[prefecture] || [];
}

