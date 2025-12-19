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
    // Google Places API由来の場合は以下が設定される
    placeId?: string; // Google Places APIのplace_id
    isFromPlaces?: boolean; // Places API由来かどうか
  }>;
  destination: { lat: number; lng: number }; // 目的地座標
  constraints: {
    pace?: "relax" | "normal";
    maxWalkMin?: number;
  };
  bCallCount: number; // Google Places API（B）の呼び出し回数（最大1回）
};

