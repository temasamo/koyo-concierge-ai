# Phase2-1 DB優先実装: 現状確認・設計合意・実装差分

## 1) 現状確認: spot_masterの実データ

### 1-1. categoryの実値集計

**確認方法**: `/api/debug/spot-master-stats` エンドポイントを実行

**想定されるcategory値**（既存ドキュメントより）:
- `食べる`
- `自然`
- `遊ぶ`
- `歴史`
- `祭り`
- `自然・遊ぶ`
- `自然・歴史`
- `null`（未設定）

**注意**: `'%観光%'` 前提は危険。実値がバラバラなので部分一致（`LIKE '%キーワード%'`）を使用。

### 1-2. tagsのnull状況確認

**想定**: tagsはほとんどnull（ドキュメントより）

**確認項目**:
- `non_null_tags_count`: nullでないtagsの件数
- `samples`: nullでないtagsのサンプル10件

**設計方針**: tagsが空の前提で`searchSpotsFromDB`を設計（`category`/`name`の部分一致検索を使用）

### 1-3. stopIntent.typeごとのDB絞り込み条件案

#### `lunch` (食事系)

**SQL案**:
```sql
-- foodCategoryがある場合
SELECT * FROM spot_master
WHERE category LIKE '%食べる%'
  AND name LIKE '%蕎麦%'  -- foodCategoryに基づく部分一致
ORDER BY name
LIMIT 10;

-- foodCategoryがない場合（fallbackKeyword使用）
SELECT * FROM spot_master
WHERE category LIKE '%食べる%'
ORDER BY name
LIMIT 10;
```

**Supabase Query案**:
```typescript
let query = supabase
  .from("spot_master")
  .select("*")
  .ilike("category", "%食べる%");

if (stopIntent.foodCategory) {
  query = query.ilike("name", `%${stopIntent.foodCategory}%`);
}

const { data } = await query
  .order("name")
  .limit(10);
```

#### `cafe` (カフェ)

**SQL案**:
```sql
SELECT * FROM spot_master
WHERE category LIKE '%食べる%'
   OR category LIKE '%カフェ%'
   OR name LIKE '%カフェ%'
ORDER BY name
LIMIT 10;
```

**Supabase Query案**:
```typescript
const { data } = await supabase
  .from("spot_master")
  .select("*")
  .or("category.ilike.%食べる%,category.ilike.%カフェ%,name.ilike.%カフェ%")
  .order("name")
  .limit(10);
```

#### `onsen` (温泉)

**SQL案**:
```sql
SELECT * FROM spot_master
WHERE category LIKE '%温泉%'
   OR name LIKE '%温泉%'
ORDER BY name
LIMIT 10;
```

**Supabase Query案**:
```typescript
const { data } = await supabase
  .from("spot_master")
  .select("*")
  .or("category.ilike.%温泉%,name.ilike.%温泉%")
  .order("name")
  .limit(10);
```

#### `shop` (お土産)

**SQL案**:
```sql
SELECT * FROM spot_master
WHERE category LIKE '%観光%'
   OR category LIKE '%お土産%'
   OR name LIKE '%お土産%'
   OR name LIKE '%売店%'
ORDER BY name
LIMIT 10;
```

**Supabase Query案**:
```typescript
const { data } = await supabase
  .from("spot_master")
  .select("*")
  .or("category.ilike.%観光%,category.ilike.%お土産%,name.ilike.%お土産%,name.ilike.%売店%")
  .order("name")
  .limit(10);
```

#### `rest` (休憩・散策)

**SQL案**:
```sql
SELECT * FROM spot_master
WHERE category LIKE '%観光%'
ORDER BY name
LIMIT 10;
```

**Supabase Query案**:
```typescript
const { data } = await supabase
  .from("spot_master")
  .select("*")
  .ilike("category", "%観光%")
  .order("name")
  .limit(10);
```

---

## 2) 設計合意

### 4) extractAndMatchSpots廃止、「候補→LLM選択」への切り替え

