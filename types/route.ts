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

