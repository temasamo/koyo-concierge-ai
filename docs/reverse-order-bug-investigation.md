# 「順番を逆に」で候補が1つ減る問題の調査結果

## 問題の概要

「順番を逆に」を実行した際に、元々3つあった経由地（蕎麦やまぶ、スモっち、丹野こんにゃく）が2つ（丹野こんにゃく、スモっち）に減っている。

## 調査した箇所

### 1. フロント側（app/page.tsx）

**403行目**: `afterContext.spots`の送信
```typescript
spots: currentSpots.length > 0 ? currentSpots : undefined, // 確定済み経由地（順番変更用）
```

**`currentSpots`の取得元**:
- `const store = useSpotStore.getState();`
- `const currentSpots = store.spots; // 確定済み経由地`

**問題の可能性**:
- `store.spots`が正しく更新されていない可能性
- `setRoutePlan`と`setSpots`の両方が呼ばれているため、タイミングの問題で古い値が使われている可能性

### 2. API側（app/api/koyo/after/route.ts）

**778-782行目**: 「順番を逆に」の処理
```typescript
if (isReverseOrder && afterContext.spots && Array.isArray(afterContext.spots) && afterContext.spots.length > 0) {
  const currentSpots = afterContext.spots;
  if (currentSpots.length >= 2) {
    // 経由地の順番を逆にする
    const reversedSpots = [...currentSpots].reverse();
```

**問題の可能性**:
- `afterContext.spots`が正しく送信されていない（3つではなく2つしか含まれていない）
- `currentSpots.length >= 2`の条件で、3つある場合でも処理されるはずだが、実際には2つしかない

**806-813行目**: `reversedSpotList`の生成
```typescript
const reversedSpotList = reversedSpots
  .map((s, idx) => {
    // optionalSpotsから元のインデックスを取得
    const originalIndex = afterContext.optionalSpots?.findIndex(opt => opt.id === s.id) ?? idx;
    const displayNumber = originalIndex !== -1 ? originalIndex + 1 : idx + 1;
    return `(${displayNumber}) ${s.name}`;
  })
  .join("、");
```

**問題の可能性**:
- `reversedSpots`が2つしかないため、`reversedSpotList`も2つしか表示されない
- `afterContext.optionalSpots`から元のインデックスを取得しているが、`reversedSpots`自体が2つしかない

### 3. ストア側（store/spots.ts）

**97-105行目**: `setRoutePlan`の実装
```typescript
setRoutePlan: (routePlan) => {
  set({ routePlan });
  // RoutePlanが設定されたら、spotsのみを更新（routeInfoはsetRouteInfoで管理）
  if (routePlan) {
    set({
      spots: routePlan.spots as Spot[],
      // routeInfo は setRouteInfo(data.routeInfo) で更新する（Phase2-1: 候補と確定の分離）
    });
  }
},
```

**問題の可能性**:
- `setRoutePlan`が`routePlan.spots`を`spots`に設定しているが、`routePlan.spots`が正しく3つすべて含まれているか確認が必要

## 原因の仮説

### 仮説1: `afterContext.spots`が正しく送信されていない（最も可能性が高い）

**可能性**: フロント側で`currentSpots`を取得する際に、`store.spots`が正しく更新されていない、または古い値が使われている。

**詳細**:
- `app/page.tsx`の403行目で`currentSpots = store.spots`を取得している
- Phase2-2のレスポンス処理（543-568行目）で、`setRoutePlan`と`setSpots`の両方が呼ばれている
- `setRoutePlan`（547-549行目）が先に実行され、その後`setSpots`（565-567行目）が実行される
- しかし、`onSend`が呼ばれる時点で`store.spots`がまだ更新されていない可能性がある

**確認方法**:
- `app/page.tsx`の403行目付近にログを追加して、`currentSpots.length`を確認
- API側の778行目付近にログを追加して、`afterContext.spots.length`を確認
- `setRoutePlan`と`setSpots`の実行タイミングを確認

### 仮説2: Phase2-2の選択処理で`spots`が正しく保存されていない

**可能性**: Phase2-2で選択されたスポットが`store.spots`に正しく保存されていない。

**詳細**:
- API側（1008行目）で`spots: selectedSpots`が返されている
- フロント側（565-567行目）で`setSpots(data.spots)`が呼ばれている
- しかし、`setRoutePlan`（547-549行目）も呼ばれており、`routePlan.spots`が`store.spots`に上書きされる可能性がある

**確認方法**:
- `app/page.tsx`の566行目付近（`setSpots(data.spots)`）にログを追加して、`data.spots.length`を確認
- `store/spots.ts`の`setSpots`と`setRoutePlan`にログを追加して、保存される`spots.length`を確認

### 仮説3: `setRoutePlan`と`setSpots`の実行順序の問題

**可能性**: `setRoutePlan`と`setSpots`が両方呼ばれているため、タイミングの問題で古い値が使われている。

**詳細**:
- Phase2-2のレスポンス処理（543-568行目）で、以下の順序で実行されている：
  1. `setRoutePlan(data.routePlan)`（547-549行目）
  2. `setRouteInfo(data.routeInfo)`（552-556行目）
  3. `setOptionalSpots(data.optionalSpots)`（558-562行目）
  4. `setSpots(data.spots)`（565-567行目）
- `setRoutePlan`が`routePlan.spots`を`store.spots`に設定する（`store/spots.ts`の102行目）
- その後`setSpots`が呼ばれるが、`onSend`が呼ばれる時点で`store.spots`がまだ更新されていない可能性がある

**確認方法**:
- `app/page.tsx`の543-568行目（Phase2-2のレスポンス処理）で、`setRoutePlan`と`setSpots`の実行順序とタイミングを確認
- `onSend`が呼ばれる時点で`store.spots`の値を確認

## 次のステップ

1. **ログを追加して原因を特定**
   - フロント側: `currentSpots.length`をログ出力
   - API側: `afterContext.spots.length`と`reversedSpots.length`をログ出力
   - ストア側: `setSpots`と`setRoutePlan`で保存される`spots.length`をログ出力

2. **実際のデータフローを確認**
   - Phase2-2で選択されたスポットが3つあることを確認
   - 「順番を逆に」を実行する前に`store.spots`に3つあることを確認
   - `afterContext.spots`に3つ含まれていることを確認

3. **修正案の検討**
   - 原因が特定でき次第、修正案を作成

