// app/api/koyo/_utils/matchSpot.ts
/**
 * スポット名を正規化する関数
 * AIの出力と spot_master.name を比較可能にするため、以下のルールで正規化する：
 * - 全角 → 半角 (normalize("NFKC"))
 * - 小文字化
 * - カタカナ → ひらがな（UTF-16差分 0x60、濁点・半濁点含む）
 * - 長音記号（ー）削除
 * - 記号除去（（ ）・ - _ など）
 * - 空白削除
 * - 括弧内文字削除（例：上山城（冬）→ 上山城）
 */
export function normalizeName(name: string): string {
  if (!name) return "";

  try {
    return name
      .toLowerCase()
      .normalize("NFKC")
      .replace(/[（(].*?[）)]/g, "") // 括弧とその中身を削除
      .replace(/[（）()・\-_\s]/g, "") // 記号除去
      .replace(/ー/g, "") // 長音記号削除
      .replace(/[ァ-ヺ]/g, (c) =>
        String.fromCharCode(c.charCodeAt(0) - 0x60)
      ); // カタカナ→ひらがな（濁点・半濁点含む）
  } catch (error) {
    // エラー時は空文字を返す
    return "";
  }
}

/**
 * AIが返したスポット名をSupabaseのspot_masterとマッチングする関数
 * 以下の優先順位で判定する：
 * 1. 完全一致
 * 2. 部分一致
 * 3. 前方一致
 * 4. 後方一致
 * 
 * @param aiName AIが返したスポット名
 * @param masterList Supabaseのspot_master一覧
 * @param usedSpotIds 既にマッチしたスポットIDのセット（重複防止用）
 * @returns マッチしたスポット、見つからなければ null
 */
export function matchSpot(
  aiName: string,
  masterList: any[],
  usedSpotIds: Set<string>
): any | null {
  if (!aiName || !masterList || masterList.length === 0) {
    return null;
  }

  const target = normalizeName(aiName);
  if (!target) {
    return null;
  }

  // 1. 完全一致
  for (const spot of masterList) {
    if (usedSpotIds.has(spot.id)) continue;
    if (normalizeName(spot.name) === target) {
      return spot;
    }
  }

  // 2. 部分一致
  for (const spot of masterList) {
    if (usedSpotIds.has(spot.id)) continue;
    const normalizedSpotName = normalizeName(spot.name);
    if (normalizedSpotName.includes(target) || target.includes(normalizedSpotName)) {
      return spot;
    }
  }

  // 3. 前方一致
  for (const spot of masterList) {
    if (usedSpotIds.has(spot.id)) continue;
    const normalizedSpotName = normalizeName(spot.name);
    if (normalizedSpotName.startsWith(target) || target.startsWith(normalizedSpotName)) {
      return spot;
    }
  }

  // 4. 後方一致
  for (const spot of masterList) {
    if (usedSpotIds.has(spot.id)) continue;
    const normalizedSpotName = normalizeName(spot.name);
    if (normalizedSpotName.endsWith(target) || target.endsWith(normalizedSpotName)) {
      return spot;
    }
  }

  // 見つからなければ null
  return null;
}




