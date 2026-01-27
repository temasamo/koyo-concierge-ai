# 「順番を逆に」でルート一覧とスポットが一致しない問題の調査結果

## 問題の概要

「順番を逆に」を実行すると、ルート一覧とスポットが一致していない。3つあったスポットが1つ減る。

## 原因の分析

### 1. `buildRouteLegs`関数での`validSpots`と`routeInfo.waypoints`のマッピング問題

**場所**: `components/map/GoogleMap.tsx` 344-354行目、746-777行目

**現状のロジック**:
```typescript
const resolvedRouteWaypoints = hasWaypointsArray
  ? (routeInfo!.waypoints || []).map((wp, idx) => {
      const spot = validSpots[idx]; // ← 問題：validSpotsのインデックスで取得
      return {
        name: spot?.name || "",
        location: { lat: wp.lat, lng: wp.lng },
        // ...
      };
    })
  : validSpots.map((s) => ({ ... }));

// buildRouteLegs内でも同様
legs.forEach((leg, index) => {
  const spot = index < validSpots.length ? validSpots[index] : null; // ← 問題：インデックスで取得
  // ...
});
```

**問題点**:
- `routeInfo.waypoints`の順番は「順番を逆に」で正しく逆順になっている
- しかし、`validSpots`は`routeSpots`（`spots`プロパティ）から生成されており、`spots`の順番が更新されていない可能性がある
- `validSpots[idx]`で取得しているため、`validSpots`の順番と`routeInfo.waypoints`の順番が一致していない場合、間違ったスポットがマッピングされる

### 2. `drawRoute`関数の呼び出し元

**場所**: `components/map/GoogleMap.tsx` 950-961行目

**現状のロジック**:
```typescript
useEffect(() => {
  if (!isLoading && showRoute && routeInfo && routeInfo.origin && routeInfo.destination && koyoOrigin) {
    drawRoute(spots || []); // ← spotsプロパティを渡している
  }
}, [routeInfo, showRoute, isLoading, drawRoute, koyoOrigin, spots]);
```

**問題点**:
- `drawRoute`は`spots`プロパティを受け取っている
- `spots`プロパティは`useSpotStore`から取得されているが、`setRoutePlan`で更新されるタイミングと`useEffect`の実行タイミングにずれがある可能性がある

### 3. `setRoutePlan`と`spots`の更新タイミング

**場所**: `store/spots.ts` 97-105行目

**現状のロジック**:
```typescript
setRoutePlan: (routePlan) => {
  set({ routePlan });
  if (routePlan) {
    set({
      spots: routePlan.spots as Spot[],
    });
  }
},
```

**問題点**:
- `setRoutePlan`は`routePlan.spots`を`store.spots`に設定している
- しかし、`GoogleMap`コンポーネントの`spots`プロパティが更新されるタイミングと、`useEffect`が実行されるタイミングにずれがある可能性がある

### 4. `routeInfo.waypoints`と`validSpots`の順番の不一致

**根本原因**:
- 「順番を逆に」の処理で、API側は`reversedSpots`を生成して`routeInfo.waypoints`に設定している
- しかし、フロント側の`spots`プロパティが更新される前に`drawRoute`が呼ばれると、`validSpots`は古い順番のままになる
- `buildRouteLegs`関数では、`routeInfo.waypoints`の座標と`validSpots`のインデックスをマッピングしているため、順番が一致していない場合、間違ったスポットがマッピングされる

## 修正案

### 案1: `routeInfo.waypoints`の座標から`validSpots`を検索する（推奨）

**修正内容**:
- `buildRouteLegs`関数で、`routeInfo.waypoints`の座標から`validSpots`を検索する
- インデックスではなく、座標の一致でマッピングする

**メリット**:
- `validSpots`の順番に依存しない
- `routeInfo.waypoints`の順番が正しければ、正しいスポットがマッピングされる

**実装例**:
```typescript
legs.forEach((leg, index) => {
  // routeInfo.waypointsの座標からvalidSpotsを検索
  let spot: Spot | null = null;
  if (index < routeInfo.waypoints.length) {
    const waypoint = routeInfo.waypoints[index];
    spot = validSpots.find(s => 
      Math.abs(s.lat! - waypoint.lat) < 0.000001 &&
      Math.abs(s.lng! - waypoint.lng) < 0.000001
    ) || null;
  }
  
  // 最後のlegの場合はdestination
  const isLastLeg = index === legs.length - 1;
  const toName = isLastLeg
    ? destinationName.replace("到着：", "")
    : spot?.name ?? leg.end_address ?? `立ち寄りスポット${index + 1}`;
  
  // ...
});
```

### 案2: `routeInfo.waypoints`の順番に合わせて`validSpots`を並び替える

**修正内容**:
- `routeInfo.waypoints`の座標順に`validSpots`を並び替える
- その後、既存のインデックスベースのマッピングを使用する

**メリット**:
- 既存のロジックを大きく変更せずに済む

**デメリット**:
- `routeInfo.waypoints`と`validSpots`の座標が一致しない場合、並び替えが失敗する可能性がある

## 推奨修正

**案1を推奨**します。

理由：
1. `routeInfo.waypoints`の座標が「真実」なので、それに基づいてマッピングするのが安全
2. `validSpots`の順番に依存しないため、タイミングの問題を回避できる
3. 座標の一致でマッピングするため、より確実

## 確認事項

1. **`routeInfo.waypoints`の順番が正しいか**
   - API側で`reversedWaypoints`が正しく生成されているか
   - フロント側で`routeInfo.waypoints`が正しく更新されているか

2. **`validSpots`の順番が正しいか**
   - `setRoutePlan`で`spots`が更新されているか
   - `drawRoute`が呼ばれるタイミングで`spots`が最新の値になっているか

3. **`buildRouteLegs`でのマッピングロジック**
   - インデックスベースのマッピングが問題の原因か
   - 座標ベースのマッピングに変更する必要があるか







