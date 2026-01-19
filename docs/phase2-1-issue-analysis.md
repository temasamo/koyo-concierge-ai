# After Phase2-1 現状分析と修正案

## 問題点

### 1. ルート一覧に「山形駅」が2回表示される
**原因:**
- `confirmedSpots`には「古窯」と「山形駅（destination）」の2つが入っている
- `GoogleMap`コンポーネントの`drawRoute`関数が、`spots`配列（= `confirmedSpots`）から`routeWaypoints`を生成している（438行目）
- `routeInfo.waypoints = []`でも、`spots`配列からwaypointsを生成してしまう

**該当コード:**
```typescript:438:444:components/map/GoogleMap.tsx
routeWaypoints = validSpots.map((s) => ({
  name: s.name,
  location: { lat: s.lat, lng: s.lng },
  stopover: true,
  category: s.category,
  city: s.city,
}));
```

### 2. `routeInfo.waypoints`が空でも、`spots`配列からwaypointsを生成している
**原因:**
- Afterモードで`routeInfo.waypoints = []`に設定しても、`drawRoute`関数内で`validSpots`（= `spots`配列）から`routeWaypoints`を生成している
- `routeInfo.waypoints`を優先的に使用するロジックがない

**該当コード:**
```typescript:425:444:components/map/GoogleMap.tsx
} else if (koyoOrigin) {
  // 通常モード（Stay/After/通常Before）
  routeOrigin = koyoOrigin;
  if (routeInfo && routeInfo.destination) {
    routeDestination = routeInfo.destination;
  } else {
    routeDestination = koyoOrigin;
  }
  // ❌ routeInfo.waypoints を無視して、validSpots から waypoints を生成
  routeWaypoints = validSpots.map((s) => ({
    name: s.name,
    location: { lat: s.lat, lng: s.lng },
    stopover: true,
    category: s.category,
    city: s.city,
  }));
}
```

### 3. `confirmedSpots`に古窯とdestinationが含まれているため、waypointsとして扱われている
**原因:**
- `confirmedSpots`は「古窯」と「destination」の2つを含む
- これらは`origin`と`destination`であり、waypointsではない
- しかし、`spots`配列として渡されるため、`validSpots`に含まれ、waypointsとして扱われている

## 修正案

### 案1: `GoogleMap`コンポーネントで`routeInfo.waypoints`を優先する（推奨）

**修正箇所:** `components/map/GoogleMap.tsx` の `drawRoute` 関数

**修正内容:**
1. Afterモード（または`routeInfo.waypoints`が空の場合）では、`routeInfo.waypoints`を優先的に使用
2. `routeInfo.waypoints`が空の場合は、`validSpots`からwaypointsを生成しない
3. `confirmedSpots`は`origin`と`destination`のみなので、waypointsから除外

**修正コード例:**
```typescript
} else if (koyoOrigin) {
  // 通常モード（Stay/After/通常Before）
  routeOrigin = koyoOrigin;
  if (routeInfo && routeInfo.destination) {
    routeDestination = routeInfo.destination;
  } else {
    routeDestination = koyoOrigin;
  }
  
  // Phase2-1: routeInfo.waypoints を優先的に使用
  if (routeInfo && Array.isArray(routeInfo.waypoints)) {
    if (routeInfo.waypoints.length === 0) {
      // waypoints が空の場合は、spots から waypoints を生成しない
      routeWaypoints = [];
      console.log("[GoogleMap] Phase2-1: routeInfo.waypoints is empty, using empty waypoints");
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
    // routeInfo がない場合は、従来通り validSpots から生成
    routeWaypoints = validSpots.map((s) => ({
      name: s.name,
      location: { lat: s.lat, lng: s.lng },
      stopover: true,
      category: s.category,
      city: s.city,
    }));
  }
}
```

### 案2: `confirmedSpots`から`origin`と`destination`を除外する

**修正箇所:** `app/api/koyo/after/route.ts`

**修正内容:**
- `confirmedSpots`を返すが、`spots`配列には含めない
- または、`confirmedSpots`を`origin`と`destination`のみに限定し、waypointsとして扱わない

**問題点:**
- フロントエンドで`confirmedSpots`を`setSpots()`に設定しているため、マーカー表示に影響する可能性がある

### 案3: `spots`配列を空にして、`routeInfo`のみを使用する

**修正箇所:** `app/page.tsx`

**修正内容:**
- Afterモードでは`setSpots([])`にして、`routeInfo`のみを使用
- マーカー表示は`routeInfo.origin`と`routeInfo.destination`から生成

**問題点:**
- マーカー表示ロジックの大幅な変更が必要

## 推奨修正案

**案1を推奨**（`GoogleMap`コンポーネントの修正）

**理由:**
1. 最小限の変更で対応可能
2. `routeInfo.waypoints`の意図を正しく反映できる
3. 他のモード（Before/Stay）への影響が少ない
4. Phase2-1の要件（`routeInfo.waypoints = []`で直行ルート）を満たせる

**追加修正:**
- `confirmedSpots`の`id`が`"koyo"`と`"destination"`の場合、waypointsから除外する処理を追加




