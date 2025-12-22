// types/route.ts

export type RouteLegInfo = {
  index: number;               // 0,1,2,... （UIでは ①②③ 表示）
  fromName: string;            // 出発地名（例：日本の宿 古窯）
  toName: string;              // 到着スポット名（例：上山城）
  distanceText: string;        // "8.2 km" など（Directions APIから）
  durationText: string;        // "18分" など（Directions APIから）
  stayTimeText?: string | null; // "約20〜40分" など（スポット情報から、文字列のまま）
  spotId?: string | null;      // 対応するスポットID（あれば）
  category?: string | null;    // スポットのカテゴリ
  city?: string | null;        // スポットの市区町村
};

export type RoutePoint = {
  location: { lat: number; lng: number };
  pointType: "origin" | "waypoint" | "destination";
  label: string; // "S" | "G" | "1" | "2" | ... | "S / G"
  name?: string; // スポット名や地名
  spotId?: string | null; // スポットID（waypointの場合）
  category?: string | null;
  city?: string | null;
};

export type KoyoMode = "before" | "stay" | "after";

// StopType: 途中立ち寄りスポットの種類（将来拡張用）
export type StopType = "meal" | "cafe" | "rest" | "onsen" | "shopping";

// StopIntent: 途中立ち寄りスポットの検出結果
export type StopIntent = {
  type: StopType;
  foodCategory?: string; // 意味レベル（例: "ラーメン", "芋煮"）- ユーザー意図
  keyword?: string; // Places API用（既存・後方互換）- 実検索ワード
  fallbackKeyword: string; // デフォルトキーワード（例: "ランチ"）
  preferenceTags?: string[]; // 好みのタグ（例: ["温かい", "冬向き"]）- フェーズ1では未使用
  placeType?: string; // Google Places 'type'（例: "restaurant"）
  radius?: number; // 検索半径（メートル、デフォルト: 2000）
  insertAfterSpotIndex?: number; // どのスポットの後に挿入するか（未指定時は自動計算）
  reason?: string; // replyに追記する一言（任意）
};

// RoutePlan: 双方向機能強化用のルートプラン状態
export type RoutePlan = {
  planId: string; // 一意のID（UUID形式）
  mode: "BEFORE" | "STAY" | "AFTER";
  dayIndex?: number; // 複数日の場合の日付インデックス（オプショナル）
  origin: { lat: number; lng: number }; // 出発地座標
  spots: Array<{
    id: string;
    name: string;
    lat: number | null;
    lng: number | null;
    category: string | null;
    city: string | null;
    season: string | null;
    drive_time: string | null;
    walk_time: string | null;
    stay_time: string | null;
    url: string | null;
    tags: string | null;
    drive_minutes: number | null;
    stayMinutes?: number | null;
    source: "db" | "places" | "virtual"; // スポットの出所（A/B/C区別用）
    // Google Places API由来の場合は以下が設定される
    placeId?: string; // Google Places APIのplace_id
    isFromPlaces?: boolean; // Places API由来かどうか（後方互換性のため残す）
  }>;
  destination: { lat: number; lng: number }; // 目的地座標
  constraints: {
    pace?: "relax" | "normal";
    maxWalkMin?: number;
  };
  bCallCount: number; // Google Places API（B）の呼び出し回数（最大1回）
};

