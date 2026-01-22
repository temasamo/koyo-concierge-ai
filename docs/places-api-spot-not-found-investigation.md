# Places API由来のスポットがエラーになる問題の調査

## 問題の概要

「順番を逆に」やスポット数を減らすと、DBにないスポット（Places API由来）がエラーになる：
- 住所表示になったり
- スポットの説明が出なかったり
- 他のものとバグったりする

## 原因の分析

### 1. Places API由来のスポットのID形式

**場所**: `app/api/koyo/_utils/places.ts` 278行目

**現状**:
```typescript
id: `places_${place.place_id}`,
```

Places API由来のスポットは`places_${place.place_id}`という形式のIDを持っています。

### 2. `optionalSpots`への追加

**場所**: `app/api/koyo/after/route.ts` 1561行目

**現状**:
```typescript
response.optionalSpots = matchedSpots.map((spot: any) => ({
  ...spot,
  spotRole: "optional" as const,
}));
```

`matchedSpots`にはPlaces API由来のスポットも含まれているので、`optionalSpots`にも含まれます。

### 3. `selectedSpots`への選択

**場所**: `app/api/koyo/after/route.ts` 927-930行目

**現状**:
```typescript
const selectedSpots = selections
  .map(i => optionalSpots[i - 1])
  .filter(Boolean)
  .filter((spot): spot is Spot => spot !== undefined && spot.lat !== null && spot.lng !== null);
```

Places API由来のスポットも`selectedSpots`に含まれます。

### 4. `waypoints`の生成

**場所**: `app/api/koyo/after/route.ts` 958-962行目

**現状**:
```typescript
const waypoints = selectedSpots.map(s => ({
  lat: s.lat!,
  lng: s.lng!,
  spotId: s.id, // places_${place.place_id}形式
}));
```

`waypoints`には`spotId: places_${place.place_id}`が設定されます。

### 5. `routePlan.spots`への追加

**場所**: `app/api/koyo/after/route.ts` 1029行目

**現状**:
```typescript
spots: selectedSpots,
```

`routePlan.spots`にはPlaces API由来のスポットも含まれます。

### 6. フロント側での`validSpots`生成

**場所**: `components/map/GoogleMap.tsx` 325-327行目

**現状**:
```typescript
const validSpots = (routeSpots || []).filter(
  (s) => s.lat != null && s.lng != null
) as Array<Spot & { lat: number; lng: number }>;
```

`validSpots`は`routeSpots`（`spots`プロパティ）から生成されています。

### 7. 問題の根本原因

**仮説1**: `setRoutePlan`で`store.spots`が更新されるタイミングと`drawRoute`が呼ばれるタイミングにずれがある

**可能性**:
- `setRoutePlan`で`store.spots`が更新される
- しかし、`drawRoute`が呼ばれる時点で`spots`プロパティがまだ更新されていない
- その結果、`validSpots`にPlaces API由来のスポットが含まれていない
- `resolveSpotByWaypoint`で`spotId: places_${place.place_id}`を検索しても見つからない
- 最終的に`leg.end_address`（住所）が表示される

**仮説2**: `routePlan.spots`にPlaces API由来のスポットが含まれていない

**可能性**:
- `selectedSpots`にPlaces API由来のスポットが含まれている
- しかし、`routePlan.spots`に設定される際に何かが起きている
- または、`setRoutePlan`で`store.spots`が更新される際にPlaces API由来のスポットが失われている

**仮説3**: Places API由来のスポットのIDが一致しない

**可能性**:
- `waypoints`の`spotId`は`places_${place.place_id}`形式
- しかし、`validSpots`内のPlaces API由来のスポットのIDが異なる形式になっている
- その結果、`resolveSpotByWaypoint`で見つからない

## 確認が必要な箇所

1. **`routePlan.spots`にPlaces API由来のスポットが含まれているか**
   - API側のレスポンスで`routePlan.spots`を確認
   - フロント側で`setRoutePlan`で`store.spots`が更新される際の内容を確認

2. **`validSpots`にPlaces API由来のスポットが含まれているか**
   - `drawRoute`が呼ばれる時点で`spots`プロパティの内容を確認
   - `validSpots`の内容を確認

3. **`spotId`の一致**
   - `routeInfo.waypoints`の`spotId`と`validSpots`内のPlaces API由来のスポットのIDが一致しているか確認

## 修正案

### 案1: `validSpots`にPlaces API由来のスポットが含まれるようにする

**修正内容**:
- `setRoutePlan`で`store.spots`が更新されるタイミングを確認
- `drawRoute`が呼ばれるタイミングで`spots`プロパティが最新の値になっているか確認
- 必要に応じて、`useEffect`の依存配列を調整

### 案2: `routePlan.spots`にPlaces API由来のスポットが確実に含まれるようにする

**修正内容**:
- API側で`routePlan.spots`にPlaces API由来のスポットが確実に含まれるようにする
- フロント側で`setRoutePlan`で`store.spots`が更新される際に、Places API由来のスポットが失われないようにする

### 案3: `spotId`の一致を保証する

**修正内容**:
- Places API由来のスポットのID生成ロジックを確認
- `waypoints`の`spotId`と`validSpots`内のPlaces API由来のスポットのIDが一致するようにする

## 次のステップ

1. デバッグログを確認して、`routePlan.spots`と`validSpots`の内容を確認
2. Places API由来のスポットのIDが一致しているか確認
3. 問題が特定できたら、適切な修正を実施




