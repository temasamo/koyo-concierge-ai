# foodIntent（料理ジャンル要求）の検証結果

## 質問① foodIntentは汎用ジャンル対応か？

**回答: 部分的にハードコードされている**

### detectStopIntentの実装
- `foodCategory`は**特定ジャンルのみ**ハードコードされている
- 対応ジャンル:
  - ラーメン
  - そば（蕎麦）
  - 芋煮
  - 米沢牛
  - 山形牛
  - 冷やしラーメン

### 処理の共通性
- 「蕎麦」「ラーメン」などは`foodCategory`として抽出される
- 「焼肉」は`foodCategory`として抽出されない（`type: "lunch"`のみ）
- 「カフェ」は`type: "cafe"`として扱われ、`foodCategory`は`undefined`

### 結論
- **汎用的ではない**。特定ジャンルのみ個別ハードコードされている
- 新しいジャンル（例：焼肉、寿司）を追加するには`detectStopIntent.ts`の`foodCategoryKeywords`に追加が必要

---

## 質問② DB検索でfoodIntentは必須条件か？

**回答: 必須条件ではない**

### DBクエリ箇所
```typescript
// app/api/koyo/after/route.ts:395-397
const { data: supabaseSpots } = await supabase
  .from("spot_master")
  .select("*");  // ← 全件取得、foodIntentによるフィルタなし
```

### 検索ロジック
1. **全スポットを取得**: `select("*")`で全件取得
2. **AIが返したスポット名とマッチング**: `extractAndMatchSpots`でAIが返したスポット名とDBのスポット名をマッチング
3. **foodIntentは使用されない**: DB検索時点では`foodCategory`は検索条件に含まれていない

### 結論
- **foodIntentは必須条件ではない**
- DB検索では「食べる」などの大分類も使用されていない
- AIが返したスポット名とDBのスポット名をマッチングするのみ
- **「蕎麦以外が混ざるのは仕様通り」**

---

## 質問③ DBで足りない時だけPlacesを呼んでいるか？

**回答: いいえ。stopIntentがあれば必ず呼ばれる**

### integratePlacesの呼び出し条件
```typescript
// app/api/koyo/after/route.ts:1505-1530
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

### 分岐ロジック
- **DB結果の件数に関係なく**、`stopIntent`があれば`integratePlaces`が呼ばれる
- DB結果が0件でも、DB結果が10件でも、`stopIntent`があればPlaces APIが呼ばれる

### 結論
- **DBで足りない時だけ呼ぶ分岐は存在しない**
- `stopIntent`があれば必ずPlaces APIが呼ばれる仕様

---

## 質問④ Places検索にfoodIntentは渡っているか？

**回答: はい。foodCategoryが優先的に使用される**

### Places APIのパラメータ構造
```typescript
// app/api/koyo/_utils/places.ts:162-176
// keyword決定: 優先順位は foodCategory → keyword → fallbackKeyword
const keyword =
  stopIntent.foodCategory ??      // 優先1: foodCategory（例: "蕎麦"）
  stopIntent.keyword ??           // 優先2: keyword
  stopIntent.fallbackKeyword;     // 優先3: fallbackKeyword（例: "ランチ"）

