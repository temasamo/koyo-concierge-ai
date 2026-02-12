# RouteList.tsx 重複キーエラー修正案

## 問題の原因

`RouteList.tsx`の72行目で`routeLegs.map()`を使用し、74行目で`key={leg.index}`を設定していますが、`leg.index`が重複している可能性があります。

エラーメッセージ: "Encountered two children with the same key, `3`"

## 原因の分析

`GoogleMap.tsx`の`buildRouteLegs`関数で生成される`RouteLegInfo`の`index`プロパティが、特定の条件下で重複する可能性があります。

特に：
- `legs`がある場合（714行目以降）: 出発地を先に追加（`index: 0`）した後、`legs.forEach`で`displayIndex = index + 1`を計算しているため、計算ロジックの不整合で重複が発生する可能性
- `legs`がない場合（631-711行目）: 同様のロジックで`index`を設定しているが、条件分岐で重複が発生する可能性

## 修正案

### 案1: 配列インデックスと`leg.index`の複合キー（推奨）

**理由**: 
- `leg.index`は表示用のラベルとして使われているため、`key`としては配列インデックスと組み合わせることで一意性を保証
- 配列の順序が変わっても、各要素を正確に識別可能

**実装**:
```tsx
{routeLegs.map((leg, arrayIndex) => (
  <div
    key={`leg-${arrayIndex}-${leg.index}`}
    className="flex gap-3 border-t border-gray-100 pt-3 first:border-t-0 first:pt-0"
  >
```

**メリット**:
- 確実に一意なキーを生成
- `leg.index`が重複していても問題なし
- 実装がシンプル

**デメリット**:
- 配列の順序が変わると、Reactが再レンダリングを最適化できない可能性（ただし、`routeLegs`の順序は通常変わらないため、実用上は問題なし）

### 案2: 配列インデックスのみをkeyとして使用

**実装**:
```tsx
{routeLegs.map((leg, arrayIndex) => (
  <div
    key={arrayIndex}
    className="flex gap-3 border-t border-gray-100 pt-3 first:border-t-0 first:pt-0"
  >
```

**メリット**:
- 最もシンプル
- 確実に一意

**デメリット**:
- 配列の順序が変わると、Reactが要素を正しく追跡できない可能性（ただし、`routeLegs`の順序は通常変わらないため、実用上は問題なし）

### 案3: `fromName`と`toName`の組み合わせ（非推奨）

**実装**:
```tsx
{routeLegs.map((leg, arrayIndex) => (
  <div
    key={`${leg.fromName}-${leg.toName}-${arrayIndex}`}
    className="flex gap-3 border-t border-gray-100 pt-3 first:border-t-0 first:pt-0"
  >
```

**デメリット**:
- `fromName`や`toName`が同じ場合、重複の可能性がある
- 配列インデックスと組み合わせる必要があるため、案1と実質的に同じ

## 推奨修正

**案1（複合キー）を推奨**します。

理由：
1. `leg.index`が重複していても確実に一意なキーを生成できる
2. 実装がシンプルで理解しやすい
3. `routeLegs`の順序が変わらない前提であれば、Reactの最適化にも問題なし

## 実装箇所

- **ファイル**: `components/map/RouteList.tsx`
- **行番号**: 72-74行目

## 修正後のコード

```tsx
{routeLegs.map((leg, arrayIndex) => (
  <div
    key={`leg-${arrayIndex}-${leg.index}`}
    className="flex gap-3 border-t border-gray-100 pt-3 first:border-t-0 first:pt-0"
  >
```










