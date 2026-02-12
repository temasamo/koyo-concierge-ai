# Phase2-1 DB優先実装計画（回答・提案）

## 1) spot_masterの実スキーマ確認

### SQLクエリ（実行用）

詳細なSQLクエリは `docs/spot-master-schema-investigation.md` に記載しています。

**主要クエリ**:
```sql
-- カラム一覧
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'spot_master'
ORDER BY ordinal_position;

-- categoryの実値集計
SELECT category, COUNT(*) as count
FROM spot_master
GROUP BY category
ORDER BY count DESC;

-- "温泉"カテゴリの存在確認
SELECT DISTINCT category
FROM spot_master
WHERE category IS NOT NULL
ORDER BY category;

-- tagsの実データ状況
SELECT COUNT(*) as non_null_tags_count
FROM spot_master
WHERE tags IS NOT NULL;
```

### コードから推測できる情報

**確認済みカラム**（`app/api/spots/search/route.ts:37-50`）:
- `id`, `name`, `category`, `city`, `season`
- `drive_time`, `walk_time`, `stay_time`
- `lat`, `lng`, `url`, `tags`

**未確認カラム**:
- `description` - Spot型には`description?: string`があるが、DBカラムの存在は未確認
- `address` - Spot型には`address?: string`があるが、DBカラムの存在は未確認
- `sub_category` - コード上では見当たらない

**推奨**: 上記SQLクエリを実行して実スキーマを確認してください。

---

## 2) 現状のPhase2-1候補生成の"DB側ロジック"

### stopIntentがDB検索条件に使われていない箇所

#### 該当コード行

**1. `app/api/koyo/after/route.ts:395-397`**
```typescript
// Supabaseから全スポットを取得
const supabase = getSupabaseClient();
const { data: supabaseSpots } = await supabase
  .from("spot_master")
  .select("*");  // ← 全件取得、stopIntentによるフィルタなし
```

**2. `app/api/koyo/after/route.ts:380-460` - `extractAndMatchSpots`関数**
```typescript
async function extractAndMatchSpots(planArray: any[]): Promise<any[] | undefined> {
  // ...
  // Supabaseから全スポットを取得（stopIntentは使用されない）
  const { data: supabaseSpots } = await supabase
    .from("spot_master")
    .select("*");
  
  // AIが返したスポット名とマッチング（stopIntentは使用されない）
  for (const aiSpot of aiSpots) {
    // IDまたはnameでマッチング
    // stopIntent.type / foodCategory は使用されない
  }
}
```

**3. `app/api/koyo/after/route.ts:50-84` - `getSpotListForPrompt`関数**
```typescript
async function getSpotListForPrompt(): Promise<string> {
  const supabase = getSupabaseClient();
  const { data: spots, error } = await supabase
    .from("spot_master")
    .select("*")  // ← 全件取得、stopIntentによるフィルタなし
    .order("name");
  // ...
}
```

### 現状の問題点

1. **全件取得**: `select("*")`で全スポットを取得
2. **フィルタなし**: `stopIntent.type`や`foodCategory`による絞り込みがない
3. **名前マッチングのみ**: AIが返したスポット名とDBのスポット名をマッチングするのみ

### `searchSpotsFromDB()`の呼び出し位置提案

**推奨位置**: `app/api/koyo/after/route.ts:1487-1489`の直後

```typescript
// 現状（1487-1489行目）
if (planArray && planArray.length > 0) {
  matchedSpots = await extractAndMatchSpots(planArray);
}

// 提案: ここにsearchSpotsFromDB()を追加
// stopIntentを検出（1493-1494行目で既に検出済みだが、ここで再取得）
const stopIntentMessage = findStopIntentMessage(userMessages) || userMessage;
const stopIntent = detectStopIntent(stopIntentMessage);

// DB優先の検索関数を呼ぶ（新規追加）
if (stopIntent) {
  const dbCandidates = await searchSpotsFromDB({
    stopIntent,
    origin: KOYO_COORDINATES,
    destination: destinationCoords,
    limit: 10,
  });
  
  // 既存のmatchedSpotsと統合（または置き換え）
  if (dbCandidates && dbCandidates.length > 0) {
    matchedSpots = dbCandidates;
  }
}
```

