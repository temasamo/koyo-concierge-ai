# spot_master 実データ確認結果

**確認日時**: 2024年（実データ取得時点）
**確認方法**: `/api/debug/spot-master-stats` エンドポイント

## 1. categoryの実値集計

| category | count |
|----------|-------|
| 歴史 | 10 |
| 自然・遊ぶ | 8 |
| 自然 | 4 |
| 食べる | 4 |
| 祭り | 4 |
| 自然・歴史 | 2 |
| 遊ぶ | 1 |
| **合計** | **33** |

### 重要な観察
- **複合カテゴリ**: `自然・遊ぶ`, `自然・歴史` など、複数のカテゴリを`・`で結合した形式がある
- **部分一致が必要**: `'%観光%'` のような前提は危険。実値は `食べる`, `自然`, `遊ぶ`, `歴史`, `祭り` など
- **カテゴリのバリエーション**: 単一カテゴリ（`食べる`, `自然`）と複合カテゴリ（`自然・遊ぶ`）が混在

### 検索方針
- `category LIKE '%食べる%'` → `食べる` にマッチ（複合カテゴリにもマッチする可能性は低いが、安全のため部分一致を使用）
- `category LIKE '%自然%'` → `自然`, `自然・遊ぶ`, `自然・歴史` にマッチ
- `category LIKE '%遊ぶ%'` → `遊ぶ`, `自然・遊ぶ` にマッチ
- `category LIKE '%歴史%'` → `歴史`, `自然・歴史` にマッチ

## 2. tagsのnull状況

| 項目 | 値 |
|------|-----|
| total | 33 |
| nonNullCount | **0** |
| nullCount | **33** |
| samples | []（空） |

### 結論
- **tagsは全てnull**: tagsベースの検索は使用不可
- **設計方針**: `category`/`name`の部分一致検索を使用する

## 3. カラム一覧

```
id, name, category, city, season, drive_time, walk_time, stay_time, lat, lng, url, tags, created_at
```

### 確認済みカラム
- `id`: スポットID
- `name`: スポット名
- `category`: カテゴリ（null可）
- `city`: 市区町村（null可）
- `season`: 季節（null可）
- `drive_time`: 車での所要時間（null可）
- `walk_time`: 徒歩での所要時間（null可）
- `stay_time`: 滞在時間（null可）
- `lat`: 緯度（null可）
- `lng`: 経度（null可）
- `url`: URL（null可）
- `tags`: タグ（**全てnull**）
- `created_at`: 作成日時

### 未確認カラム（コード上で使用されているが、DBに存在するか不明）
- `description`: Spot型には`description?: string`があるが、DBカラムの存在は未確認
- `address`: Spot型には`address?: string`があるが、DBカラムの存在は未確認
- `sub_category`: コード上では見当たらない

## 4. stopIntent.typeごとのDB絞り込み条件（実データに基づく修正案）

### `lunch` (食事系)

**実データ**: `category = '食べる'` が4件存在

**SQL案**:
```sql
-- foodCategoryがある場合
SELECT * FROM spot_master
WHERE category LIKE '%食べる%'
  AND name LIKE '%蕎麦%'  -- foodCategoryに基づく部分一致
ORDER BY name
LIMIT 10;

-- foodCategoryがない場合
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

### `cafe` (カフェ)

**実データ**: `category = '食べる'` が4件存在（カフェ専用カテゴリは存在しない）

**SQL案**:
```sql
SELECT * FROM spot_master
WHERE category LIKE '%食べる%'
   OR name LIKE '%カフェ%'
ORDER BY name
LIMIT 10;
```

**Supabase Query案**:
```typescript
const { data } = await supabase
  .from("spot_master")
  .select("*")
  .or("category.ilike.%食べる%,name.ilike.%カフェ%")
  .order("name")
  .limit(10);
```

### `onsen` (温泉)

**実データ**: `category`に「温泉」は存在しない（0件）

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

**注意**: DBに温泉カテゴリが存在しないため、`dbCandidates.length < 3`の条件でPlaces APIを呼ぶ必要がある。

### `shop` (お土産)

**実データ**: `category`に「お土産」専用カテゴリは存在しない。`category = '観光'`も存在しない。

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

**注意**: 実データでは`category = '観光'`は存在しないため、`name`での部分一致に依存する可能性が高い。

### `rest` (休憩・散策)

**実データ**: `category = '自然'` が4件、`category = '自然・遊ぶ'` が8件、`category = '遊ぶ'` が1件存在

**SQL案**:
```sql
SELECT * FROM spot_master
WHERE category LIKE '%自然%'
   OR category LIKE '%遊ぶ%'
ORDER BY name
LIMIT 10;
```

**Supabase Query案**:
```typescript
const { data } = await supabase
  .from("spot_master")
  .select("*")
  .or("category.ilike.%自然%,category.ilike.%遊ぶ%")
  .order("name")
  .limit(10);
```

## 5. 実データに基づく設計方針

### 5-1. category検索の注意点

1. **複合カテゴリの扱い**:
   - `自然・遊ぶ` は `category LIKE '%自然%'` と `category LIKE '%遊ぶ%'` の両方にマッチ
   - 重複を避けるため、`DISTINCT`または`GROUP BY`を使用するか、アプリケーション側で重複除去

2. **部分一致の使用**:
   - `category = '食べる'` のような完全一致ではなく、`category LIKE '%食べる%'` を使用
   - 実データのバリエーションに対応するため

3. **カテゴリが存在しない場合**:
   - `onsen`（温泉）: DBに存在しない → Places APIに依存
   - `shop`（お土産）: `category = '観光'`は存在しない → `name`での部分一致に依存

### 5-2. tags検索の扱い

- **tagsは全てnull**: tagsベースの検索は使用不可
- **代替手段**: `category`/`name`の部分一致検索を使用

### 5-3. 実装時の推奨事項

1. **DB検索結果が少ない場合のフォールバック**:
   - `dbCandidates.length < 3` のときのみPlaces APIを呼ぶ
   - 特に`onsen`（温泉）はDBに存在しないため、Places APIに依存

2. **ログ出力**:
   - `dbCount`, `minRequiredCount`, `willCallPlaces` をログに出力
   - 特に`onsen`の場合は「DBに温泉カテゴリが存在しないため、Places APIを呼びます」というログを出力

3. **ユーザーメッセージ**:
   - `onsen`でPlaces APIを呼んだ場合、「DBに温泉スポットが少ないため、周辺検索で候補を追加しました」というメッセージを追加

## 6. まとめ

### 実データの特徴
- **category**: 33件中、`歴史`が最多（10件）、複合カテゴリ（`自然・遊ぶ`など）が存在
- **tags**: 全てnull（0件）
- **カラム**: `id`, `name`, `category`, `city`, `season`, `drive_time`, `walk_time`, `stay_time`, `lat`, `lng`, `url`, `tags`, `created_at`

### 設計方針
- **category検索**: 部分一致（`LIKE '%キーワード%'`）を使用
- **tags検索**: 使用不可（全てnull）
- **Places API**: `dbCandidates.length < 3`のときのみ呼ぶ
- **特に`onsen`**: DBに存在しないため、Places APIに依存



