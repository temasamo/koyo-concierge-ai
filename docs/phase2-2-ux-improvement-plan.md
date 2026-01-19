# Phase2-2 UX改善 実装修正案

## 修正箇所一覧

### 1. Phase2-1: 候補提示時のreply生成（app/api/koyo/after/route.ts 1340-1354行目）

**現状の問題:**
- 候補が番号なしで列挙される
- 次アクションが不明確
- 「確定」と「候補」の区別が不明確

**修正内容:**
```typescript
// 修正前（1340-1354行目）
if (optionalSpotsForReply.length > 0) {
  const spotNames = optionalSpotsForReply.map((s: any) => s.name).join("、");
  let candidateText = "";
  if (optionalSpotsForReply.length === 1) {
    candidateText = `候補は${spotNames}です。`;
  } else if (optionalSpotsForReply.length === 2) {
    candidateText = `候補は${spotNames}の2つです。`;
  } else {
    candidateText = `候補は${spotNames}の${optionalSpotsForReply.length}つです。`;
  }
  cleanReply = `まず、古窯から${destinationName}への帰路（確定ルート）を作りました。途中で立ち寄れそうな${candidateText}\n\n${cleanReply}`;
} else {
  cleanReply = `まず、古窯から${destinationName}への帰路（確定ルート）を作りました。\n\n${cleanReply}`;
}

// 修正後（${cleanReply}を削除し、短い補足のみ追加）
if (optionalSpotsForReply.length > 0) {
  // 番号付きリストを生成
  const numberedList = optionalSpotsForReply
    .map((s: any, idx: number) => {
      const category = s.category || "観光スポット";
      return `(${idx + 1}) ${s.name}（${category}）`;
    })
    .join("\n");
  
  const candidateCount = optionalSpotsForReply.length;
  const candidateText = candidateCount === 1 
    ? "次の1つです："
    : `次の${candidateCount}つです：`;
  
  cleanReply = `まず、古窯から${destinationName}への【確定】直行ルートを作りました。
途中で立ち寄れそうな候補は${candidateText}
${numberedList}

この中から、経由地として組み込みたい番号を送ってください。
例：1 / 2 / 1と2
※「寄らない」場合は 0 と送ってください。

（補足）気になる点があれば、目的地の変更もできます。`;
} else {
  cleanReply = `まず、古窯から${destinationName}への【確定】直行ルートを作りました。

（補足）気になる点があれば、目的地の変更もできます。`;
}
```

### 2. Phase2-2: 選択待ち時のreply（app/api/koyo/after/route.ts 767-775行目）

**現状の問題:**
- 入力例が不十分
- 「0（寄らない）」オプションがない

**修正内容:**
```typescript
// 修正前（767-775行目）
if (selections.length === 0) {
  // 選択が0件なら「1〜Nの番号で選んでください」返信
  const spotNames = optionalSpots.map((s, idx) => `${idx + 1}. ${s.name}`).join("\n");
  return NextResponse.json({
    reply: `候補から選んでください。以下の番号でお知らせください。\n\n${spotNames}\n\n例：1 または 1と3 のように番号で選んでください。`,
    destination: hasDestination ? currentDestination : undefined,
    optionalSpots: optionalSpots,
    debug: { branch: "after:phase2_2_waiting_selection", phase: "after:phase2_2_waiting_selection" },
  });
}

// 修正後（userState.context.afterから取得）
const afterContext = userState.context?.after;
if (afterContext?.optionalSpots && Array.isArray(afterContext.optionalSpots) && afterContext.optionalSpots.length > 0) {
  const optionalSpots = afterContext.optionalSpots;
  const selections = extractSelections(userMessage);
  
  if (selections.length === 0) {
    // 選択が0件なら「1〜Nの番号で選んでください」返信
    const numberedList = optionalSpots
      .map((s, idx) => {
        const category = s.category || "観光スポット";
        return `(${idx + 1}) ${s.name}（${category}）`;
      })
      .join("\n");
    
    return NextResponse.json({
      reply: `候補から選んでください。以下の番号でお知らせください。