**理由**:
1. **影響範囲が最小**: `extractAndMatchSpots`の直後なので、既存の`matchedSpots`を置き換えるだけ
2. **stopIntent検出のタイミング**: 1493-1494行目で既に検出されているが、DB検索の直前に再取得することで確実性を確保
3. **後方互換性**: `extractAndMatchSpots`は残す（将来的に削除可能）

**代替案**: `extractAndMatchSpots`を完全に置き換える
- **メリット**: コードがシンプルになる
- **デメリット**: 既存の名前マッチングロジックが失われる（ただし、DB優先設計では不要）

---

## 3) Places呼び出しのゲート設計（DB優先ルール）

### 最小変更案（after/before/stay共通化）

#### 変更箇所1: `app/api/koyo/_utils/places.ts` - `integratePlaces`関数

```typescript
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
  const baseSpots = spots || [];

  if (!stopIntent) {
    // 既存の処理
    baseSpots.forEach((spot) => {
      if (!spot.source) {
        spot.source = "db";
      }
    });
    return { spots: baseSpots, placesApiFailed: false, placesAdded: false };
  }

  // ★新規追加: DB候補が十分な場合はスキップ
  if (skipIfSufficient && baseSpots.length >= minRequiredCount) {
    console.log("[koyo-places] Skipping Places API: sufficient DB candidates", {
      dbCount: baseSpots.length,
      minRequiredCount,
      stopIntentType: stopIntent.type,
      foodCategory: stopIntent.foodCategory,
      keyword: stopIntent.foodCategory ?? stopIntent.keyword ?? stopIntent.fallbackKeyword,
    });
    
    // DBスポットにsourceフィールドを追加
    baseSpots.forEach((spot) => {
      if (!spot.source) {
        spot.source = "db";
      }
    });
    return { spots: baseSpots, placesApiFailed: false, placesAdded: false };
  }

  // 既存のPlaces API呼び出し処理（以下は変更なし）
  let placesApiFailed = false;
  let placesAdded = false;
  // ...
}
```

#### 変更箇所2: 各モードでの呼び出し（オプション指定なしでデフォルト動作）

**after/before/stayすべてで既存の呼び出しをそのまま使用**:
```typescript
// 既存の呼び出し（変更不要）
const result = await integratePlaces(
  matchedSpots || [],
  stopIntent,
  origin,
  destination
);
```

**デフォルト動作**:
- `minRequiredCount = 3`
- `skipIfSufficient = true`
- つまり、`matchedSpots.length >= 3`の場合はPlaces APIを呼ばない

**カスタマイズが必要な場合**:
```typescript
// 例: afterモードでminRequiredCount=5にしたい場合
const result = await integratePlaces(
  matchedSpots || [],
  stopIntent,
  origin,
  destination,
  { minRequiredCount: 5 }
);
```

### ログ出力の追加ポイント

#### 1. `integratePlaces`関数内（ゲート条件判定時）

```typescript
// DB候補が十分な場合
console.log("[koyo-places] Skipping Places API: sufficient DB candidates", {
  dbCount: baseSpots.length,
  minRequiredCount,
  stopIntentType: stopIntent.type,
  foodCategory: stopIntent.foodCategory,
  keyword: stopIntent.foodCategory ?? stopIntent.keyword ?? stopIntent.fallbackKeyword,
  placesCalled: false,
});

// Places APIを呼ぶ場合
console.log("[koyo-places] Calling Places API: insufficient DB candidates", {
  dbCount: baseSpots.length,
  minRequiredCount,
  stopIntentType: stopIntent.type,
  foodCategory: stopIntent.foodCategory,
  keyword: stopIntent.foodCategory ?? stopIntent.keyword ?? stopIntent.fallbackKeyword,
  placesCalled: true,
});
```

#### 2. `searchPlaces`関数内（Places API呼び出し時）

```typescript
// app/api/koyo/_utils/places.ts:179
console.log("[koyo-places] Searching places near:", baseLocation, {
  type: stopIntent.type,
  keyword: keyword,
  foodCategory: stopIntent.foodCategory,
  placesCalled: true,
});
```

#### 3. 各モードでの呼び出し前後（after/before/stay）

