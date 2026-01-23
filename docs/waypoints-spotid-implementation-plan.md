# waypointsにspotIdを含める実装計画

## 目的

RouteListの順番を`routeInfo.waypoints`に完全追従させる。spotの補完は`spotId`で行い、index依存を廃止する。

## 疑問点・確認事項

### 疑問1: `RouteInfo`型の変更範囲

**現状**: `store/spots.ts`で`waypoints: Array<{ lat: number; lng: number }>`と定義されている

**質問**:
- `spotId`をオプショナル（`spotId?: string`）にするべきか？
- 既存のコード（Before/Stayモード）との互換性をどう保つか？
- `GoogleMap.tsx`の`routeInfo`プロパティの型定義も更新する必要があるか？

**回答案**:
- `spotId`はオプショナル（`spotId?: string`）にする
- 既存のコードは`spotId`がなくても動作するようにする（後方互換性を保つ）
- `GoogleMap.tsx`の型定義も更新する

### 疑問2: 他のモード（Before/Stay）での対応

**現状**: Before/Stayモードでも`waypoints`を生成している

**質問**:
- Before/Stayモードでも`spotId`を含めるべきか？
- それともAfterモードのみか？

**回答案**:
- まずはAfterモードのみ対応し、必要に応じて他のモードにも拡張する
- ただし、型定義は全モードで共通にする（`spotId`はオプショナル）

### 疑問3: `spotId`が存在しない場合のfallback

**質問**:
- `spotId`が存在しない場合、どのようにfallbackするか？
- 座標ベースの検索にフォールバックするか？

**回答案**:
- `spotId`が存在しない場合は、座標ベースの検索にフォールバック
- それでも見つからない場合は、`leg.end_address`や座標表示を使用

### 疑問4: `reversedWaypoints`の生成箇所

**現状**: `app/api/koyo/after/route.ts`の783行目で`reversedWaypoints`を生成している

**質問**:
- `reversedWaypoints`にも`spotId`を含める必要があるか？

**回答案**:
- はい、`reversedWaypoints`にも`spotId`を含める必要がある

## 実装箇所

### 1. 型定義の更新

**ファイル**: `store/spots.ts`

**修正前**:
```typescript
export type RouteInfo = {
  origin: { lat: number; lng: number };
  waypoints: Array<{ lat: number; lng: number }>;
  destination: { lat: number; lng: number };
};
```

**修正後**:
```typescript
export type RouteInfo = {
  origin: { lat: number; lng: number };
  waypoints: Array<{ lat: number; lng: number; spotId?: string }>;
  destination: { lat: number; lng: number };
};
```

### 2. `GoogleMap.tsx`の型定義の更新

**ファイル**: `components/map/GoogleMap.tsx`

**修正前**:
```typescript
routeInfo?: { origin: { lat: number; lng: number }; waypoints: Array<{ lat: number; lng: number }>; destination: { lat: number; lng: number } } | null;
```

**修正後**:
```typescript
routeInfo?: { origin: { lat: number; lng: number }; waypoints: Array<{ lat: number; lng: number; spotId?: string }>; destination: { lat: number; lng: number } } | null;
```

### 3. API側の修正（Afterモード）

**ファイル**: `app/api/koyo/after/route.ts`

**修正箇所1**: Phase2-2の選択処理（957行目）
```typescript
// 修正前
const waypoints = selectedSpots.map(s => ({
  lat: s.lat!,
  lng: s.lng!,
}));

// 修正後
const waypoints = selectedSpots.map(s => ({
  lat: s.lat!,
  lng: s.lng!,
  spotId: s.id,
}));
```

**修正箇所2**: 「順番を逆に」処理（783行目）
```typescript
// 修正前
const reversedWaypoints = reversedSpots.map(s => ({
  lat: s.lat!,
  lng: s.lng!,
}));

// 修正後
const reversedWaypoints = reversedSpots.map(s => ({
  lat: s.lat!,
  lng: s.lng!,
  spotId: s.id,
}));
```