**結論**: **OK。Phase2-1で廃止し、DB候補（最大10件）をLLMに渡して`selectedSpotIds`を返させる方式に切り替える。**

**理由**:
- コードがシンプルになる
- メンテナンスコストが低い
- 一貫性が保たれる
- DB優先の設計思想に合致

**後方互換性**: **切る**（Phase2-1で一気に移行）

### 5) Places APIゲート条件

**結論**: **OK。`dbCandidates.length < 3`のときだけPlaces APIを呼ぶ。`integratePlaces`にゲートを追加して共通化する。**

**実装方針**:
- `integratePlaces`関数に`minRequiredCount`パラメータを追加（デフォルト: 3）
- `spots.length < minRequiredCount`のときのみPlaces APIを呼ぶ
- `after`/`before`/`stay`モード共通で使用

### 6) ログフォーマット統一

**統一フォーマット**:
```typescript
{
  stopIntentType: string | null,
  foodCategory: string | null,
  dbCount: number,
  minRequiredCount: number,
  willCallPlaces: boolean,
  placesCalled: boolean,
  placesAdded: boolean,
  placesApiFailed: boolean
}
```

**ログ出力箇所**:
- `searchSpotsFromDB`呼び出し後
- `integratePlaces`呼び出し前後

---

## 3) 実装差分

### 7) searchSpotsFromDB()の実装

**新規追加**: `app/api/koyo/_utils/searchSpotsFromDB.ts`

```typescript
// app/api/koyo/_utils/searchSpotsFromDB.ts
import { getSupabaseClient } from "../after/route"; // または共通化
import type { StopIntent } from "@/types/route";
import type { Spot } from "@/store/spots";

export async function searchSpotsFromDB(params: {
  stopIntent: StopIntent;
  origin?: { lat: number; lng: number };
  destination?: { lat: number; lng: number };
  limit?: number;
}): Promise<Spot[]> {
  const { stopIntent, limit = 10 } = params;
  const supabase = getSupabaseClient();
  
  let query = supabase.from("spot_master").select("*");
  
  // stopIntent.typeごとの条件分岐
  switch (stopIntent.type) {
    case "lunch":
      query = query.ilike("category", "%食べる%");
      if (stopIntent.foodCategory) {
        query = query.ilike("name", `%${stopIntent.foodCategory}%`);
      }
      break;
      
    case "cafe":
      query = query.or("category.ilike.%食べる%,category.ilike.%カフェ%,name.ilike.%カフェ%");
      break;
      
    case "onsen":
      query = query.or("category.ilike.%温泉%,name.ilike.%温泉%");
      break;
      
    case "shop":
      query = query.or("category.ilike.%観光%,category.ilike.%お土産%,name.ilike.%お土産%,name.ilike.%売店%");
      break;
      
    case "rest":
      query = query.ilike("category", "%観光%");
      break;
      
    default:
      // デフォルト: 全件取得（後方互換性）
      break;
  }
  
  const { data, error } = await query
    .order("name")
    .limit(limit);
  
  if (error) {
    console.error("[searchSpotsFromDB] Supabase error:", error);
    return [];
  }
  
  return (data || []).map(spot => ({
    id: spot.id,
    name: spot.name,
    lat: spot.lat,
    lng: spot.lng,
    category: spot.category,
    city: spot.city,
    season: spot.season,
    drive_time: spot.drive_time,
    walk_time: spot.walk_time,
    stay_time: spot.stay_time,
    url: spot.url,
    tags: spot.tags,
    drive_minutes: spot.drive_time
      ? parseInt(spot.drive_time.match(/\d+/)?.[0] || "0")
      : null,
    source: "db",
  }));
}
```

### 8) after/route.tsの変更箇所