${numberedList}

この中から、経由地として組み込みたい番号を送ってください。
例：1 / 2 / 1と2
※「寄らない」場合は 0 と送ってください。`,
      destination: hasDestination ? currentDestination : undefined,
      optionalSpots: optionalSpots,
      debug: { branch: "after:phase2_2_waiting_selection", phase: "after:phase2_2_waiting_selection" },
    });
  }
}
```

### 3. Phase2-2: 確定後のreply（app/api/koyo/after/route.ts 833-836行目）

**現状の問題:**
- 番号なしでスポット名が列挙される
- 次のアクション（順番変更など）の指示がない

**修正内容:**
```typescript
// 修正前（833-836行目）
const selectedSpotNames = selectedSpots.map(s => s.name).join("、");
const response: any = {
  reply: `${selectedSpotNames} を経由地に組み込みました。ルートを更新しました。`,
  phase: "after:phase2_2_done",
  // ...
};

// 修正後
// 選択されたスポットを番号付きで表示（選択された順序で）
const selectedSpotList = selectedSpots
  .map((s, idx) => {
    // optionalSpotsから元のインデックスを取得
    const originalIndex = optionalSpots.findIndex(opt => opt.id === s.id);
    const displayNumber = originalIndex !== -1 ? originalIndex + 1 : idx + 1;
    return `(${displayNumber}) ${s.name}`;
  })
  .join("、");

const response: any = {
  reply: `了解です。${selectedSpotList}を経由地として組み込み、ルートを更新しました。

この順番で問題なければこのまま進めます。入れ替えたい場合は「順番を逆に」などと送ってください。`,
  phase: "after:phase2_2_done",
  // ...
};
```

### 4. 「0（寄らない）」オプションの処理追加

**修正箇所: app/api/koyo/after/route.ts 767行目以降**

**重要:** Phase2-1で生成したrouteInfoを`afterContext`に含めて、Phase2-2で再利用する必要があります。

**フロント側の修正（app/page.tsx）:**
```typescript
// userState.context.after にネスト（Before/Stayとの衝突を避ける）
// destination は必ず座標として確定できる情報から取る（routeInfoから取るのは補助扱い）
const currentRouteInfo = useSpotStore.getState().routeInfo;
const KOYO_COORDINATES = { lat: 38.123456, lng: 140.123456 }; // 実際の値を使用

// destination座標を確定（currentDestinationから優先、なければrouteInfoから）
let destinationCoords: { lat: number; lng: number } | undefined;
if (mode === "after" && currentDestination) {
  if (currentDestination.type === "pref-boundary" && currentDestination.pref) {
    // pref-boundaryの場合は境界座標を取得（getPrefBoundary関数を使用）
    const prefBoundary = getPrefBoundary(currentDestination.pref);
    if (prefBoundary) {
      destinationCoords = prefBoundary;
    }
  } else if (currentDestination.lat && currentDestination.lng) {
    destinationCoords = {
      lat: currentDestination.lat,
      lng: currentDestination.lng,
    };
  }
}
// currentDestinationから取得できない場合はrouteInfoから補助的に取得
if (!destinationCoords && currentRouteInfo?.destination) {
  destinationCoords = currentRouteInfo.destination;
}

const requestBody = {
  messages: latestMessages,
  userState: {
    origin: currentOrigin,
    destination: mode === "after" ? currentDestination : undefined,
    originInputMode: originInputMode,
    ...(mode === "after"
      ? {
          context: {
            after: {
              phase: "after:phase2_2_waiting_selection",
              optionalSpots: optionalSpots,
              // routeInfoは巨大なので、再生成に必要な最小情報だけ送る
              routeInfoKey: "direct", // 直行ルートを意味するフラグ
              origin: currentRouteInfo?.origin || KOYO_COORDINATES,
              destination: destinationCoords, // 確定した座標を送る
            },
          },
        }
      : {}),
  },
};
```

