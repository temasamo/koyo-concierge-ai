// store/spots.ts
import { create } from "zustand";

// /api/spots/search のレスポンス形式に合わせたSpot型
export type Spot = {
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
  score?: number;
  // 後方互換性のためのオプショナルフィールド
  description?: string;
  address?: string;
  imageUrl?: string;
  rating?: number;
  stayMinutes?: number;
};

export type OriginInfo = {
  type: "pref-boundary" | "fixed" | "current" | null;
  pref: "miyagi" | "fukushima" | "akita" | "niigata" | null;
  lat: number | null;
  lng: number | null;
  name?: string | null; // オプショナル（fixed タイプの場合のみ使用）
};

export type RouteInfo = {
  origin: { lat: number; lng: number };
  waypoints: Array<{ lat: number; lng: number }>;
  destination: { lat: number; lng: number };
};

type SpotStore = {
  spots: Spot[];
  setSpots: (spots: Spot[]) => void;
  clearSpots: () => void;
  origin: OriginInfo;
  setOrigin: (origin: OriginInfo) => void;
  clearOrigin: () => void;
  routeInfo: RouteInfo | null;
  setRouteInfo: (routeInfo: RouteInfo | null) => void;
  clearRouteInfo: () => void;
};

const DEFAULT_ORIGIN: OriginInfo = {
  type: null,
  pref: null,
  lat: null,
  lng: null,
  name: null,
};

export const useSpotStore = create<SpotStore>((set) => ({
  spots: [],
  setSpots: (spots) => set({ spots }),
  clearSpots: () => set({ spots: [] }),
  origin: DEFAULT_ORIGIN,
  setOrigin: (origin) => set({ origin }),
  clearOrigin: () => set({ origin: DEFAULT_ORIGIN }),
  routeInfo: null,
  setRouteInfo: (routeInfo) => set({ routeInfo }),
  clearRouteInfo: () => set({ routeInfo: null }),
}));

