# Phase2-1 DB優先「検索→候補→選択」設計合意

## 1) DB側に"絞り込みに使えるフィールド"確認

### Spot型・DBカラム対応表

| Spot型フィールド | DBカラム（spot_master） | 型 | 用途（絞り込み） |
|-----------------|------------------------|-----|-----------------|
| `id` | `id` | `string` | 一意識別子 |
| `name` | `name` | `string` | スポット名 |
| `category` | `category` | `string \| null` | **大分類（食べる/温泉/観光等）** |
| `city` | `city` | `string \| null` | 地域（天童市等） |
| `season` | `season` | `string \| null` | 季節（春/夏/秋/冬） |
| `tags` | `tags` | `string \| null` | **タグ（カンマ区切り想定？要確認）** |
| `lat` | `lat` | `number \| null` | 緯度 |
| `lng` | `lng` | `number \| null` | 経度 |
| `drive_time` | `drive_time` | `string \| null` | 移動時間（"30分"等） |
| `walk_time` | `walk_time` | `string \| null` | 徒歩時間 |
| `stay_time` | `stay_time` | `string \| null` | 滞在時間 |
| `url` | `url` | `string \| null` | URL |
| `drive_minutes` | （計算値） | `number \| null` | 移動時間（分） |
| `description` | （未確認） | `string \| undefined` | 説明文（要確認） |
| `address` | （未確認） | `string \| undefined` | 住所（要確認） |

### 絞り込みに使えるフィールド（推奨順）

1. **`category`** - 大分類（例: "食べる", "温泉", "観光"）
   - `stopIntent.type`とのマッピング:
     - `lunch` → `category = "食べる"`
     - `onsen` → `category = "温泉"`
     - `shop` → `category = "観光"` または専用カテゴリ
     - `cafe` → `category = "食べる"` または専用カテゴリ
     - `rest` → `category = "観光"`

2. **`tags`** - タグ（カンマ区切り想定？要確認）
   - `foodCategory`とのマッピング:
     - `foodCategory = "蕎麦"` → `tags`に"蕎麦"または"そば"を含む
     - `foodCategory = "ラーメン"` → `tags`に"ラーメン"を含む
   - **注意**: `tags`の形式（カンマ区切り/JSON/配列）を確認する必要あり

3. **`name`** - スポット名（部分一致検索）
   - `foodCategory`が`tags`にない場合のフォールバック
   - 例: `name LIKE '%蕎麦%'`

4. **`description`** - 説明文（要確認）
   - 現状のSpot型には`description?: string`があるが、DBカラムの存在は未確認
   - 存在する場合は全文検索に使用可能

### 確認事項

- [ ] `tags`カラムの形式（カンマ区切り/JSON/配列）
- [ ] `description`カラムの存在
- [ ] `category`の実際の値（"食べる"/"温泉"/"観光"以外の値があるか）
- [ ] `sub_category`カラムの存在（現状のコードでは見当たらない）

---

## 2) "DB候補をLLMに選ばせる"設計にできるか

### 現状の設計

```
1. LLMがスポット名を生成（JSON形式）
   ↓
2. extractAndMatchSpots でDBと名前マッチング
   ↓
3. matchedSpots を返す
```

**問題点**:
- LLMが自由にスポット名を生成するため、DBに存在しないスポット名を生成する可能性
- `stopIntent`（foodCategory/type）がDB検索に反映されない

### 提案する設計

```
1. stopIntent を検出
   ↓
2. DBから候補を検索（stopIntent.type/foodCategoryで絞り込み）
   ↓
3. 候補IDリストをLLMに渡す
   ↓
4. LLMは候補IDから1〜3件を選択
   ↓
5. 選択されたIDでDBから完全なSpot情報を取得
```

### API設計変更

#### 現状（`app/api/koyo/after/route.ts`）

```typescript
// LLMがスポット名を生成
const systemPrompt = await getSystemPrompt(stopIntent);
const completion = await openai.chat.completions.create({
  model: CHAT_MODEL,
  messages: [
    { role: "system", content: systemPrompt },
    ...userMessages,
  ],
  response_format: { type: "json_object" },
});
const reply = completion.choices[0]?.message?.content ?? "";
const planArray = await extractPlanFromReply(reply);
const matchedSpots = await extractAndMatchSpots(planArray);
```

#### 提案（変更後）

