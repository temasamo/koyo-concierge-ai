# 「順番を逆に」で「蕎麦やまぶ」が住所になる問題の調査

## 問題の概要

「順番を逆に」を実行した後、「蕎麦やまぶ」がルート一覧で住所（「日本、〒990-0323 山形県東村山郡山辺町大塚127-3」）として表示される。

## 原因の仮説

### 仮説1: `validSpots`に「蕎麦やまぶ」が含まれていない

**可能性**:
- `validSpots`は`routeSpots`（`spots`プロパティ）から生成されている
- `spots`プロパティは`useSpotStore`から取得されている
- 「順番を逆に」の処理で`setRoutePlan`が`store.spots`を更新するが、`drawRoute`が呼ばれるタイミングで`spots`がまだ更新されていない可能性がある

**確認方法**:
- デバッグログで`validSpots`の内容を確認
- `routeInfo.waypoints`の`spotId`と`validSpots`の`id`を比較

### 仮説2: `routeInfo.waypoints`に`spotId`が正しく設定されていない

**可能性**:
- 「順番を逆に」の処理で`reversedWaypoints`を生成する際に、`spotId`が正しく設定されていない可能性がある

**確認方法**:
- デバッグログで`routeInfo.waypoints`の`spotId`を確認
- API側の`reversedWaypoints`生成箇所を確認

### 仮説3: `routePlan.spots`に「蕎麦やまぶ」が含まれていない

**可能性**:
- `reversedSpots`に「蕎麦やまぶ」が含まれていない
- または、`routePlan.spots`に設定される前に何かが起きている

**確認方法**:
- API側の`reversedSpots`生成箇所を確認
- `routePlan.spots`の内容を確認

## デバッグログの追加

以下のデバッグログを追加しました：

1. `buildRouteLegs`関数の冒頭で`routeInfo.waypoints`と`validSpots`の内容をログ出力
2. `spotId`で検索しても見つからない場合に警告ログを出力
3. 座標fallbackでも見つからない場合に警告ログを出力

## 確認が必要な箇所

1. **API側**: `reversedWaypoints`の生成箇所（783行目）で`spotId`が正しく設定されているか
2. **フロント側**: `setRoutePlan`と`setRouteInfo`の実行順序（反映順の改善が正しく適用されているか）
3. **フロント側**: `drawRoute`が呼ばれるタイミングで`spots`が最新の値になっているか

## 次のステップ

1. デバッグログを確認して、`routeInfo.waypoints`と`validSpots`の内容を確認
2. 問題が特定できたら、適切な修正を実施


