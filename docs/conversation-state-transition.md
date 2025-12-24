# 会話状態遷移と入力パース仕様（コード根拠）

## 1. モード別Intent分類と優先順位

### Beforeモード (`app/api/koyo/before/route.ts`)

| 優先順位 | Intent | 検出関数 | 条件 | コード行 |
|---------|-------|---------|------|---------|
| 1 | `hasOrigin` | `currentOrigin.type !== null` | `userState.origin`が確定済み | 644-649行目 |
| 2 | `originSelection` | `parseOriginSelection(userMessage)` | A〜Gの選択肢が解析できた | 659行目 |
| 3 | `isGSelected` | `userMessage.trim().toUpperCase() === "G"` | "G"が明示的に選択された | 777行目 |
| 4 | `originInputMode === "free"` | `userState.originInputMode === "free"` | 自由入力モード中 | 924行目 |
| 5 | `isPreCheckinIntent` | `detectPreCheckinIntent(userMessage)` | Pre-Checkin関連キーワード | 658行目 |
| 6 | `stopIntent` | `detectStopIntentFromUtils(userMessage)` | 立ち寄り意図（lunch/cafe/rest/onsen/shop） | 699, 829, 963, 1162行目 |
| 7 | 通常Before | 上記すべてがfalse | 通常のBeforeモード | 1060-1356行目 |

**処理フロー（Beforeモード）:**
```
1. hasOrigin === true → Aセクション（Pre-Checkinプラン生成）
2. originSelection !== null → Cセクション（A〜E選択処理）
3. isGSelected === true → Dセクション（G選択処理）
4. originInputMode === "free" || isPreCheckinIntent || wasGSelectedInHistory → Dセクション（自由入力処理）
5. !hasOrigin && !originSelection && originInputMode !== "free" → Bセクション（origin質問）
6. 上記すべてがfalse → Eセクション（通常Before）
```

### Stayモード (`app/api/koyo/stay/route.ts`)

| 優先順位 | Intent | 検出関数 | 条件 | コード行 |
|---------|-------|---------|------|---------|
| 1 | `stopIntent` | `detectStopIntent(userMessage)` | 立ち寄り意図（lunch/cafe/rest/onsen/shop） | 1400行目 |
| 2 | `isFacilityQuery` | `isFacilityQuery(userMessage)` | 施設利用情報の問い合わせ | 1408行目 |
| 3 | デフォルト | 上記すべてがfalse | 外出プラン（Stay Planner） | 1414行目 |

**処理フロー（Stayモード）:**
```
1. stopIntent !== null → handleStayPlanner（外出プラン）
2. isFacilityQuery === true → handleFacilityOperation（館内施設案内）
3. 上記すべてがfalse → handleStayPlanner（デフォルト：外出プラン）
```

**重要:** `stopIntent`が最優先。`isFacilityQuery`は「利用時間」「何時まで」などの運用情報のみを対象（44-66行目）。

### Afterモード (`app/api/koyo/after/route.ts`)

| 優先順位 | Intent | 検出関数 | 条件 | コード行 |
|---------|-------|---------|------|---------|
| 1 | `hasDestination` | `currentDestination.type !== null` | `userState.destination`が確定済み | 709-715行目 |
| 2 | `prefSelection` | 県境選択（①/②/③/④） | 数字記号で県境が選択された | 777-794行目 |
| 3 | `originSelection` | `parseOriginSelection(userMessage)` | A〜Eの選択肢が解析できた | 825行目 |
| 4 | `isOtherSelected` | "F" / "その他" | Fが選択された | 828-831行目 |
| 5 | `stopIntent` | `detectStopIntent(userMessage)` | 立ち寄り意図（lunch/cafe/rest/onsen/shop） | 932行目 |
| 6 | デフォルト | 上記すべてがfalse | destination質問 | 864-880行目 |