```typescript
// 1. stopIntentを検出
const stopIntent = detectStopIntent(stopIntentMessage);

// 2. DBから候補を検索
const dbCandidates = await searchSpotsFromDB({
  stopIntent,
  origin: KOYO_COORDINATES,
  destination: destinationCoords,
  limit: 10, // 候補数
});

// 3. 候補IDリストをLLMに渡す
const candidateIds = dbCandidates.map(s => s.id);
const systemPrompt = await getSystemPromptWithCandidates(stopIntent, candidateIds);
const completion = await openai.chat.completions.create({
  model: CHAT_MODEL,
  messages: [
    { role: "system", content: systemPrompt },
    ...userMessages,
  ],
  response_format: { type: "json_object" },
});
const reply = completion.choices[0]?.message?.content ?? "";

// 4. LLMは候補IDから選択（JSON形式: { selectedSpotIds: ["id1", "id2"] }）
const selectedIds = extractSelectedSpotIds(reply);

// 5. 選択されたIDでDBから完全なSpot情報を取得
const matchedSpots = dbCandidates.filter(s => selectedIds.includes(s.id));
```

### 影響範囲

#### `app/api/koyo/after/route.ts`

**変更が必要な関数**:
- `getSystemPrompt()` → `getSystemPromptWithCandidates(stopIntent, candidateIds)`
  - 候補IDリストをプロンプトに含める
  - 「候補IDから選択してください」という指示を追加
- `extractPlanFromReply()` → `extractSelectedSpotIds(reply)`
  - JSONから`selectedSpotIds`配列を抽出
- **新規追加**: `searchSpotsFromDB({ stopIntent, origin, destination, limit })`
  - DBから候補を検索する関数

**削除/変更不要な関数**:
- `extractAndMatchSpots()` - 名前マッチングは不要になるが、後方互換性のため残す可能性あり

#### プロンプト（`getSystemPrompt`）

**変更内容**:
```typescript
// 現状: 全スポット一覧をプロンプトに含める
const spotListText = await getSpotListForPrompt(); // 全件取得

// 変更後: 候補IDリストのみをプロンプトに含める
const candidateListText = candidateIds
  .map((id, idx) => {
    const spot = dbCandidates.find(s => s.id === id);
    return `[${idx + 1}] ${spot.name} (ID: ${id})`;
  })
  .join("\n");
```

**プロンプト例**:
```
【候補スポット（選択してください）】
以下の候補から1〜3件を選択してください。

${candidateListText}

【選択方法】
JSON形式で返してください:
{
  "selectedSpotIds": ["id1", "id2"]
}
```

#### Spot型

**変更不要**: 現状のSpot型で問題なし

---

## 3) Places呼び出しのゲート条件を追加できるか

### 現状の実装

```typescript
// app/api/koyo/after/route.ts:1509
if (stopIntent) {
  // stopIntentがあれば必ずPlaces APIを呼ぶ
  const result = await integratePlaces(
    matchedSpots || [],
    stopIntent,
    KOYO_COORDINATES,
    destinationCoords
  );
}
```

**問題点**: DB結果の件数に関係なく、`stopIntent`があれば必ずPlaces APIが呼ばれる

### 提案するゲート条件

```typescript
if (stopIntent) {
  // DB候補が不足した場合のみPlaces APIを呼ぶ
  const dbCandidateCount = matchedSpots?.length || 0;
  const minRequiredCount = 3; // 最低必要な候補数
  
  if (dbCandidateCount < minRequiredCount) {
    console.log("[koyo-after] DB candidates insufficient, calling Places API", {
      dbCandidateCount,
      minRequiredCount,
    });
    
    const result = await integratePlaces(
      matchedSpots || [],
      stopIntent,
      KOYO_COORDINATES,
      destinationCoords
    );
    
    matchedSpots = result.spots;
    placesApiFailed = result.placesApiFailed;
    placesAdded = result.placesAdded;
  } else {
    console.log("[koyo-after] DB candidates sufficient, skipping Places API", {
      dbCandidateCount,
      minRequiredCount,
    });
  }
}
```

### 不足判定の仕様案

**提案**: `dbCandidates.length < 3` のとき Places を呼ぶ

**理由**:
- 候補は1〜3件を選択する想定
- 最低3件あれば選択の幅が確保できる
- 2件以下だと選択の幅が狭い

**考慮事項**:
- `minRequiredCount`は設定可能にする（環境変数または定数）
- ログで判定理由を記録

### after/before/stay共通化の観点

**現状**:
- `integratePlaces`は`app/api/koyo/_utils/places.ts`にあり、共通化されている
- 呼び出し側（`after/route.ts`, `before/route.ts`, `stay/route.ts`）で個別に条件分岐