**API側の修正（app/api/koyo/after/route.ts）:**
```typescript
// AfterContext型の定義（routeInfoは含めない、最小情報のみ）
type AfterContext = {
  phase?: "after:phase2_1" | "after:phase2_2_waiting_selection" | "after:phase2_2_done";
  optionalSpots?: Spot[];
  routeInfoKey?: "direct"; // 直行ルートを意味するフラグ
  origin?: { lat: number; lng: number };
  destination?: { lat: number; lng: number };
};

// AfterRequestBody型の修正
type AfterRequestBody =
  | { messages: ChatCompletionMessageParam[]; userState?: { destination?: OriginInfo; context?: { after?: AfterContext } } }
  | { query: string; userState?: { destination?: OriginInfo; context?: { after?: AfterContext } } };

// extractSelections関数の後に追加
const afterContext = userState.context?.after;
if (afterContext?.optionalSpots && Array.isArray(afterContext.optionalSpots) && afterContext.optionalSpots.length > 0) {
  // ... 既存の処理 ...
  
  if (selections.length === 0) {
    // 既存の処理...
  } else if (selections.length === 1 && selections[0] === 0) {
    // 「0（寄らない）」が選択された場合
    // 直行ルートのrouteInfoを再生成（Phase2-1と同じ形式）
    if (afterContext.routeInfoKey === "direct" && afterContext.origin && afterContext.destination) {
      // 直行ルートのrouteInfoを生成（Phase2-1と同じ形式）
      // 注意: Directions APIはフロント側で呼ばれるため、API側は{ origin, waypoints, destination }のみ返す
      // フロント側がDirections APIを呼んで完全形（distance/duration/legs/polyline等）を生成する
      const directRouteInfo = {
        origin: afterContext.origin,
        waypoints: [], // 空配列（直行ルート）
        destination: afterContext.destination,
      };
      
      return NextResponse.json({
        reply: `了解です。直行ルートのまま進めます。何かご不明な点がございましたら、お気軽にお尋ねください。`,
        phase: "after:phase2_2_done",
        spots: [], // 経由地なし
        optionalSpots: optionalSpots, // 候補は残す
        routeInfo: directRouteInfo, // Phase2-1と同じ形式（フロント側がDirections APIで完全形を生成）
        destination: hasDestination ? currentDestination : undefined,
        debug: { branch: "after:phase2_2_done_no_waypoints", phase: "after:phase2_2_done" },
      });
    } else {
      // routeInfoKeyまたは座標がない場合はエラー（通常は発生しない）
      console.warn("[koyo-after] Phase2-2: routeInfoKey or coordinates not found in afterContext", {
        routeInfoKey: afterContext.routeInfoKey,
        hasOrigin: !!afterContext.origin,
        hasDestination: !!afterContext.destination,
      });
      return NextResponse.json({
        reply: "システムエラーが発生しました。もう一度お試しください。",
        destination: hasDestination ? currentDestination : undefined,
        optionalSpots: optionalSpots,
        debug: { branch: "after:phase2_2_error_no_routeinfo" },
      });
    }
  }
}
```

## データ整合性の確保

### optionalSpotsの順序固定

**現状:**
- `matchedSpots`の順序が毎回変わる可能性がある
- フロントで保持した`optionalSpots`を次リクエストで送る方針

**確認事項:**
- Phase2-1で返す`optionalSpots`の順序を固定する
- フロントで受け取った順序を保持し、そのまま次リクエストで送る
- UI表示も同じ順序にする

**実装確認:**
- `app/api/koyo/after/route.ts` 1374-1379行目: `optionalSpots`の生成
- `app/page.tsx`: `optionalSpots`の保存と送信

### routeInfoの完全性確保（軽量化対応）