**変更前** (`app/api/koyo/after/route.ts:1487-1565`):
```typescript
// plan配列を抽出
let planArray = await extractPlanFromReply(reply);
let matchedSpots: any[] | undefined;

if (planArray && planArray.length > 0) {
  matchedSpots = await extractAndMatchSpots(planArray);
}

// 途中立ち寄り意図を検出してPlaces APIを呼び出す
const stopIntentMessage = findStopIntentMessage(userMessages) || userMessage;
const stopIntent = detectStopIntent(stopIntentMessage);

if (stopIntent) {
  const result = await integratePlaces(
    matchedSpots || [],
    stopIntent,
    KOYO_COORDINATES,
    destinationCoords
  );
  matchedSpots = result.spots;
  placesApiFailed = result.placesApiFailed;
  placesAdded = result.placesAdded;
}
```

**変更後**:
```typescript
// stopIntent検出（先に検出）
const stopIntentMessage = findStopIntentMessage(userMessages) || userMessage;
const stopIntent = detectStopIntent(stopIntentMessage);

// DBから候補を検索
let dbCandidates: Spot[] = [];
if (stopIntent) {
  dbCandidates = await searchSpotsFromDB({
    stopIntent,
    origin: KOYO_COORDINATES,
    destination: destinationCoords,
    limit: 10,
  });
  
  // ログ出力
  console.log("[koyo-after] DB search result:", {
    stopIntentType: stopIntent.type,
    foodCategory: stopIntent.foodCategory || null,
    dbCount: dbCandidates.length,
    minRequiredCount: 3,
    willCallPlaces: dbCandidates.length < 3,
  });
}

// 候補IDリストをLLMに渡す
const candidateIds = dbCandidates.map(s => s.id);
const systemPrompt = await getSystemPromptWithCandidates(stopIntent, candidateIds, dbCandidates);

const completion = await openai.chat.completions.create({
  model: CHAT_MODEL,
  messages: [
    { role: "system", content: systemPrompt },
    ...userMessages,
  ],
  response_format: { type: "json_object" },
});

const reply = completion.choices[0]?.message?.content ?? "";

// LLMは候補IDから選択
const selectedIds = extractSelectedSpotIds(reply, candidateIds);
let matchedSpots = dbCandidates.filter(s => selectedIds.includes(s.id));

// Places API呼び出し（dbCandidates < 3の場合のみ）
let placesApiFailed = false;
let placesAdded = false;
if (stopIntent && matchedSpots.length < 3) {
  const result = await integratePlaces(
    matchedSpots,
    stopIntent,
    KOYO_COORDINATES,
    destinationCoords,
    3 // minRequiredCount
  );
  matchedSpots = result.spots;
  placesApiFailed = result.placesApiFailed;
  placesAdded = result.placesAdded;
  
  // ログ出力
  console.log("[koyo-after] Places integration result:", {
    stopIntentType: stopIntent.type,
    foodCategory: stopIntent.foodCategory || null,
    dbCount: dbCandidates.length,
    minRequiredCount: 3,
    willCallPlaces: true,
    placesCalled: true,
    placesAdded: result.placesAdded,
    placesApiFailed: result.placesApiFailed,
  });
}
```

### 9) integratePlacesの変更

**変更前** (`app/api/koyo/_utils/places.ts:299-385`):
```typescript
export async function integratePlaces(
  spots: any[],
  stopIntent: StopIntent | null,
  origin?: { lat: number; lng: number },
  destination?: { lat: number; lng: number }
): Promise<{ spots: any[]; placesApiFailed: boolean; placesAdded: boolean }> {
  // spotsが空でもstopIntentがあればPlaces APIを呼ぶ
  // ...
}
```

**変更後**:
```typescript
export async function integratePlaces(
  spots: any[],
  stopIntent: StopIntent | null,
  origin?: { lat: number; lng: number },
  destination?: { lat: number; lng: number },
  minRequiredCount: number = 3 // 新規追加
): Promise<{ spots: any[]; placesApiFailed: boolean; placesAdded: boolean }> {
  // spotsが空でもstopIntentがあればPlaces APIを呼ぶ（旧仕様）
  // ただし、spots.length >= minRequiredCountの場合はPlaces APIを呼ばない（新仕様）
  
  if (spots.length >= minRequiredCount) {
    console.log("[koyo-places] Skipping Places API: spots.length >= minRequiredCount", {
      spotsCount: spots.length,
      minRequiredCount,
    });
    return { spots, placesApiFailed: false, placesAdded: false };
  }
  
  // 以下、既存の処理...
}
```

