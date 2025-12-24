// store/spots.ts
import { create } from "zustand";
import type { RouteLegInfo, RoutePlan } from "@/types/route";

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
  // RoutePlan（双方向機能強化用）
  routePlan: RoutePlan | null;
  setRoutePlan: (routePlan: RoutePlan | null) => void;
  clearRoutePlan: () => void;
  updateRoutePlan: (updates: Partial<RoutePlan>) => void;
  
  // 既存フィールド（後方互換性のため保持、RoutePlanから同期）
  spots: Spot[];
  setSpots: (spots: Spot[]) => void;
  clearSpots: () => void;
  origin: OriginInfo;
  setOrigin: (origin: OriginInfo) => void;
  clearOrigin: () => void;
  destination: OriginInfo;
  setDestination: (destination: OriginInfo) => void;
  clearDestination: () => void;
  routeInfo: RouteInfo | null;
  setRouteInfo: (routeInfo: RouteInfo | null) => void;
  clearRouteInfo: () => void;
  routeLegs: RouteLegInfo[];
  setRouteLegs: (routeLegs: RouteLegInfo[]) => void;
  clearRouteLegs: () => void;
  // 自由入力モード管理
  originInputMode: "free" | "current_location" | undefined;
  setOriginInputMode: (mode: "free" | "current_location" | undefined) => void;
  clearOriginInputMode: () => void;
};

const DEFAULT_ORIGIN: OriginInfo = {
  type: null,
  pref: null,
  lat: null,
  lng: null,
  name: null,
};

const DEFAULT_DESTINATION: OriginInfo = {
  type: null,
  pref: null,
  lat: null,
  lng: null,
  name: null,
};

export const useSpotStore = create<SpotStore>((set, get) => ({
  // RoutePlan管理
  routePlan: null,
  setRoutePlan: (routePlan) => {
    set({ routePlan });
    // RoutePlanが設定されたら、既存フィールドにも同期（後方互換性）
    if (routePlan) {
      set({
        spots: routePlan.spots as Spot[],
        routeInfo: {
          origin: routePlan.origin,
          waypoints: routePlan.spots
            .filter((s) => s.lat != null && s.lng != null)
            .map((s) => ({ lat: s.lat!, lng: s.lng! })),
          destination: routePlan.destination,
        },
      });
    }
  },
  clearRoutePlan: () => {
    set({ routePlan: null });
  },
  updateRoutePlan: (updates) => {
    const current = get().routePlan;
    if (current) {
      const updated = { ...current, ...updates };
      get().setRoutePlan(updated);
    }
  },
  
  // 既存フィールド（後方互換性のため保持）
  spots: [],
  setSpots: (spots) => set({ spots }),
  clearSpots: () => set({ spots: [] }),
  origin: DEFAULT_ORIGIN,
  setOrigin: (origin) => set({ origin }),
  clearOrigin: () => set({ origin: DEFAULT_ORIGIN }),
  destination: DEFAULT_DESTINATION,
  setDestination: (destination) => set({ destination }),
  clearDestination: () => set({ destination: DEFAULT_DESTINATION }),
  routeInfo: null,
  setRouteInfo: (routeInfo) => set({ routeInfo }),
  clearRouteInfo: () => set({ routeInfo: null }),
  routeLegs: [],
  setRouteLegs: (routeLegs) => set({ routeLegs }),
  clearRouteLegs: () => set({ routeLegs: [] }),
  // 自由入力モード管理
  originInputMode: undefined,
  setOriginInputMode: (mode) => set({ originInputMode: mode }),
  clearOriginInputMode: () => set({ originInputMode: undefined }),
}));

