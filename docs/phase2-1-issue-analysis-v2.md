# After Phase2-1 不具合分析と修正案（v2）

## 問題点

### 1. ルート一覧に候補スポット（上山城、春雨庵）がwaypointsとして表示されている
**現状:**
- ルート一覧に「上山城（Pin 1）」「春雨庵（Pin 2）」がwaypointsとして含まれている
- 地図上のルート線もこれらのスポットを経由している

**原因分析:**
1. `drawRoute`関数内で、`routeInfo.origin`が存在する場合の分岐（367-386行目）で、`routeInfo.waypoints`をそのまま使用している
   - Afterモードでは`routeInfo.origin = KOYO_COORDINATES`が設定されている
   - この分岐に入ると、`routeInfo.waypoints`が空配列でも`routeInfo.waypoints.map()`が実行される可能性がある
   - しかし、実際には`routeInfo.waypoints = []`なので、この分岐では空配列になるはず

2. `routePoints`の生成時に`validSpots`からwaypointsを生成している可能性
   - `routePoints`生成部分（787-812行目）で、`routeWaypoints`から`routePoints`を生成している
   - `routeWaypoints`が空でも、`validSpots`から直接waypointsを生成している可能性がある

3. **最も可能性が高い原因**: `routeInfo.waypoints`が空配列でも、別の分岐で`validSpots`からwaypointsを生成している
   - 367行目の分岐で`routeInfo.waypoints`が空配列の場合、`routeInfo.waypoints.map()`は空配列を返すはず
   - しかし、その後の処理で`validSpots`からwaypointsを生成している可能性がある

### 2. `routeInfo.waypoints`の優先順位が正しく機能していない
**現状:**
- `routeInfo.waypoints = []`に設定されているが、ルートにwaypointsが含まれている

**原因分析:**
1. `drawRoute`関数内で複数の分岐があり、優先順位が正しく設定されていない
   - 367行目: `routeInfo.origin`が存在する場合の分岐
   - 427行目: `koyoOrigin`がある場合の分岐（Afterモードはここ）
   - 両方の分岐で`routeInfo.waypoints`をチェックしているが、優先順位が不明確

2. `routeInfo.waypoints`が空配列の場合の処理が不十分
   - 空配列の場合、`routeInfo.waypoints.map()`は空配列を返すが、その後の処理で`validSpots`からwaypointsを生成している可能性がある

### 3. `routePoints`の生成ロジックが`validSpots`に依存している
**現状:**
- `routePoints`生成時に`routeWaypoints`を使用しているが、`validSpots`から直接waypointsを生成している可能性がある

**原因分析:**
- `routePoints`生成部分（787-812行目）で、`routeWaypoints`から`routePoints`を生成している
- しかし、`routeWaypoints`が空の場合でも、`validSpots`から直接waypointsを生成している可能性がある

## 修正案

### 案1: `drawRoute`関数内の分岐を整理し、`routeInfo.waypoints`を最優先にする（推奨）

**修正箇所:** `components/map/GoogleMap.tsx` の `drawRoute` 関数

**修正内容:**
1. `routeInfo.waypoints`を最優先でチェック
2. `routeInfo.waypoints`が空配列の場合は、`validSpots`からwaypointsを生成しない
3. すべての分岐で`routeInfo.waypoints`の優先順位を統一

**修正コード例:**
```typescript
// routeInfo.waypoints を最優先でチェック（全分岐で共通）
let routeWaypoints: any[] = [];
if (routeInfo && Array.isArray(routeInfo.waypoints)) {
  if (routeInfo.waypoints.length === 0) {
    // 空配列の場合は、validSpots から waypoints を生成しない
    routeWaypoints = [];
  } else {
    // waypoints がある場合は、それを使用
    routeWaypoints = routeInfo.waypoints.map((wp, idx) => {
      const spot = validSpots[idx];
      return {
        name: spot?.name || "",
        location: wp,
        stopover: true,
        category: spot?.category || null,
        city: spot?.city || null,
      };
    });
  }
} else {
  // routeInfo.waypoints が undefined/null の場合のみ、従来どおり validSpots から生成
  // （互換性のため、Before/Stayモードなど）
  routeWaypoints = validSpots.map((s) => ({
    name: s.name,
    location: { lat: s.lat, lng: s.lng },
    stopover: true,
    category: s.category,
    city: s.city,
  }));
}

// その後、各分岐で routeOrigin と routeDestination を決定
if (routeInfo && routeInfo.origin && !hasPrefBoundary && !hasFixedOrigin && !hasCurrentOrigin) {
  routeOrigin = routeInfo.origin;
  routeDestination = routeInfo.destination || koyoOrigin || center;
  // routeWaypoints は上記で既に決定済み
} else if (hasPrefBoundary) {
  // ...
} else if (hasFixedOrigin || hasCurrentOrigin) {
  // ...
} else if (koyoOrigin) {
  routeOrigin = koyoOrigin;
  if (routeInfo && routeInfo.destination) {
    routeDestination = routeInfo.destination;
  } else {
    routeDestination = koyoOrigin;
  }
  // routeWaypoints は上記で既に決定済み
}
```

### 案2: `routePoints`生成時に`routeWaypoints`のみを使用する

**修正箇所:** `components/map/GoogleMap.tsx` の `drawRoute` 関数内の`routePoints`生成部分

**修正内容:**
- `routePoints`生成時に`routeWaypoints`のみを使用し、`validSpots`から直接waypointsを生成しない

**問題点:**
- `routePoints`生成部分は既に`routeWaypoints`を使用しているため、この修正だけでは不十分

### 案3: Afterモード専用の分岐を追加する

**修正箇所:** `components/map/GoogleMap.tsx` の `drawRoute` 関数

**修正内容:**
- Afterモードを検出し、専用の処理を追加
- `routeInfo.waypoints = []`の場合、確実にwaypointsを空にする

**問題点:**
- モード検出ロジックが必要
- 他のモードへの影響を考慮する必要がある

## 推奨修正案

**案1を推奨**（`drawRoute`関数内の分岐を整理）

**理由:**
1. `routeInfo.waypoints`の優先順位を明確にできる
2. すべての分岐で一貫した処理が可能
3. 他のモード（Before/Stay）への影響が少ない
4. Phase2-1の要件（`routeInfo.waypoints = []`で直行ルート）を確実に満たせる

**追加確認事項:**
- `routeInfo.waypoints`が空配列の場合、`routeInfo.waypoints.map()`は空配列を返すことを確認
- `validSpots`からwaypointsを生成している箇所をすべて特定し、`routeInfo.waypoints`を優先するように修正





