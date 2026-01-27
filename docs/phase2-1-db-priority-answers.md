# Phase2-1 DB優先設計 - 回答

## Q1. tagsが空の前提でsearchSpotsFromDBを設計し直し

### stopIntent.typeごとのwhere条件案

#### 1. `lunch` (食事系)

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
  .ilike("category", "%食べる%"); // categoryに"食べる"を含む

if (stopIntent.foodCategory) {
  // foodCategoryがある場合: nameで部分一致
  query = query.ilike("name", `%${stopIntent.foodCategory}%`);
}

const { data } = await query
  .order("name")
  .limit(10);
```

#### 2. `cafe` (カフェ)

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

#### 3. `onsen` (温泉)

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

#### 4. `shop` (お土産)

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

#### 5. `rest` (休憩・散策)

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

### 実装案: `searchSpotsFromDB`関数

```typescript
async function searchSpotsFromDB(params: {
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
        // foodCategoryがある場合: nameで部分一致
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

### categoryの実値がバラバラでも動く設計

**方針**: `LIKE '%キーワード%'`で部分一致検索を使用
- `category LIKE '%食べる%'` → "食べる", "食べ物", "食事"などにマッチ
- `category LIKE '%観光%'` → "観光", "観光スポット"などにマッチ
- 実値がバラバラでも柔軟に対応可能

---

## Q2. "温泉"がDBに無い場合の扱い

### 仕様

**DBに温泉カテゴリが存在しない/少ない場合**:
- `dbCandidates.length < 3` のときのみ Places APIを呼ぶ
- **OK**: この仕様で問題なし

### ログ出力

```typescript
// searchSpotsFromDB呼び出し後
const dbCandidates = await searchSpotsFromDB({ stopIntent, limit: 10 });

console.log("[koyo-after] DB search result:", {
  stopIntentType: stopIntent.type,
  foodCategory: stopIntent.foodCategory,
  dbCount: dbCandidates.length,
  minRequiredCount: 3,
  willCallPlaces: dbCandidates.length < 3,
});

if (dbCandidates.length < 3) {
  console.log("[koyo-after] DB candidates insufficient, will call Places API", {
    dbCount: dbCandidates.length,
    reason: stopIntent.type === "onsen" 
      ? "温泉カテゴリがDBに存在しない/少ない"
      : "DB候補が不足",
  });
}
```

### 返却メッセージ（replyへの追記）

```typescript
// integratePlaces呼び出し後
if (result.placesAdded && dbCandidates.length < 3) {
  const supplementMessage = stopIntent.type === "onsen"
    ? "\n\n※DBに温泉スポットが少ないため、周辺検索で候補を追加しました。"
    : "\n\n※DBに候補が少ないため、周辺検索で候補を追加しました。";
  
  cleanReply = cleanReply + supplementMessage;
}
```

**または、より自然な表現**:
```typescript
if (result.placesAdded && dbCandidates.length < 3) {
  const supplementMessage = stopIntent.type === "onsen"
    ? "\n\n（周辺の温泉スポットも検索して候補に追加しました）"
    : "\n\n（周辺検索で候補を追加しました）";
  
  cleanReply = cleanReply + supplementMessage;
}
```

---

## Q3. extractAndMatchSpots廃止、「候補→LLM選択」への置き換え

### 差分（変更箇所）

#### 1. 新規関数: `searchSpotsFromDB` (上記Q1参照)

#### 2. プロンプト生成の変更

**現状** (`getSpotListForPrompt`):
```typescript
// 全スポット一覧をプロンプトに含める
const spotListText = await getSpotListForPrompt();
```

**変更後** (`getSystemPromptWithCandidates`):
```typescript
async function getSystemPromptWithCandidates(
  stopIntent: StopIntent | null,
  candidateIds: string[],
  candidateSpots: Spot[]
): Promise<string> {
  // 候補IDリストをプロンプトに含める
  const candidateListText = candidateIds
    .map((id, idx) => {
      const spot = candidateSpots.find(s => s.id === id);
      return `[${idx + 1}] ${spot.name} (ID: ${id})`;
    })
    .join("\n");
  
  return `
【候補スポット（選択してください）】
以下の候補から1〜3件を選択してください。

${candidateListText}

【選択方法】
JSON形式で返してください:
{
  "selectedSpotIds": ["id1", "id2"]
}
  `;
}
```

#### 3. レスポンス解析の変更

**現状** (`extractPlanFromReply`):
```typescript
const planArray = await extractPlanFromReply(reply);
const matchedSpots = await extractAndMatchSpots(planArray);
```

**変更後** (`extractSelectedSpotIds`):
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

// 使用例
const selectedIds = extractSelectedSpotIds(reply, candidateIds);
const matchedSpots = dbCandidates.filter(s => selectedIds.includes(s.id));
```

#### 4. メイン処理の変更

**現状** (`app/api/koyo/after/route.ts:1487-1543`):
```typescript
if (planArray && planArray.length > 0) {
  matchedSpots = await extractAndMatchSpots(planArray);
}

// stopIntent検出
const stopIntent = detectStopIntent(stopIntentMessage);

if (stopIntent) {
  const result = await integratePlaces(matchedSpots || [], stopIntent, ...);
  matchedSpots = result.spots;
}
```

**変更後**:
```typescript
// stopIntent検出（先に検出）
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
matchedSpots = dbCandidates.filter(s => selectedIds.includes(s.id));

// Places API呼び出し（dbCandidates < 3の場合のみ）
if (stopIntent && matchedSpots.length < 3) {
  const result = await integratePlaces(matchedSpots, stopIntent, ...);
  matchedSpots = result.spots;
}
```

### 後方互換性の判断材料

#### 後方互換を残す場合

**メリット**:
- 既存の動作が保証される
- 段階的な移行が可能
- バグ発生時のロールバックが容易

**デメリット**:
- コードが複雑になる（2つのパスを維持）
- テストケースが増える
- メンテナンスコストが高い

**実装案**:
```typescript
// フラグで切り替え
const USE_DB_PRIORITY_SEARCH = process.env.USE_DB_PRIORITY_SEARCH === "true";

if (USE_DB_PRIORITY_SEARCH) {
  // 新方式: DB優先検索
  dbCandidates = await searchSpotsFromDB({ stopIntent, ... });
  // ...
} else {
  // 旧方式: extractAndMatchSpots
  if (planArray && planArray.length > 0) {
    matchedSpots = await extractAndMatchSpots(planArray);
  }
  // ...
}
```

#### Phase2-1で切る場合

**メリット**:
- コードがシンプルになる
- メンテナンスコストが低い
- 一貫性が保たれる

**デメリット**:
- 既存の動作が変わる（リスク）
- ロールバックが困難

**判断材料**:
1. **既存の動作への依存度**: 他の機能が`extractAndMatchSpots`に依存しているか
2. **テストカバレッジ**: 新方式のテストが十分か
3. **リリースタイミング**: Phase2-1で一気に切るか、段階的に移行するか

**推奨**: **Phase2-1で切る**（理由: 新方式の方が明確で保守しやすい）

---

## まとめ

### Q1. searchSpotsFromDB設計
- tagsが空の前提で、category/nameの部分一致検索を使用
- stopIntent.typeごとにwhere条件を定義
- foodCategoryがある場合はnameで部分一致

### Q2. "温泉"がDBに無い場合
- `dbCandidates.length < 3`のときのみPlaces APIを呼ぶ
- ログと返却メッセージを追加

### Q3. extractAndMatchSpots廃止
- 「候補→LLM選択」方式に統一
- 後方互換は切ることを推奨（コードの簡潔性のため）






