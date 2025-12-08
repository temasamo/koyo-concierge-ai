/**
 * Pre-Checkin Origin Definitions
 * 出発地の定義と解析処理
 */

export interface Origin {
  name: string;
  lat: number;
  lng: number;
}

export const PRECHECKIN_ORIGINS: Record<string, Origin> = {
  A: { name: "山形駅", lat: 38.2404, lng: 140.3276 },
  B: { name: "山形空港", lat: 38.4125, lng: 140.3711 },
  C: { name: "かみのやま温泉駅", lat: 38.1527, lng: 140.2683 },
  D: { name: "山形蔵王IC", lat: 38.1977, lng: 140.3588 },
  E: { name: "かみのやま温泉IC", lat: 38.1613, lng: 140.2754 },
};

/**
 * ユーザーの回答から出発地を解析する
 * @param message ユーザーの回答（例：「A」「山形駅」「空港」など）
 * @returns Originオブジェクト、または現在地指定の場合は { useCurrentLocation: true }、見つからない場合は null
 */
export function parseOriginSelection(message: string): Origin | { useCurrentLocation: true } | null {
  if (!message || typeof message !== "string") {
    return null;
  }

  const m = message.trim().toUpperCase();

  // 1. ラベル（A, B, C, D, E）で直接指定された場合
  if (PRECHECKIN_ORIGINS[m]) {
    return PRECHECKIN_ORIGINS[m];
  }

  // 2. 名称で回答された場合
  const normalizedMessage = message.trim();
  for (const [key, origin] of Object.entries(PRECHECKIN_ORIGINS)) {
    if (normalizedMessage.includes(origin.name)) {
      return origin;
    }
  }

  // 3. 部分一致で検索（例：「空港」→「山形空港」）
  const partialMatches: Record<string, string> = {
    空港: "B",
    駅: "A", // デフォルトで山形駅（複数ある場合は最初に見つかったものを優先）
    かみのやま: "C",
    蔵王: "D",
    温泉: "E", // かみのやま温泉IC
  };

  for (const [keyword, key] of Object.entries(partialMatches)) {
    if (normalizedMessage.includes(keyword)) {
      return PRECHECKIN_ORIGINS[key];
    }
  }

  // 4. 現在地指定
  const currentLocationKeywords = ["現地", "現在地", "GPS", "HERE", "ここ", "今いる場所", "現在の場所"];
  if (currentLocationKeywords.some((keyword) => normalizedMessage.includes(keyword))) {
    return { useCurrentLocation: true };
  }

  return null;
}