**afterモード** (`app/api/koyo/after/route.ts:1538`):
```typescript
// 呼び出し前
console.log("[koyo-after] Before integratePlaces:", {
  dbCount: matchedSpots?.length || 0,
  stopIntentType: stopIntent?.type,
  foodCategory: stopIntent?.foodCategory,
  keyword: stopIntent?.foodCategory ?? stopIntent?.keyword ?? stopIntent?.fallbackKeyword,
});

const result = await integratePlaces(
  matchedSpots || [],
  stopIntent,
  KOYO_COORDINATES,
  destinationCoords
);

// 呼び出し後
console.log("[koyo-after] After integratePlaces:", {
  dbCount: matchedSpots?.filter(s => !s.id?.startsWith("places_")).length || 0,
  placesCount: matchedSpots?.filter(s => s.id?.startsWith("places_")).length || 0,
  placesCalled: result.placesAdded || result.placesApiFailed,
  placesAdded: result.placesAdded,
  placesApiFailed: result.placesApiFailed,
});
```

**beforeモード** (`app/api/koyo/before/route.ts:1250`):
```typescript
// 同様のログを追加
console.log("[koyo-before] Before integratePlaces:", {
  dbCount: matchedSpots?.length || 0,
  stopIntentType: stopIntent?.type,
  foodCategory: stopIntent?.foodCategory,
  keyword: stopIntent?.foodCategory ?? stopIntent?.keyword ?? stopIntent?.fallbackKeyword,
});

const result = await integratePlaces(
  matchedSpots || [],
  stopIntent,
  origin,
  destinationCoords
);

console.log("[koyo-before] After integratePlaces:", {
  dbCount: matchedSpots?.filter(s => !s.id?.startsWith("places_")).length || 0,
  placesCount: matchedSpots?.filter(s => s.id?.startsWith("places_")).length || 0,
  placesCalled: result.placesAdded || result.placesApiFailed,
  placesAdded: result.placesAdded,
  placesApiFailed: result.placesApiFailed,
});
```

**stayモード** (`app/api/koyo/stay/route.ts:1245`):
```typescript
// 同様のログを追加
console.log("[koyo-stay] Before integratePlaces:", {
  dbCount: matchedSpots?.length || 0,
  stopIntentType: stopIntent?.type,
  foodCategory: stopIntent?.foodCategory,
  keyword: stopIntent?.foodCategory ?? stopIntent?.keyword ?? stopIntent?.fallbackKeyword,
});

const result = await integratePlaces(matchedSpots, stopIntent);

console.log("[koyo-stay] After integratePlaces:", {
  dbCount: matchedSpots?.filter(s => !s.id?.startsWith("places_")).length || 0,
  placesCount: matchedSpots?.filter(s => s.id?.startsWith("places_")).length || 0,
  placesCalled: result.placesAdded || result.placesApiFailed,
  placesAdded: result.placesAdded,
  placesApiFailed: result.placesApiFailed,
});
```

### ログ出力の統一フォーマット

**推奨フォーマット**:
```typescript
{
  dbCount: number,           // DB候補数
  minRequiredCount: number,   // 最低必要な候補数
  stopIntentType: string,     // stopIntent.type
  foodCategory: string | null, // stopIntent.foodCategory
  keyword: string,            // 使用されたキーワード
  placesCalled: boolean,      // Places APIが呼ばれたか
  placesAdded: boolean,       // Places APIでスポットが追加されたか
  placesApiFailed: boolean,   // Places APIが失敗したか
}
```

---

## まとめ

### 1) スキーマ確認
- SQLクエリを `docs/spot-master-schema-investigation.md` に記載
- 実行して実スキーマを確認してください

### 2) DB側ロジック
- **問題箇所**: `extractAndMatchSpots`（395-460行目）、`getSpotListForPrompt`（50-84行目）
- **提案**: `searchSpotsFromDB()`を1487-1489行目の直後に追加

### 3) Places呼び出しのゲート設計
- **最小変更**: `integratePlaces`に`minRequiredCount`オプションを追加
- **デフォルト**: `dbCount >= 3`の場合はPlaces APIを呼ばない
- **ログ出力**: 各モードで統一フォーマットのログを追加









