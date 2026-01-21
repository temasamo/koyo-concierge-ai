# ルート一覧で住所が表示される問題の調査結果

## 問題の概要

ルート一覧の最後の項目（目的地）に、本来は目的地名（例：「山形駅」「宮城方面」）が表示されるべきところ、住所（「日本、〒999-3225 山形県上山市皆沢字諏訪前608-1」）が表示されている。

## 原因の分析

### 1. `getDestinationName()`関数の問題

**場所**: `components/map/GoogleMap.tsx` 565-623行目

**現状のロジック**:
- `routeInfo.destination`の座標をチェックして、固定地点（古窯、県境、山形駅など）と一致するかどうかを確認
- 一致しない場合は`"到着：目的地"`を返す

**問題点**:
- 座標ベースの判定のみで、`destination`プロパティ（`OriginInfo`）の`name`フィールドを参照していない
- Afterモードでは、`destination`プロパティに`name`が設定されている（例：`"山形駅"`、`"宮城方面"`）が、それを活用していない

### 2. `buildRouteLegs`関数の問題

**場所**: `components/map/GoogleMap.tsx` 755-759行目

**現状のロジック**:
```typescript
const toName = isLastLeg
  ? destinationName.replace("到着：", "")
  : spot?.name ??
    leg.end_address ??
    `立ち寄りスポット${index + 1}`;
```

**問題点**:
- `isLastLeg`が`true`の場合、`destinationName.replace("到着：", "")`を使っている
- しかし、`getDestinationName()`が`"到着：目的地"`を返す場合、`toName`は`"目的地"`になるはず
- 実際には住所が表示されているということは、`destinationName`が空文字列や未定義になっている可能性がある
- または、`leg.end_address`が使われている可能性がある（ただし、コード上は`isLastLeg`が`true`の場合は使われないはず）

### 3. `destination`プロパティの活用不足

**場所**: `components/map/GoogleMap.tsx` 144-156行目

**現状**:
- `GoogleMapProps`に`destination: OriginInfo | undefined`が定義されている
- しかし、`getDestinationName()`関数では`destination`プロパティを参照していない
- `routeInfo.destination`（座標のみ）のみを参照している

**問題点**:
- Afterモードでは、`destination`プロパティに`name`が設定されている（例：`"山形駅"`、`"宮城方面"`）
- しかし、`getDestinationName()`は`destination`プロパティを参照していないため、`name`が活用されていない

## 修正案

### 案1: `getDestinationName()`で`destination`プロパティを優先的に参照（推奨）

**修正内容**:
1. `getDestinationName()`関数で、まず`destination`プロパティ（`OriginInfo`）の`name`をチェック
2. `name`が存在する場合は、それを`"到着：${name}"`として返す
3. `name`が存在しない場合のみ、座標ベースの判定を行う

**メリット**:
- `destination`プロパティの`name`を活用できる
- Afterモードで正しい目的地名が表示される
- 既存の座標ベースの判定も維持される

**実装例**:
```typescript
const getDestinationName = () => {
  // 1. destination プロパティの name を最優先でチェック
  if (destination && destination.name) {
    return `到着：${destination.name}`;
  }
  
  // 2. routeInfo が存在し、destination が古窯と異なる場合
  if (routeInfo && routeInfo.destination) {
    const dest = routeInfo.destination;
    // ... 既存の座標ベースの判定ロジック ...
  }
  
  // 3. デフォルト
  return "到着：日本の宿 古窯";
};
```

### 案2: `buildRouteLegs`で`destination`プロパティを直接参照

**修正内容**:
- `buildRouteLegs`関数内で、最後のlegの`toName`を決定する際に、`destination`プロパティの`name`を直接参照

**メリット**:
- `getDestinationName()`を変更せずに済む
- より直接的な修正

**デメリット**:
- `getDestinationName()`と`buildRouteLegs`でロジックが重複する可能性がある

## 推奨修正

**案1を推奨**します。

理由：
1. `destination`プロパティの`name`を活用できる
2. 既存の座標ベースの判定も維持される
3. 他の箇所（例：`routePoints`の生成）でも`getDestinationName()`が使われているため、一貫性が保たれる

## 確認事項

1. **`destination`プロパティが正しく渡されているか**
   - `app/page.tsx`で`setDestination(data.destination)`が呼ばれているか
   - `GoogleMap`コンポーネントに`destination`プロパティが渡されているか

2. **`routeInfo.destination`と`destination`プロパティの関係**
   - `routeInfo.destination`は座標のみ
   - `destination`プロパティは`OriginInfo`型で、`name`を含む

3. **`leg.end_address`が使われている可能性**
   - もし`destinationName`が空文字列や未定義の場合、`leg.end_address`が使われる可能性がある
   - ただし、コード上は`isLastLeg`が`true`の場合は使われないはず