### 4. フロント側の修正

**ファイル**: `components/map/GoogleMap.tsx`

**修正箇所1**: `resolvedRouteWaypoints`の生成（344-354行目）
```typescript
// 修正前
const resolvedRouteWaypoints = hasWaypointsArray
  ? (routeInfo!.waypoints || []).map((wp, idx) => {
      const spot = validSpots[idx];
      return {
        name: spot?.name || "",
        location: { lat: wp.lat, lng: wp.lng },
        stopover: true as const,
        category: spot?.category ?? null,
        city: spot?.city ?? null,
      };
    })
  : validSpots.map((s) => ({ ... }));

// 修正後
const resolvedRouteWaypoints = hasWaypointsArray
  ? (routeInfo!.waypoints || []).map((wp) => {
      // spotIdで検索（優先）
      let spot: Spot | null = null;
      if (wp.spotId) {
        spot = validSpots.find((s) => s.id === wp.spotId) ?? null;
      }
      // spotIdがない場合は座標ベースで検索（fallback）
      if (!spot) {
        spot = validSpots.find((s) => 
          Math.abs(s.lat! - wp.lat) < 0.000001 &&
          Math.abs(s.lng! - wp.lng) < 0.000001
        ) ?? null;
      }
      return {
        name: spot?.name || "",
        location: { lat: wp.lat, lng: wp.lng },
        stopover: true as const,
        category: spot?.category ?? null,
        city: spot?.city ?? null,
      };
    })
  : validSpots.map((s) => ({ ... }));
```

**修正箇所2**: `buildRouteLegs`関数内のマッピング（746-777行目）
```typescript
// 修正前
legs.forEach((leg, index) => {
  const spot = index < validSpots.length ? validSpots[index] : null;
  // ...
});

// 修正後
legs.forEach((leg, index) => {
  // routeInfo.waypointsの順番に従ってspotを取得
  let spot: Spot | null = null;
  if (index < routeInfo.waypoints.length) {
    const waypoint = routeInfo.waypoints[index];
    // spotIdで検索（優先）
    if (waypoint.spotId) {
      spot = validSpots.find((s) => s.id === waypoint.spotId) ?? null;
    }
    // spotIdがない場合は座標ベースで検索（fallback）
    if (!spot) {
      spot = validSpots.find((s) => 
        Math.abs(s.lat! - waypoint.lat) < 0.000001 &&
        Math.abs(s.lng! - waypoint.lng) < 0.000001
      ) ?? null;
    }
  }
  // ...
});
```

### 5. 反映順の改善（任意だが推奨）

**ファイル**: `app/page.tsx`

**修正箇所**: Phase2-2のレスポンス処理（543-568行目）

**修正前**:
```typescript
// 1. RoutePlan の更新
if (data.routePlan) {
  setRoutePlan(data.routePlan);
}
// 2. routeInfo の更新
if (data.routeInfo) {
  setRouteInfo(data.routeInfo);
}
```

**修正後**:
```typescript
// 1. routeInfo の更新（唯一経路、先に更新）
if (data.routeInfo) {
  setRouteInfo(data.routeInfo);
}
// 2. RoutePlan の更新（routeInfo更新後に実行）
if (data.routePlan) {
  setRoutePlan(data.routePlan);
}
```

## 実装順序

1. 型定義の更新（`store/spots.ts`、`components/map/GoogleMap.tsx`）
2. API側の修正（Afterモードの`waypoints`生成箇所）
3. フロント側の修正（`buildRouteLegs`関数）
4. 反映順の改善（`app/page.tsx`）
5. 動作確認

## 注意事項

- `spotId`はオプショナルなので、既存のコード（Before/Stayモード）はそのまま動作する
- `spotId`が存在しない場合は、座標ベースの検索にフォールバックする
- `buildRouteLegs`関数では、`routeInfo.waypoints`の順番をそのまま使用する





