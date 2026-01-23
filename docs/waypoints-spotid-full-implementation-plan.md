# waypointsにspotIdを含める完全実装計画

## 確認事項・疑問点

### 疑問1: `fromName`の生成ロジック

**現状**: `validSpots[index - 1]`で前のスポットを取得している（809-811行目）

**質問**: `fromName`もspotId参照に変更する必要があるか？

**回答**: はい、変更が必要です。
- 最初のleg（index 0）: `fromName`は`originName`
- それ以外: 前のwaypoint（`routeInfo.waypoints[index - 1]`）の`spotId`でspotを取得して`name`を使用

### 疑問2: `routePoints`の生成ロジック

**現状**: `validSpots[idx]`でspotを取得している（871行目）

**質問**: `routePoints`の生成もspotId参照に変更する必要があるか？

**回答**: はい、変更が必要です。
- `routeWaypoints`は`resolvedRouteWaypoints`から生成されている
- `resolvedRouteWaypoints`は既にspotId参照に変更済み
- しかし、`routePoints`の生成で`validSpots[idx]`を使っている箇所があるので、これも修正が必要

### 疑問3: `waypointDetails`の生成ロジック

**現状**: `validSpots[index]`でspotを取得している（537行目）

**質問**: これはデバッグ用なので、修正は不要か？

**回答**: デバッグ用なので、修正は任意ですが、一貫性のため修正を推奨します。

### 疑問4: legsがない場合の処理

**現状**: `validSpots`をインデックスで参照している（680-715行目）

**質問**: legsがない場合（ZERO_RESULTS等）の処理もspotId参照に変更する必要があるか？

**回答**: legsがない場合は`routeInfo.waypoints`が空配列の可能性が高いので、現状の処理で問題ない可能性があります。ただし、`routeInfo.waypoints`がある場合はspotId参照に変更する必要があります。

## 修正箇所の整理

### 1. `fromName`の生成（805-811行目）

**修正前**:
```typescript
const fromName =
  index === 0
    ? originName.replace("出発：", "")
    : index <= validSpots.length
    ? validSpots[index - 1]?.name ?? originName.replace("出発：", "")
    : originName.replace("出発：", "");
```

**修正後**:
```typescript
let fromName: string;
if (index === 0) {
  fromName = originName.replace("出発：", "");
} else if (index > 0 && index <= routeInfo.waypoints.length) {
  // 前のwaypointのspotIdでspotを取得
  const prevWaypoint = routeInfo.waypoints[index - 1];
  let prevSpot: Spot | null = null;
  if (prevWaypoint.spotId) {
    prevSpot = validSpots.find((s) => s.id === prevWaypoint.spotId) ?? null;
  }
  fromName = prevSpot?.name ?? originName.replace("出発：", "");
} else {
  fromName = originName.replace("出発：", "");
}
```

### 2. `routePoints`の生成（870-875行目）

**修正前**:
```typescript
...routeWaypoints.map((wp, idx) => {
  const spot = validSpots[idx];
  return {
    location: wp.location,
    pointType: "waypoint" as const,
    label: "", // assignLabelで設定
    name: spot?.name || wp.name || `スポット${idx + 1}`,
    spotId: spot?.id || null,
    category: spot?.category || wp.category || null,
    city: spot?.city || wp.city || null,
  };
}),
```

**修正後**:
```typescript
...routeWaypoints.map((wp) => {
  // spotIdでspotを取得
  let spot: Spot | null = null;
  if (wp.spotId) {
    spot = validSpots.find((s) => s.id === wp.spotId) ?? null;
  }
  return {
    location: wp.location,
    pointType: "waypoint" as const,
    label: "", // assignLabelで設定
    name: spot?.name || wp.name || `スポット`,
    spotId: spot?.id || wp.spotId || null,
    category: spot?.category || wp.category || null,
    city: spot?.city || wp.city || null,
  };
}),
```

### 3. `waypointDetails`の生成（536-542行目）

**修正前**:
```typescript
const waypointDetails = routeWaypoints.map((wp, index) => {
  const spot = validSpots[index];
  return {
    index,
    spotId: spot?.id || "unknown",
    spotName: spot?.name || "unknown",
    location: wp.location,
  };
});
```

**修正後**:
```typescript
const waypointDetails = routeWaypoints.map((wp, index) => {
  // spotIdでspotを取得
  let spot: Spot | null = null;
  if (wp.spotId) {
    spot = validSpots.find((s) => s.id === wp.spotId) ?? null;
  }
  return {
    index,
    spotId: spot?.id || wp.spotId || "unknown",
    spotName: spot?.name || "unknown",
    location: wp.location,
  };
});
```

### 4. legsがない場合の処理（630-710行目）

**確認**: legsがない場合は`routeInfo.waypoints`が空配列の可能性が高いので、現状の処理で問題ない可能性があります。ただし、`routeInfo.waypoints`がある場合はspotId参照に変更する必要があります。

**修正方針**: `routeInfo.waypoints`がある場合はspotId参照を使用、ない場合は現状の処理を維持

## 実装順序

1. `fromName`の生成ロジックを修正
2. `routePoints`の生成ロジックを修正
3. `waypointDetails`の生成ロジックを修正（任意）
4. legsがない場合の処理を確認・修正（必要に応じて）
5. 動作確認





