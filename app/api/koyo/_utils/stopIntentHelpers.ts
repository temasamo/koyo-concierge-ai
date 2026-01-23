// app/api/koyo/_utils/stopIntentHelpers.ts
// stopIntent関連のヘルパー関数

/**
 * 料理ジャンルキーワードを検出
 * ユーザーが料理ジャンル（例：蕎麦/ラーメン/焼肉/米沢牛 etc）を明示した場合を判定
 * 
 * @param text ユーザーの入力テキスト
 * @returns { hasFoodKeyword: boolean, foodKeyword: string | null }
 */
export function detectFoodKeyword(text: string): {
  hasFoodKeyword: boolean;
  foodKeyword: string | null;
} {
  const normalized = text.toLowerCase();
  
  // 料理ジャンルキーワード（最低限）
  const foodKeywords: Array<{ keyword: string; patterns: string[] }> = [
    { keyword: "蕎麦", patterns: ["蕎麦", "そば", "soba"] },
    { keyword: "ラーメン", patterns: ["ラーメン", "らーめん", "中華そば", "ramen"] },
    { keyword: "焼肉", patterns: ["焼肉", "やきにく", "yakiniku"] },
    { keyword: "米沢牛", patterns: ["米沢牛", "よねざわぎゅう", "yonezawagyuu"] },
    { keyword: "ステーキ", patterns: ["ステーキ", "steak"] },
    { keyword: "すき焼き", patterns: ["すき焼き", "すきやき", "sukiyaki"] },
    { keyword: "寿司", patterns: ["寿司", "すし", "sushi"] },
    { keyword: "うなぎ", patterns: ["うなぎ", "鰻", "unagi"] },
    { keyword: "定食", patterns: ["定食", "ていしょく", "teishoku"] },
    { keyword: "山形牛", patterns: ["山形牛", "やまがたぎゅう", "yamagatagyuu"] },
    { keyword: "芋煮", patterns: ["芋煮", "いも煮", "いもに", "imoni"] },
    { keyword: "冷やしラーメン", patterns: ["冷やしラーメン", "冷やしらーめん", "ひやしらーめん"] },
  ];
  
  // 優先順位順にチェック（最初にマッチしたものを採用）
  for (const { keyword, patterns } of foodKeywords) {
    if (patterns.some((pattern) => normalized.includes(pattern))) {
      return {
        hasFoodKeyword: true,
        foodKeyword: keyword,
      };
    }
  }
  
  return {
    hasFoodKeyword: false,
    foodKeyword: null,
  };
}