**提案**:
- `integratePlaces`の呼び出し前にゲート条件を追加
- 各モード（after/before/stay）で同じ条件を使用
- 必要に応じて`minRequiredCount`をモードごとに設定可能にする

**実装例**:
```typescript
// app/api/koyo/_utils/places.ts
export async function integratePlaces(
  spots: any[],
  stopIntent: StopIntent | null,
  origin?: { lat: number; lng: number },
  destination?: { lat: number; lng: number },
  options?: {
    minRequiredCount?: number; // デフォルト: 3
    skipIfSufficient?: boolean; // デフォルト: true
  }
): Promise<{ spots: any[]; placesApiFailed: boolean; placesAdded: boolean }> {
  const minRequiredCount = options?.minRequiredCount ?? 3;
  const skipIfSufficient = options?.skipIfSufficient ?? true;
  
  if (!stopIntent) {
    // 既存の処理
    return { spots: baseSpots, placesApiFailed: false, placesAdded: false };
  }
  
  // ゲート条件: DB候補が十分な場合はスキップ
  if (skipIfSufficient && baseSpots.length >= minRequiredCount) {
    console.log("[koyo-places] Skipping Places API: sufficient DB candidates", {
      dbCandidateCount: baseSpots.length,
      minRequiredCount,
    });
    return { spots: baseSpots, placesApiFailed: false, placesAdded: false };
  }
  
  // 既存のPlaces API呼び出し処理
  // ...
}
```

---

## 4) stopIntent辞書（焼肉・カフェ等）をどこに置くべきか

### 現状の構成

```
app/api/koyo/_utils/
  ├── detectStopIntent.ts  ← stopIntent検出ロジック
  ├── matchSpot.ts
  └── places.ts
```

**現状の問題点**:
- `foodCategoryKeywords`が`detectStopIntent.ts`内にハードコードされている
- 新しいジャンル（焼肉、寿司、居酒屋等）を追加するには`detectStopIntent.ts`を直接編集する必要がある

### 提案: 別モジュールに切り出す

**推奨構成**:
```
app/api/koyo/_utils/
  ├── detectStopIntent.ts  ← stopIntent検出ロジック（辞書を参照）
  ├── intent/
  │   ├── foodDictionary.ts  ← 食事系ジャンル辞書
  │   └── stopTypeConfig.ts   ← stopType設定（cafe, onsen, shop等）
  ├── matchSpot.ts
  └── places.ts
```

**理由**:
1. **保守性**: 辞書の追加・変更が容易
2. **テスト容易性**: 辞書を独立してテスト可能
3. **拡張性**: 将来的に他の辞書（地域辞書、季節辞書等）も追加可能
4. **既存構成との整合性**: `_utils`配下に機能別モジュールを配置する方針と一致

### 実装例

#### `app/api/koyo/_utils/intent/foodDictionary.ts`

```typescript
// 食事系ジャンル辞書
export type FoodCategory = 
  | "ラーメン"
  | "そば"
  | "芋煮"
  | "米沢牛"
  | "山形牛"
  | "冷やしラーメン"
  | "焼肉"
  | "寿司"
  | "居酒屋"
  | "スイーツ";

export type FoodCategoryConfig = {
  foodCategory: FoodCategory;
  patterns: string[];
  dbTags?: string[]; // DBのtagsカラムで検索する際のキーワード
};

export const FOOD_CATEGORY_DICTIONARY: FoodCategoryConfig[] = [
  { 
    foodCategory: "ラーメン", 
    patterns: ["ラーメン", "らーめん"],
    dbTags: ["ラーメン", "らーめん"],
  },
  { 
    foodCategory: "そば", 
    patterns: ["そば", "蕎麦"],
    dbTags: ["そば", "蕎麦"],
  },
  { 
    foodCategory: "焼肉", 
    patterns: ["焼肉", "やきにく", "焼き肉"],
    dbTags: ["焼肉", "やきにく"],
  },
  { 
    foodCategory: "寿司", 
    patterns: ["寿司", "すし", "鮨"],
    dbTags: ["寿司", "すし"],
  },
  { 
    foodCategory: "居酒屋", 
    patterns: ["居酒屋", "いざかや"],
    dbTags: ["居酒屋", "いざかや"],
  },
  { 
    foodCategory: "スイーツ", 
    patterns: ["スイーツ", "スイート", "デザート", "ケーキ"],
    dbTags: ["スイーツ", "デザート", "ケーキ"],
  },
  // 既存のジャンルも含める
  { 
    foodCategory: "芋煮", 
    patterns: ["芋煮", "いも煮", "いもに", "imoni"],
    dbTags: ["芋煮", "いも煮"],
  },
  { 
    foodCategory: "米沢牛", 
    patterns: ["米沢牛", "よねざわぎゅう"],
    dbTags: ["米沢牛"],
  },
  { 
    foodCategory: "山形牛", 
    patterns: ["山形牛", "やまがたぎゅう"],
    dbTags: ["山形牛"],
  },
  { 
    foodCategory: "冷やしラーメン", 
    patterns: ["冷やしラーメン", "冷やしらーめん", "ひやしらーめん"],
    dbTags: ["冷やしラーメン"],
  },
];
```