### 10) 新規関数: getSystemPromptWithCandidates

**追加**: `app/api/koyo/after/route.ts`

```typescript
async function getSystemPromptWithCandidates(
  stopIntent: StopIntent | null,
  candidateIds: string[],
  candidateSpots: Spot[]
): Promise<string> {
  const basePrompt = await getSystemPrompt(stopIntent);
  
  // 候補IDリストをプロンプトに含める
  const candidateListText = candidateIds
    .map((id, idx) => {
      const spot = candidateSpots.find(s => s.id === id);
      return `[${idx + 1}] ${spot?.name || "不明"} (ID: ${id})`;
    })
    .join("\n");
  
  return `${basePrompt}

【候補スポット（選択してください）】
以下の候補から1〜3件を選択してください。

${candidateListText}

【選択方法】
JSON形式で返してください:
{
  "selectedSpotIds": ["id1", "id2"]
}

重要: selectedSpotIdsには、上記候補IDリストに含まれるIDのみを指定してください。`;
}
```

### 11) 新規関数: extractSelectedSpotIds

**追加**: `app/api/koyo/after/route.ts`

```typescript
function extractSelectedSpotIds(reply: string, candidateIds: string[]): string[] {
  try {
    const cleanedReply = reply.replace(/```json\s*/g, '').replace(/```\s*/g, '');
    const jsonResponse = JSON.parse(cleanedReply);
    
    if (jsonResponse.selectedSpotIds && Array.isArray(jsonResponse.selectedSpotIds)) {
      // 候補IDリストに含まれるもののみを返す
      return jsonResponse.selectedSpotIds.filter((id: string) => candidateIds.includes(id));
    }
  } catch (e) {
    console.warn("[extractSelectedSpotIds] Failed to parse JSON:", e);
  }
  
  return [];
}
```

---

## 4) 影響範囲（8）

### 4-1. 既存機能への影響

#### ✅ 影響なし（後方互換性維持）
- **ルート生成**: 既存のルート生成ロジックは維持（`routePlan`/`routeInfo`/`spots`の構造は変更なし）
- **フロントエンド**: レスポンス形式は変更なし（`spots`配列は同じ形式）
- **Places API統合**: `integratePlaces`の戻り値は変更なし（`minRequiredCount`はオプショナル）

#### ⚠️ 動作変更（意図的な変更）
- **候補生成**: `extractAndMatchSpots`（LLMが自由に名前生成→DB名前マッチ）から「DB候補→LLM選択」方式に変更
  - **影響**: LLMが生成するスポット名が、DBに存在しない可能性がなくなる
  - **メリット**: DBに存在しないスポットが返されることがなくなる
- **Places API呼び出し**: `dbCandidates.length < 3`のときのみ呼ぶ（以前は`stopIntent`があれば常に呼んでいた）
  - **影響**: DB候補が3件以上ある場合、Places APIは呼ばれない
  - **メリット**: APIコスト削減、DB優先の設計思想に合致

#### ❌ 削除される機能
- **`extractAndMatchSpots`関数**: Phase2-1で削除
  - **影響**: この関数を使用している他のモード（`before`/`stay`）も同様に変更が必要
  - **対応**: `before`/`stay`モードも同様に「DB候補→LLM選択」方式に移行（別PRで対応）

### 4-2. できなくなること

#### 1. LLMが自由にスポット名を生成する機能
- **以前**: LLMが「○○レストラン」など自由に名前を生成し、DBで名前マッチング
- **以後**: LLMはDB候補IDリストから選択するのみ
- **影響**: DBに存在しないスポット名を生成することはできなくなる（これは意図的な変更）

#### 2. DB候補が3件以上ある場合のPlaces API呼び出し
- **以前**: `stopIntent`があれば常にPlaces APIを呼ぶ
- **以後**: `dbCandidates.length < 3`のときのみPlaces APIを呼ぶ
- **影響**: DB候補が十分な場合、Places APIの結果は統合されない
- **メリット**: DB優先の設計思想に合致、APIコスト削減

### 4-3. 新しくできること

#### 1. DB優先の候補生成
- DBから`stopIntent`に基づいて候補を検索し、LLMが選択する方式
- **メリット**: DBに存在しないスポットが返されることがなくなる

#### 2. Places APIの条件付き呼び出し
- `dbCandidates.length < 3`のときのみPlaces APIを呼ぶ
- **メリット**: APIコスト削減、DB優先の設計思想に合致

#### 3. 統一ログフォーマット
- すべてのログが統一フォーマットで出力される
- **メリット**: デバッグが容易になる

### 4-4. 他モードへの影響

#### `before`モード (`app/api/koyo/before/route.ts`)
- **現状**: `extractAndMatchSpots`を使用
- **対応**: Phase2-1で`after`モードと同様に変更（別PRで対応）

#### `stay`モード (`app/api/koyo/stay/route.ts`)
- **現状**: `extractAndMatchSpots`を使用
- **対応**: Phase2-1で`after`モードと同様に変更（別PRで対応）

### 4-5. テストケース

#### テストが必要なケース
1. **DB候補が3件以上ある場合**: Places APIが呼ばれないことを確認
2. **DB候補が2件以下の場合**: Places APIが呼ばれることを確認
3. **LLMが候補IDから選択する場合**: `selectedSpotIds`が正しく解析されることを確認
4. **LLMが候補ID以外を返した場合**: フィルタリングされることを確認
5. **`stopIntent`がない場合**: 既存の動作が維持されることを確認

---

## 5) 実装順序

1. **`searchSpotsFromDB`関数の実装** (`app/api/koyo/_utils/searchSpotsFromDB.ts`)
2. **`getSystemPromptWithCandidates`関数の実装** (`app/api/koyo/after/route.ts`)
3. **`extractSelectedSpotIds`関数の実装** (`app/api/koyo/after/route.ts`)
4. **`integratePlaces`の変更** (`app/api/koyo/_utils/places.ts`)
5. **`after/route.ts`のメイン処理変更** (`app/api/koyo/after/route.ts`)
6. **`extractAndMatchSpots`の削除** (`app/api/koyo/after/route.ts`)
7. **ログフォーマット統一** (各関数)
8. **テスト** (上記テストケース)

---

## 6) 確認事項

### 実データ確認が必要な項目
1. **categoryの実値集計**: `/api/debug/spot-master-stats`を実行して確認
2. **tagsのnull状況**: 同エンドポイントで確認
3. **category値のバリエーション**: 実データに基づいて`LIKE`条件を調整

### 設計合意が必要な項目
1. **`minRequiredCount`のデフォルト値**: 3でOKか？
2. **`foodCategory`辞書の拡張**: 「焼肉」「寿司」「スイーツ」などを追加するか？
3. **後方互換性**: `extractAndMatchSpots`を完全に削除するか、一時的に残すか？

---

## 7) まとめ

### 実装方針
- **DB優先**: DBから候補を検索し、LLMが選択する方式
- **Places APIゲート**: `dbCandidates.length < 3`のときのみ呼ぶ
- **統一ログフォーマット**: すべてのログを統一フォーマットで出力
- **後方互換性**: 切る（Phase2-1で一気に移行）

### 影響範囲
- **`after`モード**: 主要な変更箇所
- **`before`/`stay`モード**: 後続PRで対応
- **フロントエンド**: 影響なし（レスポンス形式は変更なし）

### リスク
- **LLMが候補IDから選択できない場合**: フォールバック処理が必要（現状は空配列を返す）
- **DB候補が0件の場合**: Places APIに依存（既存の動作と同じ）



