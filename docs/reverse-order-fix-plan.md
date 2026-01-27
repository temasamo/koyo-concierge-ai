# 「順番を逆に」で候補が1つ減る問題の修正案

## 修正方針

### 1. `onSend`内の`currentSpots`取得を削除

**現状**:
- 128-131行目（`sendMessageWithUserState`）と370-371行目（`onSend`）で`currentSpots = store.spots`を取得している
- これは非同期更新のタイミング問題で古い値が取得される可能性がある

**修正**:
- payload構築直前に`useSpotStore.getState()`を呼び、そこから`spots`を読む
- `afterContext.spots`は必ずその`spots`を使う

### 2. レスポンス処理で`setRoutePlan`に統一

**現状**:
- Phase2-2のレスポンス処理（543-568行目）で`setRoutePlan`と`setSpots`の両方を呼んでいる
- `setRoutePlan`は`store/spots.ts`の102行目で`spots: routePlan.spots`を設定しているので、`setSpots`は冗長

**修正**:
- `setRoutePlan(data.routePlan)`に統一し、`setSpots`は呼ばない

## 疑問点・確認事項

### 疑問1: `sendMessageWithUserState`内でも同様の修正が必要か？

**回答**: はい、必要です。`sendMessageWithUserState`内でも`currentSpots = store.spots`を取得しているため、同様の修正が必要です。

### 疑問2: Phase2-2以外の処理でも`setSpots`を削除するか？

**現状**:
- Phase2-2以外の処理（例：Phase2-1、通常の処理）でも`setSpots`を呼んでいる箇所がある
- 例：292行目、684行目、760行目

**回答**: 
- Phase2-2のレスポンス処理（543-568行目、569-589行目）では`setSpots`を削除
- ただし、Phase2-2以外の処理（例：Phase2-1、通常の処理）では`setSpots`を残す必要がある可能性がある
- 理由：`setRoutePlan`が呼ばれない場合、`setSpots`が必要

**確認が必要な箇所**:
- 292行目（`sendMessageWithUserState`内）
- 684行目（Phase2-1または通常の処理）
- 760行目（通常の処理）

### 疑問3: 569行目の`else if`ブロックは重複しているか？

**現状**:
- 543行目と569行目で同じ条件（`mode === "after" && data.phase === "after:phase2_2_done"`）をチェックしている

**回答**: はい、重複しています。569行目の`else if`ブロックは削除すべきです。

### 疑問4: `setRoutePlan`が`store.spots`を更新するタイミング

**確認**:
- `setRoutePlan`は`store/spots.ts`の102行目で`spots: routePlan.spots`を設定している
- これは同期的に実行されるため、`setRoutePlan`を呼んだ直後に`store.spots`が更新される

**回答**: `setRoutePlan`を呼んだ直後に`useSpotStore.getState().spots`を取得すれば、最新の値が取得できる

## 修正箇所

### 1. `sendMessageWithUserState`内の修正（128-180行目）

**修正前**:
```typescript
const store = useSpotStore.getState();
const currentOptionalSpots = store.optionalSpots;
const currentRouteInfo = store.routeInfo;
const currentSpots = store.spots; // 確定済み経由地

// ... 中略 ...

const requestBody = {
  messages: latestMessages,
  userState: {
    // ...
    ...(mode === "after"
      ? {
          context: {
            after: {
              phase,
              optionalSpots: currentOptionalSpots,
              spots: currentSpots.length > 0 ? currentSpots : undefined,
              // ...
            },
          },
        }
      : {}),
  },
};
```

**修正後**:
```typescript
// payload構築直前に最新の状態を取得
const requestBody = {
  messages: latestMessages,
  userState: {
    // ...
    ...(mode === "after"
      ? (() => {
          const store = useSpotStore.getState();
          const currentSpots = store.spots; // 確定済み経由地（最新の値を取得）
          const currentRouteInfo = store.routeInfo;
          const currentOptionalSpots = store.optionalSpots;
          
          const phase = currentSpots.length > 0 ? "after:phase2_2_done" : "after:phase2_2_waiting_selection";
          
          // destination座標を確定（currentDestinationから優先、なければrouteInfoから）
          let destinationCoords: { lat: number; lng: number } | undefined;
          if (mode === "after" && params.userState.destination) {
            const dest = params.userState.destination;
            if (dest.type === "pref-boundary" && dest.pref) {
              const prefBoundary = getPrefBoundary(dest.pref as PrefectureKey);
              if (prefBoundary) {
                destinationCoords = prefBoundary;
              }
            } else if (dest.lat && dest.lng) {
              destinationCoords = {
                lat: dest.lat,
                lng: dest.lng,
              };
            }
          }
          if (!destinationCoords && currentRouteInfo?.destination) {
            destinationCoords = currentRouteInfo.destination;
          }
          
          return {
            context: {
              after: {
                phase,
                optionalSpots: currentOptionalSpots,
                spots: currentSpots.length > 0 ? currentSpots : undefined, // 必ず最新の値を使用
                routeInfoKey: "direct",
                origin: currentRouteInfo?.origin || KOYO_COORDINATES,
                destination: destinationCoords,
              },
            },
          };
        })()
      : {}),
  },
};
```

