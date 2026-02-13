// store/spots.ts
import { create } from "zustand";
import type { RouteInfo, RouteLegInfo, RoutePlan } from "@/types/route";

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
  // Phase2-1: スポットの役割（確定/候補）
  spotRole?: "confirmed" | "optional";
};

export type OriginInfo = {
  type: "pref-boundary" | "fixed" | "current" | null;
  pref: "miyagi" | "fukushima" | "akita" | "niigata" | null;
  lat: number | null;
  lng: number | null;
  name?: string | null; // オプショナル（fixed タイプの場合のみ使用）
};

type MapFilters = {
  transport?: "driving" | "walking";
  radiusKm?: number;
  category?: string;
  keyword?: string;
};

type RouteDraft = {
  routeInfo: RouteInfo | null;
  routePlan: RoutePlan | null;
  spots: Spot[];
  optionalSpots: Spot[];
};

type SpotStore = {
  // RoutePlan（双方向機能強化用）
  routePlan: RoutePlan | null;
  setRoutePlan: (routePlan: RoutePlan | null) => void;
  clearRoutePlan: () => void;
  updateRoutePlan: (updates: Partial<RoutePlan>) => void;
  
  // 共有Trip State（Step0）
  tripId: string;
  selectedSpotId: string | null;
  selectedSpotSource: "map" | "chat" | null;
  routeDraft: RouteDraft | null;
  mapFilters: MapFilters;
  lastEvent: { type: string; payload: any; ts: number } | null;
  startNewTrip: () => void;
  setSelectedSpotId: (id: string | null) => void;
  setMapFilters: (filters: Partial<MapFilters>) => void;
  clearMapFilters: () => void;
  setRouteDraft: (draft: RouteDraft | null) => void;
  applyDraftToConfirmed: () => void;
  setLastEvent: (type: string, payload: any) => void;
  // Step1: Map/Chat選択の共有
  newTrip: () => void;
  setSelectedSpot: (spotId: string | null, source?: "map" | "chat") => void;
  clearSelectedSpot: () => void;
  
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
  // Phase2-2: 候補スポット（確定経由地ではない）
  optionalSpots: Spot[];
  setOptionalSpots: (spots: Spot[]) => void;
  clearOptionalSpots: () => void;
  // Phase2-2.5: ルート関連stateの一括更新
  routeReady: boolean;
  routeVersion: number;
  applyRouteUpdate: (payload: {
    routePlan?: RoutePlan | null;
    routeInfo?: RouteInfo | null;
    spots?: Spot[];
    optionalSpots?: Spot[];
  }) => void;
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
    // RoutePlanが設定されたら、spotsのみを更新（routeInfoはsetRouteInfoで管理）
    if (routePlan) {
      set({
        spots: routePlan.spots as Spot[],
        // routeInfo は setRouteInfo(data.routeInfo) で更新する（Phase2-1: 候補と確定の分離）
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
  
  // 共有Trip State（Step0）
  tripId: crypto.randomUUID(),
  selectedSpotId: null,
  selectedSpotSource: null,
  routeDraft: null,
  mapFilters: {},
  lastEvent: null,
  startNewTrip: () => {
    set({
      tripId: crypto.randomUUID(),
      selectedSpotId: null,
      selectedSpotSource: null,
      routeDraft: null,
      lastEvent: null,
    });
  },
  setSelectedSpotId: (id) =>
    set({ selectedSpotId: id, selectedSpotSource: null }),
  setMapFilters: (filters) =>
    set((state) => ({
      mapFilters: { ...state.mapFilters, ...filters },
    })),
  clearMapFilters: () => set({ mapFilters: {} }),
  setRouteDraft: (draft) => set({ routeDraft: draft }),
  applyDraftToConfirmed: () => {
    const draft = get().routeDraft;
    if (!draft) return;
    get().applyRouteUpdate({
      routeInfo: draft.routeInfo,
      routePlan: draft.routePlan,
      spots: draft.spots,
      optionalSpots: draft.optionalSpots,
    });
    set({ routeDraft: null });
  },
  setLastEvent: (type, payload) =>
    set({ lastEvent: { type, payload, ts: Date.now() } }),
  newTrip: () => {
    set({
      tripId: crypto.randomUUID(),
      selectedSpotId: null,
      selectedSpotSource: null,
    });
  },
  setSelectedSpot: (spotId, source) =>
    set({
      selectedSpotId: spotId,
      selectedSpotSource: spotId ? source ?? null : null,
    }),
  clearSelectedSpot: () =>
    set({ selectedSpotId: null, selectedSpotSource: null }),
  
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
  // Phase2-2: 候補スポット管理
  optionalSpots: [],
  setOptionalSpots: (optionalSpots) => set({ optionalSpots }),
  clearOptionalSpots: () => set({ optionalSpots: [] }),
  // Phase2-2.5: ルート関連stateの一括更新
  routeReady: false,
  routeVersion: 0,
  applyRouteUpdate: (payload) => {
    const current = get();
    const newVersion = current.routeVersion + 1;
    const updates: Partial<SpotStore> = {
      routeVersion: newVersion,
    };
    
    // routePlan: null=クリア、undefined=保持
    if ('routePlan' in payload) {
      updates.routePlan = payload.routePlan;
    }
    
    // routeInfo: null=クリア（routeReady=false）、undefined=保持、存在する場合はrouteReady=true
    if ('routeInfo' in payload) {
      updates.routeInfo = payload.routeInfo;
      updates.routeReady = payload.routeInfo !== null;
    }
    
    // spots: undefined=保持、[]は空に更新
    if ('spots' in payload) {
      updates.spots = payload.spots;
    }
    
    // optionalSpots: undefined=保持、[]は空に更新
    if ('optionalSpots' in payload) {
      updates.optionalSpots = payload.optionalSpots;
    }
    
    console.log("[applyRouteUpdate] Called", {
      routeVersion: `${current.routeVersion} → ${newVersion}`,
      payload: {
        routePlan: payload.routePlan ? `planId: ${payload.routePlan.planId}` : payload.routePlan,
        routeInfo: payload.routeInfo ? `waypoints: ${payload.routeInfo.waypoints?.length || 0}` : payload.routeInfo,
        spots: payload.spots ? `count: ${payload.spots.length}` : payload.spots,
        optionalSpots: payload.optionalSpots ? `count: ${payload.optionalSpots.length}` : payload.optionalSpots,
      },
      routeReady: updates.routeReady !== undefined ? updates.routeReady : current.routeReady,
    });
    
    set(updates);
  },
}));