const placeType = stopIntent.placeType || PLACE_TYPE_MAP[stopIntent.type] || "establishment";
// lunch → "restaurant"
// cafe → "cafe"
```

### 実際のAPI呼び出し
```typescript
url.searchParams.set("keyword", keyword);  // 例: "蕎麦"
url.searchParams.set("type", placeType);    // 例: "restaurant"
```

### 結論
- **foodIntent（foodCategory）はPlaces APIのkeywordに反映されている**
- 例: `keyword = "蕎麦"`, `type = "restaurant"`
- ただし、`foodCategory`が`undefined`の場合は`fallbackKeyword`（例: "ランチ"）が使用される

---

## 質問⑤ DB優先ルールは仕様として存在するか？

**回答: コード上には明示されていない**

### システムプロンプトでの言及
```typescript
// app/api/koyo/after/route.ts:129
"- Supabaseのスポット以外は絶対に出さない（推測生成は厳禁）。"
```

### 実装上の動作
- DB検索: AIが返したスポット名とDBのスポット名をマッチング
- Places API: `stopIntent`があれば必ず呼ばれる（DB結果の件数に関係なく）
- 統合: DB結果とPlaces結果を統合して返す

### 結論
- **「DB優先」という明示的なルールはコード上に存在しない**
- システムプロンプトでは「Supabaseのスポット以外は出さない」とあるが、実装ではPlaces APIの結果も統合されている
- 現状は「DB + Places」のハイブリッド方式

---

## 観光スポット全般の要求の場合

### 食事以外のタイプ（cafe, rest, onsen, shop）

**検出される内容**:
- `stopIntent.type`: 検出される（例: "onsen", "shop", "cafe"）
- `stopIntent.foodCategory`: `undefined`（食事系の`lunch`タイプのみ`foodCategory`が設定される）
- `stopIntent.fallbackKeyword`: 設定される（例: "温泉", "お土産", "カフェ"）

**システムプロンプトへの反映**:
- `foodCategory`がある場合のみ特別な指示が追加される（`app/api/koyo/after/route.ts:96-113`）
- 観光スポット全般の要求では`foodCategory`が`undefined`のため、**特別な指示は追加されない**

**DB検索**:
- 食事系と同様に、`stopIntent.type`は検索条件に含まれない
- 全件取得してAIが返したスポット名とマッチングするのみ

**Places API**:
- `stopIntent.type`に基づいて`type`パラメータが設定される:
  - `onsen` → `"establishment"`
  - `shop` → `"store"`
  - `cafe` → `"cafe"`
  - `rest` → `"park"`
- `keyword`は`fallbackKeyword`が使用される（例: "温泉", "お土産"）

### 結論

**観光スポット全般の要求でも、食事系と同様の問題が発生する**:
1. DB検索で`stopIntent.type`は検索条件に含まれない
2. AIが返したスポット名とマッチングするのみ
3. そのため、「温泉がいい」と言っても温泉以外のスポットが混ざる可能性がある

---

## まとめ

### 食事系（lunch）の場合
1. **foodIntentは汎用的ではない** - 特定ジャンルのみハードコード
2. **DB検索でfoodIntentは必須条件ではない** - 全件取得してマッチングのみ
3. **DBで足りない時だけPlacesを呼ぶ分岐はない** - stopIntentがあれば必ず呼ばれる
4. **Places検索にfoodIntentは渡っている** - foodCategoryが優先的に使用される
5. **DB優先ルールは明示されていない** - 現状はハイブリッド方式

### 観光スポット全般（cafe, rest, onsen, shop）の場合
1. **stopIntent.typeは検出される** - ただし、DB検索条件には含まれない
2. **DB検索でstopIntent.typeは必須条件ではない** - 全件取得してマッチングのみ
3. **DBで足りない時だけPlacesを呼ぶ分岐はない** - stopIntentがあれば必ず呼ばれる
4. **Places検索にstopIntent.typeは渡っている** - typeパラメータに反映される
5. **システムプロンプトへの特別な指示は追加されない** - foodCategoryがないため

## 推奨される改善

### 問題点
- 「蕎麦が食べたい」と言っても、DB検索ではfoodIntentが使われず、AIが返したスポット名とマッチングするのみ
- そのため、蕎麦以外のスポットが混ざる可能性がある

### 改善案
1. **DB検索にfoodIntentを反映**
   - `tags`カラムや`category`カラムでfoodIntentをフィルタ
   - または、AIプロンプトでfoodIntentを強調して、AIが適切なスポットを返すようにする

2. **Places APIの呼び出し条件を見直す**
   - DB結果が十分な場合（例: 3件以上）はPlaces APIを呼ばない
   - または、DB結果にfoodIntentに合致するスポットがない場合のみPlaces APIを呼ぶ

