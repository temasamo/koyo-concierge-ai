# ルート一覧で住所が表示される問題の修正案

## 原因

1. **`GoogleMapProps`に`destination`プロパティが定義されていない**
   - `components/map/GoogleMap.tsx`の130-142行目で`GoogleMapProps`が定義されているが、`destination`プロパティがない
   - そのため、`getDestinationName()`関数で`destination`プロパティを参照できない

2. **`getDestinationName()`関数が`destination`プロパティを参照していない**
   - 座標ベースの判定のみで、`destination`プロパティの`name`フィールドを活用していない

3. **`buildRouteLegs`関数で`leg.end_address`が使われている可能性**
   - 最後のleg（目的地）の場合、`destinationName`が正しく取得できないと、`leg.end_address`（住所）が表示される可能性がある

## 修正案

### 1. `GoogleMapProps`に`destination`プロパティを追加

**修正箇所**: `components/map/GoogleMap.tsx` 130-142行目

**修正前**:
```typescript
interface GoogleMapProps {
  center: { lat: number; lng: number };
  markers: Spot[];
  spots?: Spot[];
  showRoute?: boolean;
  koyoOrigin?: { lat: number; lng: number };
  origin?: OriginInfo;
  routeInfo?: { ... } | null;
  onRouteWarningChange?: (warning: string | null) => void;
  showRouteList?: boolean;
  onShowRouteListChange?: (show: boolean) => void;
  onSpotDoubleClick?: (spotId: string) => void;
}
```

**修正後**:
```typescript
interface GoogleMapProps {
  center: { lat: number; lng: number };
  markers: Spot[];
  spots?: Spot[];
  showRoute?: boolean;
  koyoOrigin?: { lat: number; lng: number };
  origin?: OriginInfo;
  destination?: OriginInfo; // 追加：Afterモード用のdestination情報
  routeInfo?: { ... } | null;
  onRouteWarningChange?: (warning: string | null) => void;
  showRouteList?: boolean;
  onShowRouteListChange?: (show: boolean) => void;
  onSpotDoubleClick?: (spotId: string) => void;
}
```

### 2. `getDestinationName()`関数で`destination`プロパティを優先的に参照

**修正箇所**: `components/map/GoogleMap.tsx` 565-623行目

**修正前**:
```typescript
const getDestinationName = () => {
  // routeInfo が存在し、destination が古窯と異なる場合
  if (routeInfo && routeInfo.destination) {
    // ... 座標ベースの判定 ...
  }
  
  // routeInfo が存在しない場合は古窯固定
  return "到着：日本の宿 古窯";
};
```

**修正後**:
```typescript
const getDestinationName = () => {
  // 1. destination プロパティの name を最優先でチェック
  if (destination && destination.name) {
    return `到着：${destination.name}`;
  }
  
  // 2. routeInfo が存在し、destination が古窯と異なる場合
  if (routeInfo && routeInfo.destination) {
    const dest = routeInfo.destination;
    const koyoLat = koyoOrigin?.lat || center.lat;
    const koyoLng = koyoOrigin?.lng || center.lng;
    
    // 古窯の座標と一致するかチェック（小数点以下6桁で比較）
    const isKoyo = 
      Math.abs(dest.lat - koyoLat) < 0.000001 &&
      Math.abs(dest.lng - koyoLng) < 0.000001;
    
    if (isKoyo) {
      return "到着：日本の宿 古窯";
    }
    
    // 県境の座標と一致するかチェック
    // ... 既存のロジック ...
    
    // 固定地点（A〜E）の座標と一致するかチェック
    // ... 既存のロジック ...
    
    // 一致しない場合は座標を表示
    return `到着：目的地`;
  }
  
  // 3. デフォルト
  return "到着：日本の宿 古窯";
};
```

### 3. `GoogleMap`コンポーネントの使用箇所で`destination`プロパティを渡す

**確認が必要な箇所**:
- `app/page.tsx`（または`GoogleMap`を使用している箇所）
- `destination`プロパティを`useSpotStore`から取得して渡す

**修正例**:
```typescript
const destination = useSpotStore((s) => s.destination);

<GoogleMap
  // ... 既存のprops ...
  destination={destination} // 追加
/>
```

## 実装順序

1. `GoogleMapProps`に`destination`プロパティを追加
2. `getDestinationName()`関数を修正（`destination`プロパティを優先的に参照）
3. `GoogleMap`コンポーネントの使用箇所で`destination`プロパティを渡す

## 期待される結果

- ルート一覧の最後の項目（目的地）に、正しい目的地名（例：「山形駅」「宮城方面」）が表示される
- 住所が表示されなくなる