#### `app/api/koyo/_utils/intent/stopTypeConfig.ts`

```typescript
import type { StopType } from "@/types/route";

export type StopTypeConfig = {
  type: StopType;
  keywords: string[];
  fallbackKeyword: string;
  dbCategory?: string; // DBのcategoryカラムで検索する際の値
};

export const STOP_TYPE_CONFIGS: StopTypeConfig[] = [
  {
    type: "lunch",
    keywords: ["ランチ", "昼食", "お昼", "昼ごはん", "昼飯", "食べたい", "食べて", "ご飯", "食事"],
    fallbackKeyword: "ランチ",
    dbCategory: "食べる",
  },
  {
    type: "cafe",
    keywords: ["カフェ", "コーヒー", "休憩"],
    fallbackKeyword: "カフェ",
    dbCategory: "食べる", // または専用カテゴリ
  },
  {
    type: "rest",
    keywords: ["一息", "散策"],
    fallbackKeyword: "休憩",
    dbCategory: "観光",
  },
  {
    type: "onsen",
    keywords: ["温泉", "湯", "風呂"],
    fallbackKeyword: "温泉",
    dbCategory: "温泉",
  },
  {
    type: "shop",
    keywords: ["お土産", "売店", "ショップ"],
    fallbackKeyword: "お土産",
    dbCategory: "観光", // または専用カテゴリ
  },
];
```

#### `app/api/koyo/_utils/detectStopIntent.ts`（変更後）

```typescript
import { FOOD_CATEGORY_DICTIONARY } from "./intent/foodDictionary";
import { STOP_TYPE_CONFIGS } from "./intent/stopTypeConfig";

export function detectStopIntent(message: string): StopIntent | null {
  const normalized = message.toLowerCase();
  
  // STOP_TYPE_CONFIGSを使用
  for (const config of STOP_TYPE_CONFIGS) {
    const hasMatch = config.keywords.some((k) => normalized.includes(k));
    
    if (hasMatch) {
      // onsen の場合は外出文脈が必要
      if (config.type === "onsen" && !hasOutdoorContext) {
        continue;
      }
      
      // lunchの場合はfoodCategoryも抽出
      let foodCategory: string | undefined;
      if (config.type === "lunch") {
        for (const { foodCategory: fc, patterns } of FOOD_CATEGORY_DICTIONARY) {
          if (patterns.some((p) => normalized.includes(p))) {
            foodCategory = fc;
            break;
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
  
  return null;
}
```

### 既存構成との整合性

**既存の`_utils`配下の構成**:
- `detectStopIntent.ts` - 汎用関数
- `matchSpot.ts` - 汎用関数
- `places.ts` - 汎用関数

**提案する構成**:
- `intent/`ディレクトリを追加して、意図検出関連の辞書・設定を集約
- `detectStopIntent.ts`は`intent/`配下の辞書を参照する関数として残す

**メリット**:
- 既存の`_utils`配下の構成パターンと一致
- 将来的に`intent/`配下に他の辞書（地域辞書、季節辞書等）も追加可能

---

## まとめ

### 1) DB側の絞り込みフィールド
- **推奨**: `category`（大分類）+ `tags`（詳細ジャンル）
- **要確認**: `tags`の形式、`description`カラムの存在

### 2) DB候補をLLMに選ばせる設計
- **可能**: 設計変更は可能
- **影響範囲**: `route.ts`のプロンプト生成・レスポンス解析、新規`searchSpotsFromDB`関数の追加

### 3) Places呼び出しのゲート条件
- **可能**: `dbCandidates.length < 3` の条件で実装可能
- **共通化**: `integratePlaces`に`minRequiredCount`オプションを追加

### 4) stopIntent辞書の配置
- **推奨**: `app/api/koyo/_utils/intent/`配下に辞書モジュールを配置
- **構成**: `foodDictionary.ts` + `stopTypeConfig.ts`




