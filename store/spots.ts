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

type SpotStore = {
  spots: Spot[];
  setSpots: (spots: Spot[]) => void;
  clearSpots: () => void;
};

export const useSpotStore = create<SpotStore>((set) => ({
  spots: [],
  setSpots: (spots) => set({ spots }),
  clearSpots: () => set({ spots: [] }),
}));