**現状:**
- Phase2-1で生成したrouteInfoは`response.routeInfo`として返される（`{ origin, waypoints, destination }`形式）
- Phase2-2の「0（寄らない）」処理では、routeInfoを再生成している（部分的な構造）
- Directions系のrouteInfoは巨大（polyline/legs/steps全部入り）で、リクエストpayloadが重くなる
- **重要**: Directions APIはフロント側（GoogleMap.tsx）で呼ばれているため、API側は`{ origin, waypoints, destination }`形式を返せば十分

**修正方針:**
- routeInfoを丸ごと送るのではなく、再生成に必要な最小情報だけ送る
- `routeInfoKey: "direct"`フラグと`origin`/`destination`座標のみ送る
- Phase2-2の「0」処理では、`routeInfoKey`から直行ルートのrouteInfoを生成（`{ origin, waypoints: [], destination }`形式）
- フロント側がDirections APIを呼んで完全形（distance/duration/legs/polyline等）を生成する

**実装確認:**
- `app/page.tsx`: Phase2-1レスポンス受信時に`routeInfo`を保持（表示用）
- `app/page.tsx`: `context.after`に`routeInfoKey`と最小情報のみ送信（destinationはcurrentDestinationから確定）
- `app/api/koyo/after/route.ts`: `AfterContext`型に`routeInfoKey`と最小情報を追加
- `app/api/koyo/after/route.ts`: 「0」処理で`routeInfoKey`からrouteInfoを生成（Phase2-1と同じ形式）

**注意点:**
- destination座標は`currentDestination`から優先的に取得（routeInfoから取るのは補助扱い）
- Phase2-1直後でrouteInfoがまだstoreに入っていないタイミングでも、currentDestinationから座標を確定できる

## 実装順序

1. **AfterContext型の修正**（routeInfoKeyと最小情報のみ、context.afterにネスト）
2. **AfterRequestBody型の修正**（userState.context.afterに変更）
3. **フロント側の修正**（userState.context.afterに変更、routeInfoKeyを送る、destinationはcurrentDestinationから確定）
4. **Phase2-1のreply生成を修正**（番号付きリスト化、${cleanReply}を削除、Markdown強調を【】に変更）
5. **Phase2-2の選択待ち時のreplyを修正**（入力例改善）
6. **Phase2-2の確定後のreplyを修正**（番号付き＋次アクション指示）
7. **「0（寄らない）」オプションの処理を追加**（routeInfoKeyから直行ルートを生成、Phase2-1と同じ形式）
8. 動作確認

## 重要な注意点

**「0（寄らない）」で返すrouteInfoについて:**
- API側は`{ origin, waypoints: [], destination }`形式を返す（Phase2-1と同じ）
- Directions APIはフロント側（GoogleMap.tsx）で呼ばれるため、API側で完全形を生成する必要はない
- フロント側がDirections APIを呼んで完全形（distance/duration/legs/polyline等）を生成する
- この形式であれば、フロント側の描画・一覧は正常に動作する

**destination座標の取得について:**
- `currentDestination`から優先的に取得（routeInfoから取るのは補助扱い）
- Phase2-1直後でrouteInfoがまだstoreに入っていないタイミングでも、currentDestinationから座標を確定できる

## テストケース

1. **Phase2-1: 候補が1件の場合**
   - 番号(1)が表示される
   - 入力例が表示される
   - 「0（寄らない）」オプションが表示される

2. **Phase2-1: 候補が2件の場合**
   - 番号(1), (2)が表示される
   - 入力例「1 / 2 / 1と2」が表示される

3. **Phase2-1: 候補が3件の場合**
   - 番号(1), (2), (3)が表示される
   - 入力例が表示される

4. **Phase2-2: 選択なしの場合**
   - 番号付きリストが再表示される
   - 入力例が表示される

5. **Phase2-2: 「0」を選択した場合**
   - 直行ルートのまま進む旨が返信される
   - waypointsが空配列になる

6. **Phase2-2: 「1」を選択した場合**
   - 番号付きで確定メッセージが返る
   - 次のアクション（順番変更）が指示される

7. **Phase2-2: 「1と2」を選択した場合**
   - 番号付きで確定メッセージが返る
   - 次のアクションが指示される

