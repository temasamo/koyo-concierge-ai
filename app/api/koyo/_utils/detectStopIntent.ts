// app/api/koyo/_utils/detectStopIntent.ts
// 途中立ち寄り意図を検出する関数（汎用化）

import type { SightseeingSubType, StopIntent, StopType } from "@/types/route";

/**
 * 途中立ち寄り意図を検出（StopIntent生成）- 汎用版
 * 優先順位: lunch > cafe > rest > onsen > shop
 * 
 * 検出キーワード:
 * - lunch: ["ランチ", "昼食", "食べたい", "ラーメン", "そば", "芋煮", "山形牛"]
 * - cafe: ["カフェ", "コーヒー", "休憩"]
 * - rest: ["休憩", "一息", "散策"]
 * - onsen: ["温泉", "湯", "風呂"]（外出文脈がある場合のみ）
 * - shop: ["お土産", "売店", "ショップ"]
 * 
 * 外出文脈キーワード:
 * - これらのキーワードが含まれる場合、外出スポットとして扱う
 */
export function detectStopIntent(message: string): StopIntent | null {
  const normalized = message.toLowerCase();
  
  // 外出文脈キーワード（旅程・行動要求を示す）
  const outdoorContextKeywords = [
    "プラン",
    "途中",
    "立ち寄り",
    "観光",
    "行きたい",
    "寄りたい",
    "周辺",
    "近く",
    "スポット",
    "訪れ",
    "行く",
  ];
  
  const hasOutdoorContext = outdoorContextKeywords.some((k) => normalized.includes(k));
  
  // 優先順位順に定義（lunch > cafe > rest > onsen > shop）
  const stopTypeConfigs: Array<{
    type: StopType;
    keywords: string[];
    fallbackKeyword: string;
    foodCategoryKeywords?: Array<{ foodCategory: string; patterns: string[] }>;
  }> = [
    {
      type: "lunch",
      keywords: ["ランチ", "昼食", "お昼", "昼ごはん", "昼飯", "食べたい", "食べて", "ご飯", "食事"],
      fallbackKeyword: "ランチ",
      foodCategoryKeywords: [
        { foodCategory: "ラーメン", patterns: ["ラーメン", "らーめん"] },
        { foodCategory: "そば", patterns: ["そば", "蕎麦"] },
        { foodCategory: "芋煮", patterns: ["芋煮", "いも煮", "いもに", "imoni"] },
        { foodCategory: "米沢牛", patterns: ["米沢牛", "よねざわぎゅう"] },
        { foodCategory: "山形牛", patterns: ["山形牛", "やまがたぎゅう"] },
        { foodCategory: "冷やしラーメン", patterns: ["冷やしラーメン", "冷やしらーめん", "ひやしらーめん"] },
      ],
    },
    {
      type: "cafe",
      keywords: ["カフェ", "コーヒー", "休憩"],
      fallbackKeyword: "カフェ",
    },
    {
      type: "rest",
      keywords: ["一息", "散策"],
      fallbackKeyword: "休憩",
    },
    {
      type: "onsen",
      keywords: ["温泉", "湯", "風呂"],
      fallbackKeyword: "温泉",
    },
    {
      type: "shop",
      keywords: ["お土産", "売店", "ショップ"],
      fallbackKeyword: "お土産",
    },
  ];
  
  // 優先順位順にチェック（最初にマッチしたものを採用）
  for (const config of stopTypeConfigs) {
    const hasMatch = config.keywords.some((k) => normalized.includes(k));
    
    if (hasMatch) {
      // onsen の場合は外出文脈が必要（館内施設案内との区別のため）
      if (config.type === "onsen" && !hasOutdoorContext) {
        // 外出文脈がない場合は館内施設案内として扱う（nullを返す）
        continue;
      }
      
      // lunchの場合はfoodCategoryも抽出
      let foodCategory: string | undefined;
      if (config.type === "lunch" && config.foodCategoryKeywords) {
        for (const { foodCategory: fc, patterns } of config.foodCategoryKeywords) {
          if (patterns.some((p) => normalized.includes(p))) {
            foodCategory = fc;
            break; // 最初にマッチしたものを採用
          }
        }
      }
      
      return {
        type: config.type,
        foodCategory,
        fallbackKeyword: config.fallbackKeyword,
      };
    }
  }

  // sightseeing（観光）: lunch等に当たらない場合のフォールバックとして最後に判定
  // 例: 「歴史観光して帰りたい」「自然に寄って帰りたい」「祭りを見たい」「観光したい」「寄り道したい」
  const sightseeingKeywords = [
    "観光",
    "寄り道",
    "立ち寄り",
    "史跡",
    "寺",
    "神社",
    "城",
    "文化財",
    "歴史",
    "自然",
    "景色",
    "渓谷",
    "山",
    "展望",
    "公園",
    "遊び",
    "体験",
    "アクティビティ",
    "祭り",
    "花笠",
  ];
  const hasSightseeing = sightseeingKeywords.some((k) => normalized.includes(k));
  if (hasSightseeing) {
    let subType: SightseeingSubType = null;
    if (["歴史", "史跡", "寺", "神社", "城", "文化財"].some((k) => normalized.includes(k))) {
      subType = "history";
    } else if (["自然", "景色", "渓谷", "山", "展望", "公園"].some((k) => normalized.includes(k))) {
      subType = "nature";
    } else if (["遊び", "体験", "アクティビティ"].some((k) => normalized.includes(k))) {
      subType = "play";
    } else if (["祭り", "花笠"].some((k) => normalized.includes(k))) {
      subType = "festival";
    }

    const keywordBySubType: Record<Exclude<SightseeingSubType, null>, string> = {
      history: "歴史",
      nature: "自然",
      play: "遊ぶ",
      festival: "祭り",
    };

    return {
      type: "sightseeing",
      subType,
      // Places側のkeyword優先順位(foodCategory→keyword→fallbackKeyword)に乗せる
      keyword: subType ? keywordBySubType[subType] : "観光",
      fallbackKeyword: "観光",
    };
  }
  
  return null;
}

