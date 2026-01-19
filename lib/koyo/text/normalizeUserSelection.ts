/**
 * ユーザー選択入力の正規化関数
 * parseOriginSelection などのパース関数に渡す前に使用する
 * @param raw 生のユーザー入力
 * @returns 正規化された文字列
 */
export function normalizeUserSelection(raw: string): string {
  if (!raw || typeof raw !== "string") {
    return "";
  }

  return raw
    .normalize("NFKC") // 全角→半角、記号揺れもある程度統一
    .trim()
    .replace(/[\.．、。:：\)\(（）\s]/g, "") // よくある記号/空白を除去
    .toUpperCase();
}