### 2. `onSend`内の修正（360-414行目）

**修正前**:
```typescript
...(mode === "after"
  ? (() => {
      const store = useSpotStore.getState();
      const currentSpots = store.spots; // 確定済み経由地
      const currentRouteInfo = store.routeInfo;
      const currentOptionalSpots = store.optionalSpots;
      
      // ...
      
      return {
        context: {
          after: {
            phase,
            optionalSpots: currentOptionalSpots,
            spots: currentSpots.length > 0 ? currentSpots : undefined,
            // ...
          },
        },
      };
    })()
  : {}),
```

**修正後**:
```typescript
...(mode === "after"
  ? (() => {
      // payload構築直前に最新の状態を取得
      const store = useSpotStore.getState();
      const currentSpots = store.spots; // 確定済み経由地（最新の値を取得）
      const currentRouteInfo = store.routeInfo;
      const currentOptionalSpots = store.optionalSpots;
      
      const phase = currentSpots.length > 0 ? "after:phase2_2_done" : "after:phase2_2_waiting_selection";
      
      // destination座標を確定（currentDestinationから優先、なければrouteInfoから）
      let destCoords: { lat: number; lng: number } | undefined;
      if (currentDestination) {
        if (currentDestination.type === "pref-boundary" && currentDestination.pref) {
          const prefBoundary = getPrefBoundary(currentDestination.pref as PrefectureKey);
          if (prefBoundary) {
            destCoords = prefBoundary;
          }
        } else if (currentDestination.lat && currentDestination.lng) {
          destCoords = {
            lat: currentDestination.lat,
            lng: currentDestination.lng,
          };
        }
      }
      if (!destCoords && currentRouteInfo?.destination) {
        destCoords = currentRouteInfo.destination;
      }
      
      return {
        context: {
          after: {
            phase,
            optionalSpots: currentOptionalSpots,
            spots: currentSpots.length > 0 ? currentSpots : undefined, // 必ず最新の値を使用
            routeInfoKey: "direct",
            origin: currentRouteInfo?.origin || KOYO_COORDINATES,
            destination: destCoords,
          },
        },
      };
    })()
  : {}),
```

### 3. Phase2-2のレスポンス処理の修正（543-589行目）

**修正前**:
```typescript
if (mode === "after" && data.phase === "after:phase2_2_done") {
  // 1. RoutePlan の更新（routeInfoは触らない）
  if (data.routePlan) {
    setRoutePlan(data.routePlan);
  }
  
  // 2. routeInfo の更新（唯一経路）
  if (data.routeInfo) {
    setRouteInfo(data.routeInfo);
  }
  
  // 3. optionalSpots の更新（候補更新があれば）
  if (data.optionalSpots && Array.isArray(data.optionalSpots)) {
    setOptionalSpots(data.optionalSpots);
  }
  
  // spots（確定経由地）の更新
  if (data.spots && Array.isArray(data.spots)) {
    setSpots(data.spots); // ← 削除（setRoutePlanで更新される）
  }
} else if (mode === "after" && data.phase === "after:phase2_2_done") {
  // 重複ブロック（削除）
  // ...
}
```

**修正後**:
```typescript
if (mode === "after" && data.phase === "after:phase2_2_done") {
  // 1. RoutePlan の更新（routeInfoは触らない、spotsも自動更新される）
  if (data.routePlan) {
    setRoutePlan(data.routePlan);
    console.log("[page.tsx] Phase2-2: Set routePlan:", data.routePlan.planId, "spots:", data.routePlan.spots.length);
  }
  
  // 2. routeInfo の更新（唯一経路）
  if (data.routeInfo) {
    setRouteInfo(data.routeInfo);
    console.log("[page.tsx] Phase2-2: Set routeInfo (waypoints:", data.routeInfo.waypoints?.length || 0, ")");
  }
  
  // 3. optionalSpots の更新（候補更新があれば）
  if (data.optionalSpots && Array.isArray(data.optionalSpots)) {
    setOptionalSpots(data.optionalSpots);
    console.log("[page.tsx] Phase2-2: Set optionalSpots:", data.optionalSpots.length);
  }
  
  // spots（確定経由地）の更新は不要（setRoutePlanで自動更新される）
} else {
  // Phase2-1 または通常の処理
  // ...
}
```

## 確認事項

1. **`sendMessageWithUserState`内の修正**: 128-180行目を修正する必要があるか？
   - 回答: はい、必要です

2. **Phase2-2以外の処理での`setSpots`**: 削除するか残すか？
   - 回答: Phase2-2のレスポンス処理では削除、それ以外では残す（`setRoutePlan`が呼ばれない場合があるため）

3. **569行目の重複ブロック**: 削除するか？
   - 回答: はい、削除します







