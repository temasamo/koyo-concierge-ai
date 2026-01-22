# waypointsにspotIdを含める完全実装 - 確認事項

## 確認事項

### 確認1: `resolvedRouteWaypoints`の型に`spotId`を追加

**現状**: `resolvedRouteWaypoints`の型に`spotId`が含まれていない（338-344行目）

**質問**: `resolvedRouteWaypoints`の型に`spotId`を追加する必要があるか？

**回答**: はい、追加が必要です。`routeWaypoints`は`resolvedRouteWaypoints`から生成されているので、`spotId`を保持する必要があります。

**修正案**:
```typescript
const resolvedRouteWaypoints: Array<{
  name?: string;
  location: { lat: number; lng: number };
  stopover: true;
  category?: string | null;
  city?: string | null;
  spotId?: string; // 追加
}> = hasWaypointsArray
  ? (routeInfo!.waypoints || []).map((wp) => {
      // ...
      return {
        name: spot?.name || "",
        location: { lat: wp.lat, lng: wp.lng },
        stopover: true as const,
        category: spot?.category ?? null,
        city: spot?.city ?? null,
        spotId: wp.spotId, // 追加
      };
    })
  : validSpots.map((s) => ({
      name: s.name,
      location: { lat: s.lat!, lng: s.lng! },
      stopover: true as const,
      category: s.category ?? null,
      city: s.city ?? null,
      spotId: s.id, // 追加
    }));
```

### 確認2: `routePoints`生成での`spotId`の使用

**現状**: `routePoints`生成で`validSpots[idx]`を使っている（870-879行目）

**質問**: `routeWaypoints`から`spotId`を取得して使用するか？

**回答**: はい、`routeWaypoints`（`resolvedRouteWaypoints`）から`spotId`を取得して使用します。

**修正案**:
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

### 確認3: `waypointDetails`の修正

**現状**: `validSpots[index]`でspotを取得している（537行目）

**質問**: `waypointDetails`もspotId参照に変更するか？

**回答**: はい、一貫性のため変更します。

**修正案**:
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
    // ...
  };
});
```

## 実装順序

1. `WaypointInfo`型を定義（`store/spots.ts`または`types/route.ts`）
2. `resolveSpotByWaypoint`ヘルパー関数を作成
3. `resolvedRouteWaypoints`の型に`spotId`を追加し、生成時に`spotId`を保持
4. `buildRouteLegs`の`fromName`生成をspotId参照に変更
5. `routePoints`生成をspotId参照に変更
6. `waypointDetails`をspotId参照に変更（任意だが推奨）
7. 動作確認