**処理フロー（Afterモード）:**
```
1. hasDestination === true → Aセクション（プラン生成）
2. prefSelection !== undefined → 県境をdestinationに設定
3. originSelection !== null && !useCurrentLocation → A〜Eをdestinationに設定
4. isOtherSelected === true → 県境選択を促す
5. 上記すべてがfalse → destination質問（A〜F選択肢）
```

---

## 2. Beforeモードで「蕎麦が食べたい」だけでプラン作成フローに入る仕様

### 現行実装の動作

**「蕎麦が食べたい」だけではプラン作成フローに入らない。**

**理由:**
- Beforeモードでは`hasOrigin === false`の場合、必ずorigin質問（Bセクション）が実行される（1065行目）
- `stopIntent`は検出されるが、プラン生成前にoriginが必要

**origin選択質問が出る条件:**
```typescript
// 1065行目
if (!hasOrigin && !originSelection && originInputMode !== "free") {
  // origin質問を返す
  return NextResponse.json({
    mode: "precheckin-origin-select",
    reply: "チェックイン前の観光プランをお作りしますね！\nまず、出発地を教えてください。\nA. 山形駅\n..."
  });
}
```

**条件:**
- `hasOrigin === false`（origin未確定）
- `originSelection === null`（A〜Gが選択されていない）
- `originInputMode !== "free"`（自由入力モード中でない）

**「蕎麦が食べたい」の処理フロー:**
```
1. userMessage = "蕎麦が食べたい"
2. stopIntent = detectStopIntent("蕎麦が食べたい") → { type: "lunch", foodCategory: "そば" }
3. hasOrigin = false（origin未確定）
4. originSelection = parseOriginSelection("蕎麦が食べたい") → null（A〜Gに該当しない）
5. originInputMode = undefined（自由入力モード中でない）
6. → Bセクション実行：origin質問を返す
7. ユーザーが「A」を選択
8. originSelection = parseOriginSelection("A") → { name: "山形駅", lat: ..., lng: ... }
9. → Cセクション実行：プラン生成（stopIntentは履歴から検出）
```

---

## 3. origin選択（A〜G）の入力パース仕様

### `parseOriginSelection`関数 (`lib/koyo/precheckin/origins.ts`)

| 入力パターン | パース結果 | コード行 | 備考 |
|------------|----------|---------|------|
| `"A"` | `{ name: "山形駅", lat: ..., lng: ... }` | 36-39行目 | ラベル直接指定 |
| `"A."` | `null` | 36-39行目 | ピリオド付きは未対応 |
| `"A "` | `{ name: "山形駅", lat: ..., lng: ... }` | 34行目（trim処理） | スペースはtrimされる |
| `"山形駅"` | `{ name: "山形駅", lat: ..., lng: ... }` | 42-47行目 | 名称完全一致 |
| `"空港"` | `{ name: "山形空港", lat: ..., lng: ... }` | 49-62行目 | 部分一致（partialMatches） |
| `"現在地で"` | `{ useCurrentLocation: true }` | 64-68行目 | 現在地指定キーワード |

**部分一致マッピング（50-56行目）:**
- `"空港"` → B（山形空港）
- `"駅"` → A（山形駅）
- `"かみのやま"` → C（かみのやま温泉駅）
- `"蔵王"` → D（山形蔵王IC）
- `"温泉"` → E（かみのやま温泉IC）

**現在地指定キーワード（65行目）:**
- `"現地"`, `"現在地"`, `"GPS"`, `"HERE"`, `"ここ"`, `"今いる場所"`, `"現在の場所"`

**失敗時の分岐（Beforeモード）:**
- `originSelection === null` かつ `originInputMode !== "free"` → Bセクション（origin質問を再表示）
- `originInputMode === "free"` → Dセクション（`resolveOriginFromFreeInput`で県名推定）

---

## 4. 質問中の状態管理（userState）

### Beforeモード

| 状態フィールド | 型 | 用途 | コード行 |
|-------------|----|------|---------|
| `origin` | `OriginInfo` | 出発地の確定状態 | 632行目 |
| `originInputMode` | `"free" \| undefined` | 自由入力モード中かどうか | 633行目 |

**`OriginInfo`型（`store/spots.ts`）:**
```typescript
type OriginInfo = {
  type: "pref-boundary" | "fixed" | "current" | null;
  pref: "miyagi" | "fukushima" | "akita" | "niigata" | null;
  lat: number | null;
  lng: number | null;
  name?: string | null;
};
```

**状態遷移:**
- `origin.type === null` → origin未確定（Bセクションで質問）
- `origin.type !== null` → origin確定（A/C/Dセクションでプラン生成）
- `originInputMode === "free"` → 自由入力モード中（Dセクションで処理、Bセクションをスキップ）
- `originInputMode === undefined` → 通常モード（BセクションでA〜G選択肢を表示）

**`originInputMode`の設定/削除:**
- 設定: `userMessage === "G"` の時（906-920行目）
- 削除: `resolveOriginFromFreeInput`が`resolved`を返した時（1008-1021行目、`originInputMode`を含めない = 削除を意味する）

### Afterモード

| 状態フィールド | 型 | 用途 | コード行 |
|-------------|----|------|---------|
| `destination` | `OriginInfo` | 最終目的地の確定状態 | 700行目 |

**状態遷移:**
- `destination.type === null` → destination未確定（Bセクションで質問）
- `destination.type !== null` → destination確定（Aセクションでプラン生成）

### Stayモード

| 状態フィールド | 型 | 用途 | コード行 |
|-------------|----|------|---------|
| `gender` | `"male" \| "female" \| undefined` | 性別（施設案内用） | 1375行目 |

**状態遷移:**
- `gender === undefined` かつ `requiresGender === true` → 性別質問（1107-1121行目）
- `gender !== undefined` → 施設案内を実行

---

## 5. 「Aを返したら謝罪になる」ケースの条件

### 問題の発生条件

**Beforeモードで以下の条件がすべて満たされた場合:**

1. `hasOrigin === false`（origin未確定）
2. `originSelection === null`（`parseOriginSelection("A")`が`null`を返す）
3. `originInputMode !== "free"`（自由入力モード中でない）
4. `isGSelected === false`（"G"が選択されていない）

**→ Bセクション（780行目）が実行され、origin質問が再表示される**

**しかし、`parseOriginSelection("A")`は正常に`{ name: "山形駅", ... }`を返すはず（36-39行目）。**

**考えられる原因:**
- `userMessage`が`"A"`ではなく、`"A."`や`"A "`（ピリオド付き）の場合、`parseOriginSelection`は`null`を返す可能性がある
- ただし、`"A "`（スペースのみ）は`trim()`で処理されるため、正常に動作するはず

**実際のコードフロー:**
```typescript
// 659行目
const originSelection = parseOriginSelection(userMessage);

// 804行目
if (originSelection) {
  // Cセクション：プラン生成
} else {
  // originSelection === null の場合
  // → 780行目の条件チェックに到達
  if (!originSelection && !isGSelected && originInputMode !== "free") {
    // Bセクション：origin質問を再表示
  }
}
```

**「Aを返したら謝罪になる」ケースが起きるif分岐:**
- **780行目**: `if (!originSelection && !isGSelected && originInputMode !== "free")`
- この条件が`true`の場合、origin質問が再表示される（ユーザーから見ると「謝罪」に見える可能性がある）

---

## 6. 「プラン立てて」という明示が必要かどうかの根拠

### Beforeモード

**「プラン立てて」という明示は不要。**

**根拠:**
- Eセクション（通常Before）では、`stopIntent`が検出されなくても、AIがプランを生成する（1086-1356行目）
- `stopIntent`が検出された場合、`integratePlaces`でPlaces APIスポットが追加される（1162-1225行目）
- `stopIntent`が検出されない場合でも、DBスポットのみでプランが生成される

**判定条件（Eセクション）:**
```typescript
// 1086行目
const systemPrompt = await getSystemPrompt();

// 1094-1099行目
const completion = await openai.chat.completions.create({
  model: CHAT_MODEL,
  messages,
  temperature: 0.7,
  response_format: { type: "json_object" },
});
```

**システムプロンプト（91-541行目）の指示:**
- 「ユーザーが観光プランを希望している場合は、必ずJSON形式でプランを返してください」
- 明示的な「プラン立てて」という発話は不要

### Stayモード

**「プラン立てて」という明示は不要。**

**根拠:**
- `stopIntent`が検出されなくても、`handleStayPlanner`が実行される（1414行目）
- AIがユーザーの意図を推測してプランを生成する

### Afterモード

**「プラン立てて」という明示は不要。**

**根拠:**
- `hasDestination === true`の場合、自動的にプラン生成に進む（765行目）
- AIがユーザーの意図を推測してプランを生成する

---

## まとめ表：モード別「入力→判定→次の質問/処理」

### Beforeモード

| 入力 | 判定結果 | 次の処理 | コード行 |
|------|---------|---------|---------|
| `hasOrigin === true` | origin確定済み | Aセクション：Pre-Checkinプラン生成 | 665-765行目 |
| `originSelection !== null` | A〜E選択 | Cセクション：プラン生成 | 804-886行目 |
| `userMessage === "G"` | G選択 | Dセクション：自由入力モード開始 | 905-920行目 |
| `originInputMode === "free"` | 自由入力モード中 | Dセクション：県名推定 | 924-1057行目 |
| `!hasOrigin && !originSelection && originInputMode !== "free"` | origin未確定 | Bセクション：origin質問 | 780-799行目 |
| 上記すべてがfalse | 通常Before | Eセクション：プラン生成 | 1060-1356行目 |

### Stayモード

| 入力 | 判定結果 | 次の処理 | コード行 |
|------|---------|---------|---------|
| `stopIntent !== null` | 立ち寄り意図検出 | `handleStayPlanner`：外出プラン | 1404-1407行目 |
| `isFacilityQuery === true` | 施設利用情報問い合わせ | `handleFacilityOperation`：館内施設案内 | 1408-1411行目 |
| 上記すべてがfalse | デフォルト | `handleStayPlanner`：外出プラン | 1414-1415行目 |

### Afterモード

| 入力 | 判定結果 | 次の処理 | コード行 |
|------|---------|---------|---------|
| `hasDestination === true` | destination確定済み | Aセクション：プラン生成 | 765-772行目 |
| 県境選択（①/②/③/④） | 県境が選択された | destination設定→プラン生成 | 797-807行目 |
| `originSelection !== null` | A〜E選択 | destination設定→プラン生成 | 833-844行目 |
| `isOtherSelected === true` | F選択 | 県境選択を促す | 845-861行目 |
| 上記すべてがfalse | destination未確定 | destination質問（A〜F） | 863-880行目 |

---

## 補足：`stopIntent`検出の詳細

### `detectStopIntent`関数 (`app/api/koyo/_utils/detectStopIntent.ts`)

**優先順位:**
1. `lunch`（ランチ・食事）
2. `cafe`（カフェ・休憩）
3. `rest`（一息・散策）
4. `onsen`（温泉・外出文脈のみ）
5. `shop`（お土産・売店）

**検出キーワード例:**
- `lunch`: "ランチ", "昼食", "お昼", "食べたい", "食べて"
- `cafe`: "カフェ", "コーヒー", "休憩"
- `rest`: "一息", "散策"
- `onsen`: "温泉", "湯", "風呂"（外出文脈キーワード必須）
- `shop`: "お土産", "売店", "ショップ"

**重要:** `onsen`は`outdoorContextKeywords`（"プラン", "途中", "立ち寄り"など）が含まれている場合のみ検出される。

